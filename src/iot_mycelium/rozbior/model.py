"""Mały tagger + parser zależności dla polskiego (warstwa rozumienia), przejście w przód w czystym numpy.

Architektura (ta sama w torch – trening, numpy – węzły i weryfikator, TypeScript – przeglądarka):
  wejście tokenu = [słowo (64) ; znaki CNN (k=3, 96, max) ; wielkość liter (8) ; treebank (8)]
  → BiLSTM ×2 (160 na kierunek) → głowy: UPOS, każda cecha osobno, reguła lematu,
  łuki biaffine (MLP 256) i etykiety zależności (MLP 96, biliniowo). Pozycja 0 = sztuczny KORZEŃ.
Dekodowanie drzewa: maksymalne drzewo rozpinające (Chu–Liu–Edmonds) z jednym korzeniem.

Plik wag „MYCRB2”: 6 B magii + u32 (LE) długość nagłówka JSON + nagłówek (słowniki, etykiety, kształty) + tensory:
macierze ≥ 4096 wartości jako int8 ze skalą fp32 na wiersz, reszta fp16 LE (MYCRB1 = same fp16, nadal czytany).
"""

from __future__ import annotations

import json
import struct
from typing import Any

import numpy as np

from . import analiza

MAGIC = b"MYCRB2"
WDIM, CDIM, CFIL, CASED, TBD, HID, ARC, REL = 64, 32, 96, 8, 8, 160, 256, 96
MAXC = 20
PAD, UNK, ROOT = 0, 1, 2  # słowa i znaki
TBS = ["pdb", "lfg"]


def chars_of(w: str) -> str:
    s = "^" + w.lower() + "$"
    return s if len(s) <= MAXC else s[:2] + s[-(MAXC - 2) :]


def casing(w: str) -> int:
    if not w or not any(ch.isalpha() for ch in w):
        return 3
    if w.isupper() and len(w) > 1:
        return 2
    return 1 if w[0].isupper() else 0


# ---------------------------------------------------------------- reguły lematu
def lemma_rule(form: str, lemma: str) -> str:
    f, l_ = form.lower(), lemma.lower()
    p = 0
    while p < min(len(f), len(l_)) and f[p] == l_[p]:
        p += 1
    cap = "C" if lemma[:1].isupper() else ""
    return f"{len(f) - p}|{l_[p:]}|{cap}"


def apply_rule(form: str, rule: str) -> str:
    try:
        k, app, cap = rule.split("|")
        k = int(k)
    except ValueError:
        return form.lower()
    f = form.lower()
    if k > len(f):
        return f
    out = f[: len(f) - k] + app
    return out[:1].upper() + out[1:] if cap else out


# ---------------------------------------------------------------- wagi
def shapes(H: dict[str, Any]) -> list[tuple[str, tuple[int, ...]]]:
    nw, nc = len(H["words"]) + 3, len(H["chars"]) + 3
    D = WDIM + CFIL + CASED + TBD
    s: list[tuple[str, tuple[int, ...]]] = [
        ("wemb", (nw, WDIM)),
        ("cemb", (nc, CDIM)),
        ("conv_w", (CFIL, CDIM, 3)),
        ("conv_b", (CFIL,)),
        ("case", (4, CASED)),
        ("tb", (len(TBS), TBD)),
        ("root", (2 * HID,)),
    ]
    for layer, din in ((0, D), (1, 2 * HID)):
        for d in ("f", "b"):
            s += [
                (f"l{layer}{d}_wi", (4 * HID, din)),
                (f"l{layer}{d}_wh", (4 * HID, HID)),
                (f"l{layer}{d}_b", (4 * HID,)),
            ]
    s += [("upos_w", (len(H["upos"]), 2 * HID)), ("upos_b", (len(H["upos"]),))]
    for k in analiza.FEATS:
        n = len(H["feats"][k])
        s += [(f"f_{k}_w", (n, 2 * HID)), (f"f_{k}_b", (n,))]
    s += [("lem_w", (len(H["lemmas"]), 2 * HID)), ("lem_b", (len(H["lemmas"]),))]
    s += [
        ("ad_w", (ARC, 2 * HID)),
        ("ad_b", (ARC,)),
        ("ah_w", (ARC, 2 * HID)),
        ("ah_b", (ARC,)),
        ("arc_U", (ARC, ARC)),
        ("arc_h", (ARC,)),
        ("rd_w", (REL, 2 * HID)),
        ("rd_b", (REL,)),
        ("rh_w", (REL, 2 * HID)),
        ("rh_b", (REL,)),
        ("rel_U", (len(H["deprels"]), REL + 1, REL + 1)),
    ]
    return s


def _q8(sh: tuple[int, ...] | list[int]) -> bool:
    """Macierze ≥ 4096 wartości: int8 z jedną skalą fp32 na wiersz; reszta (wektory, małe) fp16."""
    return len(sh) >= 2 and int(np.prod(sh)) >= 4096


def save(path: str, H: dict[str, Any], W: dict[str, np.ndarray]) -> bytes:
    """MYCRB2: nagłówek JSON + tensory w kolejności shapes(H) (int8 + skale wierszy albo fp16) – plik < 4 MB."""
    hdr = {k: v for k, v in H.items() if k != "shapes"}
    hdr["shapes"] = [[k, list(sh)] for k, sh in shapes(H)]
    hb = json.dumps(hdr, ensure_ascii=False, separators=(",", ":")).encode()
    parts = []
    for k, sh in shapes(H):
        w = np.asarray(W[k], np.float32)
        if _q8(sh):
            rows = w.reshape(-1, sh[-1])
            sc = np.abs(rows).max(axis=1) / 127.0
            sc = np.where(sc > 0, sc, 1.0).astype("<f4")
            q = np.clip(np.rint(rows / sc[:, None]), -127, 127).astype(np.int8)
            parts += [sc.tobytes(), q.tobytes()]
        else:
            parts.append(w.astype("<f2").tobytes())
    body = MAGIC + struct.pack("<I", len(hb)) + hb + b"".join(parts)
    if path:
        with open(path, "wb") as f:
            f.write(body)
    return body


def load(body: bytes) -> tuple[dict[str, Any], dict[str, np.ndarray]]:
    if body[:6] not in (MAGIC, b"MYCRB1"):
        raise ValueError("to nie jest plik MYCRB2")
    v1 = body[:6] == b"MYCRB1"
    (n,) = struct.unpack("<I", body[6:10])
    H = json.loads(body[10 : 10 + n].decode())
    o = 10 + n
    W = {}
    for k, sh in shapes(H):
        cnt = int(np.prod(sh))
        if not v1 and _q8(sh):
            r = cnt // sh[-1]
            sc = np.frombuffer(body, "<f4", r, o)
            o += 4 * r
            q = np.frombuffer(body, np.int8, cnt, o).reshape(r, sh[-1])
            W[k] = (q.astype(np.float32) * sc[:, None]).reshape(sh)
            o += cnt
        else:
            W[k] = np.frombuffer(body, "<f2", cnt, o).astype(np.float32).reshape(sh)
            o += 2 * cnt
    if o != len(body):
        raise ValueError(f"rozmiar pliku {len(body)} != {o}")
    return H, W


# ---------------------------------------------------------------- przejście w przód (numpy)
def _sig(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def _lstm(x: np.ndarray, wi: np.ndarray, wh: np.ndarray, b: np.ndarray, rev: bool) -> np.ndarray:
    n = x.shape[0]
    h = np.zeros(HID, np.float32)
    c = np.zeros(HID, np.float32)
    out = np.zeros((n, HID), np.float32)
    xi = x @ wi.T + b
    rng = range(n - 1, -1, -1) if rev else range(n)
    for t in rng:
        g = xi[t] + wh @ h
        i, f, gg, o = _sig(g[:HID]), _sig(g[HID : 2 * HID]), np.tanh(g[2 * HID : 3 * HID]), _sig(g[3 * HID :])
        c = f * c + i * gg
        h = o * np.tanh(c)
        out[t] = h
    return out


def encode_words(
    H: dict[str, Any], forms: list[str], tb: str = "pdb"
) -> tuple[np.ndarray, list[list[int]], np.ndarray]:
    wv = H["_wv"] if "_wv" in H else {w: i + 3 for i, w in enumerate(H["words"])}
    cv = H["_cv"] if "_cv" in H else {c: i + 3 for i, c in enumerate(H["chars"])}
    H["_wv"], H["_cv"] = wv, cv
    wid = np.array([wv.get(w.lower(), UNK) for w in forms], np.int64)
    cid = [[cv.get(ch, UNK) for ch in chars_of(w)] for w in forms]
    cas = np.array([casing(w) for w in forms], np.int64)
    return wid, cid, cas


def hidden(H: dict[str, Any], W: dict[str, np.ndarray], forms: list[str], tb: str = "pdb") -> np.ndarray:
    wid, cid, cas = encode_words(H, forms, tb)
    rows = []
    for j, cs in enumerate(cid):
        e = W["cemb"][cs]  # L × CDIM
        L = e.shape[0]
        win = np.stack([e[t : t + 3] for t in range(L - 2)])  # (L-2) × 3 × CDIM
        conv = np.einsum("tkc,fck->tf", win, W["conv_w"]) + W["conv_b"]
        ch = np.maximum(conv, 0).max(0)
        rows.append(np.concatenate([W["wemb"][wid[j]], ch, W["case"][cas[j]], W["tb"][TBS.index(tb)]]))
    x = np.stack(rows).astype(np.float32)
    for layer in (0, 1):
        f = _lstm(x, W[f"l{layer}f_wi"], W[f"l{layer}f_wh"], W[f"l{layer}f_b"], False)
        b = _lstm(x, W[f"l{layer}b_wi"], W[f"l{layer}b_wh"], W[f"l{layer}b_b"], True)
        x = np.concatenate([f, b], 1)
    return np.concatenate([W["root"][None, :], x], 0)  # (n+1) × 2HID, wiersz 0 = KORZEŃ


def mst(scores: np.ndarray) -> list[int]:
    """Chu–Liu–Edmonds: scores[d, h] (d, h ∈ 0..n; d = 0 pomijany). Dokładnie jedno dziecko korzenia."""
    n = scores.shape[0] - 1
    s = scores.astype(np.float64).copy()
    np.fill_diagonal(s, -np.inf)
    s[0, :] = -np.inf
    best = None
    roots = list(range(1, n + 1))
    # jedno dziecko korzenia: próbujemy kandydatów od najlepszego wyniku łuku do korzenia (do 3), wybieramy najlepsze drzewo
    cand = sorted(roots, key=lambda d: -s[d, 0])[:3]
    for r in cand:
        t = s.copy()
        t[1:, 0] = -np.inf
        t[r, :] = -np.inf
        t[r, 0] = 0.0
        heads = _cle(t)
        tot = sum(s[d, heads[d]] for d in range(1, n + 1))
        if best is None or tot > best[0]:
            best = (tot, heads)
    return best[1]


def _cle(s: np.ndarray) -> list[int]:
    n = s.shape[0]
    heads = [0] + [int(np.argmax(s[d])) for d in range(1, n)]
    while True:
        cyc = _find_cycle(heads)
        if not cyc:
            return heads
        cs = set(cyc)
        # skurcz cyklu do jednego węzła c
        rest = [v for v in range(n) if v not in cs]
        idx = {v: i for i, v in enumerate(rest)}
        c = len(rest)
        cyc_score = sum(s[v, heads[v]] for v in cyc)
        ns = np.full((c + 1, c + 1), -np.inf)
        enter: dict[int, tuple[int, int]] = {}
        leave: dict[int, int] = {}
        for d in rest:
            for h in rest:
                ns[idx[d], idx[h]] = s[d, h]
            # łuk z cyklu do d
            hb = max(cyc, key=lambda h: s[d, h])
            ns[idx[d], c] = s[d, hb]
            leave[d] = hb
        for h in rest:
            dv = max(cyc, key=lambda d: s[d, h] - s[d, heads[d]])
            ns[c, idx[h]] = s[dv, h] - s[dv, heads[dv]] + cyc_score
            enter[h] = (dv, h)
        sub = _cle(ns)
        new = list(heads)
        for d in rest:
            if d == 0:
                continue
            hh = sub[idx[d]]
            new[d] = leave[d] if hh == c else rest[hh]
        hc = rest[sub[c]]
        dv, _ = enter[hc]
        for v in cyc:
            new[v] = heads[v]
        new[dv] = hc
        return new


def _find_cycle(heads: list[int]) -> list[int] | None:
    n = len(heads)
    color = [0] * n
    for s0 in range(1, n):
        path, v = [], s0
        while v != 0 and color[v] == 0:
            color[v] = 1
            path.append(v)
            v = heads[v]
        if v != 0 and color[v] == 1:
            return path[path.index(v) :]
        for p in path:
            color[p] = 2
    return None


def predict(H: dict[str, Any], W: dict[str, np.ndarray], forms: list[str], tb: str = "pdb") -> list[dict[str, Any]]:
    """Tokeny → [{form, lemma, upos, feats, head, deprel, p}] (p = pewność łuku i etykiety)."""
    if not forms:
        return []
    X = hidden(H, W, forms, tb)
    x = X[1:]
    up = x @ W["upos_w"].T + W["upos_b"]
    feats = {}
    for k in analiza.FEATS:
        feats[k] = (x @ W[f"f_{k}_w"].T + W[f"f_{k}_b"]).argmax(1)
    lem = (x @ W["lem_w"].T + W["lem_b"]).argmax(1)
    ad = np.maximum(X @ W["ad_w"].T + W["ad_b"], 0)
    ah = np.maximum(X @ W["ah_w"].T + W["ah_b"], 0)
    S = ad @ W["arc_U"] @ ah.T + (ah @ W["arc_h"])[None, :]  # [d, h]
    S = S - S.max(1, keepdims=True)
    S = S - np.log(np.exp(S).sum(1, keepdims=True))
    heads = mst(S)
    rd = np.maximum(X @ W["rd_w"].T + W["rd_b"], 0)
    rh = np.maximum(X @ W["rh_w"].T + W["rh_b"], 0)
    one = np.ones((X.shape[0], 1), np.float32)
    rd1, rh1 = np.concatenate([rd, one], 1), np.concatenate([rh, one], 1)
    out = []
    for i in range(1, len(forms) + 1):
        h = heads[i]
        rs = np.einsum("a,lab,b->l", rd1[i], W["rel_U"], rh1[h])
        rl = H["deprels"][int(rs.argmax())]
        if h == 0:
            rl = "root"
        elif rl == "root":
            rs2 = rs.copy()
            rs2[H["deprels"].index("root")] = -np.inf
            rl = H["deprels"][int(rs2.argmax())]
        fe = {}
        for k in analiza.FEATS:
            v = H["feats"][k][int(feats[k][i - 1])]
            if v != "_":
                fe[k] = v
        upos = H["upos"][int(up[i - 1].argmax())]
        out.append(
            {
                "form": forms[i - 1],
                "lemma": apply_rule(forms[i - 1], H["lemmas"][int(lem[i - 1])]),
                "upos": upos,
                "feats": fe,
                "head": int(h),
                "deprel": rl,
                "p": round(float(np.exp(S[i, h])), 3),
            }
        )
    return out
