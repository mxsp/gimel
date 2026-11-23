"""Geheimnisse verschlüsselt ablegen — AES-256-GCM mit dem Betriebsschlüssel.

Bislang lag in dieser Datenbank nichts, was im Klartext gefährlich gewesen
wäre: Passwörter sind bcrypt-Hashes, Refresh-Token SHA-256-Hashes, die
Kontakt-E-Mail hat eine Frist. Ein TOTP-Geheimnis ist die erste Ausnahme —
es *muss* zurückgelesen werden können, um einen Code zu prüfen, ein Hash
scheidet also aus. Wer die Datenbank liest, könnte damit jeden zweiten Faktor
erzeugen, und der zweite Faktor wäre dann keiner mehr.

**Hier wird nicht selbst gerechnet.** Das ganze Repository schreibt bewusst
eigene Implementierungen (DXF, SMTP, TOTP, QR), weil die jeweiligen Formate
klein und die Fehler sichtbar sind. Blockchiffren sind das Gegenteil: die
Fehler sind unsichtbar und stehen erst in fremden Papern. ``cryptography``
ist deshalb die eine Abhängigkeit, die dieses Verzeichnis rechtfertigt.

Der Schlüssel wird aus ``ALPHA_SECRET_KEY`` abgeleitet, mit einem eigenen
Info-Feld — derselbe Betriebsschlüssel signiert die Zugangstoken, und dieselbe
Bytefolge für zwei Zwecke ist der Weg, auf dem später eine Schwäche des einen
zur Schwäche des anderen wird.

Was das schützt und was nicht: es schützt eine **gestohlene Datenbankdatei**
(Backup, Kopie, SQL-Injection). Es schützt nicht gegen jemanden, der auch die
Umgebung des Servers liest — dann hat er den Schlüssel. Der nächste Schritt
wäre ein KMS oder ein HSM; die Naht dafür ist genau diese Datei.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from ..config import get_settings

#: Kennzeichen am Anfang jedes Kryptogramms. Damit ist an einem Feldwert
#: ablesbar, ob er verschlüsselt ist — und ein späterer Wechsel des Verfahrens
#: kann alte Werte weiter lesen, statt sie stumm als Müll zu behandeln.
PREFIX = "v1:"

_NONCE_BYTES = 12  # AES-GCM: 96 bit, der einzige Wert, für den GCM entworfen ist


def _derive(root: str) -> bytes:
    return hmac.new(root.encode("utf-8"), b"alpha.secretbox.v1", hashlib.sha256).digest()


def _key() -> bytes:
    """32 Byte aus dem Betriebsschlüssel, HKDF-artig über HMAC-SHA256.

    Das Info-Feld trennt diesen Zweck von jedem anderen, der denselben
    ``ALPHA_SECRET_KEY`` benutzt (Zugangstoken, Kontakt-Hashes).
    """
    root = get_settings().secret_key or ""
    if not root:
        raise RuntimeError("ALPHA_SECRET_KEY fehlt — Geheimnisse nicht ablegbar.")
    return _derive(root)


def _previous_key() -> bytes | None:
    """Der Schlüssel vor dem letzten Wechsel — nur zum Lesen.

    Ein naiver Wechsel von ``ALPHA_SECRET_KEY`` machte jedes gespeicherte
    TOTP-Geheimnis unlesbar, und ``open_`` meldet das bewusst still als
    „nicht eingerichtet": der zweite Faktor aller Konten wäre ohne ein Wort
    abgeschaltet. Mit ``ALPHA_SECRET_KEY_PREVIOUS`` bleibt er lesbar, bis
    ``scripts/reseal_secrets.py`` neu versiegelt hat.
    """
    prev = get_settings().secret_key_previous or ""
    return _derive(prev) if prev else None


def seal(plain: str) -> str:
    """Klartext → ``v1:<base64(nonce|ciphertext|tag)>``.

    Ein leerer Wert bleibt leer: „kein Geheimnis" ist ein Zustand und kein
    zu verschlüsselnder Wert.
    """
    if not plain:
        return ""
    nonce = os.urandom(_NONCE_BYTES)
    blob = nonce + AESGCM(_key()).encrypt(nonce, plain.encode("utf-8"), None)
    return PREFIX + base64.b64encode(blob).decode("ascii")


def open_(sealed: str) -> str:
    """Zurücklesen. Gibt bei jedem Fehler den leeren Text zurück.

    Bewusst kein Werfen: ein Konto, dessen Geheimnis nicht mehr entschlüsselt
    werden kann (rotierter Betriebsschlüssel, beschädigte Zeile), darf keine
    500 auslösen. Es hat dann faktisch keinen zweiten Faktor mehr, und der
    Aufrufer behandelt das wie „nicht eingerichtet" — der Kunde kommt über
    seinen Wiederherstellungscode wieder hinein.
    """
    if not sealed:
        return ""
    if not sealed.startswith(PREFIX):
        # Ein Wert aus der Zeit vor dieser Datei. Es gibt keinen — aber wenn
        # doch, ist er Klartext und wird als solcher zurückgegeben, damit ein
        # Bestandskonto nicht ausgesperrt wird.
        return sealed
    plain, _ = _open_with_source(sealed)
    return plain


def _open_with_source(sealed: str) -> tuple[str, str]:
    """Wie ``open_``, sagt aber, welcher Schlüssel passte:
    ``"current"``, ``"previous"`` oder ``""`` (keiner)."""
    try:
        blob = base64.b64decode(sealed[len(PREFIX):])
    except Exception:  # noqa: BLE001
        return "", ""
    nonce, ct = blob[:_NONCE_BYTES], blob[_NONCE_BYTES:]
    for name, key in (("current", _key()), ("previous", _previous_key())):
        if key is None:
            continue
        try:
            return AESGCM(key).decrypt(nonce, ct, None).decode("utf-8"), name
        except Exception:  # noqa: BLE001 — siehe Dokumentation von open_
            continue
    return "", ""


def reseal(sealed: str) -> tuple[str, str]:
    """Für den Schlüsselwechsel: ``(neuer Wert, Zustand)``.

    Zustand ``"current"`` — schon mit dem aktuellen Schlüssel, unverändert;
    ``"resealed"`` — war mit dem alten, jetzt mit dem aktuellen versiegelt;
    ``"unreadable"`` — passt zu keinem Schlüssel, unverändert gelassen.
    """
    if not sealed or not sealed.startswith(PREFIX):
        return sealed, "current"
    plain, source = _open_with_source(sealed)
    if source == "current":
        return sealed, "current"
    if source == "previous":
        return seal(plain), "resealed"
    return sealed, "unreadable"
