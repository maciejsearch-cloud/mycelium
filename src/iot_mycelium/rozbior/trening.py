"""Trening modelu rozbioru w PyTorch (box/węzeł PC). Wagi wymienne z model.py (numpy) i web/src/myc/rozbior.ts.

    python -m iot_mycelium.rozbior.trening --data web/public/data/rozbior --out /tmp/rb.bin --epochs 12 [--tb pdb|lfg]

Dane: pliki zdań z export_rozbior.py (train-*.json.gz). Test UD nigdy nie jest tu czytany – wybór najlepszej
epoki tylko na podziale dev.
"""

from __future__ import annotations

import argparse
import gzip
import json
import random
import time
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np
import torch
from torch import nn
from torch.nn.utils.rnn import pack_padded_sequence, pad_packed_sequence

from . import analiza, model
from .model import ARC, CASED, CDIM, CFIL, HID, MAXC, REL, TBD, TBS, WDIM


def build_header(train: list[dict[str, Any]], max_words: int = 16000, max_lem: int = 1000) -> dict[str, Any]:
    wc, cc, lc, dc = Counter(), Counter(), Counter(), Counter()
    fv: dict[str, Counter] = {k: Counter() for k in analiza.FEATS}
    for s in train:
        for t in s["toks"]:
            wc[t["form"].lower()] += 1
            for ch in model.chars_of(t["form"]):
                cc[ch] += 1
            lc[model.lemma_rule(t["form"], t["lemma"])] += 1
            dc[t["deprel"]] += 1
            for k in analiza.FEATS:
                fv[k][(t.get("feats") or {}).get(k, "_")] += 1
    words = [w for w, n in wc.most_common(max_words) if n >= 3]
    chars = sorted(c for c, n in cc.items() if n >= 5)
    lemmas = ["0||"] + [r for r, n in lc.most_common(max_lem) if r != "0||"][: max_lem - 1]
    return {
        "words": words,
        "chars": chars,
        "upos": analiza.UPOS,
        "feats": {k: ["_"] + sorted(v for v in fv[k] if v != "_") for k in analiza.FEATS},
        "lemmas": lemmas,
        "deprels": sorted(dc),
    }


class Net(nn.Module):
    def __init__(self, H: dict[str, Any]):
        super().__init__()
        self.H = H
        nw, nc = len(H["words"]) + 3, len(H["chars"]) + 3
        self.wemb = nn.Embedding(nw, WDIM)
        self.cemb = nn.Embedding(nc, CDIM)
        self.conv = nn.Conv1d(CDIM, CFIL, 3)
        self.case = nn.Embedding(4, CASED)
        self.tb = nn.Embedding(len(TBS), TBD)
        self.root = nn.Parameter(torch.zeros(2 * HID))
        D = WDIM + CFIL + CASED + TBD
        self.l0 = nn.LSTM(D, HID, batch_first=True, bidirectional=True)
        self.l1 = nn.LSTM(2 * HID, HID, batch_first=True, bidirectional=True)
        self.drop = nn.Dropout(0.33)
        self.upos = nn.Linear(2 * HID, len(H["upos"]))
        self.feats = nn.ModuleDict({k: nn.Linear(2 * HID, len(H["feats"][k])) for k in analiza.FEATS})
        self.lem = nn.Linear(2 * HID, len(H["lemmas"]))
        self.ad, self.ah = nn.Linear(2 * HID, ARC), nn.Linear(2 * HID, ARC)
        self.arc_U = nn.Parameter(torch.zeros(ARC, ARC))
        self.arc_h = nn.Parameter(torch.zeros(ARC))
        self.rd, self.rh = nn.Linear(2 * HID, REL), nn.Linear(2 * HID, REL)
        self.rel_U = nn.Parameter(torch.zeros(len(H["deprels"]), REL + 1, REL + 1))

    def encode(self, wid, cid, clen, cas, tb, lens):
        B, N = wid.shape
        ce = self.cemb(cid.view(B * N, -1)).transpose(1, 2)  # BN × C × L
        cv = self.conv(ce)  # BN × F × (L-2)
        L2 = cv.shape[2]
        pos = torch.arange(L2).view(1, 1, -1)
        mask = pos < (clen.view(B * N, 1, 1) - 2)
        cv = cv.masked_fill(~mask, -1e4).max(2).values.clamp(min=0).view(B, N, CFIL)
        x = torch.cat([self.wemb(wid), cv, self.case(cas), self.tb(tb).unsqueeze(1).expand(B, N, TBD)], 2)
        for i, lstm in enumerate((self.l0, self.l1)):
            x = self.drop(x) if i == 0 or self.training else x
            p = pack_padded_sequence(x, lens.cpu(), batch_first=True, enforce_sorted=False)
            x, _ = lstm(p)
            x, _ = pad_packed_sequence(x, batch_first=True, total_length=N)
        x = self.drop(x)
        return torch.cat([self.root.view(1, 1, -1).expand(B, 1, 2 * HID), x], 1)  # B × (N+1) × 2H

    def forward(self, b):
        X = self.encode(b["wid"], b["cid"], b["clen"], b["cas"], b["tb"], b["lens"])
        x = X[:, 1:]
        out = {"upos": self.upos(x), "lem": self.lem(x), "feats": {k: m(x) for k, m in self.feats.items()}}
        ad, ah = torch.relu(self.ad(X)), torch.relu(self.ah(X))
        S = ad @ self.arc_U @ ah.transpose(1, 2) + (ah @ self.arc_h).unsqueeze(1)  # B × d × h
        N1 = X.shape[1]
        hm = torch.arange(N1).view(1, 1, -1) <= b["lens"].view(-1, 1, 1)
        out["arc"] = S.masked_fill(~hm, -1e9)
        rd, rh = torch.relu(self.rd(X)), torch.relu(self.rh(X))
        one = torch.ones(*rd.shape[:2], 1)
        rd1, rh1 = torch.cat([rd, one], 2), torch.cat([rh, one], 2)
        hg = b["head"].clamp(min=0)  # B × N (złote głowy)
        rhg = torch.gather(rh1, 1, hg.unsqueeze(2).expand(-1, -1, REL + 1))  # B × N × R
        out["rel"] = torch.einsum("bna,lac,bnc->bnl", rd1[:, 1:], self.rel_U, rhg)
        return out

    def export(self) -> dict[str, np.ndarray]:
        g = lambda t: t.detach().cpu().numpy().astype(np.float32)  # noqa: E731
        W = {
            "wemb": g(self.wemb.weight),
            "cemb": g(self.cemb.weight),
            "conv_w": g(self.conv.weight),
            "conv_b": g(self.conv.bias),
            "case": g(self.case.weight),
            "tb": g(self.tb.weight),
            "root": g(self.root),
        }
        for li, lstm in enumerate((self.l0, self.l1)):
            for d, sfx in (("f", ""), ("b", "_reverse")):
                W[f"l{li}{d}_wi"] = g(getattr(lstm, f"weight_ih_l0{sfx}"))
                W[f"l{li}{d}_wh"] = g(getattr(lstm, f"weight_hh_l0{sfx}"))
                W[f"l{li}{d}_b"] = g(getattr(lstm, f"bias_ih_l0{sfx}")) + g(getattr(lstm, f"bias_hh_l0{sfx}"))
        W["upos_w"], W["upos_b"] = g(self.upos.weight), g(self.upos.bias)
        for k, m in self.feats.items():
            W[f"f_{k}_w"], W[f"f_{k}_b"] = g(m.weight), g(m.bias)
        W["lem_w"], W["lem_b"] = g(self.lem.weight), g(self.lem.bias)
        for n in ("ad", "ah", "rd", "rh"):
            W[f"{n}_w"], W[f"{n}_b"] = g(getattr(self, n).weight), g(getattr(self, n).bias)
        W["arc_U"], W["arc_h"], W["rel_U"] = g(self.arc_U), g(self.arc_h), g(self.rel_U)
        return W

    def load_np(self, W: dict[str, np.ndarray]) -> None:
        t = lambda a: torch.tensor(np.asarray(a, np.float32))  # noqa: E731
        with torch.no_grad():
            self.wemb.weight.copy_(t(W["wemb"]))
            self.cemb.weight.copy_(t(W["cemb"]))
            self.conv.weight.copy_(t(W["conv_w"]))
            self.conv.bias.copy_(t(W["conv_b"]))
            self.case.weight.copy_(t(W["case"]))
            self.tb.weight.copy_(t(W["tb"]))
            self.root.copy_(t(W["root"]))
            for li, lstm in enumerate((self.l0, self.l1)):
                for d, sfx in (("f", ""), ("b", "_reverse")):
                    getattr(lstm, f"weight_ih_l0{sfx}").copy_(t(W[f"l{li}{d}_wi"]))
                    getattr(lstm, f"weight_hh_l0{sfx}").copy_(t(W[f"l{li}{d}_wh"]))
                    getattr(lstm, f"bias_ih_l0{sfx}").copy_(t(W[f"l{li}{d}_b"]))
                    getattr(lstm, f"bias_hh_l0{sfx}").zero_()
            self.upos.weight.copy_(t(W["upos_w"]))
            self.upos.bias.copy_(t(W["upos_b"]))
            for k, m in self.feats.items():
                m.weight.copy_(t(W[f"f_{k}_w"]))
                m.bias.copy_(t(W[f"f_{k}_b"]))
            self.lem.weight.copy_(t(W["lem_w"]))
            self.lem.bias.copy_(t(W["lem_b"]))
            for n in ("ad", "ah", "rd", "rh"):
                getattr(self, n).weight.copy_(t(W[f"{n}_w"]))
                getattr(self, n).bias.copy_(t(W[f"{n}_b"]))
            self.arc_U.copy_(t(W["arc_U"]))
            self.arc_h.copy_(t(W["arc_h"]))
            self.rel_U.copy_(t(W["rel_U"]))


def batchify(
    H: dict[str, Any], sents: list[dict[str, Any]], word_drop: float = 0.0, rng=None
) -> dict[str, torch.Tensor]:
    wv = {w: i + 3 for i, w in enumerate(H["words"])}
    cv = {c: i + 3 for i, c in enumerate(H["chars"])}
    lv = {r: i for i, r in enumerate(H["lemmas"])}
    dv = {r: i for i, r in enumerate(H["deprels"])}
    uv = {u: i for i, u in enumerate(H["upos"])}
    fvs = {k: {v: i for i, v in enumerate(H["feats"][k])} for k in analiza.FEATS}
    B, N = len(sents), max(len(s["toks"]) for s in sents)
    z = lambda *s: torch.zeros(*s, dtype=torch.long)  # noqa: E731
    b = {
        "wid": z(B, N),
        "cid": z(B, N, MAXC),
        "clen": torch.full((B, N), 3, dtype=torch.long),
        "cas": z(B, N),
        "tb": z(B),
        "lens": z(B),
        "upos": torch.full((B, N), -100, dtype=torch.long),
        "lem": torch.full((B, N), -100, dtype=torch.long),
        "head": torch.full((B, N), -100, dtype=torch.long),
        "rel": torch.full((B, N), -100, dtype=torch.long),
        "feats": {k: torch.full((B, N), -100, dtype=torch.long) for k in analiza.FEATS},
    }
    for i, s in enumerate(sents):
        b["tb"][i] = TBS.index(s.get("tb", "pdb"))
        b["lens"][i] = len(s["toks"])
        for j, t in enumerate(s["toks"]):
            w = t["form"].lower()
            wi = wv.get(w, model.UNK)
            if word_drop and rng is not None and rng.random() < word_drop:
                wi = model.UNK
            b["wid"][i, j] = wi
            cs = [cv.get(ch, model.UNK) for ch in model.chars_of(t["form"])]
            b["cid"][i, j, : len(cs)] = torch.tensor(cs)
            b["clen"][i, j] = len(cs)
            b["cas"][i, j] = model.casing(t["form"])
            # None = pole niezweryfikowane (zdania z głosów Weryfikuj) → maska -100, bez nadzoru
            if t.get("upos") is not None:
                b["upos"][i, j] = uv.get(t["upos"], uv["X"])
            if t.get("lemma") is not None:
                b["lem"][i, j] = lv.get(model.lemma_rule(t["form"], t["lemma"]), -100)
            if t.get("head") is not None:
                b["head"][i, j] = t["head"]
            if t.get("deprel") is not None:
                b["rel"][i, j] = dv.get(t["deprel"], -100)
            if "feats" not in t or t["feats"] is not None:
                for k in analiza.FEATS:
                    b["feats"][k][i, j] = fvs[k].get((t.get("feats") or {}).get(k, "_"), 0)
    return b


def loss_of(out, b) -> torch.Tensor:
    def ce(x, y, ignore_index=-100):
        # pusta partia celów (np. same zdania z głosów bez lematów/cech) → 0 zamiast NaN
        if not bool((y != ignore_index).any()):
            return x.sum() * 0.0
        return nn.functional.cross_entropy(x, y, ignore_index=ignore_index)

    loss = ce(out["upos"].flatten(0, 1), b["upos"].flatten(), ignore_index=-100)
    loss = loss + ce(out["lem"].flatten(0, 1), b["lem"].flatten(), ignore_index=-100)
    for k in analiza.FEATS:
        loss = loss + 0.5 * ce(out["feats"][k].flatten(0, 1), b["feats"][k].flatten(), ignore_index=-100)
    arc = out["arc"][:, 1:]  # B × N × (N+1)
    loss = loss + ce(arc.flatten(0, 1), b["head"].flatten(), ignore_index=-100)
    loss = loss + ce(out["rel"].flatten(0, 1), b["rel"].flatten(), ignore_index=-100)
    return loss


def batches(sents, bs, rng):
    idx = sorted(range(len(sents)), key=lambda i: len(sents[i]["toks"]) + rng.random() * 3)
    chunks = [idx[i : i + bs] for i in range(0, len(idx), bs)]
    rng.shuffle(chunks)
    return chunks


def train_epochs(
    net: Net, sents, epochs: float, lr: float, bs: int = 32, seed: int = 0, log=print, max_sec: float = 1e9
):
    """Trening lokalny (też zadanie węzła: kilka set zdań, 1 epoka, małe lr). Zwraca (kroki, tokeny, średnia strata)."""
    rng = random.Random(seed)
    torch.manual_seed(seed)
    opt = torch.optim.Adam(net.parameters(), lr=lr, betas=(0.9, 0.9))
    net.train()
    steps = toks = 0
    tot = 0.0
    t0 = time.time()
    n_ep = int(np.ceil(epochs))
    for ep in range(n_ep):
        ch = batches(sents, bs, rng)
        if ep == n_ep - 1 and epochs < n_ep:
            ch = ch[: max(1, int(len(ch) * (epochs - ep)))]
        for c in ch:
            b = batchify(net.H, [sents[i] for i in c], 0.1, rng)
            loss = loss_of(net(b), b)
            if not torch.isfinite(loss):
                continue
            opt.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            steps += 1
            toks += int(b["lens"].sum())
            tot += float(loss.detach())
            if steps % 200 == 0:
                log(f"krok {steps}: strata {tot / steps:.3f}, {toks / (time.time() - t0):.0f} tok/s")
            if time.time() - t0 > max_sec:
                return steps, toks, tot / max(steps, 1)
    return steps, toks, tot / max(steps, 1)


def read_split(d: Path, split: str) -> list[dict[str, Any]]:
    out = []
    for p in sorted(d.glob(f"{split}-*.json.gz")):
        out += json.loads(gzip.decompress(p.read_bytes()))["sents"]
    return out


def evaluate_np(H, W, sents, limit: int | None = None) -> dict[str, Any]:
    from . import miary

    ss = sents[:limit] if limit else sents
    gold = [s["toks"] for s in ss]
    pred = [model.predict(H, W, [t["form"] for t in s["toks"]], s.get("tb", "pdb")) for s in ss]
    return miary.score(gold, pred)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="web/public/data/rozbior")
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=12)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--threads", type=int, default=3)
    ap.add_argument("--dev-limit", type=int, default=800)
    ap.add_argument("--max-hours", type=float, default=6)
    ap.add_argument(
        "--tb",
        default="pdb",
        choices=["pdb", "lfg"],
        help="treebank = licencja wag: pdb (CC BY-NC-SA 4.0, domyślny) albo lfg (GPL-3.0); nigdy oba naraz",
    )
    ap.add_argument(
        "--votes", default="", help="plik JSON ze zdaniami z zatwierdzonych rozbiorów (scripts/rozbior_votes.py)"
    )
    ap.add_argument("--votes-weight", type=int, default=3, help="ile razy powtórzyć zdania z głosów w epoce")
    ap.add_argument("--init", default="", help="start z wag istniejącego modelu (dostrajanie, ten sam nagłówek)")
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    d = Path(a.data)
    train, dev = read_split(d, "train"), read_split(d, "dev")
    if a.tb:
        train = [s for s in train if s.get("tb") == a.tb]
        dev = [s for s in dev if s.get("tb") == a.tb]
    votes = json.loads(Path(a.votes).read_text())["sents"] if a.votes else []
    if a.init:
        H, W0 = model.load(Path(a.init).read_bytes())
        H = {k: v for k, v in H.items() if k not in ("train", "shapes")}
        net = Net(H)
        net.load_np(W0)
    else:
        H = build_header(train)
        net = Net(H)
        nn.init.normal_(net.arc_U, std=0.01)
        nn.init.normal_(net.rel_U, std=0.01)
    train = train + votes * max(1, a.votes_weight)
    if votes:
        print(f"zdań z głosów Weryfikuj: {len(votes)} (×{a.votes_weight})")
    print(f"zdań: train {len(train)}, dev {len(dev)}; słów {len(H['words'])}, reguł lematu {len(H['lemmas'])}")
    rng = random.Random(1)
    devs = rng.sample(dev, min(a.dev_limit, len(dev)))
    best, t0 = -1.0, time.time()
    hist = []
    for ep in range(a.epochs):
        lr = a.lr * (0.75 ** max(0, ep - 3))
        st, tk, ls = train_epochs(net, train, 1, lr, seed=ep)
        net.eval()
        W = {k: v.astype(np.float16).astype(np.float32) for k, v in net.export().items()}
        m = evaluate_np(H, W, devs)
        hist.append({"ep": ep, "loss": round(ls, 4), "dev": {k: m[k] for k in ("role_f1", "upos", "feats", "las")}})
        print(
            f"epoka {ep}: strata {ls:.3f}, dev role-F1 {m['role_f1']}, UPOS {m['upos']}, cechy {m['feats']}, LAS {m['las']} ({(time.time() - t0) / 60:.1f} min)",
            flush=True,
        )
        if m["role_f1"] > best:
            best = m["role_f1"]
            H2 = dict(H)
            H2["train"] = {"epochs": ep + 1, "dev_role_f1": best, "hist": hist, "lr": a.lr}
            model.save(a.out, H2, net.export())
        if time.time() - t0 > a.max_hours * 3600:
            break


if __name__ == "__main__":
    main()
