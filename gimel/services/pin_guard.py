"""Drossel und Sperre für die Gimel-PIN (routers/auth.py, ``POST /api/auth/pin``).

Eine PIN ist ein schwaches Geheimnis — acht Ziffern sind 10⁸ Möglichkeiten.
Erraten wird sie nur, wenn man beliebig oft fragen darf. Deshalb zwei Grenzen:

* je Absender (IPv4-Adresse, IPv6 je /64): ``PER_IP`` Fehlversuche in
  ``WINDOW``, danach 429 bis das Fenster abläuft;
* über alle Absender: nach ``GLOBAL_FAILS`` Fehlversuchen in ``WINDOW`` ist die
  PIN-Anmeldung ``GLOBAL_LOCK`` lang ganz gesperrt — ein Angriff aus vielen
  Adressen sperrt die Tür, statt sie zu öffnen.

Bewusst im Speicher: ein Prozess (uvicorn ohne Worker), ein Neustart setzt die
Zähler zurück — das kostet einen Angreifer einen Neustart, den er nicht
auslösen kann. Erfolgreiche Anmeldungen setzen den Zähler des Absenders zurück.
"""

from __future__ import annotations

import ipaddress
import threading
import time

WINDOW = 15 * 60
PER_IP = 5
GLOBAL_FAILS = 20
GLOBAL_LOCK = 60 * 60

_lock = threading.Lock()
_fails: dict[str, list[float]] = {}
_all_fails: list[float] = []
_locked_until = 0.0


def rate_key(ip: str) -> str:
    """IPv4 je Adresse, IPv6 je /64 — wie tunnel/gate-rules.mjs rateKey."""
    try:
        addr = ipaddress.ip_address((ip or "").strip())
    except ValueError:
        return (ip or "").strip() or "unbekannt"
    if isinstance(addr, ipaddress.IPv6Address):
        if addr.ipv4_mapped:
            return str(addr.ipv4_mapped)
        return str(ipaddress.ip_network(f"{addr}/64", strict=False))
    return str(addr)


def _prune(now: float) -> None:
    for key in list(_fails):
        _fails[key] = [t for t in _fails[key] if now - t < WINDOW]
        if not _fails[key]:
            del _fails[key]
    _all_fails[:] = [t for t in _all_fails if now - t < WINDOW]


def blocked(ip: str, now: float | None = None) -> int:
    """Sekunden, die dieser Absender noch warten muss (0 = darf versuchen)."""
    now = now or time.time()
    with _lock:
        _prune(now)
        if _locked_until > now:
            return int(_locked_until - now) + 1
        seen = _fails.get(rate_key(ip), [])
        if len(seen) >= PER_IP:
            return int(WINDOW - (now - seen[0])) + 1
    return 0


def failed(ip: str, now: float | None = None) -> bool:
    """Fehlversuch zählen. ``True``, wenn damit die globale Sperre greift."""
    global _locked_until
    now = now or time.time()
    with _lock:
        _prune(now)
        _fails.setdefault(rate_key(ip), []).append(now)
        _all_fails.append(now)
        if len(_all_fails) >= GLOBAL_FAILS and _locked_until <= now:
            _locked_until = now + GLOBAL_LOCK
            _all_fails.clear()
            return True
    return False


def succeeded(ip: str) -> None:
    with _lock:
        _fails.pop(rate_key(ip), None)


def reset() -> None:
    """Nur für Tests."""
    global _locked_until
    with _lock:
        _fails.clear()
        _all_fails.clear()
        _locked_until = 0.0
