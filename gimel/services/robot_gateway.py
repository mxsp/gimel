"""Die Naht zum Flotten-Gateway — lokal, hochstufig, ohne Aktor-Befehl.

Gimel schickt **Aufträge und Programmstände**, keine Geschwindigkeit, keine
Gelenkwinkel und keinen Not-Halt. Kollisionsvermeidung, Zonenfreigabe und
sicheres Bremsen gehören in die Flottensteuerung; ein zweiter Regler über
HTTP wäre eine Gefahr, keine Funktion.

Die Protokolle liegen hinter einem kleinen Adapter: ``sim`` rechnet nur,
``http`` ruft die eingetragenen Pfade auf, ``vda5050`` ist ehrlich noch nicht
verdrahtet. Die Adresse muss lokal sein (localhost, privates Netz,
``.local``/``.lan``/``.internal`` oder ein einzelner Rechnername) — Gimel ist
LAN-only, und ein Cloud-Endpunkt wäre ein stiller Bruch dieser Regel.

Der HTTP-Client ist austauschbar (``CLIENT_FACTORY``), damit ein Test Netz,
Zeitüberschreitung und Ablehnung ohne echten Server prüfen kann.
"""

from __future__ import annotations

import ipaddress
from typing import Any, Protocol
from urllib.parse import urlparse

import httpx

TIMEOUT_S = 5.0
LOCAL_SUFFIXES = (".local", ".lan", ".internal", ".home.arpa")

#: Wird von Tests ersetzt; muss ``httpx.Client(**kwargs)`` nachbilden.
CLIENT_FACTORY = httpx.Client


class GatewayError(ValueError):
    """Ein Gateway-Auftrag ist so nicht ausführbar."""


class GatewayAdapter(Protocol):
    """Was ein Gateway können muss: einen Auftrag annehmen und sich prüfen."""

    def deliver(self, action: str, payload: dict) -> dict: ...

    def probe(self) -> dict: ...


def _local_host(host: str) -> bool:
    h = (host or "").strip().lower().strip("[]")
    if not h:
        return False
    if h in ("localhost", "host.docker.internal", "::1"):
        return True
    try:
        ip = ipaddress.ip_address(h)
        return ip.is_private or ip.is_loopback or ip.is_link_local
    except ValueError:
        return h.endswith(LOCAL_SUFFIXES) or "." not in h


def check_url(url: str) -> str:
    """Eine Gateway-Adresse prüfen und normalisiert zurückgeben."""
    raw = (url or "").strip()
    if not raw:
        raise GatewayError("Das Gateway hat keine Adresse.")
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https"):
        raise GatewayError("Die Gateway-Adresse muss mit http:// oder https:// beginnen.")
    if parsed.username or parsed.password:
        raise GatewayError("Zugangsdaten gehören nicht in die Adresse.")
    if not parsed.hostname or not _local_host(parsed.hostname):
        raise GatewayError(
            "Die Gateway-Adresse muss im lokalen Netz liegen — Gimel ist LAN-only."
        )
    if parsed.port is not None and not (1 <= parsed.port <= 65535):
        raise GatewayError("Der Port der Gateway-Adresse ist ungültig.")
    return raw.rstrip("/")


def _kind(gateway: Any) -> str:
    return (getattr(gateway, "kind", "") or "sim").strip().lower()


def _enabled(gateway: Any) -> bool:
    return bool(getattr(gateway, "enabled", True))


def _token(gateway: Any) -> str:
    return str(getattr(gateway, "token", "") or "").strip()


def _endpoint(gateway: Any, key: str) -> str:
    endpoints = gateway.endpoints if isinstance(gateway.endpoints, dict) else {}
    value = str(endpoints.get(key) or "").strip()
    if not value:
        raise GatewayError(f"Am Gateway fehlt der Endpunkt „{key}“.")
    if value.startswith(("http://", "https://")):
        return check_url(value)
    if not value.startswith("/") or ".." in value.split("/"):
        raise GatewayError(f"Der Endpunkt „{key}“ muss ein lokaler Pfad sein.")
    return check_url(gateway.base_url) + value


def _client() -> httpx.Client:
    return CLIENT_FACTORY(timeout=TIMEOUT_S, follow_redirects=False)


def _headers(gateway: Any, *, body: bool = False) -> dict[str, str]:
    headers: dict[str, str] = {}
    token = _token(gateway)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body:
        headers["Content-Type"] = "application/json"
    return headers


def _message(response: Any) -> str:
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        for key in ("message", "detail", "error", "status"):
            if body.get(key):
                return str(body[key])[:300]
    text = (getattr(response, "text", "") or "").strip().replace("\n", " ")
    return text[:300] or f"HTTP {response.status_code}"


def _post(gateway: Any, key: str, payload: dict) -> dict:
    url = _endpoint(gateway, key)
    try:
        with _client() as client:
            response = client.post(url, json=payload, headers=_headers(gateway, body=True))
    except httpx.HTTPError as exc:
        return {"ok": False, "state": "failed",
                "message": f"Gateway nicht erreichbar: {type(exc).__name__}"}
    if 200 <= response.status_code < 300:
        return {"ok": True, "state": "accepted", "message": _message(response),
                "http_status": response.status_code}
    return {"ok": False, "state": "rejected", "message": _message(response),
            "http_status": response.status_code}


class SimAdapter:
    """Rechnet nur und sagt das auch — nie ein Gerät."""

    def __init__(self, gateway: Any):
        self.gateway = gateway

    def deliver(self, action: str, payload: dict) -> dict:
        return {"ok": True, "state": "accepted",
                "message": "Simulation — kein Gerät angesprochen."}

    def probe(self) -> dict:
        return {"ok": True, "message": "Simulation — immer erreichbar."}


class HttpAdapter:
    """Der eingetragene lokale HTTP-Endpunkt; kein Redirect, kein Cloud-Ziel."""

    def __init__(self, gateway: Any):
        self.gateway = gateway

    def deliver(self, action: str, payload: dict) -> dict:
        return _post(self.gateway, action, payload)

    def probe(self) -> dict:
        try:
            url = _endpoint(self.gateway, "health")
        except GatewayError as exc:
            return {"ok": False, "message": str(exc)}
        try:
            with _client() as client:
                response = client.get(url, headers=_headers(self.gateway))
        except httpx.HTTPError as exc:
            return {"ok": False, "message": f"Gateway nicht erreichbar: {type(exc).__name__}"}
        return {"ok": 200 <= response.status_code < 300,
                "message": _message(response), "http_status": response.status_code}


class Vda5050Adapter:
    """Der Platz für einen lokalen MQTT-Adapter — noch nicht verdrahtet."""

    def __init__(self, gateway: Any):
        self.gateway = gateway

    def deliver(self, action: str, payload: dict) -> dict:
        return {"ok": False, "state": "rejected",
                "message": "VDA 5050 ist noch nicht verdrahtet — kein MQTT-Adapter eingerichtet."}

    def probe(self) -> dict:
        return {"ok": False, "message": "Art „vda5050“ hat keine Prüfung."}


class UnknownAdapter:
    def __init__(self, kind: str):
        self.kind = kind

    def deliver(self, action: str, payload: dict) -> dict:
        return {"ok": False, "state": "rejected", "message": f"Unbekannte Gateway-Art: {self.kind}"}

    def probe(self) -> dict:
        return {"ok": False, "message": f"Art „{self.kind}“ hat keine Prüfung."}


def adapter_for(gateway: Any) -> GatewayAdapter:
    kind = _kind(gateway)
    if kind == "sim":
        return SimAdapter(gateway)
    if kind == "http":
        return HttpAdapter(gateway)
    if kind == "vda5050":
        return Vda5050Adapter(gateway)
    return UnknownAdapter(kind)


def deliver(gateway: Any, action: str, payload: dict) -> dict:
    """Einen hochstufigen Auftrag ausliefern — sim, http oder ehrlich nichts.

    ``action`` ist ``deploy``, ``command`` oder ``cancel``. Der Rückgabewert
    ist immer dieselbe Form: ``ok``, ``state``, ``message``. Ein Netzfehler
    beendet keinen Auftrag still; der Aufrufer schreibt den Zustand fest.
    """
    if _kind(gateway) != "sim" and not _enabled(gateway):
        return {"ok": False, "state": "rejected", "message": "Das Gateway ist ausgeschaltet."}
    return adapter_for(gateway).deliver(action, payload)


def probe(gateway: Any) -> dict:
    """Erreichbarkeit prüfen, ohne einen Auftrag zu erzeugen."""
    return adapter_for(gateway).probe()
