"""Szyfrowanie znalezionego klucza do klucza publicznego właściciela (docs/puzzle71.md, „Bezpieczeństwo”).

Format (wersja 1, szesnastkowo): 01 | efemeryczny klucz X25519 (32 B) | nonce (12 B) | szyfrogram ChaCha20-Poly1305.
Klucz symetryczny = HKDF-SHA256(wspólny sekret X25519, sól = efemeryczny‖właściciel, info = "MYC-P71/v1/seal").
Węzeł zna tylko klucz PUBLICZNY właściciela (owner_x25519.pub w repozytorium); prywatny leży poza repozytorium
(chmod 600) i nie jest nigdzie publikowany ani wypisywany. Bez niego szyfrogram w bazie jest bezużyteczny.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

INFO = b"MYC-P71/v1/seal"
OWNER_PUB_FILE = Path(__file__).with_name("owner_x25519.pub")


def owner_pub() -> bytes:
    b = bytes.fromhex(OWNER_PUB_FILE.read_text().strip())
    if len(b) != 32:
        raise ValueError("zły klucz publiczny właściciela")
    return b


def _kdf(shared: bytes, eph: bytes, pub: bytes) -> bytes:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF

    return HKDF(algorithm=hashes.SHA256(), length=32, salt=eph + pub, info=INFO).derive(shared)


def seal(payload: dict, pub: bytes | None = None) -> str:
    from cryptography.hazmat.primitives import serialization as s
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

    pub = pub or owner_pub()
    e = X25519PrivateKey.generate()
    eph = e.public_key().public_bytes(s.Encoding.Raw, s.PublicFormat.Raw)
    key = _kdf(e.exchange(X25519PublicKey.from_public_bytes(pub)), eph, pub)
    nonce = os.urandom(12)
    ct = ChaCha20Poly1305(key).encrypt(nonce, json.dumps(payload, sort_keys=True).encode(), b"\x01" + eph)
    return (b"\x01" + eph + nonce + ct).hex()


def open_sealed(blob_hex: str, priv: bytes) -> dict:
    """Tylko dla właściciela (scripts/p71_open.py): odszyfrowanie kluczem prywatnym."""
    from cryptography.hazmat.primitives import serialization as s
    from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
    from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305

    b = bytes.fromhex(blob_hex)
    if b[0] != 1:
        raise ValueError("nieznana wersja")
    eph, nonce, ct = b[1:33], b[33:45], b[45:]
    k = X25519PrivateKey.from_private_bytes(priv)
    pub = k.public_key().public_bytes(s.Encoding.Raw, s.PublicFormat.Raw)
    key = _kdf(k.exchange(X25519PublicKey.from_public_bytes(eph)), eph, pub)
    return json.loads(ChaCha20Poly1305(key).decrypt(nonce, ct, b"\x01" + eph))


def available() -> bool:
    try:
        import cryptography.hazmat.primitives.ciphers.aead  # noqa: F401

        owner_pub()
        return True
    except Exception:  # noqa: BLE001
        return False
