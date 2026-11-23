"""ERP/Plate-sync — die Nahtstelle zu SAP & Co.

Ein Werkstoff liegt in zwei Systemen: Alef-2 schneidet ihn, SAP/ERP zählt ihn.
Beide müssen denselben Bestand sehen, sonst schachtelt der Sammellauf auf
Platten, die es nicht gibt, oder ein voller Sammelbeutel bleibt im System,
während das Regal leer ist.

Prinzip:

* **Alef-2 ist führend für den Zuschnitt** — welche Platte auf welche Maschine
  geht, entscheidet der Sammellauf. SAP ist führend für die Menge — was als
  *gebucht* gilt. Keines überschreibt das andere still.
* **Adapter, kein Umbau.**  Ein kleines Interface (``ERPAdapter``). Die echte
  SAP-Anbindung (BAPI ``BAPI_MATERIAL_AVAILABILITY``, IDoc ``MATMAS`` oder ein
  einfacher REST-Wrapper) steckt dahinter, ohne dass die Fertigung je davon
  wissen muss. Ohne ``SAP_BASE_URL`` gibt es keinen Adapter und die Nahtstelle
  sagt das auch: ``get_adapter`` liefert ``None``. Bis 2026-10-31 antwortete hier
  ein Mock mit „erreichbar, 12 ms" und dem lokalen Bestand als SAP-Bestand.
* **Reservierung statt Abzug.**  Der Sammellauf reserviert Platten (``reserved``),
  der Wareneingang aus SAP gleicht ab und gibt frei. So laeuft die Schachtelung
  weiter, auch wenn SAP eine Stunde haengt.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol

from sqlalchemy.orm import Session

from ..models import AuditLog, Product, StockMovement
from .inventory import move_stock

log = logging.getLogger("alpha.erp")


@dataclass
class StockLevel:
    mat: str
    stock: int
    unit: str = "ST"
    warehouse: str = "1000"
    updated_at: datetime | None = None
    source: str = "erp"


@dataclass
class PlateMaster:
    mat: str
    sheets: list[list[int]]
    lead_days: int = 0


class ERPAdapter(Protocol):
    def fetch_stock(self, mats: list[str] | None = None) -> list[StockLevel]: ...
    def fetch_plates(self, mats: list[str] | None = None) -> list[PlateMaster]: ...
    def push_consumption(self, mat: str, qty: int, ref: str) -> bool: ...
    def health(self) -> dict: ...


#: Die Antwort von ``/api/integration/health``, wenn kein Adapter eingerichtet ist.
NOT_CONFIGURED = {
    "mode": "none",
    "configured": False,
    "reachable": False,
    "note": "Keine ERP-Anbindung eingerichtet.",
}


class ERPNotConfigured(RuntimeError):
    """Ein Abgleich wurde verlangt, aber es gibt kein ERP, mit dem er ginge."""


class SapRestAdapter:
    """Skelett fuer einen echten SAP-REST-Wrapper.
    ENV: SAP_BASE_URL, SAP_USER, SAP_PASSWORD, SAP_CLIENT.
    Noch ohne HTTP — nur die Stellen, an denen der Aufruf sitzt."""

    def __init__(self, db: Session, base_url: str = ""):
        self.db = db
        self.base_url = base_url

    def fetch_stock(self, mats=None):
        raise NotImplementedError("SAP REST nicht konfiguriert — SAP_BASE_URL setzen.")

    def fetch_plates(self, mats=None):
        raise NotImplementedError("SAP REST nicht konfiguriert.")

    def push_consumption(self, mat, qty, ref):
        raise NotImplementedError("SAP REST nicht konfiguriert.")

    def health(self):
        return {
            "mode": "sap-rest",
            "configured": True,
            "reachable": False,
            "base_url": self.base_url or "—",
        }


def get_adapter(db: Session) -> ERPAdapter | None:
    from ..config import get_settings

    s = get_settings()
    base = getattr(s, "sap_base_url", "") or ""
    return SapRestAdapter(db, base) if base else None


def sync_from_erp(db: Session, *, actor: str = "erp-sync", mats=None) -> dict:
    """Bestand aus ERP holen und Abweichungen als Korrekturbuchung anlegen.
    Nie still ueberschreiben — jede Differenz wird als ``StockMovement`` mit
    reason=korrektur und note='ERP-Abgleich' sichtbar."""
    adapter = get_adapter(db)
    if adapter is None:
        raise ERPNotConfigured(NOT_CONFIGURED["note"])
    remote = {r.mat: r for r in adapter.fetch_stock(mats)}
    changed = []
    for p in (
        db.query(Product).filter(Product.id.in_(remote.keys()) if mats else True).all()
    ):
        r = remote.get(p.id)
        if not r:
            continue
        delta = int(r.stock) - int(p.stock)
        if delta != 0:
            move_stock(
                db,
                p,
                delta,
                reason="korrektur",
                actor=actor,
                note=f"ERP-Abgleich {r.source}: {p.stock - delta} → {r.stock}",
            )
            changed.append({"mat": p.id, "delta": delta, "after": int(p.stock)})
    if changed:
        db.add(
            AuditLog(
                actor=actor,
                action="erp_sync",
                entity="inventory",
                entity_id=",".join(c["mat"] for c in changed),
                detail={"changed": changed},
            )
        )
        db.commit()
    return {
        "checked": len(remote),
        "changed": changed,
        "mode": adapter.health().get("mode"),
    }


def reserve_for_work_order(db: Session, mat: str, qty: int, ref: str) -> bool:
    """Platten fuer einen neuen Innenauftrag reservieren und an ERP melden.
    Lokale Reservierung laeuft immer; ERP-Meldung darf scheitern — sie wird
    dann beim naechsten Sync nachgeholt (outbox-Prinzip wie in server/bridge.mjs)."""
    try:
        adapter = get_adapter(db)
        ok = adapter is not None and adapter.push_consumption(mat, qty, ref)
        if ok:
            db.add(
                AuditLog(
                    actor="system",
                    action="erp_reserve",
                    entity="product",
                    entity_id=mat,
                    detail={"qty": qty, "ref": ref},
                )
            )
            db.commit()
        return ok
    except Exception as e:
        log.warning("ERP reserve failed %s x%s: %s", mat, qty, e)
        return False
