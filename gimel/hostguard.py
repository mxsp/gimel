"""Host-Prüfung gegen DNS-Rebinding.

Der Dienst hört auf 127.0.0.1:8001. Das schützt nicht vor einer Webseite im
Browser des Betreibers: Sie legt einen Namen an, der erst auf ihren Server und
nach kurzer Zeit auf 127.0.0.1 zeigt, und der Browser hält die Seite weiter
für „dieselbe Herkunft“ — samt Cookies und Zugriff auf die Antworten. Die
Anfrage trägt dann aber ihren eigenen Namen im ``Host``-Header. Den prüfen wir.

Erlaubt ist ohne Einstellung, was lokal und der Pförtner schicken:
``localhost``, jede IP-Adresse als Zahl (ein Browser schickt eine IP im Host nur,
wenn die Adresszeile eine IP zeigt — ein Rebinding-Name ist nie eine), das
Starlette-TestClient-``testserver``. Dazu ``<PRÄFIX>ALLOWED_HOSTS``: Namen mit
Komma getrennt, ``*.beispiel.de`` für Unterdomänen, ``*`` schaltet die Prüfung
ab. Der Port zählt nicht. Fehlt der Host-Header ganz (HTTP/1.0, Skripte),
geht die Anfrage durch: Ein Browser lässt ihn nie weg.
"""

from __future__ import annotations

import ipaddress
from collections.abc import Iterable

BUILTIN = ("localhost", "testserver")


def split_host(value: str) -> str:
    """Hostname ohne Port, klein, ohne Punkt am Ende; IPv6 ohne Klammern."""
    v = (value or "").strip().lower()
    if v.startswith("["):
        end = v.find("]")
        return v[1:end] if end > 0 else v
    if v.count(":") == 1:
        v = v.split(":", 1)[0]
    return v.rstrip(".")


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        return False


def parse_allowed(raw: str) -> tuple[str, ...]:
    return tuple(h for h in (split_host(x) for x in (raw or "").split(",")) if h)


def host_allowed(header: str | None, extra: Iterable[str] = ()) -> bool:
    if header is None or header.strip() == "":
        return True
    host = split_host(header)
    if not host:
        return False
    if host in BUILTIN or _is_ip(host):
        return True
    for pattern in extra:
        if pattern == "*" or host == pattern:
            return True
        if pattern.startswith("*.") and host.endswith(pattern[1:]) and len(host) > len(pattern) - 1:
            return True
    return False


class HostGuardMiddleware:
    """ASGI-Schicht: falscher Host → 400, bevor irgendeine Route läuft."""

    def __init__(self, app, allowed_hosts: str = ""):
        self.app = app
        self.extra = parse_allowed(allowed_hosts)

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        host = None
        for k, v in scope.get("headers") or ():
            if k == b"host":
                host = v.decode("latin-1")
                break
        if host_allowed(host, self.extra):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = b"Invalid host header"
        await send({"type": "http.response.start", "status": 400, "headers": [
            (b"content-type", b"text/plain; charset=utf-8"),
            (b"content-length", str(len(body)).encode()),
            (b"cache-control", b"no-store"),
        ]})
        await send({"type": "http.response.body", "body": body})
