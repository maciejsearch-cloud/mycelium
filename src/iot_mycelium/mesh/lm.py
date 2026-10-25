"""Model językowy grzybni: adapter LoRA dla Qwen2.5-0.5B, trenowany federacyjnie na węzłach.

Każdy węzeł trzyma zamrożone wagi bazowe (bf16) i mały adapter (rank 4 na projekcjach uwagi qkv i o, 24 warstwy,
368 640 parametrów, ok. 0,7 MB w fp16). Runda: węzły trenują adapter z bieżącej wersji na różnych odłamkach danych
(polska Wikipedia CC BY-SA 4.0: akapity + pytania „Co to jest…?” z pierwszych zdań haseł), agregator uśrednia
adaptery (FedAvg ważony liczbą tokenów), liczy stały odłożony zbiór (perpleksja + test wyboru definicji)
i zgłasza kandydata. Wersja powstaje dopiero po niezależnej ponownej ocenie i bez regresji (bramka w bazie).

Format odłamka i zbioru testowego (.bin): b"MYCLM1\\0\\0" + u32 długość nagłówka JSON + JSON + dane.
"""

from __future__ import annotations

import hashlib
import json
import math
import struct
import time
from dataclasses import dataclass

import torch
import torch.nn.functional as F

from .qwen import HEAD_DIM, HEADS, HIDDEN, INTER, KV_HEADS, LAYERS, Qwen

RANK = 4
ALPHA = 8.0
SCALE = ALPHA / RANK
QKV_OUT = (HEADS + 2 * KV_HEADS) * HEAD_DIM  # 1152
N_PARAMS = LAYERS * RANK * (HIDDEN + QKV_OUT + HIDDEN + HIDDEN)
MAGIC_ADAPTER = b"MYCLORA1"
MAGIC_DATA = b"MYCLM1\0\0"
MAGIC_KD = b"MYCKD1\0\0"
# destylacja: strata = (1 − α)·CE + α·T²·KL(nauczyciel_T ‖ uczeń_T) na top-k logitach nauczyciela
# 25.10.2026: T=2, α=0,5 dawało kandydatów gorszych od v1 (ppl 73,15 / 37,39 przy 32,82) → słabsza domieszka KL
KD_T, KD_ALPHA = 1.0, 0.15
# koszt jednego tokenu treningu (przód + tył przez zamrożony model ≈ 3× przód 2·N) i oceny (przód)
FLOPS_TRAIN_TOKEN = 6 * 494e6
FLOPS_EVAL_TOKEN = 2 * 494e6


# ---------------------------------------------------------------- adapter
@dataclass
class Lora:
    a_qkv: torch.Tensor  # L×896×r
    b_qkv: torch.Tensor  # L×r×1152
    a_o: torch.Tensor  # L×896×r
    b_o: torch.Tensor  # L×r×896

    NAMES = ("a_qkv", "b_qkv", "a_o", "b_o")

    @classmethod
    def init(cls, seed: int = 0) -> Lora:
        """Wersja 0: A losowe (stałe ziarno, ten sam adapter na każdym węźle), B = 0 → model identyczny z bazowym."""
        g = torch.Generator().manual_seed(seed)
        std = 1.0 / math.sqrt(HIDDEN)
        return cls(
            torch.randn(LAYERS, HIDDEN, RANK, generator=g) * std,
            torch.zeros(LAYERS, RANK, QKV_OUT),
            torch.randn(LAYERS, HIDDEN, RANK, generator=g) * std,
            torch.zeros(LAYERS, RANK, HIDDEN),
        )

    def tensors(self) -> list[torch.Tensor]:
        return [getattr(self, n) for n in self.NAMES]

    def to_bytes(self, meta: dict | None = None) -> bytes:
        h = json.dumps({"rank": RANK, "alpha": ALPHA, "layers": LAYERS, "dtype": "f16", **(meta or {})}).encode()
        body = b"".join(tobytes(t.to(torch.float16)) for t in self.tensors())
        return MAGIC_ADAPTER + struct.pack("<I", len(h)) + h + body

    @classmethod
    def from_bytes(cls, b: bytes) -> Lora:
        if b[:8] != MAGIC_ADAPTER:
            raise ValueError("to nie jest adapter grzybni")
        n = struct.unpack_from("<I", b, 8)[0]
        h = json.loads(b[12 : 12 + n])
        if h.get("rank") != RANK or h.get("layers") != LAYERS:
            raise ValueError("niezgodny kształt adaptera")
        raw = torch.frombuffer(bytearray(b[12 + n :]), dtype=torch.float16).float()
        shapes = [(LAYERS, HIDDEN, RANK), (LAYERS, RANK, QKV_OUT), (LAYERS, HIDDEN, RANK), (LAYERS, RANK, HIDDEN)]
        out, i = [], 0
        for s in shapes:
            k = math.prod(s)
            out.append(raw[i : i + k].view(s).clone())
            i += k
        if i != raw.numel():
            raise ValueError("zły rozmiar adaptera")
        return cls(*out)

    @staticmethod
    def average(items: list[tuple[Lora, float]]) -> Lora:
        tot = sum(w for _, w in items)
        return Lora(*[sum(getattr(x, n) * (w / tot) for x, w in items) for n in Lora.NAMES])

    def finite(self) -> bool:
        return all(bool(torch.isfinite(t).all()) for t in self.tensors())

    def roundtrip(self) -> Lora:
        """Ta sama precyzja co po zapisie (fp16) – ocena agregatora = ocena weryfikatorów."""
        return Lora.from_bytes(self.to_bytes())


def tobytes(t: torch.Tensor) -> bytes:
    """Surowe bajty tensora bez numpy (koło PyTorch CPU nie zawiera numpy)."""
    import ctypes

    t = t.contiguous()
    return ctypes.string_at(t.data_ptr(), t.numel() * t.element_size())


def runtime(lora: Lora, dtype) -> dict:
    """Adapter do czatu (Qwen.layers): f32 jak w treningu, B już przeskalowane (dtype: typ modelu bazowego)."""
    del dtype
    return {"a_qkv": lora.a_qkv, "b_qkv": lora.b_qkv * SCALE, "a_o": lora.a_o, "b_o": lora.b_o * SCALE}


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ---------------------------------------------------------------- dane
def pack_data(meta: dict, ids: torch.Tensor, mask: torch.Tensor, extra: bytes = b"") -> bytes:
    """ids: N×T int32, mask: N×T uint8 (1 = token liczony w stracie)."""
    meta = {**meta, "n": int(ids.shape[0]), "t": int(ids.shape[1])}
    h = json.dumps(meta, ensure_ascii=False).encode()
    return (
        MAGIC_DATA
        + struct.pack("<I", len(h))
        + h
        + tobytes(ids.to(torch.int32))
        + tobytes(mask.to(torch.uint8))
        + extra
    )


def unpack_data(b: bytes) -> tuple[dict, torch.Tensor, torch.Tensor, bytes]:
    if b[:8] != MAGIC_DATA:
        raise ValueError("zły plik danych")
    n = struct.unpack_from("<I", b, 8)[0]
    meta = json.loads(b[12 : 12 + n])
    N, T = meta["n"], meta["t"]
    o = 12 + n
    ids = torch.frombuffer(bytearray(b[o : o + 4 * N * T]), dtype=torch.int32).view(N, T).long()
    o += 4 * N * T
    mask = torch.frombuffer(bytearray(b[o : o + N * T]), dtype=torch.uint8).view(N, T).bool()
    o += N * T
    return meta, ids, mask, b[o:]


# ---------------------------------------------------------------- destylacja (logity nauczyciela, tylko dane)
def pack_kd(meta: dict, idx: torch.Tensor, logits: torch.Tensor) -> bytes:
    """Top-k logitów nauczyciela dla kolejnych liczonych pozycji odłamka (kolejność = mask[:,1:] wierszami).

    idx: P×k int32 (identyfikatory tokenów, wspólny tokenizer Qwen2.5), logits: P×k fp16 (surowe logity, T=1)."""
    meta = {**meta, "p": int(idx.shape[0]), "k": int(idx.shape[1])}
    h = json.dumps(meta, ensure_ascii=False).encode()
    return MAGIC_KD + struct.pack("<I", len(h)) + h + tobytes(idx.to(torch.int32)) + tobytes(logits.to(torch.float16))


def unpack_kd(b: bytes) -> tuple[dict, torch.Tensor, torch.Tensor]:
    if b[:8] != MAGIC_KD:
        raise ValueError("zły plik destylacji")
    n = struct.unpack_from("<I", b, 8)[0]
    meta = json.loads(b[12 : 12 + n])
    P, k = int(meta["p"]), int(meta["k"])
    o = 12 + n
    if len(b) != o + 6 * P * k:
        raise ValueError("zły rozmiar pliku destylacji")
    idx = torch.frombuffer(bytearray(b[o : o + 4 * P * k]), dtype=torch.int32).view(P, k).long()
    lg = torch.frombuffer(bytearray(b[o + 4 * P * k :]), dtype=torch.float16).view(P, k).float()
    return meta, idx, lg


def kd_offsets(mask: torch.Tensor) -> torch.Tensor:
    """Początek wierszy pliku destylacji dla każdej sekwencji (N+1)."""
    c = mask[:, 1:].sum(1)
    return torch.cat([torch.zeros(1, dtype=torch.long), c.cumsum(0)])


# ---------------------------------------------------------------- model z adapterem (przód z gradientem)
def _rope(m: Qwen, x: torch.Tensor) -> torch.Tensor:  # B×T×H×D, pozycje 0..T-1
    T = x.shape[1]
    c, s = m.cos[None, :T, None, :], m.sin[None, :T, None, :]
    a, b = x[..., : HEAD_DIM // 2], x[..., HEAD_DIM // 2 :]
    return torch.cat([a * c - b * s, b * c + a * s], -1)


def hidden(m: Qwen, lora: Lora | None, ids: torch.Tensor) -> torch.Tensor:
    """Stany ukryte po ostatniej normie dla wsadu ids (B×T) – z autogradem względem adaptera (wagi bazowe zamrożone)."""
    B, T = ids.shape
    qd, kd = HEADS * HEAD_DIM, KV_HEADS * HEAD_DIM
    dt = m.dtype
    h = m.emb[ids]
    for li in range(len(m.L)):  # len(m.L) < LAYERS tylko w teście szybkości GPU (gpu.py)
        L = m.L[li]
        n = Qwen._rms(h, L["ln1"])
        qkv = n @ L["qkv_w"] + L["qkv_b"]
        if lora is not None:
            qkv = qkv + ((n.float() @ lora.a_qkv[li]) @ lora.b_qkv[li] * SCALE).to(dt)
        q = _rope(m, qkv[..., :qd].view(B, T, HEADS, HEAD_DIM)).transpose(1, 2)
        k = _rope(m, qkv[..., qd : qd + kd].view(B, T, KV_HEADS, HEAD_DIM)).transpose(1, 2)
        v = qkv[..., qd + kd :].view(B, T, KV_HEADS, HEAD_DIM).transpose(1, 2)
        k = k.repeat_interleave(HEADS // KV_HEADS, 1)
        v = v.repeat_interleave(HEADS // KV_HEADS, 1)
        a = F.scaled_dot_product_attention(q, k, v, is_causal=True).transpose(1, 2).reshape(B, T, qd)
        o = a @ L["o"]
        if lora is not None:
            o = o + ((a.float() @ lora.a_o[li]) @ lora.b_o[li] * SCALE).to(dt)
        h = h + o
        n = Qwen._rms(h, L["ln2"])
        gu = n @ L["gu"]
        h = h + (F.silu(gu[..., :INTER]) * gu[..., INTER:]) @ L["down"]
    return Qwen._rms(h, m.norm)


def token_nll(
    m: Qwen, lora: Lora | None, ids: torch.Tensor, mask: torch.Tensor, chunk: int = 256, kd=None
) -> torch.Tensor:
    """Wektor NLL (f32) dla tokenów ids[:,1:] wskazanych przez mask[:,1:]; logity liczone porcjami (mało RAM).

    kd = (idx P×k, logity P×k, T, α) wyrównane z liczonymi pozycjami → strata mieszana CE/KL zamiast czystego NLL."""
    h = hidden(m, lora, ids)
    sel = mask[:, 1:]
    x = h[:, :-1][sel]
    y = ids[:, 1:][sel]
    if kd is not None and kd[0].shape[0] != x.shape[0]:
        raise ValueError("plik destylacji nie pasuje do odłamka")
    out = []
    for i in range(0, x.shape[0], chunk):
        xi, yi = x[i : i + chunk], y[i : i + chunk]
        if kd is None:
            fn, args = _ce, (xi, yi, m.emb)
        else:
            fn, args = _ce_kd, (xi, yi, m.emb, kd[0][i : i + chunk], kd[1][i : i + chunk], kd[2], kd[3])
        if torch.is_grad_enabled():
            out.append(torch.utils.checkpoint.checkpoint(fn, *args, use_reentrant=False))
        else:
            out.append(fn(*args))
    return torch.cat(out) if out else torch.zeros(0)


def _ce(x, y, emb):
    return F.cross_entropy((x @ emb.t()).float(), y, reduction="none")


def _ce_kd(x, y, emb, t_idx, t_logit, T: float, alpha: float):
    z = (x @ emb.t()).float()
    ce = F.cross_entropy(z, y, reduction="none")
    s_logp = F.log_softmax(z / T, -1).gather(1, t_idx)  # uczeń na tokenach top-k nauczyciela
    t_logp = F.log_softmax(t_logit / T, -1)  # nauczyciel renormalizowany na top-k
    kl = (t_logp.exp() * (t_logp - s_logp)).sum(-1)
    return (1 - alpha) * ce + alpha * T * T * kl


# ---------------------------------------------------------------- trening lokalny
class Trainer:
    """Trening adaptera od wersji globalnej krok po kroku (węzeł oddaje CPU czatowi między krokami).

    AdamW, kolejność próbek z ziarna zadania (powtarzalne), przycinanie gradientu do 1.0.
    micro: ile sekwencji naraz w przejściu wstecz (mniej RAM; gradient sumowany, ta sama funkcja straty co dla całej paczki)."""

    def __init__(
        self,
        m: Qwen,
        base: Lora,
        ids,
        mask,
        batch: int,
        lr: float,
        seed: int,
        micro: int | None = None,
        kd=None,
        device=None,
    ):
        """kd = (idx, logity, T, α) dla całego odłamka (z unpack_kd) – destylacja; None = sama entropia krzyżowa.

        device: urządzenie modelu m (np. DirectML z gpu.py); dane i adapter przenoszone tam, wynik wraca na CPU."""
        self.m, self.ids, self.mask, self.batch = m, ids, mask, batch
        self.dev = device
        self.kd = kd
        self.kd_off = kd_offsets(mask) if kd is not None else None
        if kd is not None and int(self.kd_off[-1]) != kd[0].shape[0]:
            raise ValueError("plik destylacji nie pasuje do odłamka")
        self.micro = max(1, min(batch, micro or batch))
        to = (lambda t: t.to(device)) if device is not None else (lambda t: t)
        self._to = to
        self.lora = Lora(*[to(t.clone()).requires_grad_(True) for t in base.tensors()])
        # foreach=False: prostsze operacje (DirectML nie ma wszystkich wariantów „foreach”); na CPU bez zmian
        self.opt = torch.optim.AdamW(
            self.lora.tensors(), lr=lr, weight_decay=0.0, **({"foreach": False} if device is not None else {})
        )
        self.order = torch.randperm(ids.shape[0], generator=torch.Generator().manual_seed(seed))
        self.losses: list[float] = []
        self.skipped = 0
        self.tokens = 0
        self.t0 = time.perf_counter()

    def step(self) -> float:
        s, B, n = len(self.losses), self.batch, len(self.order)
        idx = self.order[(s * B) % n : (s * B) % n + B]
        if len(idx) < B:
            idx = torch.cat([idx, self.order[: B - len(idx)]])
        self.opt.zero_grad()
        n_tok = int(self.mask[idx][:, 1:].sum())
        tot = 0.0
        for j in range(0, B, self.micro):
            k = idx[j : j + self.micro]
            kd = None
            if self.kd is not None:
                rows = torch.cat([torch.arange(int(self.kd_off[i]), int(self.kd_off[i + 1])) for i in k.tolist()])
                kd = (self._to(self.kd[0][rows]), self._to(self.kd[1][rows]), self.kd[2], self.kd[3])
            part = token_nll(self.m, self.lora, self._to(self.ids[k]), self._to(self.mask[k]), kd=kd).sum() / max(
                1, n_tok
            )
            part.backward()
            tot += float(part.detach())
        finite = math.isfinite(tot) and all(
            t.grad is None or bool(torch.isfinite(t.grad).all()) for t in self.lora.tensors()
        )
        if finite:
            torch.nn.utils.clip_grad_norm_(self.lora.tensors(), 1.0, foreach=False if self.dev is not None else None)
            self.opt.step()
        else:  # nieskończona strata/gradient (zaobserwowane przy destylacji) – krok pominięty, adapter bez zmian
            self.skipped += 1
            self.opt.zero_grad()
        self.losses.append(tot)
        self.tokens += int(self.ids[idx].numel())
        return self.losses[-1]

    def result(self) -> tuple[Lora, dict]:
        ls = [x for x in self.losses if math.isfinite(x)] or [float("nan")]
        return Lora(*[t.detach().cpu().clone() for t in self.lora.tensors()]), {
            "skipped": self.skipped,
            "loss_first": round(ls[0], 5),
            "loss_last": round(ls[-1], 5),
            "loss_mean": round(sum(ls) / len(ls), 5),
            "tokens": self.tokens,
            "steps": len(ls),
            "s": round(time.perf_counter() - self.t0, 2),
        }


def train(m: Qwen, base: Lora, ids, mask, steps: int, batch: int, lr: float, seed: int, log=None):
    tr = Trainer(m, base, ids, mask, batch, lr, seed)
    for s in range(steps):
        x = tr.step()
        if log:
            log(f"krok {s + 1}/{steps}: strata {x:.4f}")
    return tr.result()


@torch.no_grad()
def mean_nll(m: Qwen, lora: Lora | None, ids, mask, batch: int = 8) -> float:
    tot, n = 0.0, 0
    for i in range(0, ids.shape[0], batch):
        v = token_nll(m, lora, ids[i : i + batch], mask[i : i + batch])
        tot += float(v.double().sum())
        n += v.numel()
    return tot / max(1, n)


# ---------------------------------------------------------------- ocena (stały zbiór)
def evaluate(
    m: Qwen, lora: Lora | None, eval_bytes: bytes, batch: int = 16, shard: tuple[int, int] | None = None
) -> dict:
    """Perpleksja na odłożonych akapitach + trafność wyboru poprawnej definicji (1 z 4) na odłożonych hasłach."""
    it = evaluate_iter(m, lora, eval_bytes, batch, shard)
    while True:
        try:
            next(it)
        except StopIteration as e:
            return e.value


def _trim(ids: torch.Tensor, mask: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    """Obcina dopełnienie za ostatnim liczonym tokenem wsadu (uwaga przyczynowa → wynik ten sam, mniej obliczeń)."""
    cols = mask.any(0).nonzero()
    end = int(cols.max()) + 1 if cols.numel() else 1
    return ids[:, :end], mask[:, :end]


@torch.no_grad()
def evaluate_iter(m: Qwen, lora: Lora | None, eval_bytes: bytes, batch: int = 16, shard: tuple[int, int] | None = None):
    """Jak evaluate, ale jako generator: oddaje sterowanie po każdym wsadzie, wynik w StopIteration.value.

    shard=(i, k): tylko pytania o numerach ≡ i (mod k), a akapity perpleksji tylko w odłamku 0 – wyniki częściowe
    (nll_sum, nll_n, correct, n_part) sumuje combine(); bez shard = pełna ocena.
    """
    meta, ids, mask, extra = unpack_data(eval_bytes)
    n_ppl = meta["n_ppl"]
    si, sk = shard or (0, 1)
    nll_sum, nll_n, pos = 0.0, 0, 0
    for i in range(0, n_ppl if si == 0 else 0, batch):
        pos += int(ids[i : min(n_ppl, i + batch)].numel())
        v = token_nll(m, lora, ids[i : min(n_ppl, i + batch)], mask[i : min(n_ppl, i + batch)])
        nll_sum += float(v.double().sum())
        nll_n += v.numel()
        yield
    # pytania wyboru: każda opcja to osobny wiersz; maska = tokeny odpowiedzi; wynik = średni logprob odpowiedzi
    mc = json.loads(extra.decode())  # [[wiersz_opcji_0..3], poprawna]
    part = [q for k, q in enumerate(mc) if k % sk == si]
    rows = sorted((r for opts, _ in part for r in opts), key=lambda r: int(mask[r].nonzero().max()))
    score: dict[int, float] = {}
    for i in range(0, len(rows), batch):
        r = rows[i : i + batch]
        sub_ids, sub_mask = _trim(ids[r], mask[r])
        pos += int(sub_ids.numel())
        h = hidden(m, lora, sub_ids)
        for j, row in enumerate(r):
            sel = sub_mask[j, 1:]
            x = h[j, :-1][sel]
            y = sub_ids[j, 1:][sel]
            score[row] = -float(_ce(x, y, m.emb).mean())
        yield
    correct = sum(1 for opts, ans in part if max(range(len(opts)), key=lambda k: score[opts[k]]) == ans)
    out = {
        "nll_sum": nll_sum,
        "nll_n": nll_n,
        "correct": correct,
        "n_part": len(part),
        "n": len(mc),
        "eval_sha": sha256(eval_bytes),
        "shard": [si, sk],
        "positions": pos,
    }
    return combine([out]) if sk == 1 else out


def combine(parts: list[dict]) -> dict:
    """Składa wyniki odłamków oceny (ten sam plik, wszystkie odłamki 0..k-1) w pełny wynik."""
    sk = parts[0]["shard"][1]
    if sorted(p["shard"][0] for p in parts) != list(range(sk)) or len({p["eval_sha"] for p in parts}) != 1:
        raise ValueError("niepełny albo niespójny zestaw odłamków oceny")
    nll_sum = sum(p["nll_sum"] for p in parts)
    nll_n = sum(p["nll_n"] for p in parts)
    correct = sum(p["correct"] for p in parts)
    n = parts[0]["n"]
    if sum(p["n_part"] for p in parts) != n:
        raise ValueError("odłamki nie pokrywają wszystkich pytań")
    return {
        "ppl": round(math.exp(nll_sum / max(1, nll_n)), 4),
        "acc": round(correct / n, 6),
        "correct": correct,
        "n": n,
        "ppl_tokens": nll_n,
        "eval_sha": parts[0]["eval_sha"],
        "positions": sum(p["positions"] for p in parts),
    }
