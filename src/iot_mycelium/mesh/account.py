"""Anonimowe konto Mycelium AI w węźle PC (to samo co zakładka Konto na stronie).

Supabase Auth „anonymous sign-in” (bez e-maila, imienia i hasła) → konto (myc_acct_create) albo dołączenie
istniejącego kodem odzyskiwania (myc_acct_recover); węzeł przypisuje się do konta (myc_acct_link_nodes).
Sesja (token dostępu + odświeżania) leży tylko na tym komputerze: w systemowym sejfie haseł (keyring), gdy jest
dostępny, w przeciwnym razie w <pamięć podręczna>/account.json z prawami tylko dla właściciela (0600).
Tokenów i kodów nie wypisujemy, nie logujemy i nie oddajemy lokalnemu panelowi.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

from .net import SB_KEY, SB_URL
from .qwen import cache_dir

KR_SERVICE, KR_USER = "mycelium-node", "account"
HANDLE = re.compile(r"^[A-Za-z0-9_.-]{3,24}$")
CODE = re.compile(r"^MYC-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$")
REF = re.compile(r"^[0-9a-f]{8}$")


class AccountError(Exception):
    pass


def _keyring():
    with contextlib.suppress(Exception):
        import keyring  # type: ignore

        keyring.get_password(KR_SERVICE, KR_USER)  # test backendu (bez backendu: wyjątek)
        return keyring
    return None


class Store:
    """Miejsce na sesję: keyring albo plik 0600."""

    def __init__(self, path=None, use_keyring: bool = True):
        self.path = path or cache_dir() / "account.json"
        self.kr = _keyring() if use_keyring else None

    @property
    def where(self) -> str:
        return "sejf systemowy (keyring)" if self.kr else "plik tylko dla właściciela w pamięci podręcznej węzła"

    def load(self) -> dict | None:
        raw = None
        if self.kr:
            with contextlib.suppress(Exception):
                raw = self.kr.get_password(KR_SERVICE, KR_USER)
        if raw is None:
            with contextlib.suppress(OSError):
                raw = self.path.read_text()
        with contextlib.suppress(ValueError, TypeError):
            s = json.loads(raw)
            if (
                isinstance(s, dict)
                and isinstance(s.get("access_token"), str)
                and isinstance(s.get("refresh_token"), str)
            ):
                return s
        return None

    def save(self, s: dict | None) -> None:
        if self.kr:
            with contextlib.suppress(Exception):
                if s is None:
                    self.kr.delete_password(KR_SERVICE, KR_USER)
                else:
                    self.kr.set_password(KR_SERVICE, KR_USER, json.dumps(s))
                    self.path.unlink(missing_ok=True)
                    return
        if s is None:
            self.path.unlink(missing_ok=True)
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.unlink(missing_ok=True)
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps(s))
        os.replace(tmp, self.path)
        with contextlib.suppress(OSError):
            os.chmod(self.path, 0o600)


def _post(path: str, body: dict, token: str | None = None, timeout: float = 20):
    h = {"apikey": SB_KEY, "Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(f"{SB_URL}{path}", data=json.dumps(body).encode(), headers=h, method="POST")  # noqa: S310
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 – stały adres https Supabase
            t = r.read().decode()
            return json.loads(t) if t else None
    except urllib.error.HTTPError as e:
        try:
            j = json.loads(e.read().decode() or "{}")
        except ValueError:
            j = {}
        msg = str(j.get("message") or j.get("msg") or j.get("error_description") or f"HTTP {e.code}")
        raise AccountError(msg.removeprefix("myc: ")) from None
    except OSError as e:
        raise AccountError(f"brak połączenia: {type(e).__name__}") from None


class NodeAccount:
    def __init__(self, node_id: str, store: Store | None = None, post=_post, log=print):
        self.node_id, self.store, self.post, self.log = node_id, store or Store(), post, log
        self.lock = threading.Lock()
        self.me: dict | None = None
        self.checked = 0.0
        self.error = ""

    # ---------------------------------------------------------------- sesja
    def _sess(self, j: dict) -> dict:
        if not isinstance(j, dict) or not j.get("access_token") or not j.get("refresh_token"):
            raise AccountError("logowanie nieudane")
        return {
            "access_token": j["access_token"],
            "refresh_token": j["refresh_token"],
            "expires_at": time.time() + float(j.get("expires_in") or 3600),
        }

    def _token(self, create: bool = False) -> str | None:
        s = self.store.load()
        if s is None:
            if not create:
                return None
            s = self._sess(self.post("/auth/v1/signup", {}))
            self.store.save(s)
        if s["expires_at"] - time.time() < 120:
            try:
                s = self._sess(
                    self.post("/auth/v1/token?grant_type=refresh_token", {"refresh_token": s["refresh_token"]})
                )
            except AccountError:
                self.store.save(None)  # unieważniona sesja: konto wróci kodem odzyskiwania
                raise AccountError("sesja wygasła – zaloguj się kodem odzyskiwania") from None
            self.store.save(s)
        return s["access_token"]

    def rpc(self, fn: str, args: dict | None = None, create: bool = False):
        tok = self._token(create)
        if not tok:
            raise AccountError("brak sesji")
        return self.post(f"/rest/v1/rpc/{fn}", args or {}, tok)

    # ---------------------------------------------------------------- akcje
    def _set_me(self, me) -> dict:
        self.me = me if isinstance(me, dict) else None
        self.checked = time.time()
        self.error = ""
        return self.view()

    def refresh(self) -> dict:
        with self.lock:
            if self.store.load() is None:
                return self._set_me(None)
            try:
                me = self.rpc("myc_acct_me")
                if isinstance(me, dict) and self.node_id not in (me.get("nodes") or []):
                    with contextlib.suppress(AccountError):
                        if self.rpc("myc_acct_link_nodes", {"p_nodes": [self.node_id]}):
                            me = self.rpc("myc_acct_me")
                return self._set_me(me)
            except AccountError as e:
                self.error = str(e)
                return self.view()

    def create(self, handle: str, ref: str = "") -> dict:
        handle = (handle or "").strip()
        if not HANDLE.match(handle):
            raise AccountError("pseudonim 3–24 znaki: litery, cyfry, _ . -")
        ref = (ref or "").strip().lower()
        with self.lock:
            me = self.rpc(
                "myc_acct_create",
                {"p_handle": handle, "p_nodes": [self.node_id], "p_ref": ref if REF.match(ref) else None},
                create=True,
            )
            self.log("konto: założone i przypisane do tego węzła")
            return self._set_me(me)

    def recover(self, code: str) -> dict:
        code = (code or "").strip().upper()
        if not CODE.match(code):
            raise AccountError("kod ma postać MYC-XXXXXX-XXXXXX-XXXXXX-XXXXXX")
        with self.lock:
            self.rpc("myc_acct_recover", {"p_code": code}, create=True)
            with contextlib.suppress(AccountError):
                self.rpc("myc_acct_link_nodes", {"p_nodes": [self.node_id]})
            self.log("konto: ten komputer dołączony kodem odzyskiwania")
            return self._set_me(self.rpc("myc_acct_me"))

    def new_recovery(self) -> str:
        """Nowy kod odzyskiwania – oddawany raz do wyświetlenia, nigdzie nie zapisywany."""
        with self.lock:
            code = self.rpc("myc_acct_recovery_new")
            if self.me is not None:
                self.me["has_recovery"] = True
            self.log("konto: utworzono nowy kod odzyskiwania (pokazany raz w panelu)")
            return str(code)

    def logout(self, force: bool = False) -> dict:
        with self.lock:
            if self.store.load() is not None:
                self.rpc("myc_acct_forget_device", {"p_force": bool(force)})
            self.store.save(None)
            self.log("konto: wylogowano ten komputer")
            return self._set_me(None)

    def view(self) -> dict:
        """Tylko to, co może zobaczyć lokalny panel (bez tokenów)."""
        me = self.me
        out = {"logged_in": me is not None, "session": self.store.load() is not None, "where": self.store.where}
        if self.error:
            out["error"] = self.error
        if me:
            out["me"] = {
                k: me.get(k)
                for k in (
                    "handle",
                    "ref_code",
                    "has_recovery",
                    "devices",
                    "points",
                    "points_by_source",
                    "referrals",
                    "referrals_qualified",
                    "wallet_sol",
                    "created_at",
                )
            }
            out["me"]["nodes"] = len(me.get("nodes") or [])
            out["me"]["this_node_linked"] = self.node_id in (me.get("nodes") or [])
        return out
