"""UPS Live-Tracking — Sendungsverfolgung über die UPS REST API.

Zweistufig: OAuth 2.0 (client credentials) holt das Zugriffstoken, die
Track API v1 (``GET /api/track/v1/details/{trackingNumber}``) liefert den
Status. Das Token wird pro (Basis-URL, Client-ID) gecacht und vor Ablauf
erneuert — nicht pro Abfrage neu anfordern, UPS drosselt das.

Prinzip wie ``services/erp_sync.py``: der Client fragt nur ab, er deutet
nichts. Die Deutung — Shipment-Status nachziehen, Audit-Log schreiben —
bleibt im Router (``routers/shipping.py``). Nicht konfiguriert heißt kein
Auftritt: ``track()`` liefert dann ``ok=False`` mit klarem Grund, statt den
Versand mit einem Stacktrace zu beenden.

ENV (Betreiber, UPS Developer Portal → Apps → OAuth):
    UPS_CLIENT_ID / UPS_CLIENT_SECRET  — Zugangsdaten der App
    UPS_ACCOUNT_NUMBER                 — eigene Kontonummer (für Zoll/Referenz)
    ALPHA_UPS_BASE_URL                 — Testumgebung: https://wwwcie.ups.com
"""

from __future__ import annotations

import base64
import logging
import threading
import time
import uuid
from typing import Any

import httpx

from ..config import ENV_PREFIX, get_settings

log = logging.getLogger("alpha.ups")

# Das Token ist ~2 Stunden gültig; wir holen es fünf Minuten vor Ablauf neu.
TOKEN_SAFETY_SECONDS = 300

UPS_STATUS: dict[str, tuple[str, str]] = {
    # UPS-Status-Typ → (unser Status, Kurztext)
    "M": ("pre_transit", "Sendung angemeldet"),
    "P": ("in_transit", "Abholung"),
    "I": ("in_transit", "Unterwegs"),
    "D": ("delivered", "Zugestellt"),
    "X": ("exception", "Störung"),
    "RS": ("returned", "Rücksendung"),
}


def is_ups_shipment(carrier: str, tracking: str) -> bool:
    """Sieht diese Sendung nach UPS aus? Der Speditionseintrag ist Freitext,
    also zusätzlich am klassischen 1Z-Präfix der Sendungsnummer erkennen."""
    if "ups" in (carrier or "").lower():
        return True
    return (tracking or "").strip().upper().startswith("1Z")


def _ups_datetime(date: str, time_s: str) -> str:
    """UPS liefert Datum (YYYYMMDD) und Zeit (HHMMSS) in Ortszeit —
    unverändert als ISO-String durchreichen, keine erfundene Zeitzone."""
    if not date:
        return ""
    try:
        from datetime import datetime

        dt = datetime.strptime(f"{date}{(time_s or '000000').zfill(6)}",
                               "%Y%m%d%H%M%S")
        return dt.isoformat()
    except ValueError:
        return ""


def _ups_date(date: str) -> str:
    if not date or len(date) != 8:
        return ""
    return f"{date[0:4]}-{date[4:6]}-{date[6:8]}"


def normalize_track_payload(payload: dict, tracking_number: str) -> dict:
    """UPS-Antwort auf ein kleines, stabiles Format bringen — die Router
    und die Oberfläche sollen nicht die UPS-Struktur kennenlernen müssen."""
    shipments = (payload.get("trackResponse") or {}).get("shipment") or []
    if not shipments:
        return {"ok": False, "reason": "empty", "tracking_number": tracking_number,
                "error": "UPS kennt diese Sendungsnummer nicht (noch)."}
    shipment = shipments[0]
    packages = shipment.get("package") or [{}]
    pkg = packages[0]

    activities = []
    for a in pkg.get("activity") or []:
        addr = (a.get("location") or {}).get("address") or {}
        st = a.get("status") or {}
        activities.append({
            "when": _ups_datetime(a.get("date"), a.get("time")),
            "city": addr.get("city", ""),
            "postal": addr.get("postalCode", ""),
            "country": addr.get("country", ""),
            "type": st.get("type", ""),
            "description": st.get("description", ""),
        })
    # UPS listet die Aktivitäten neueste zuerst — so lassen.

    status_field = pkg.get("packageStatus") or {}
    ups_type = status_field.get("type", "") or (activities[0]["type"] if activities else "")
    our_status, label = UPS_STATUS.get(ups_type, ("unknown", ups_type or "unbekannt"))

    return {
        "ok": True,
        "reason": "",
        "tracking_number": tracking_number,
        "status": our_status,
        "status_label": label,
        "ups_type": ups_type,
        "description": status_field.get("description", ""),
        "eta": _ups_date(pkg.get("scheduledDeliveryDate", "")),
        "delivered": our_status == "delivered",
        "last_activity": activities[0] if activities else None,
        "activity": activities,
    }


class UPSTrackingClient:
    """Kleiner REST-Client gegen onlinetools.ups.com (oder wwwcie.ups.com
    für die Testumgebung). Ohne Zugangsdaten antwortet er höflich statt mit
    Ausnahme — der Versand läuft auch ohne UPS weiter."""

    def __init__(self, client_id: str = "", client_secret: str = "",
                 base_url: str = "", account_number: str = "",
                 transaction_src: str = ENV_PREFIX.rstrip("_").lower() + "-versand", timeout: float = 10.0):
        self.client_id = client_id
        self.client_secret = client_secret
        self.base_url = (base_url or "https://onlinetools.ups.com").rstrip("/")
        self.account_number = account_number
        self.transaction_src = transaction_src
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    def health(self) -> dict:
        return {
            "mode": "ups-rest",
            "configured": self.configured,
            "base_url": self.base_url,
        }

    # -- OAuth -----------------------------------------------------------

    def _get_token(self) -> str:
        key = (self.base_url, self.client_id)
        with _TOKEN_LOCK:
            cached = _TOKENS.get(key)
            if cached and cached["expires_at"] - TOKEN_SAFETY_SECONDS > time.time():
                return cached["token"]
            basic = base64.b64encode(
                f"{self.client_id}:{self.client_secret}".encode()).decode()
            with httpx.Client(timeout=self.timeout) as client:
                r = client.post(
                    f"{self.base_url}/security/v1/oauth/token",
                    headers={"Authorization": f"Basic {basic}",
                             "Content-Type": "application/x-www-form-urlencoded"},
                    data={"grant_type": "client_credentials"},
                )
            r.raise_for_status()
            data = r.json()
            expires_in = int(data.get("expires_in") or 3600)
            _TOKENS[key] = {"token": data["access_token"],
                            "expires_at": time.time() + expires_in}
            return data["access_token"]

    # -- Track API -------------------------------------------------------

    def track(self, tracking_number: str) -> dict:
        tn = (tracking_number or "").strip()
        if not tn:
            return {"ok": False, "reason": "no_number",
                    "error": "Keine Sendungsnummer hinterlegt."}
        if not self.configured:
            return {"ok": False, "reason": "not_configured",
                    "error": ("UPS ist nicht konfiguriert — UPS_CLIENT_ID und "
                              "UPS_CLIENT_SECRET setzen (siehe .env.example).")}
        try:
            token = self._get_token()
            headers = {
                "Authorization": f"Bearer {token}",
                "transId": uuid.uuid4().hex,
                "transactionSrc": self.transaction_src,
                "Accept": "application/json",
            }
            params = {"locale": "de_DE", "returnSignature": "false"}
            with httpx.Client(timeout=self.timeout) as client:
                r = client.get(f"{self.base_url}/api/track/v1/details/{tn}",
                               headers=headers, params=params)
            if r.status_code == 404:
                return {"ok": False, "reason": "unknown", "tracking_number": tn,
                        "error": "UPS kennt diese Sendungsnummer nicht (noch)."}
            r.raise_for_status()
            return normalize_track_payload(r.json(), tn)
        except httpx.HTTPStatusError as e:
            log.warning("UPS track %s: HTTP %s", tn, e.response.status_code)
            return {"ok": False, "reason": "http", "tracking_number": tn,
                    "error": f"UPS-Fehler {e.response.status_code}."}
        except Exception as e:  # Netzwerk, OAuth, Parse — nie den Versand blockieren
            log.warning("UPS track %s: %s", tn, e)
            return {"ok": False, "reason": "request", "tracking_number": tn,
                    "error": "UPS nicht erreichbar."}


# Token-Cache pro (Basis-URL, Client-ID) — uvicorn kann mehrere Threads fahren.
_TOKEN_LOCK = threading.Lock()
_TOKENS: dict[tuple[str, str], dict[str, Any]] = {}


def client_from_settings() -> UPSTrackingClient:
    s = get_settings()
    return UPSTrackingClient(
        client_id=s.ups_client_id, client_secret=s.ups_client_secret,
        base_url=s.ups_base_url, account_number=s.ups_account_number,
    )
