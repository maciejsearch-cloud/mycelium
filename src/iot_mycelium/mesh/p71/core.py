"""Rdzeń: secp256k1, hash160, adresy Base58Check i skan zakresu (C przez ctypes albo czysty Python).

Szybka ścieżka: p71core.c kompilowany lokalnie (`python -m iot_mycelium.mesh.p71.core build`) do pamięci podręcznej
węzła. Gdy nie ma kompilatora/biblioteki, działa wolniejszy, ale ten sam algorytm w czystym Pythonie
(dodawanie punktów afinicznych z jedną odwrotnością na paczkę). Wynik obu ścieżek jest bitowo taki sam (testy).
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
BATCH = 1024
SRC = Path(__file__).with_name("p71core.c")


# ------------------------------------------------------------------ adresy
def b58decode_check(addr: str) -> bytes:
    n = 0
    for ch in addr:
        n = n * 58 + B58.index(ch)
    raw = n.to_bytes(25, "big")
    if hashlib.sha256(hashlib.sha256(raw[:21]).digest()).digest()[:4] != raw[21:]:
        raise ValueError("zła suma kontrolna adresu")
    return raw


def address_h160(addr: str) -> bytes:
    raw = b58decode_check(addr)
    if raw[0] != 0:
        raise ValueError("to nie jest adres P2PKH (1…)")
    return raw[1:21]


def h160_address(h: bytes) -> str:
    raw = b"\x00" + h
    raw += hashlib.sha256(hashlib.sha256(raw).digest()).digest()[:4]
    n = int.from_bytes(raw, "big")
    s = ""
    while n:
        n, r = divmod(n, 58)
        s = B58[r] + s
    return "1" * (len(raw) - len(raw.lstrip(b"\x00"))) + s


# ------------------------------------------------------------------ RIPEMD-160 (zapas, gdy OpenSSL go nie ma)
def _rmd160_py(msg: bytes) -> bytes:
    rl = [*range(16), 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12,
          1, 9, 11, 10, 0, 8, 12, 4, 13, 3, 7, 15, 14, 5, 6, 2, 4, 0, 5, 9, 7, 12, 2, 10, 14, 1, 3, 8, 11, 6, 15, 13]  # fmt: skip
    rr = [5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8, 12, 4, 9, 1, 2,
          15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11, 15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
          12, 15, 10, 4, 1, 5, 8, 7, 6, 2, 13, 14, 0, 3, 9, 11]  # fmt: skip
    sl = [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12, 15, 9, 11, 7, 13, 12,
          11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14, 15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
          9, 15, 5, 11, 6, 8, 13, 12, 5, 12, 13, 14, 11, 8, 5, 6]  # fmt: skip
    sr = [8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7, 12, 7, 6, 15, 13, 11,
          9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11, 14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
          8, 5, 12, 9, 12, 5, 14, 6, 8, 13, 6, 5, 15, 13, 11, 11]  # fmt: skip
    kl, kr = [0, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E], [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0]
    m32 = 0xFFFFFFFF

    def rol(x, n):
        return ((x << n) | (x >> (32 - n))) & m32

    def f(j, x, y, z):
        return [x ^ y ^ z, (x & y) | (~x & z), (x | ~y) ^ z, (x & z) | (y & ~z), x ^ (y | ~z)][j >> 4] & m32

    h = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]
    data = msg + b"\x80" + b"\x00" * ((55 - len(msg)) % 64) + (len(msg) * 8).to_bytes(8, "little")
    for o in range(0, len(data), 64):
        x = [int.from_bytes(data[o + 4 * i : o + 4 * i + 4], "little") for i in range(16)]
        al, bl, cl, dl, el = h
        ar, br, cr, dr, er = h
        for j in range(80):
            t = (rol((al + f(j, bl, cl, dl) + x[rl[j]] + kl[j >> 4]) & m32, sl[j]) + el) & m32
            al, el, dl, cl, bl = el, dl, rol(cl, 10), bl, t
            t = (rol((ar + f(79 - j, br, cr, dr) + x[rr[j]] + kr[j >> 4]) & m32, sr[j]) + er) & m32
            ar, er, dr, cr, br = er, dr, rol(cr, 10), br, t
        t = (h[1] + cl + dr) & m32
        h[1], h[2], h[3], h[4], h[0] = (
            (h[2] + dl + er) & m32,
            (h[3] + el + ar) & m32,
            (h[4] + al + br) & m32,
            (h[0] + bl + cr) & m32,
            t,
        )
    return b"".join(v.to_bytes(4, "little") for v in h)


try:
    hashlib.new("ripemd160", b"")

    def rmd160(b: bytes) -> bytes:
        return hashlib.new("ripemd160", b).digest()

    RMD_BACKEND = "openssl"
except ValueError:  # OpenSSL 3 bez dostawcy „legacy”
    rmd160 = _rmd160_py
    RMD_BACKEND = "python"


# ------------------------------------------------------------------ secp256k1 (Python, wzorzec do testów i zapas)
def _inv(a: int) -> int:
    return pow(a, P - 2, P)


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None
        lam = 3 * x1 * x1 * _inv(2 * y1) % P
    else:
        lam = (y2 - y1) * _inv(x2 - x1) % P
    x3 = (lam * lam - x1 - x2) % P
    return x3, (lam * (x1 - x3) - y1) % P


def point_mul(k: int, pt=(GX, GY)):
    r = None
    while k:
        if k & 1:
            r = _add(r, pt)
        pt = _add(pt, pt)
        k >>= 1
    return r


def compressed(pt) -> bytes:
    return bytes([2 | (pt[1] & 1)]) + pt[0].to_bytes(32, "big")


def h160_of_point(pt) -> bytes:
    return rmd160(hashlib.sha256(compressed(pt)).digest())


def h160_of_key(k: int) -> bytes:
    if not 1 <= k < N:
        raise ValueError("klucz poza zakresem")
    return h160_of_point(point_mul(k))


def address_of_key(k: int) -> str:
    return h160_address(h160_of_key(k))


def scan_py(start: int, n: int, target: bytes) -> tuple[int | None, bytes]:
    """Czysty Python: ten sam algorytm co C (P, P+G, …; jedna odwrotność na paczkę). Zwraca (klucz albo None, XOR hash160)."""
    if start <= BATCH + 1:
        raise ValueError("start musi być > BATCH+1")
    table = [None, (GX, GY)]
    for _ in range(2, BATCH + 1):
        table.append(_add(table[-1], (GX, GY)))
    px, py = point_mul(start)
    k, done, hit, acc = start, 0, None, 0
    sha = hashlib.sha256
    while done < n:
        m = min(n - done, BATCH)
        dx = [0] + [(table[j][0] - px) % P for j in range(1, BATCH + 1)]
        pre = [0, dx[1]]
        for j in range(2, BATCH + 1):
            pre.append(pre[-1] * dx[j] % P)
        inv = pow(pre[BATCH], P - 2, P)
        idx = [0] * (BATCH + 1)
        for j in range(BATCH, 0, -1):
            idx[j] = inv * pre[j - 1] % P if j > 1 else inv
            inv = inv * dx[j] % P
        for j in range(m):
            if j == 0:
                qx, qy = px, py
            else:
                tx, ty = table[j]
                lam = (ty - py) * idx[j] % P
                qx = (lam * lam - px - tx) % P
                qy = (lam * (px - qx) - py) % P
            h = rmd160(sha(bytes([2 | (qy & 1)]) + qx.to_bytes(32, "big")).digest())
            acc ^= int.from_bytes(h, "big")
            if h == target:
                hit = k + j
        done += m
        if done < n:
            tx, ty = table[BATCH]
            lam = (ty - py) * idx[BATCH] % P
            nx = (lam * lam - px - tx) % P
            py = (lam * (px - nx) - py) % P
            px = nx
            k += BATCH
    return hit, acc.to_bytes(20, "big")


# ------------------------------------------------------------------ C (ctypes)
def lib_path() -> Path:
    from ..qwen import cache_dir

    return cache_dir() / "p71" / f"p71core-{sys.platform}.so"


def build(dst: Path | None = None) -> Path | None:
    """Kompiluje p71core.c (gcc/cc/clang). Brak kompilatora = None (węzeł użyje czystego Pythona)."""
    dst = dst or lib_path()
    cc = next((c for c in ("cc", "gcc", "clang") if shutil.which(c)), None)
    if cc is None or not SRC.exists():
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(
        f"{dst.stem}.{os.getpid()}.{os.urandom(4).hex()}.tmp.so"
    )  # osobny plik na proces: dwa węzły naraz się nie psują
    r = subprocess.run([cc, "-O3", "-shared", "-fPIC", "-o", str(tmp), str(SRC)], capture_output=True, timeout=120)
    if r.returncode != 0:
        tmp.unlink(missing_ok=True)
        return None
    os.replace(tmp, dst)
    return dst


class CCore:
    def __init__(self, path: Path):
        self.lib = ctypes.CDLL(str(path))
        self.lib.p71_scan.restype = ctypes.c_int
        self.lib.p71_scan.argtypes = [
            ctypes.c_char_p,
            ctypes.c_uint64,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
        ]

    def h160_of_key(self, k: int) -> bytes:
        out = ctypes.create_string_buffer(20)
        self.lib.p71_hash160_of_key(k.to_bytes(32, "big"), out)
        return out.raw

    def scan(self, start: int, n: int, target: bytes) -> tuple[int | None, bytes]:
        key, xo = ctypes.create_string_buffer(32), ctypes.create_string_buffer(20)
        r = self.lib.p71_scan(start.to_bytes(32, "big"), n, target, key, xo)  # ctypes zwalnia GIL na czas wywołania
        if r < 0:
            raise ValueError("zły zakres skanu")
        return (int.from_bytes(key.raw, "big") if r == 1 else None), xo.raw


def load(build_if_missing: bool = True) -> CCore | None:
    with __import__("contextlib").suppress(Exception):
        p = lib_path()
        if (not p.exists() or p.stat().st_mtime < SRC.stat().st_mtime) and build_if_missing:
            build(p)
        if p.exists():
            c = CCore(p)
            # samosprawdzenie przy każdym ładowaniu: zagadka #20 (klucz publiczny z listy rozwiązanych)
            if c.h160_of_key(0xD2C55) == address_h160("1HsMJxNiV7TLxmoF6uJNkydxPFDog4NQum"):
                return c
    return None


if __name__ == "__main__" and sys.argv[1:2] == ["build"]:
    print(build() or "brak kompilatora")
