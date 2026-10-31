"""Walidacja księgi MYC-test na węźle (tokeny testowe bez wartości; docs/wallet.md).

Co ok. 30 s węzeł pobiera kolejne bloki (publiczny odczyt Supabase) i dla każdego NIEZALEŻNIE sprawdza:
  1. ciągłość: wysokość, skrót poprzedniego bloku, numery transakcji bez luk,
  2. łańcuch skrótów transakcji: hash = sha256(prev_hash|body|sig),
  3. każdy podpis Ed25519 przelewu (treść jak w bazie i przeglądarce),
  4. reguły: nonce = poprzedni + 1, saldo ≥ kwota (stan liczony od bloku 1), emisja tylko według reguł
     (kran 10,00; nagrody ze stałą stawką; identyfikator zdarzenia jednorazowy),
  5. korzeń Merkle i skrót nagłówka bloku.
Potem liczy mały dowód pracy (sha256 z 16 wiodącymi bitami zerowymi) i podpisuje wynik własnym kluczem węzła
(Ed25519, powstaje na węźle, plik w pamięci podręcznej). Blok jest ostateczny, gdy ≥ 2 uprawnione węzły poświadczą
ten sam skrót. Czas weryfikacji i liczba sprawdzonych podpisów trafiają do bazy (telemetria „wallet”).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import re
import time
from pathlib import Path

from . import ed25519

PERIOD = float(os.environ.get("MYC_WALLET_PERIOD", "30"))
ZERO = "0" * 64
PREFIX = "MYC-TEST/v1"
HEX64 = re.compile(r"^[0-9a-f]{64}$")
MEMO_TRANSFER = re.compile(r"^[\w .,:!?#+-]{0,64}$")
# reguły emisji (te same stawki co myc_wallet_rewards / myc_wallet_faucet_claim w supabase/myc_wallet.sql)
MINT_RULES = [
    (re.compile(r"^faucet:[0-9a-f]{32}:[0-9]{8}$"), lambda a: a == 1000),
    (re.compile(r"^reward:pt:[0-9]{1,18}$"), lambda a: 1 <= a <= 100000),
    (re.compile(r"^reward:w[ap]:[0-9]{1,18}:[0-9a-f]{32}$"), lambda a: a == 50),
    (re.compile(r"^reward:spk:[0-9]{1,18}:[0-9a-f]{32}$"), lambda a: a == 10),
]


def sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def body(t: dict) -> str:
    return "|".join(
        [
            PREFIX,
            t["kind"],
            t.get("from_pub") or "",
            t["to_pub"],
            str(t["amount"]),
            str(t["nonce"]),
            str(t["ts_ms"]),
            t.get("memo") or "",
        ]
    )


def tx_hash(prev: str, t: dict) -> str:
    return sha(f"{prev}|{body(t)}|{t.get('sig') or ''}")


def merkle(hashes: list[str]) -> str:
    if not hashes:
        return ZERO
    lv = [bytes.fromhex(h) for h in hashes]
    while len(lv) > 1:
        lv = [hashlib.sha256(lv[i] + lv[min(i + 1, len(lv) - 1)]).digest() for i in range(0, len(lv), 2)]
    return lv[0].hex()


def header(b: dict) -> str:
    return "|".join(
        [
            PREFIX,
            "block",
            str(b["height"]),
            b["prev_hash"],
            b["merkle_root"],
            str(b["first_id"]),
            str(b["last_id"]),
            str(b["n_tx"]),
            b["last_tx_hash"],
            str(b["created_ms"]),
        ]
    )


def new_state() -> dict:
    return {"height": 0, "block_hash": ZERO, "last_id": 0, "last_hash": ZERO, "bal": {}, "nonce": {}, "mints": []}


class Invalid(Exception):
    pass


def verify_block(st: dict, b: dict, txs: list[dict]) -> tuple[dict, int]:
    """Sprawdza blok względem stanu po poprzednim bloku. Zwraca (nowy stan, liczba sprawdzonych podpisów) albo rzuca Invalid."""
    if b["height"] != st["height"] + 1:
        raise Invalid(f"wysokość {b['height']} ≠ {st['height'] + 1}")
    if b["prev_hash"] != st["block_hash"]:
        raise Invalid("skrót poprzedniego bloku się nie zgadza")
    txs = sorted(txs, key=lambda t: t["id"])
    if len(txs) != b["n_tx"] or not txs:
        raise Invalid(f"liczba transakcji {len(txs)} ≠ {b['n_tx']}")
    if txs[0]["id"] != st["last_id"] + 1 or b["first_id"] != txs[0]["id"] or b["last_id"] != txs[-1]["id"]:
        raise Invalid("luka w numeracji transakcji")
    bal = dict(st["bal"])
    nonce = dict(st["nonce"])
    mints = set(st["mints"])
    prev = st["last_hash"]
    n_sig = 0
    for i, t in enumerate(txs):
        if t["id"] != txs[0]["id"] + i:
            raise Invalid(f"luka przy tx {t['id']}")
        if t["prev_hash"] != prev:
            raise Invalid(f"tx {t['id']}: zerwany łańcuch skrótów")
        if tx_hash(prev, t) != t["hash"]:
            raise Invalid(f"tx {t['id']}: zły skrót")
        amt = int(t["amount"])
        if amt < 1 or not HEX64.match(t["to_pub"]):
            raise Invalid(f"tx {t['id']}: zła kwota albo adres")
        if t["kind"] == "mint":
            memo = t.get("memo") or ""
            if t.get("from_pub") or t.get("sig"):
                raise Invalid(f"tx {t['id']}: emisja z nadawcą/podpisem")
            if not any(rx.match(memo) and ok(amt) for rx, ok in MINT_RULES):
                raise Invalid(f"tx {t['id']}: emisja poza regułami ({memo[:24]})")
            if memo in mints:
                raise Invalid(f"tx {t['id']}: powtórzona emisja {memo[:24]}")
            mints.add(memo)
        elif t["kind"] == "transfer":
            f = t.get("from_pub") or ""
            if not HEX64.match(f) or f == t["to_pub"] or not MEMO_TRANSFER.match(t.get("memo") or ""):
                raise Invalid(f"tx {t['id']}: złe pola przelewu")
            if not ed25519.verify(bytes.fromhex(f), body(t).encode(), bytes.fromhex(t.get("sig") or "")):
                raise Invalid(f"tx {t['id']}: zły podpis Ed25519")
            n_sig += 1
            if int(t["nonce"]) != nonce.get(f, 0) + 1:
                raise Invalid(f"tx {t['id']}: zły nonce (powtórka/podwójne wydanie)")
            if bal.get(f, 0) < amt:
                raise Invalid(f"tx {t['id']}: brak środków (podwójne wydanie)")
            nonce[f] = int(t["nonce"])
            bal[f] = bal.get(f, 0) - amt
        else:
            raise Invalid(f"tx {t['id']}: nieznany rodzaj")
        bal[t["to_pub"]] = bal.get(t["to_pub"], 0) + amt
        prev = t["hash"]
    if b["last_tx_hash"] != prev:
        raise Invalid("skrót ostatniej transakcji się nie zgadza")
    if merkle([t["hash"] for t in txs]) != b["merkle_root"]:
        raise Invalid("zły korzeń Merkle")
    if sha(header(b)) != b["hash"]:
        raise Invalid("zły skrót nagłówka bloku")
    return {
        "height": b["height"],
        "block_hash": b["hash"],
        "last_id": txs[-1]["id"],
        "last_hash": prev,
        "bal": bal,
        "nonce": nonce,
        "mints": sorted(mints),
    }, n_sig


def pow_solve(block_hash: str, node_pub: str, bits: int) -> tuple[int, int]:
    """Najmniejszy nonce z sha256('<skrót>|<klucz>|<nonce>') zaczynającym się od bits/4 zer szesnastkowo. Zwraca (nonce, liczba skrótów)."""
    want = "0" * (bits // 4)
    n = 0
    pre = f"{block_hash}|{node_pub}|".encode()
    while True:
        if hashlib.sha256(pre + str(n).encode()).hexdigest().startswith(want):
            return n, n + 1
        n += 1


def attest_msg(height: int, h: str, ok: bool, node: str, pow_n: int) -> bytes:
    return "|".join([PREFIX, "attest", str(height), h, "1" if ok else "0", node, str(pow_n)]).encode()


class NodeKey:
    def __init__(self, node_id: str, path: Path | None = None):
        from .qwen import cache_dir

        self.node_id = node_id
        self.path = path or cache_dir() / f"wallet-node-key-{node_id[:8]}"
        if self.path.exists():
            self.seed = bytes.fromhex(self.path.read_text().strip())
        else:
            self.seed = os.urandom(32)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as f:
                f.write(self.seed.hex())
        self.pub = ed25519.public_key(self.seed).hex()

    def sign(self, msg: bytes) -> str:
        return ed25519.sign(self.seed, msg).hex()


class WalletWorker:
    def __init__(self, node, log=print, sb=None, key: NodeKey | None = None, state_dir: Path | None = None):
        from .lmwork import Supa  # wymaga torch – import dopiero w działającym węźle
        from .qwen import cache_dir

        self.node, self.log = node, log
        self.sb = sb or Supa()
        self.key = key or NodeKey(node.id)
        self.state_path = (state_dir or cache_dir()) / f"wallet-state-{node.id[:8]}.json"
        self.state = self._load()
        self.registered = False
        self.stats = {"wallet_blocks": 0, "wallet_attested": 0, "wallet_sigs": 0, "wallet_ms": 0, "wallet_invalid": 0}
        self.last_job: dict | None = None
        self.bad: tuple[int, str] | None = None

    def _load(self) -> dict:
        with contextlib.suppress(OSError, ValueError):
            s = json.loads(self.state_path.read_text())
            if isinstance(s, dict) and {"height", "block_hash", "bal"} <= s.keys():
                return s
        return new_state()

    def _save(self) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state))
        os.replace(tmp, self.state_path)

    def register(self) -> None:
        if self.registered:
            return
        msg = "|".join([PREFIX, "nodekey", self.node.id, self.key.pub]).encode()
        self.sb.rpc(
            "myc_node_key_register", {"p_node": self.node.id, "p_pub": self.key.pub, "p_sig": self.key.sign(msg)}
        )
        self.registered = True

    def _txs(self, a: int, b: int) -> list[dict]:
        out: list[dict] = []
        cur = a
        while cur <= b:
            page = self.sb.get(
                f"myc_wallet_tx?select=id,kind,from_pub,to_pub,amount,nonce,ts_ms,memo,sig,prev_hash,hash"
                f"&id=gte.{cur}&id=lte.{b}&order=id.asc&limit=1000"
            )
            if not page:
                break
            out += page
            cur = page[-1]["id"] + 1
        return out

    def step(self) -> dict:
        """Jeden przebieg: kolejne bloki od stanu lokalnego; poświadczenie bloków jeszcze nieostatecznych."""
        self.register()
        blocks = self.sb.get(f"myc_wallet_blocks?select=*&height=gt.{self.state['height']}&order=height.asc&limit=20")
        done = {"blocks": 0, "attested": 0, "sigs": 0, "ms": 0, "tx": 0}
        mine: set[int] = set()
        if blocks:
            lo, hi = blocks[0]["height"], blocks[-1]["height"]
            mine = {
                r["height"]
                for r in self.sb.get(
                    f"myc_wallet_attest?select=height&node_id=eq.{self.node.id}&height=gte.{lo}&height=lte.{hi}"
                )
            }
        for b in blocks:
            txs = self._txs(b["first_id"], b["last_id"])
            t0 = time.perf_counter()
            try:
                st, n_sig = verify_block(self.state, b, txs)
                ok, why = True, ""
            except Invalid as e:
                st, n_sig, ok, why = None, 0, False, str(e)[:120]
            ms = int((time.perf_counter() - t0) * 1000)
            done["sigs"] += n_sig
            done["ms"] += ms
            done["tx"] += len(txs)
            if b.get("final_at") is None and b["height"] not in mine:
                pw, _ = pow_solve(b["hash"], self.key.pub, int(b.get("pow_bits") or 16))
                sig = self.key.sign(attest_msg(b["height"], b["hash"], ok, self.node.id, pw))
                r = self.sb.rpc(
                    "myc_wallet_attest",
                    {
                        "p_node": self.node.id,
                        "p_height": b["height"],
                        "p_hash": b["hash"],
                        "p_ok": ok,
                        "p_reason": why,
                        "p_pow": pw,
                        "p_n_tx": len(txs),
                        "p_n_sig": n_sig,
                        "p_ms": ms,
                        "p_backend": "cpu",
                        "p_sig": sig,
                    },
                )
                done["attested"] += 1
                self.log(
                    f"portfel: blok {b['height']} ({len(txs)} tx, {n_sig} podpisów, {ms} ms) "
                    f"{'poprawny' if ok else 'NIEPOPRAWNY: ' + why} → poświadczony"
                    f"{' (ostateczny)' if (r or {}).get('finalized') else ''}"
                )
            if not ok and b.get("final_at") is not None and self.state["height"] > 0:
                # blok już ostateczny (inne węzły go potwierdziły), a mój stan się nie zgadza → przeliczam od bloku 1
                self.log(f"portfel: stan lokalny niezgodny przy bloku {b['height']} ({why}) – liczę od początku")
                self.state = new_state()
                self._save()
                break
            if not ok:
                self.stats["wallet_invalid"] += 1
                if self.bad != (b["height"], why):
                    self.log(f"portfel: blok {b['height']} odrzucony: {why}")
                self.bad = (b["height"], why)
                break
            self.state = st
            done["blocks"] += 1
        if done["blocks"]:
            self._save()
        for k in ("blocks", "attested", "sigs", "ms"):
            self.stats[f"wallet_{k}"] += done[k]
        return done

    async def run(self, stop: asyncio.Event):
        await asyncio.sleep(5)
        while not stop.is_set():
            sched = getattr(self.node, "sched", None)
            if sched is None or sched.alloc["shares"].get("wallet", 100) > 0 and sched.alloc.get("compute_on", True):
                try:
                    with sched.job("wallet") if sched is not None else contextlib.nullcontext():
                        r = await asyncio.to_thread(self.step)
                    if r["blocks"] or r["attested"]:
                        self.last_job = {
                            "kind": "validate",
                            "id": self.state["height"],
                            "ms": r["ms"],
                            "at": time.time(),
                            **r,
                        }
                except Exception as e:  # noqa: BLE001 – błąd sieci/bazy: następna próba za chwilę
                    self.log(f"portfel: błąd walidacji: {str(e)[:200]}")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(stop.wait(), PERIOD)


# ------------------------------------------------------------------ budowanie (testy i samosprawdzenie wydania)
def make_tx(
    prev: str,
    tid: int,
    kind: str,
    to: str,
    amount: int,
    *,
    seed: bytes | None = None,
    nonce: int = 0,
    ts: int = 0,
    memo: str = "",
) -> dict:
    t = {
        "id": tid,
        "kind": kind,
        "from_pub": None,
        "to_pub": to,
        "amount": amount,
        "nonce": nonce,
        "ts_ms": ts,
        "memo": memo,
        "sig": "",
    }
    if seed is not None:
        t["from_pub"] = ed25519.public_key(seed).hex()
        t["sig"] = ed25519.sign(seed, body(t).encode()).hex()
    t["prev_hash"] = prev
    t["hash"] = tx_hash(prev, t)
    return t


def make_block(height: int, prev_block: str, txs: list[dict], ms: int = 0) -> dict:
    b = {
        "height": height,
        "prev_hash": prev_block,
        "merkle_root": merkle([t["hash"] for t in txs]),
        "first_id": txs[0]["id"],
        "last_id": txs[-1]["id"],
        "n_tx": len(txs),
        "last_tx_hash": txs[-1]["hash"],
        "created_ms": ms,
    }
    b["hash"] = sha(header(b))
    return b


def selftest() -> dict:
    """Samosprawdzenie (CI wydania węzła): prawdziwe podpisy na świeżych kluczach, bez bazy i bez sieci."""
    t0 = time.perf_counter()
    a, c = os.urandom(32), os.urandom(32)
    pa, pc = ed25519.public_key(a).hex(), ed25519.public_key(c).hex()
    m = make_tx(ZERO, 1, "mint", pa, 1000, memo="faucet:" + "ab" * 16 + ":20261101")
    t1 = make_tx(m["hash"], 2, "transfer", pc, 400, seed=a, nonce=1, ts=1)
    b = make_block(1, ZERO, [m, t1])
    st, n = verify_block(new_state(), b, [m, t1])
    ok = n == 1 and st["bal"] == {pa: 600, pc: 400}
    # podwójne wydanie (ten sam nonce) i podrobiony podpis muszą zostać odrzucone
    rejected = 0
    t2 = make_tx(t1["hash"], 3, "transfer", pc, 400, seed=a, nonce=1, ts=2)
    forged = dict(make_tx(t1["hash"], 3, "transfer", pa, 400, seed=c, nonce=1, ts=2))
    forged["amount"] = 401
    forged["hash"] = tx_hash(t1["hash"], forged)
    for bad in (t2, forged):
        try:
            verify_block(st, make_block(2, b["hash"], [bad]), [bad])
        except Invalid:
            rejected += 1
    return {
        "ok": ok and rejected == 2,
        "backend": ed25519.BACKEND,
        "rejected": rejected,
        "ms": int((time.perf_counter() - t0) * 1000),
    }
