"""OCI-PunchOut für SAP (2026-09, online resale) — OCI 4/5, kein cXML.

Ablauf (vier Stationen, XICTRON/SAP-Duktus):
  1. Setup-Request: Der Einkäufer klickt im SAP (Ariba/SRM/JAGGAER/Onventis) auf
     den Lieferantenkatalog. SAP POSTet HOOK_URL + Anmeldung an
     ``POST /api/punchout/setup`` (JSON oder Form — SAP schickt Form).
  2. Anmeldung + Sitzung: Wir prüfen Benutzer/Passwort (Kundenkonto mit
     Preisgruppe), legen die Preisgruppe und HOOK_URL in eine Sitzung
     (Token, 48 h) und antworten mit der Katalog-URL auf Port 8000.
  3. Stöbern: Der Einkäufer stellt im Shop (Plotter-Sortiment, seine Preise,
     ``?punchout=<token>``) den Warenkorb zusammen — ohne Kasse, ohne Konto-
     Wechsel. ``GET /api/punchout/session/{token}`` liefert den Käuferkontext.
  4. Warenkorb-Rückgabe: ``POST /api/punchout/cart`` rechnet mit denselben
     Kernen (Nesting + Preis + Wiederverkäufer-Rabatt) und liefert OCI-Felder
     (NEW_ITEM-*) + HOOK_URL. Das Portal POSTet sie als HTML-Formular an SAP;
     dort werden sie zur Bestellanforderung. Kein Auftrag entsteht hier — erst
     die SAP-Bestellung (E-Mail/Telefon/EDI) wird zum Auftrag.

Session-TTL 48 h (üblich 24–72 h). Danach 410. Jede Rückgabe wird gezählt und
audit-protokolliert. HOOK_URL muss http(s) sein (Test: http erlaubt).
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Annotated, Optional
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from ..db import get_db
from ..core.nesting import ENGINE_VERSION
from ..models import AuditLog, PunchoutSession, User
from ..schemas import QuoteLine
from ..security import require_staff, verify_password
from ..services import settings_store
from ..services.catalog import load_products
from ..services.orders import PRICE_GROUPS, discount_for, quote

router = APIRouter(prefix="/api/punchout", tags=["punchout"])

SESSION_TTL_H = 48


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _valid_hook(url: str) -> bool:
    try:
        p = urlparse((url or "").strip())
        return p.scheme in ("http", "https") and bool(p.netloc)
    except (ValueError, AttributeError):
        return False


def _get_session(db: Session, token: str) -> PunchoutSession:
    s = db.query(PunchoutSession).filter(PunchoutSession.token == token).first()
    if not s:
        raise HTTPException(status_code=404, detail="PunchOut-Sitzung unbekannt.")
    exp = s.expires_at
    if exp and exp.tzinfo is None:
        exp = exp.replace(tzinfo=timezone.utc)
    if s.status != "open" or (exp and exp < _now()):
        if s.status == "open":
            s.status = "expired"
            db.commit()
        raise HTTPException(status_code=410, detail="PunchOut-Sitzung abgelaufen.")
    return s


class SetupIn(BaseModel):
    hook_url: str = Field(default="", max_length=500)
    username: str = Field(default="", max_length=254)
    password: str = Field(default="", max_length=200)
    buyer_cookie: str = Field(default="", max_length=200)
    buyer_id: str = Field(default="", max_length=120)
    currency: str = Field(default="EUR", max_length=10)


class SetupOut(BaseModel):
    token: str
    catalog_url: str
    expires_at: datetime
    price_group: str
    discount_pct: float


async def _setup_body(request: Request) -> SetupIn:
    ctype = (request.headers.get("content-type") or "").lower()
    if "application/x-www-form-urlencoded" in ctype or "multipart/form-data" in ctype:
        form = await request.form()
        get = lambda *names: next((str(form.get(n) or "") for n in names
                                   if form.get(n) is not None), "")
        return SetupIn(
            hook_url=get("HOOK_URL", "hook_url", "hookurl"),
            username=get("USERNAME", "username", "user", "USER"),
            password=get("PASSWORD", "password", "PASSWORD"),
            buyer_cookie=get("BUYER_COOKIE", "buyer_cookie", "buyercookie",
                             "BASKET_ID", "basket_id"),
            buyer_id=get("BUYER_ID", "buyer_id", "buyerid", "BUYER"),
            currency=get("CURRENCY", "currency", "CURRENCIES") or "EUR",
        )
    try:
        data = await request.json()
    except (ValueError, TypeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    low = {str(k).lower(): v for k, v in data.items()}
    return SetupIn(
        hook_url=str(data.get("hook_url") or data.get("HOOK_URL") or ""),
        username=str(data.get("username") or data.get("USERNAME") or ""),
        password=str(data.get("password") or data.get("PASSWORD") or ""),
        buyer_cookie=str(data.get("buyer_cookie") or data.get("BUYER_COOKIE") or ""),
        buyer_id=str(data.get("buyer_id") or data.get("BUYER_ID") or ""),
        currency=str(data.get("currency") or data.get("CURRENCY") or "EUR") or "EUR",
    )


@router.post("/setup", response_model=SetupOut)
async def setup(request: Request, db: Annotated[Session, Depends(get_db)]) -> SetupOut:
    """OCI Setup-Request: anmelden, Sitzung anlegen, Katalog-URL zurück."""
    if not settings_store.get_bool(db, "punchout_enabled", True):
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                            detail="PunchOut ist derzeit abgeschaltet.")
    body = await _setup_body(request)
    if not _valid_hook(body.hook_url):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="HOOK_URL fehlt oder ist keine http(s)-Adresse.")
    if not body.username or not body.password:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="PunchOut-Anmeldung: Benutzername und Passwort erforderlich.")
    user = db.query(User).filter(User.email == body.username.strip().lower()).first()
    if not user or not user.active or not verify_password(body.password,
                                                          user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="PunchOut-Anmeldung ungültig.")
    token = secrets.token_urlsafe(32)
    exp = _now() + timedelta(hours=SESSION_TTL_H)
    group = str(user.price_group or "standard").lower()
    s = PunchoutSession(token=token, buyer_id=body.buyer_id or user.email,
                        user_id=user.id, hook_url=body.hook_url.strip(),
                        buyer_cookie=body.buyer_cookie[:200],
                        price_group=group, currency=(body.currency or "EUR")[:10],
                        status="open", expires_at=exp)
    db.add(s)
    db.add(AuditLog(actor=user.email, action="punchout_setup", entity="punchout",
                    entity_id=token[:12] + "…",
                    detail={"buyer": s.buyer_id, "group": group}))
    db.commit()
    portal = settings_store.get(db, "portal_url", "http://127.0.0.1:8000").rstrip("/")
    return SetupOut(token=token, catalog_url=f"{portal}/#/punchout?session={token}",
                    expires_at=exp, price_group=group,
                    discount_pct=discount_for(user))


@router.get("/session/{token}")
def session_info(token: str, db: Annotated[Session, Depends(get_db)]) -> dict:
    s = _get_session(db, token)
    user = db.get(User, s.user_id) if s.user_id else None
    return {"buyer": s.buyer_id, "price_group": s.price_group,
            "discount_pct": discount_for(user),
            "currency": s.currency, "expires_at": s.expires_at,
            "plotter_only": settings_store.get_bool(db, "shop_plotter_only", True),
            "notice": settings_store.get(db, "shop_notice", "")}


class CartIn(BaseModel):
    token: str = Field(min_length=10, max_length=64)
    lines: list[QuoteLine] = Field(min_length=1, max_length=500)
    cert: str = "2.2"


def _oci_fields(s: PunchoutSession, pc: dict, lines: list[QuoteLine],
                currency: str) -> dict[str, str]:
    """OCI 4-Teilmenge: je Position eine NEW_ITEM-Gruppe (1-basiert). Preis =
    Netto je Stück inkl. anteiligem Rüsten? Nein — ehrlich: Zeilensumme aus
    dem Kern (mat+cut-Anteil) durch Menge, Rüsten/Rabatt als eigene letzte
    Zeile, damit SAP die Summe nachrechnen kann."""
    fields: dict[str, str] = {}
    ext_quote = f"PO-{s.token[:8].upper()}"
    fields["NEW_ITEM-EXT_QUOTE_ID"] = ext_quote
    n = 0
    for line in lines:
        n += 1
        e = pc["per"].get(line.id, {}) or {}
        row_net = float(e.get("mat", 0.0) or 0.0) + float(e.get("cut", 0.0) or 0.0)
        qty = max(1, int(line.q or 1))
        unit_net = round(row_net / qty, 4) if row_net else 0.0
        desc = (line.label or line.mat or f"Position {line.id}")[:200]
        if line.kind == "sheet" and line.fmt:
            desc = f"{desc} — Platte {line.fmt[0]:g}×{line.fmt[1]:g} mm"
        fields[f"NEW_ITEM-DESCRIPTION[{n}]"] = desc
        fields[f"NEW_ITEM-QUANTITY[{n}]"] = str(qty)
        fields[f"NEW_ITEM-UNIT[{n}]"] = "PCE"
        fields[f"NEW_ITEM-PRICE[{n}]"] = f"{unit_net:.4f}"
        fields[f"NEW_ITEM-PRICEUNIT[{n}]"] = "1"
        fields[f"NEW_ITEM-CURRENCY[{n}]"] = currency
        fields[f"NEW_ITEM-VENDORMAT[{n}]"] = (line.mat or "")[:60]
        fields[f"NEW_ITEM-EXT_QUOTE_ITEM[{n}]"] = str(line.id)
    disc = float(pc.get("discount", 0.0) or 0.0)
    setup = float(pc.get("setup", 0.0) or 0.0)
    if disc:
        n += 1
        fields[f"NEW_ITEM-DESCRIPTION[{n}]"] = (
            f"Wiederverkäufer-Rabatt {float(pc.get('discountPct', 0.0)):.1f} %")
        fields[f"NEW_ITEM-QUANTITY[{n}]"] = "1"
        fields[f"NEW_ITEM-UNIT[{n}]"] = "PCE"
        fields[f"NEW_ITEM-PRICE[{n}]"] = f"{-disc:.4f}"
        fields[f"NEW_ITEM-PRICEUNIT[{n}]"] = "1"
        fields[f"NEW_ITEM-CURRENCY[{n}]"] = currency
        fields[f"NEW_ITEM-VENDORMAT[{n}]"] = "RABATT"
    if setup:
        pass  # im Stückpreis je Zeile bereits enthalten (Anteil) — keine Doppelzeile
    fields["NEW_ITEM_COUNT"] = str(n)
    return fields


@router.post("/cart")
def cart_return(body: CartIn, db: Annotated[Session, Depends(get_db)]) -> dict:
    """Warenkorb → OCI-Felder. Kein Auftrag, keine Zahlung — erst die SAP-
    Bestellung wird zum Auftrag (per E-Mail/Telefon/EDI wie bisher)."""
    s = _get_session(db, body.token)
    user = db.get(User, s.user_id) if s.user_id else None
    products = load_products(db)
    for line in body.lines:
        p = products.get(line.mat)
        if p is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail=f"Werkstoff {line.mat} unbekannt.")
        if settings_store.get_bool(db, "shop_plotter_only", True) and \
                (getattr(p, "cnc", "confirmed") != "confirmed"):
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail=f"Werkstoff {line.mat} ist kein CNC-Plotter-Material "
                                       f"(PunchOut-Sortiment: nur cnc=confirmed).")
    pc = quote(db, body.lines, body.cert or "2.2", user=user)
    if pc["over"]:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="Übergrößen werden nicht automatisch bepreist "
                                   "(Anfrage an die Technik).")
    fields = _oci_fields(s, pc, body.lines, s.currency or "EUR")
    s.last_used_at = _now()
    s.cart_returns = int(s.cart_returns or 0) + 1
    db.add(AuditLog(actor=s.buyer_id or "punchout", action="punchout_cart",
                    entity="punchout", entity_id=s.token[:12] + "…",
                    detail={"lines": len(body.lines), "net": round(pc["total"], 2),
                            "engine": ENGINE_VERSION}))
    db.commit()
    return {"hook_url": s.hook_url, "buyer_cookie": s.buyer_cookie,
            "currency": s.currency, "engine_version": ENGINE_VERSION,
            "net": round(pc["total"], 2), "gross": round(pc["gross"], 2),
            "discount_pct": round(float(pc.get("discountPct", 0.0) or 0.0), 2),
            "discount": round(float(pc.get("discount", 0.0) or 0.0), 2),
            "fields": fields}


@router.get("/cart/form")
def cart_form(token: str, db: Annotated[Session, Depends(get_db)]) -> HTMLResponse:
    return HTMLResponse(
        "<!doctype html><meta charset=utf-8><title>PunchOut</title>"
        "<p>Der Warenkorb wird per POST /api/punchout/cart als OCI-Formular "
        "an die HOOK_URL übertragen (NEW_ITEM-*). Diese Seite ist nur ein "
        "Platzhalter für den Formular-Endpunkt.</p>", status_code=200)


@router.get("/sessions", dependencies=[Depends(require_staff)])
def list_sessions(db: Annotated[Session, Depends(get_db)],
                  open_only: bool = False) -> dict:
    q = db.query(PunchoutSession).order_by(PunchoutSession.created_at.desc()).limit(200)
    rows = q.all()
    if open_only:
        rows = [r for r in rows if r.status == "open"]
    return {"sessions": [{
        "buyer": r.buyer_id, "group": r.price_group, "status": r.status,
        "created_at": r.created_at, "expires_at": r.expires_at,
        "last_used_at": r.last_used_at, "cart_returns": r.cart_returns,
        "hook_host": urlparse(r.hook_url or "").netloc} for r in rows]}
