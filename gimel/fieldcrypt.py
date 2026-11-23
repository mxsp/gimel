"""Feldverschlüsselung für Personen- und Nutzungsdaten (AES-256-GCM).

Was das schützt: eine gestohlene oder kopierte Datenbankdatei (Backup, Image
der Platte, SQL-Injection mit Lesezugriff). Es schützt nicht gegen jemanden,
der auch die Umgebung des Dienstes liest — dort steht der Datenschlüssel.

**Hier wird nicht selbst gerechnet.** AES-GCM, HKDF und HMAC kommen aus
``cryptography`` bzw. der Standardbibliothek; diese Datei legt nur Format,
Schlüsselverwaltung und die SQLAlchemy-Typen darum.

Unterschied zu ``services/secretbox.py`` (TOTP-Geheimnisse): ein eigener,
neuer Schlüssel, nicht aus ``SECRET_KEY`` abgeleitet, mit Kennung im Kryptogramm.

Schlüssel: ``<PRÄFIX>DATA_KEYS`` = ``kennung:schlüssel[,kennung:schlüssel…]``.
Der Schlüssel sind 32 zufällige Bytes in base64url (``python -m gimel.fieldmigrate
genkey``). Der erste Eintrag verschlüsselt, alle lesen. Wechsel: neuen Schlüssel
davor setzen, ``fieldmigrate --apply`` laufen lassen, den alten erst danach
entfernen.

Format eines Wertes: ``fe1:<kennung>:<base64url(nonce ‖ chiffrat ‖ tag)>``. Bei
Binärfeldern dasselbe als Bytes, ohne base64. Zugeordnet ist jeder Wert seinem
Feld (``label`` geht als zusätzlich authentifizierte Daten ein): ein Wert aus
``addresses.street`` lässt sich nicht in ``addresses.city`` umkopieren.

Verhalten:

* **Kein Schlüssel gesetzt: alles wie vorher.** Es wird Klartext geschrieben und
  gelesen. Den Code allein auszurollen ändert nichts.
* **Klartext aus der Zeit davor wird gelesen wie bisher** und beim nächsten
  Schreiben verschlüsselt (oder durch ``fieldmigrate``).
* **Unlesbares Kryptogramm** (Schlüssel fehlt oder falsch) wirft
  ``UnreadableField``, mit Feld und Schlüsselkennung, nie mit dem Wert. Still
  leer zurückzugeben wäre schlimmer: eine Rechnung mit leerer Anschrift.
* Leere Werte (``None``, ``""``, ``{}``, ``[]``) bleiben, wie sie sind.

Klartext, der wie ein Kryptogramm aussieht (eine Anschrift, die jemand so
eingetippt hat), bekommt beim Schreiben ``fe0:`` davor und verliert es beim
Lesen. Sonst könnte ein Kunde mit einem einzigen Feld jede Liste sperren, die
die Zeile liest.

Nicht verschlüsselt werden Felder, nach denen in SQL gesucht, sortiert oder
eindeutig gemacht wird (E-Mail, Name, Firma, Auftrags-E-Mail). Für ein solches
Feld gäbe es ``blind_indexes``: einen schlüsselabhängigen HMAC zum Suchen auf
Gleichheit. Heute nutzt ihn noch keine Spalte.
"""

from __future__ import annotations

import base64
import contextlib
import contextvars
import hashlib
import hmac
import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from sqlalchemy import JSON, LargeBinary, Text
from sqlalchemy.types import TypeDecorator

from .config import ENV_PREFIX, get_settings

PREFIX = "fe1:"
ESCAPE = "fe0:"
_BPREFIX = PREFIX.encode()
_BESCAPE = ESCAPE.encode()
_NONCE = 12
_TAG = 16
_KID = re.compile(r"^[A-Za-z0-9_-]{1,16}$")


class FieldCryptError(Exception):
    pass


class KeyConfigError(FieldCryptError):
    """``DATA_KEYS`` ist unbrauchbar — der Dienst soll beim Start abbrechen, nicht später beim Schreiben."""


class UnreadableField(FieldCryptError):
    """Ein Kryptogramm lässt sich nicht öffnen. Nennt Feld und Schlüsselkennung, nie den Inhalt."""


@dataclass(frozen=True)
class _Ring:
    active: str | None
    enc: dict
    idx: dict


def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _b64e(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def _sub(master: bytes, info: bytes) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(master)


@lru_cache(maxsize=16)
def _parse(raw: str) -> _Ring:
    raw = (raw or "").strip()
    if not raw:
        return _Ring(None, {}, {})
    enc, idx, first = {}, {}, None
    for part in (p.strip() for p in raw.split(",") if p.strip()):
        kid, sep, key = part.partition(":")
        if not sep or not _KID.match(kid):
            raise KeyConfigError(f"{ENV_PREFIX}DATA_KEYS: Eintrag ohne gültige Kennung (erwartet kennung:schlüssel)")
        if kid in enc:
            raise KeyConfigError(f"{ENV_PREFIX}DATA_KEYS: Kennung '{kid}' kommt doppelt vor")
        try:
            master = _b64d(key)
        except Exception as exc:  # noqa: BLE001
            raise KeyConfigError(f"{ENV_PREFIX}DATA_KEYS: Schlüssel '{kid}' ist kein base64url") from exc
        if len(master) != 32:
            raise KeyConfigError(f"{ENV_PREFIX}DATA_KEYS: Schlüssel '{kid}' muss 32 Byte lang sein")
        enc[kid] = _sub(master, b"gimel.fieldcrypt.enc.v1")
        idx[kid] = _sub(master, b"gimel.fieldcrypt.idx.v1")
        first = first or kid
    return _Ring(first, enc, idx)


def _ring() -> _Ring:
    return _parse(get_settings().data_keys)


def validate() -> None:
    """Beim Start aufrufen: wirft ``KeyConfigError``, wenn ``DATA_KEYS`` gesetzt, aber kaputt ist."""
    _ring()


def enabled() -> bool:
    return _ring().active is not None and not _plain_writes.get()


def active_key_id() -> str | None:
    return _ring().active


def generate_key(kid: str = "k1") -> str:
    """Ein frischer Eintrag für ``DATA_KEYS``. Der Aufrufer legt ihn ab; hier wird nichts gespeichert."""
    if not _KID.match(kid):
        raise ValueError("Kennung: 1–16 Zeichen aus A–Z a–z 0–9 _ -")
    return f"{kid}:{_b64e(os.urandom(32))}"


#: Für den Rückweg (``fieldmigrate --decrypt``): lesen mit allen Schlüsseln, aber Klartext schreiben.
_plain_writes: contextvars.ContextVar[bool] = contextvars.ContextVar("gimel_plain_writes", default=False)


@contextlib.contextmanager
def plaintext_writes():
    tok = _plain_writes.set(True)
    try:
        yield
    finally:
        _plain_writes.reset(tok)


def _aad(label: str) -> bytes:
    return b"gimel.fe1|" + label.encode("utf-8")


def _seal(label: str, data: bytes) -> tuple[str, bytes]:
    ring = _ring()
    nonce = os.urandom(_NONCE)
    return ring.active, nonce + AESGCM(ring.enc[ring.active]).encrypt(nonce, data, _aad(label))


def _open(label: str, kid: str, blob: bytes) -> bytes:
    key = _ring().enc.get(kid)
    if key is None:
        raise UnreadableField(f"{label}: Datenschlüssel '{kid}' ist nicht in {ENV_PREFIX}DATA_KEYS")
    try:
        return AESGCM(key).decrypt(blob[:_NONCE], blob[_NONCE:], _aad(label))
    except InvalidTag as exc:
        raise UnreadableField(f"{label}: Kryptogramm (Schlüssel '{kid}') ist beschädigt oder gehört zu einem anderen Feld") from exc


# ---- Text ------------------------------------------------------------------

def _split_text(v: str):
    """``(kid, blob)`` wenn ``v`` wie ein Kryptogramm aussieht, sonst ``None`` (dann ist es Klartext)."""
    if not v.startswith(PREFIX):
        return None
    kid, sep, body = v[len(PREFIX):].partition(":")
    if not sep or not _KID.match(kid):
        return None
    try:
        blob = _b64d(body)
    except Exception:  # noqa: BLE001
        return None
    return (kid, blob) if len(blob) >= _NONCE + _TAG else None


def is_token(v) -> bool:
    if isinstance(v, str):
        return _split_text(v) is not None
    if isinstance(v, (bytes, bytearray, memoryview)):
        return _split_bytes(bytes(v)) is not None
    return False


def token_key_id(v) -> str | None:
    """Mit welchem Schlüssel ``v`` verschlüsselt ist; ``None`` bei Klartext."""
    if isinstance(v, str):
        p = _split_text(v)
    elif isinstance(v, (bytes, bytearray, memoryview)):
        p = _split_bytes(bytes(v))
    else:
        return None
    return p[0] if p else None


def encrypt_text(label: str, value):
    if not value or not isinstance(value, str):
        return value
    if not enabled():
        return ESCAPE + value if value.startswith((PREFIX, ESCAPE)) else value
    kid, blob = _seal(label, value.encode("utf-8"))
    return f"{PREFIX}{kid}:{_b64e(blob)}"


def decrypt_text(label: str, value):
    if not isinstance(value, str):
        return value
    if value.startswith(ESCAPE):
        return value[len(ESCAPE):]
    p = _split_text(value)
    return value if p is None else _open(label, *p).decode("utf-8")


# ---- Bytes -----------------------------------------------------------------

def _split_bytes(v: bytes):
    if not v.startswith(_BPREFIX):
        return None
    end = v.find(b":", len(_BPREFIX), len(_BPREFIX) + 17)
    if end < 0:
        return None
    kid = v[len(_BPREFIX):end].decode("ascii", "replace")
    blob = v[end + 1:]
    return (kid, blob) if _KID.match(kid) and len(blob) >= _NONCE + _TAG else None


def encrypt_bytes(label: str, value):
    if not value or not isinstance(value, (bytes, bytearray, memoryview)):
        return value
    if not enabled():
        raw = bytes(value)
        return _BESCAPE + raw if raw.startswith((_BPREFIX, _BESCAPE)) else value
    kid, blob = _seal(label, bytes(value))
    return _BPREFIX + kid.encode() + b":" + blob


def decrypt_bytes(label: str, value):
    if not isinstance(value, (bytes, bytearray, memoryview)):
        return value
    raw = bytes(value)
    if raw.startswith(_BESCAPE):
        return raw[len(_BESCAPE):]
    p = _split_bytes(raw)
    return value if p is None else _open(label, *p)


# ---- JSON ------------------------------------------------------------------

def _empty(v) -> bool:
    return v is None or v == "" or v == {} or v == []


def encrypt_json(label: str, value):
    """Ein JSON-Wert wird zu einem einzigen JSON-String mit dem Kryptogramm. Die Spalte bleibt, was sie war."""
    if _empty(value):
        return value
    if not enabled():
        return encrypt_text(label, value) if isinstance(value, str) else value
    return encrypt_text(label, json.dumps(value, ensure_ascii=False, separators=(",", ":")))


def decrypt_json(label: str, value):
    if isinstance(value, str) and value.startswith(ESCAPE):
        return value[len(ESCAPE):]
    if isinstance(value, str) and _split_text(value) is not None:
        return json.loads(decrypt_text(label, value))
    return value


# ---- Blindindex ------------------------------------------------------------

def blind_indexes(label: str, value: str) -> list[str]:
    """Suchwerte für ``value`` unter *jedem* Schlüssel des Rings (HMAC-SHA256, ohne Schlüsselkennung).

    Zum Suchen ``col.in_(blind_indexes(...))``; geschrieben wird ``blind_index``. So bleibt
    eine Suche über einen Schlüsselwechsel hinweg richtig, bis ``fieldmigrate`` neu indiziert hat.
    Gleichheit ist ablesbar (zwei Zeilen mit gleichem Wert haben gleichen Index) — mehr nicht.
    """
    norm = (value or "").strip().lower().encode("utf-8")
    return [hmac.new(k, label.encode() + b"\0" + norm, hashlib.sha256).hexdigest() for k in _ring().idx.values()]


def blind_index(label: str, value: str) -> str:
    ring = _ring()
    if ring.active is None:
        raise FieldCryptError("kein Datenschlüssel gesetzt")
    norm = (value or "").strip().lower().encode("utf-8")
    return hmac.new(ring.idx[ring.active], label.encode() + b"\0" + norm, hashlib.sha256).hexdigest()


# ---- SQLAlchemy-Typen --------------------------------------------------------

class EncryptedText(TypeDecorator):
    """Text, verschlüsselt abgelegt. ``label`` ist ein fester Name wie ``"addresses.street"`` (nicht
    der Spaltenname im Schema — der darf sich nie ändern, dieser auch nicht)."""

    impl = Text
    cache_ok = True

    def __init__(self, label: str):
        super().__init__()
        self.label = label

    def process_bind_param(self, value, dialect):
        return encrypt_text(self.label, value)

    def process_result_value(self, value, dialect):
        return decrypt_text(self.label, value)


class EncryptedJSON(TypeDecorator):
    impl = JSON
    cache_ok = True

    def __init__(self, label: str):
        super().__init__()
        self.label = label

    def process_bind_param(self, value, dialect):
        return encrypt_json(self.label, value)

    def process_result_value(self, value, dialect):
        return decrypt_json(self.label, value)


class EncryptedBytes(TypeDecorator):
    impl = LargeBinary
    cache_ok = True

    def __init__(self, label: str):
        super().__init__()
        self.label = label

    def process_bind_param(self, value, dialect):
        return encrypt_bytes(self.label, value)

    def process_result_value(self, value, dialect):
        return decrypt_bytes(self.label, value)


ENCRYPTED_TYPES = (EncryptedText, EncryptedJSON, EncryptedBytes)
