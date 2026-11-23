"""TOTP nach RFC 6238 — der zweite Faktor, aus der Standardbibliothek.

Ein zeitbasiertes Einmalkennwort ist HMAC-SHA1 über die Zeitscheibe, davon
vier Bytes an einer im letzten Nibble kodierten Stelle, modulo 10^6. Das ist
alles. Es steht hier und nicht in einer Abhängigkeit, weil ``hmac`` und
``hashlib`` es vollständig hergeben und weil die Fehlermöglichkeiten in einer
fremden Bibliothek dieselben wären, nur unsichtbar.

Drei Dinge, die an einer TOTP-Prüfung erfahrungsgemäß schiefgehen und hier
ausdrücklich behandelt sind:

* **Der Vergleich muss zeitkonstant sein.** Ein `==` auf der Zifferfolge
  verrät über die Laufzeit, wie viele Stellen stimmen. Sechs Stellen sind
  wenig genug, dass das zählt.
* **Ein Code darf nur einmal gelten.** Ohne Wiederholungsschutz ist eine
  abgefangene Ziffernfolge dreißig Sekunden lang ein gültiger zweiter Faktor.
  ``verify`` gibt die verbrauchte Zeitscheibe zurück, und der Aufrufer legt
  sie an den Benutzer — eine Scheibe, die nicht größer ist als die zuletzt
  verbrauchte, wird abgelehnt.
* **Das Fenster ist eine Toleranz, kein Komfort.** ±1 Scheibe (30 s) fängt
  eine schief gehende Uhr ab. Wer es auf ±3 stellt, verdreifacht die Fläche
  für einen Rateangriff und merkt es nie.

Der Ratenschutz gehört *nicht* hierher: 10^6 Möglichkeiten sind nur dann
genug, wenn nach ein paar Fehlversuchen Schluss ist, und diese Entscheidung
trifft der Router am Benutzerkonto (``mfa_failed_count``).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import time
from urllib.parse import quote

#: Sekunden je Zeitscheibe. 30 ist der Wert, den jede Authenticator-App
#: voreinstellt; ein abweichender wäre in der App von Hand zu setzen.
PERIOD = 30

#: Stellen des Codes. Sechs, aus demselben Grund.
DIGITS = 6

#: Toleranz in Scheiben, in beide Richtungen. Siehe Kopf.
WINDOW = 1

#: Länge des Geheimnisses in Bytes. 20 = 160 bit, die Blockgröße von SHA-1 und
#: das, was RFC 4226 §4 als Minimum nennt.
SECRET_BYTES = 20


def new_secret() -> str:
    """Ein frisches Geheimnis als Base32 ohne Füllzeichen.

    Base32, weil die ``otpauth://``-URI es so verlangt und weil ein Mensch es
    notfalls abtippen können muss — Base64 verwechselt O und 0.
    """
    return base64.b32encode(secrets.token_bytes(SECRET_BYTES)).decode("ascii").rstrip("=")


def _decode(secret: str) -> bytes:
    """Base32 mit fehlender Füllung und Leerzeichen tolerant lesen.

    Menschen tippen das Geheimnis in Vierergruppen ab und lassen die
    Gleichheitszeichen weg; beides darf keine Anmeldung kosten.
    """
    raw = secret.strip().replace(" ", "").replace("-", "").upper()
    raw += "=" * (-len(raw) % 8)
    return base64.b32decode(raw, casefold=True)


def slot(at: float | None = None) -> int:
    """Die Zeitscheibe zu einem Zeitpunkt. Unix-Zeit, keine Zeitzone."""
    return int((at if at is not None else time.time()) // PERIOD)


def code_at(secret: str, at_slot: int) -> str:
    """Der Code einer bestimmten Scheibe — RFC 4226 §5.3."""
    key = _decode(secret)
    msg = struct.pack(">Q", at_slot)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    # Dynamic truncation: das letzte Nibble sagt, wo die vier Bytes stehen.
    offset = digest[-1] & 0x0F
    chunk = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFF_FFFF
    return str(chunk % (10 ** DIGITS)).zfill(DIGITS)


def code(secret: str, at: float | None = None) -> str:
    """Der Code, der gerade gilt. Für Tests und für die Prüfnachricht."""
    return code_at(secret, slot(at))


def verify(secret: str, given: str, *, last_slot: int | None = None,
           at: float | None = None, window: int = WINDOW) -> int | None:
    """Prüfen und die verbrauchte Zeitscheibe zurückgeben, sonst ``None``.

    ``last_slot`` ist der Wiederholungsschutz: die zuletzt am Konto
    verbrauchte Scheibe. Ein Code aus dieser oder einer älteren Scheibe wird
    abgelehnt, auch wenn er rechnerisch stimmt — sonst ist eine einmal
    mitgelesene Ziffernfolge eine halbe Minute lang ein zweiter Faktor.

    Der Rückgabewert ist bewusst die Scheibe und kein ``bool``: der Aufrufer
    *muss* sie speichern, und ein Rückgabewert, den man wegwerfen kann, wird
    weggeworfen.
    """
    digits = "".join(ch for ch in str(given or "") if ch.isdigit())
    if len(digits) != DIGITS:
        return None
    now = slot(at)
    for drift in range(-window, window + 1):
        candidate = now + drift
        if last_slot is not None and candidate <= last_slot:
            continue
        # hmac.compare_digest: die Laufzeit darf nicht verraten, wie viele
        # Stellen stimmen.
        if hmac.compare_digest(code_at(secret, candidate), digits):
            return candidate
    return None


def replayed(secret: str, given: str, *, last_slot: int | None,
             at: float | None = None, window: int = WINDOW) -> bool:
    """Stimmt der Code zu einer Scheibe, die schon verbraucht ist?

    Nur für die Meldung: ``verify`` lehnt solche Codes weiter ab, und der
    Aufrufer zählt den Versuch weiter als Fehlversuch. Der Kunde, der denselben
    Code ein zweites Mal tippt (doppelter Klick, zweiter Tab), soll aber lesen,
    dass er auf den nächsten warten muss, statt an seiner Uhr zu zweifeln.
    """
    if not last_slot:
        return False
    digits = "".join(ch for ch in str(given or "") if ch.isdigit())
    if len(digits) != DIGITS:
        return False
    now = slot(at)
    hit = False
    for drift in range(-window, window + 1):
        candidate = now + drift
        if candidate > last_slot:
            continue
        # Alle Kandidaten rechnen, kein frühes Ende: gleiche Laufzeit.
        hit = hmac.compare_digest(code_at(secret, candidate), digits) or hit
    return hit


def provisioning_uri(secret: str, *, account: str, issuer: str) -> str:
    """Die ``otpauth://``-URI, die jede Authenticator-App als QR erwartet.

    Der Aussteller steht doppelt darin — im Pfad und als Parameter. Das ist
    keine Redundanz aus Versehen: ältere Apps lesen nur das eine, neuere nur
    das andere, und wer eines weglässt, bekommt Einträge ohne Namen.
    """
    label = quote(f"{issuer}:{account}", safe="")
    params = "&".join([
        f"secret={secret}",
        f"issuer={quote(issuer, safe='')}",
        "algorithm=SHA1",
        f"digits={DIGITS}",
        f"period={PERIOD}",
    ])
    return f"otpauth://totp/{label}?{params}"


def grouped(secret: str, size: int = 4) -> str:
    """Das Geheimnis in Vierergruppen — zum Abtippen, wenn die Kamera fehlt."""
    return " ".join(secret[i:i + size] for i in range(0, len(secret), size))


# --------------------------------------------------------------------------
# Wiederherstellungscodes
# --------------------------------------------------------------------------
#: Zeichenvorrat ohne die Paare, die auf Papier verwechselt werden: kein 0/O,
#: kein 1/I/l. Ein Code, den der Kunde falsch abliest, ist ein Konto, in das
#: er nicht mehr hineinkommt.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

RECOVERY_COUNT = 10
RECOVERY_GROUPS = 2
RECOVERY_GROUP_LEN = 5


def new_recovery_code() -> str:
    """Ein Code der Form ``ABCDE-FGHJK`` — 50 bit, einmal verwendbar."""
    parts = ["".join(secrets.choice(_ALPHABET) for _ in range(RECOVERY_GROUP_LEN))
             for _ in range(RECOVERY_GROUPS)]
    return "-".join(parts)


def normalize_recovery(given: str) -> str:
    """Grosschreibung, ohne Trenner — wie der Kunde ihn auch tippt."""
    return "".join(ch for ch in str(given or "").upper() if ch in _ALPHABET)
