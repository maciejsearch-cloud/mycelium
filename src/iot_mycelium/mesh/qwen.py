"""Qwen2.5-0.5B-Instruct (Apache-2.0) w czystym PyTorch na CPU – cały model w jednym węźle.

Te same wagi co w przeglądarce (ten sam plik safetensors z Hugging Face, ta sama rewizja).
Pamięć K/V jest trzymana osobno dla każdej rozmowy, więc kolejna wypowiedź liczy tylko nowe tokeny.
"""

from __future__ import annotations

import contextlib
import json
import os
import struct
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import torch

MODEL_ID = "Qwen/Qwen2.5-0.5B-Instruct"
REV = "7ae557604adf67be50417f59c2c2f167def9a775"
URL = f"https://huggingface.co/{MODEL_ID}/resolve/{REV}/model.safetensors"
SHA256 = "fdf756fa7fcbe7404d5c60e26bff1a0c8b8aa1f72ced49e7dd0210fe288fb7fe"  # suma pliku z Hugging Face (LFS oid)
HIDDEN, INTER, LAYERS, HEADS, KV_HEADS, HEAD_DIM, VOCAB = 896, 4864, 24, 14, 2, 64, 151936
EPS, THETA = 1e-6, 1e6
EOS = (151645, 151643)
EMB_PARTS_DEFAULT = 4


def cache_dir() -> Path:
    return Path(os.environ.get("MYC_CACHE", Path.home() / ".cache" / "mycelium"))


def _weights_ok(p: Path) -> bool:
    """Plik kompletny: rozmiar = 8 + nagłówek + koniec ostatniego tensora."""
    try:
        size = p.stat().st_size
        with open(p, "rb") as f:
            n = struct.unpack("<Q", f.read(8))[0]
            if n <= 0 or n > 10_000_000 or 8 + n > size:
                return False
            header = json.loads(f.read(n))
        header.pop("__metadata__", None)
        end = max(t["data_offsets"][1] for t in header.values())
        return size == 8 + n + end
    except (OSError, ValueError, KeyError, struct.error):
        return False


def _sha_ok(p: Path, log=print) -> bool:
    """Pełna suma SHA-256 (raz; potem znacznik z rozmiarem i czasem modyfikacji pliku)."""
    import hashlib

    st = p.stat()
    mark = p.with_suffix(".sha256ok")
    tag = f"{SHA256} {st.st_size} {int(st.st_mtime)}"
    if mark.exists() and mark.read_text().strip() == tag:
        return True
    log("sprawdzam sumę SHA-256 wag…")
    h = hashlib.sha256()
    with open(p, "rb") as f:
        while chunk := f.read(8 << 20):
            h.update(chunk)
    if h.hexdigest() != SHA256:
        log("suma SHA-256 wag się nie zgadza – pobieram ponownie")
        return False
    mark.write_text(tag)
    return True


def ensure_weights(log=print, variant: str = "bf16") -> Path:
    """Pobiera plik wag (ok. 988 MB) raz: wznawianie, blokada między procesami, kontrola kompletności i SHA-256.

    ``variant="int8"`` (opt-in węzła, ``--weights int8``): najpierw mniejszy plik int8 z wydania GitHub
    (``qwen_int8``, SHA-256), a przy jakimkolwiek problemie oryginał bf16 z Hugging Face. Weryfikator i bramka
    wersji zawsze wołają z domyślnym ``bf16``."""
    if variant == "int8":
        from .qwen_int8 import ensure_int8

        q = ensure_int8(cache_dir(), log)
        if q is not None:
            return q
    elif variant != "bf16":
        raise ValueError(f"nieznany wariant wag: {variant}")
    p = cache_dir() / "qwen2.5-0.5b-instruct.safetensors"
    if p.exists() and _weights_ok(p) and _sha_ok(p, log):
        return p
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p.with_suffix(".lock"), "w") as lock:
        with contextlib.suppress(ImportError):
            import fcntl

            fcntl.flock(lock, fcntl.LOCK_EX)
        if p.exists() and _weights_ok(p) and _sha_ok(p, log):
            return p
        p.unlink(missing_ok=True)
        part = p.with_suffix(".part")
        for attempt in range(200):
            have = part.stat().st_size if part.exists() else 0
            req = urllib.request.Request(URL, headers={"Range": f"bytes={have}-"} if have else {})  # noqa: S310
            try:
                with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310
                    mode = "ab" if have and r.status == 206 else "wb"
                    with open(part, mode) as f:
                        while chunk := r.read(1 << 20):
                            f.write(chunk)
            except OSError as e:
                log(f"pobieranie przerwane ({e}), wznawiam, próba {attempt + 1}")
                time.sleep(min(30, 2 + attempt))
                continue
            if _weights_ok(part):
                break
            log(f"plik niekompletny ({part.stat().st_size} B), wznawiam, próba {attempt + 1}")
            time.sleep(2)
        else:
            raise RuntimeError("nie udało się pobrać wag")
        part.replace(p)
        if not _sha_ok(p, log):
            p.unlink(missing_ok=True)
            raise RuntimeError("pobrane wagi mają złą sumę SHA-256")
    return p


def weights_variant(path: Path) -> str:
    """„int8” dla pliku z qwen_int8 (metadane format), inaczej „bf16”."""
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        meta = json.loads(f.read(n)).get("__metadata__") or {}
    return "int8" if str(meta.get("format", "")).startswith("mycelium-int8") else "bf16"


def load_safetensors(path: Path, dtype=torch.float32) -> dict[str, torch.Tensor]:
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))
    if (header.get("__metadata__") or {}).get("format", "").startswith("mycelium-int8"):
        from .qwen_int8 import load_dequant

        return load_dequant(path, dtype)
    header.pop("__metadata__", None)
    raw = torch.from_file(str(path), shared=False, size=os.path.getsize(path), dtype=torch.uint8)
    out = {}
    for k, t in header.items():
        a, b = t["data_offsets"]
        assert t["dtype"] == "BF16", t["dtype"]
        out[k] = raw[8 + n + a : 8 + n + b].view(torch.bfloat16).reshape(t["shape"]).to(dtype)
    return out


@dataclass
class Session:
    """Pamięć K/V jednej rozmowy (na tym węźle) i tokeny, które już przez nią przeszły."""

    tokens: list[int] = field(default_factory=list)
    k: list[torch.Tensor] = field(default_factory=list)
    v: list[torch.Tensor] = field(default_factory=list)
    at: float = field(default_factory=time.time)


class Qwen:
    def __init__(self, path: Path, dtype=torch.float32):
        w = load_safetensors(path, dtype)
        self.dtype = dtype
        self.weights = weights_variant(path)  # "bf16" (oryginał HF) albo "int8" (qwen_int8, opt-in)
        self.emb = w["model.embed_tokens.weight"]
        self.norm = w["model.norm.weight"]
        self.L = []
        for i in range(LAYERS):
            p = f"model.layers.{i}."

            def g(n, p=p, w=w):
                return w[p + n]

            qkv_w = torch.cat(
                [g("self_attn.q_proj.weight"), g("self_attn.k_proj.weight"), g("self_attn.v_proj.weight")]
            )
            qkv_b = torch.cat([g("self_attn.q_proj.bias"), g("self_attn.k_proj.bias"), g("self_attn.v_proj.bias")])
            gu = torch.cat([g("mlp.gate_proj.weight"), g("mlp.up_proj.weight")])
            self.L.append(
                {
                    "ln1": g("input_layernorm.weight"),
                    "ln2": g("post_attention_layernorm.weight"),
                    "qkv_w": qkv_w.t().contiguous(),
                    "qkv_b": qkv_b,
                    "o": g("self_attn.o_proj.weight").t().contiguous(),
                    "gu": gu.t().contiguous(),
                    "down": g("mlp.down_proj.weight").t().contiguous(),
                }
            )
        del w
        inv = 1.0 / (THETA ** (torch.arange(0, HEAD_DIM, 2, dtype=torch.float32) / HEAD_DIM))
        ang = torch.outer(torch.arange(32768, dtype=torch.float32), inv)
        self.cos, self.sin = ang.cos().to(dtype), ang.sin().to(dtype)
        self.sessions: dict[str, Session] = {}
        # adapter LoRA modelu językowego grzybni (lm.runtime) albo None = model bazowy; wersja do ogłoszenia w sieci
        self.lora: dict | None = None
        self.lora_version: int | None = None

    @staticmethod
    def _rms(x, w):
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + EPS) * w

    def _rope(self, x, p0):  # x: T×H×D
        T = x.shape[0]
        c, s = self.cos[p0 : p0 + T, None, :], self.sin[p0 : p0 + T, None, :]
        a, b = x[..., : HEAD_DIM // 2], x[..., HEAD_DIM // 2 :]
        return torch.cat([a * c - b * s, b * c + a * s], -1)

    @torch.inference_mode()
    def layers(
        self, h: torch.Tensor, sess: Session, lo: int = 0, hi: int = LAYERS, p0: int | None = None
    ) -> torch.Tensor:
        """Warstwy lo..hi-1 dla T nowych stanów ukrytych h (T×896); K/V sesji indeksowane od lo."""
        p0 = len(sess.tokens) if p0 is None else p0
        T = h.shape[0]
        qd, kd = HEADS * HEAD_DIM, KV_HEADS * HEAD_DIM
        mask = torch.ones(T, p0 + T, dtype=torch.bool).tril(p0) if T > 1 else None
        for li in range(lo, hi):
            L, j = self.L[li], li - lo
            n = self._rms(h, L["ln1"])
            qkv = n @ L["qkv_w"] + L["qkv_b"]
            if lo_ := self.lora:
                qkv = qkv + ((n.float() @ lo_["a_qkv"][li]) @ lo_["b_qkv"][li]).to(self.dtype)
            q = self._rope(qkv[:, :qd].view(T, HEADS, HEAD_DIM), p0)
            k = self._rope(qkv[:, qd : qd + kd].view(T, KV_HEADS, HEAD_DIM), p0)
            v = qkv[:, qd + kd :].view(T, KV_HEADS, HEAD_DIM)
            if j < len(sess.k):
                sess.k[j] = torch.cat([sess.k[j][:p0], k])
                sess.v[j] = torch.cat([sess.v[j][:p0], v])
            else:
                sess.k.append(k)
                sess.v.append(v)
            K = sess.k[j].transpose(0, 1).repeat_interleave(HEADS // KV_HEADS, 0)  # H×P×D
            V = sess.v[j].transpose(0, 1).repeat_interleave(HEADS // KV_HEADS, 0)
            a = torch.nn.functional.scaled_dot_product_attention(q.transpose(0, 1), K, V, attn_mask=mask)
            a = a.transpose(0, 1).reshape(T, qd)
            o = a @ L["o"]
            if lo_:
                o = o + ((a.float() @ lo_["a_o"][li]) @ lo_["b_o"][li]).to(self.dtype)
            h = h + o
            n = self._rms(h, L["ln2"])
            gu = n @ L["gu"]
            h = h + (torch.nn.functional.silu(gu[:, :INTER]) * gu[:, INTER:]) @ L["down"]
        sess.at = time.time()
        return h

    @torch.inference_mode()
    def forward(self, ids: list[int], sess: Session) -> torch.Tensor:
        """Przepuszcza nowe tokeny przez cały model, dopisuje K/V do sesji, zwraca logity ostatniego tokenu."""
        h = self.layers(self.emb[torch.tensor(ids)], sess)
        sess.tokens.extend(ids)
        last = self._rms(h[-1:], self.norm)
        return (last @ self.emb.t())[0].float()

    def session(self, conv: str, prompt: list[int]) -> tuple[Session, list[int]]:
        """Sesja rozmowy z pamięcią K/V: zwraca tokeny jeszcze nieliczone (wspólny początek jest pomijany)."""
        s = self.sessions.get(conv)
        if s is None:
            s = self.sessions[conv] = Session()
            while len(self.sessions) > 8:
                del self.sessions[min(self.sessions, key=lambda c: self.sessions[c].at)]
        n = 0
        while n < min(len(s.tokens), len(prompt) - 1) and s.tokens[n] == prompt[n]:
            n += 1
        if n < len(s.tokens):
            s.tokens = s.tokens[:n]
            s.k = [k[:n] for k in s.k]
            s.v = [v[:n] for v in s.v]
        return s, prompt[n:]

    def generate(self, conv, prompt, max_new=200, temp=0.4, top_p=0.9, on_token=None, stop=None) -> dict:
        t0 = time.perf_counter()
        s, rest = self.session(conv, prompt)
        reused = len(prompt) - len(rest)
        logits = self.forward(rest, s)
        out: list[int] = []
        nx = sample(logits, prompt[-48:], temp, top_p)
        first_ms = (time.perf_counter() - t0) * 1000
        t1 = time.perf_counter()
        while nx not in EOS and len(out) < max_new:
            out.append(nx)
            if on_token:
                on_token(nx)
            if stop and stop():
                break
            logits = self.forward([nx], s)
            nx = sample(logits, (prompt + out)[-48:], temp, top_p)
        dt = time.perf_counter() - t1
        tps = len(out) / dt if out and dt > 0 else 0.0
        return {"tokens": out, "first_ms": first_ms, "tps": tps, "prompt": len(prompt), "reused": reused}


def sample(logits: torch.Tensor, recent: list[int], temp: float, top_p: float) -> int:
    z = logits.clone()
    if recent:
        r = torch.tensor(sorted(set(recent)))
        z[r] = torch.where(z[r] > 0, z[r] / 1.1, z[r] * 1.1)
    if temp <= 0:
        return int(z.argmax())
    top = torch.topk(z, 40)
    p = torch.softmax(top.values / temp, -1)
    keep = int((p.cumsum(-1) < top_p).sum()) + 1
    p = p[:keep] / p[:keep].sum()
    return int(top.indices[torch.multinomial(p, 1)])
