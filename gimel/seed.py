"""Ersteinrichtung: Schema anlegen, fehlende Spalten nachziehen, den ersten
Administrator erzeugen. Stammdaten bringt die Anwendung über ihr Plugin mit."""

from __future__ import annotations

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from .config import ENV_PREFIX, get_settings
from .db import Base, SessionLocal, engine
from .extensions import active
from .models import Role, User
from .security import hash_password
from .services import settings_store


def seed_admin(db: Session) -> User | None:
    """Erster Administrator — nur, wenn es noch gar keinen Benutzer gibt.

    Das Passwort steht in der Konfiguration und muss nach dem ersten Anmelden
    geändert werden. Ein fest eingebautes Passwort wäre dieselbe Attrappe wie
    die PIN der Prototyp-Supportseite.
    """
    if db.query(User).count():
        return None
    s = get_settings()
    if not (s.bootstrap_admin_email and s.bootstrap_admin_password):
        return None
    admin = User(
        email=s.bootstrap_admin_email.strip().lower(),
        password_hash=hash_password(s.bootstrap_admin_password),
        name="Erstzugang",
        role=Role.admin,
        active=True,
    )
    db.add(admin)
    return admin


# Spalten, die nach dem ersten Ausrollen dazugekommen sind. ``create_all``
# legt neue *Tabellen* an, aber keine neuen *Spalten* in bestehenden — eine
# vorhandene alpha.db bekäme sie sonst nie zu sehen und stürbe beim ersten
# SELECT. Alembic gehört in dieses Projekt (CLAUDE.md Phase 0.3); bis dahin ist
# ein idempotentes ALTER ehrlicher als ein „bitte Datenbank löschen".
ADDED_COLUMNS: dict[str, dict[str, str]] = {
    "products": {
        # Werkstoffrichtung und Wendbarkeit — Schranken der Dreh- und
        # Spiegeloption des Rechenkerns (2.9.0-lite). Bestehende Datenbanken
        # erben "none"/an, bis die Stammdaten sie ausdrücklich setzen.
        "grain": "VARCHAR(20) DEFAULT 'none'",
        "flip_ok": "BOOLEAN DEFAULT 1",
        # Verkaufspreis je Dicke (VK €/m²) aus der Einkaufsliste (2.10.0-lite).
        "eur_m2_thk": "JSON",
        # Mindeststeg im Teil — die Latte für Loch- und Ringstege, nicht der
        # Spannrand der Schachtelung (der bleibt `web`).
        "min_web": "FLOAT",
    },
    "orders": {
        # Auftragsart und verantwortlicher Mitarbeiter eines internen Auftrags.
        "kind": "VARCHAR(10) DEFAULT 'external'",
        "internal_owner": "VARCHAR(160) DEFAULT ''",
        "due_date": "DATETIME",
        "released": "BOOLEAN DEFAULT 1",
        "release_note": "VARCHAR(200) DEFAULT ''",
        "rush": "BOOLEAN DEFAULT 0",
        "paid": "BOOLEAN DEFAULT 0",
        "paid_at": "DATETIME",
        "payment_ref": "VARCHAR(120) DEFAULT ''",
        "payment_method": "VARCHAR(20) DEFAULT ''",
        "price_check": "JSON",
        "anon_id": "VARCHAR(64) DEFAULT ''",
        "claimed_at": "DATETIME",
        "invoice_no": "VARCHAR(40) DEFAULT ''",
        "invoiced_at": "DATETIME",
        "invoice_due_at": "DATETIME",
        "invoice_reference": "VARCHAR(140) DEFAULT ''",
        "contact_email": "VARCHAR(254) DEFAULT ''",
        "email_retain_until": "DATETIME",
        "handler_user_id": "INTEGER",
        "handler_reason": "VARCHAR(300) DEFAULT ''",
        "handler_at": "DATETIME",
        # Manueller Versand aus dem Auftragsbüro — Vorgabe für den Versand.
        "manual_shipment": "JSON",
        # Standorte (2026-11, Aufgabe 32): Eingang und Fertigungsort-Vorgabe.
        "site_id": "INTEGER",
        "route_scope": "VARCHAR(200) DEFAULT ''",
        # Auftragslebenslauf (2026-11, Aufgabe 45): anhalten, stornieren,
        # Büronotiz, Änderungszähler.
        "held_at": "DATETIME",
        "hold_reason": "VARCHAR(200) DEFAULT ''",
        "cancelled_at": "DATETIME",
        "cancel_reason": "VARCHAR(200) DEFAULT ''",
        "office_note": "TEXT DEFAULT ''",
        "rev": "INTEGER DEFAULT 0",
    },
    "shipments": {
        # Versandkosten, von Hand erfasst (manueller Versand / Nachtrag).
        "price": "FLOAT DEFAULT 0",
    },
    "twin_views": {
        # Twin Studio (2026-11-07): Besitz über die Konto-Id statt der E-Mail.
        "created_by_id": "INTEGER",
    },
    "factory_floors": {
        "name": "VARCHAR(120) DEFAULT 'Halle'",
        "zones": "JSON",
        "obstacles": "JSON",
        # Förderbänder (2026-11-07, task 37).
        "conveyors": "JSON",
        "doors": "JSON",
        "aisles": "JSON",
        "grid": "FLOAT DEFAULT 1.0",
        "snap": "FLOAT DEFAULT 0.25",
        "hall_id": "INTEGER",
        "level": "INTEGER DEFAULT 0",
        "level_name": "VARCHAR(60) DEFAULT ''",
        "elevation_m": "FLOAT DEFAULT 0",
        "height_m": "FLOAT DEFAULT 6",
    },
    "factory_stations": {
        "machine_kind": "VARCHAR(20) DEFAULT ''",
        "speed_mm_s": "FLOAT DEFAULT 0",
        "pierce_s": "FLOAT DEFAULT 0",
        "setup_min": "FLOAT DEFAULT 0",
        "changeover_min": "FLOAT DEFAULT 0",
        "handling_min_per_plate": "FLOAT DEFAULT 0",
        "max_sheet_w": "FLOAT DEFAULT 0",
        "max_sheet_h": "FLOAT DEFAULT 0",
        "thk_min": "FLOAT DEFAULT 0",
        "thk_max": "FLOAT DEFAULT 0",
        "cost_per_h": "FLOAT DEFAULT 0",
        "capacity_min_per_day": "FLOAT DEFAULT 0",
        "is_storage": "BOOLEAN DEFAULT 0",
        "task_min": "FLOAT DEFAULT 0",
        "unit_min": "FLOAT DEFAULT 0",
        "note": "TEXT DEFAULT ''",
        "model_file": "VARCHAR(180) DEFAULT ''",
        "model_scale": "FLOAT DEFAULT 1.0",
        "model_rotation": "FLOAT DEFAULT 0",
        "model_kind": "VARCHAR(16) DEFAULT ''",
        "staffed": "BOOLEAN DEFAULT 0",
        "floor_id": "INTEGER",
    },
    "addresses": {
        "is_delivery": "BOOLEAN DEFAULT 0",
    },
    "order_positions": {
        "note": "VARCHAR(500) DEFAULT ''",
        "external_note": "VARCHAR(500) DEFAULT ''",
        "price_gross": "FLOAT DEFAULT 0",
        # Formfamilie für die Rüststufe der festen Einrichtung (2.10.0-lite).
        "fam": "VARCHAR(20) DEFAULT ''",
        # Herkunft aus der Formenbibliothek (2026-11) — der Rückweg von der
        # Bestellposition zur Form und ihre Verwendung. Bestehende Aufträge
        # bleiben ohne Kennung: ihre Kontur ist da, die Herkunft nicht.
        "shape_id": "INTEGER",
    },
    "work_plates": {
        # Gedreht verbauter Teller (GRE, 2026-09): das Schnittband läuft dann
        # über die Plattenbreite. Bestandsplatten bleiben 0 — sie wurden vor
        # dem Umbau immer hochkant gerechnet.
        "turned": "BOOLEAN DEFAULT 0",
        # Platte aus einem Reststück (offcuts.id) — Reststücke, Aufgabe 44.
        "offcut_id": "INTEGER",
        # Zugeordnete Materialcharge (material_lots.id) — Lieferkette.
        "lot_id": "INTEGER",
    },
    "work_orders": {
        # Handlage im Schachtel-Editor (2026-11): leer heißt Lage des Rechenkerns.
        "auto_layout": "JSON",
        "layout_edited_at": "DATETIME",
        "layout_edited_by": "VARCHAR(160) DEFAULT ''",
        "layout_rev": "INTEGER DEFAULT 0",
        "cut_files_issued_at": "DATETIME",
        "formats": "JSON",
        "release_reason": "VARCHAR(200) DEFAULT ''",
        "policy_mode": "VARCHAR(20) DEFAULT 'sammel'",
        "nest_options": "JSON",
        "order_done": "JSON",
        "station_id": "INTEGER",
        "assign_mode": "VARCHAR(12) DEFAULT ''",
        "assign_score": "FLOAT DEFAULT 0",
        "assign_reason": "VARCHAR(400) DEFAULT ''",
        "assigned_at": "DATETIME",
        "assigned_by": "VARCHAR(254) DEFAULT ''",
        "planned_min": "FLOAT DEFAULT 0",
        "material_staged_at": "DATETIME",
        "material_staged_by": "VARCHAR(254) DEFAULT ''",
        # Aus welchem Lagerort die Platten kamen (2026-11). Bestehende
        # Bereitstellungen bleiben ohne Ort — das ist ehrlicher als ein
        # nachträglich erfundener.
        "material_staged_location_id": "INTEGER",
        "material_staged_location": "VARCHAR(200) DEFAULT ''",
        "route_scope": "VARCHAR(200) DEFAULT ''",
    },
    "users": {
        # Zweiter Faktor (2026-09). Bestandskonten bekommen die Spalten leer
        # und bleiben damit ohne 2FA — einschalten ist eine Kundenentscheidung
        # und darf niemanden beim Aufspielen aussperren.
        # Auftragssperre und Büronotiz am Kunden (2026-11, Aufgabe 45).
        "order_block": "BOOLEAN DEFAULT 0",
        "order_block_reason": "VARCHAR(200) DEFAULT ''",
        "office_note": "TEXT DEFAULT ''",
        "totp_secret_enc": "TEXT DEFAULT ''",
        "totp_enabled": "BOOLEAN DEFAULT 0",
        "totp_confirmed_at": "DATETIME",
        "totp_last_slot": "INTEGER DEFAULT 0",
        "mfa_failed_count": "INTEGER DEFAULT 0",
        "mfa_locked_until": "DATETIME",
        # Bis 2026-10 standen diese fünf unter einem zweiten Schlüssel "users"
        # weiter oben; der zweite überschrieb den ersten, ältere Datenbanken
        # bekamen die Spalten nie. Ein Schlüssel je Tabelle.
        "failed_login_count": "INTEGER DEFAULT 0",
        "locked_until": "DATETIME",
        "email_verified": "BOOLEAN DEFAULT 0",
        "credit_limit": "FLOAT DEFAULT 0",
        "vat_id": "VARCHAR(40) DEFAULT ''",
    },
    "price_history": {
        # Dicke des geänderten Satzes (eur_m2_thk); leer = Bezugspreis eur_m2.
        "thk": "FLOAT",
    },
    "batch_policies": {
        "nest_gap": "FLOAT",
        "nest_margin": "FLOAT",
        "nest_trim_w": "FLOAT",
        "nest_trim_h": "FLOAT",
        "max_orders_per_group": "INTEGER",
        "max_plates_per_group": "INTEGER",
    },
    "stock_movements": {
        "thk": "FLOAT",
        "lot_id": "INTEGER",
        "purchase_order_no": "VARCHAR(30) DEFAULT ''",
    },
    "offcuts": {
        "lot_id": "INTEGER",
    },
    "station_tasks": {
        # Ein Mensch hat die Aufgabe geschlossen; der Abgleich respektiert das,
        # solange sich die Quelle nicht ändert (siehe services/worklist.py).
        "closed_at": "DATETIME",
        "closed_by": "VARCHAR(254) DEFAULT ''",
        "closed_key": "VARCHAR(120) DEFAULT ''",
        "closed_reason": "VARCHAR(200) DEFAULT ''",
    },
    "suppliers": {
        "city": "VARCHAR(120) DEFAULT ''",
        "region": "VARCHAR(40) DEFAULT ''",
        "lat": "FLOAT",
        "lon": "FLOAT",
        "transit_corridors": "JSON",
        "materials_tags": "JSON",
    },
}


def ensure_columns(verbose: bool = False) -> list[str]:
    """Fehlende Spalten nachziehen. Tut nichts, wenn alles da ist."""
    added: list[str] = []
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    with engine.begin() as conn:
        for table, columns in ADDED_COLUMNS.items():
            if table not in existing_tables:
                continue
            have = {c["name"] for c in inspector.get_columns(table)}
            for name, ddl in columns.items():
                if name in have:
                    continue
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                added.append(f"{table}.{name}")
    if verbose and added:
        print("Spalten ergänzt: " + ", ".join(added))
    return added


# Indizes für Großdaten / Millionen Aufträge. Idempotent per CREATE INDEX IF NOT EXISTS,
# damit auch bestehende Datenbanken (ohne Alembic) alle zusammengesetzten Indizes erhalten.
INDEXES: list[tuple[str, str, str]] = [
    # Aufträge — Sortierung, Pipeline, Zahlung, Rechnung, Fristen, Suche
    ("ix_orders_created_id", "orders", "created_at DESC, id DESC"),
    ("ix_orders_due_date", "orders", "due_date"),
    ("ix_orders_invoiced_at", "orders", "invoiced_at DESC"),
    ("ix_orders_invoice_due_at", "orders", "invoice_due_at"),
    ("ix_orders_cancelled_at", "orders", "cancelled_at"),
    ("ix_orders_held_at", "orders", "held_at"),
    ("ix_orders_stage_cancel_created", "orders", "stage, cancelled_at, created_at DESC"),
    ("ix_orders_user_paid_cancel", "orders", "user_id, paid, cancelled_at"),
    ("ix_orders_release_flags", "orders", "released, blocked, held_at, cancelled_at"),
    ("ix_orders_invoice_paid", "orders", "invoice_no, paid, invoiced_at DESC"),
    ("ix_orders_customer_ref", "orders", "customer_ref"),
    ("ix_orders_invoice_ref", "orders", "invoice_reference"),
    ("ix_orders_paid_at", "orders", "paid_at"),
    ("ix_orders_email_retain", "orders", "email_retain_until"),
    # Auftragspositionen — Sammellauf, Versandbereitschaft, Werkstoffsuche
    ("ix_order_positions_order_status", "order_positions", "order_id, production_status"),
    ("ix_order_positions_status_kind_order", "order_positions", "production_status, kind, order_id"),
    ("ix_order_positions_mat", "order_positions", "mat"),
    # Innenaufträge, Platten & Teile
    ("ix_work_orders_status_created", "work_orders", "status, created_at DESC"),
    ("ix_work_orders_station_status", "work_orders", "station_id, status"),
    ("ix_work_orders_run_status", "work_orders", "run_id, status"),
    ("ix_work_orders_created_at", "work_orders", "created_at DESC"),
    ("ix_work_plates_offcut_id", "work_plates", "offcut_id"),
    ("ix_work_plates_status", "work_plates", "status"),
    ("ix_work_items_wo_order", "work_items", "work_order_id, order_no"),
    ("ix_work_items_wo_pos", "work_items", "work_order_id, position_id"),
    # Sendungen
    ("ix_shipments_status_created", "shipments", "status, created_at DESC"),
    ("ix_shipments_created_at", "shipments", "created_at DESC"),
    ("ix_shipments_tracking", "shipments", "tracking"),
    # Benutzer & Kunden
    ("ix_users_role_active", "users", "role, active"),
    ("ix_users_customer_no", "users", "customer_no"),
    ("ix_users_company_name", "users", "company, name, email"),
    # Protokoll (Audit)
    ("ix_audit_log_entity_id_at", "audit_log", "entity, entity_id, at DESC"),
    ("ix_audit_log_action_entity_id", "audit_log", "action, entity_id"),
    ("ix_audit_log_actor", "audit_log", "actor"),
    # Lager & Aufgaben
    ("ix_stock_movements_prod_created", "stock_movements", "product_id, created_at DESC"),
    ("ix_station_tasks_state_kind_station", "station_tasks", "state, kind, station_id"),
    ("ix_station_tasks_kind_state_done", "station_tasks", "kind, state, done_at DESC"),
    ("ix_station_tasks_ref", "station_tasks", "kind, ref"),
    # Rechnungen
    ("ix_local_invoices_kind_issued", "local_invoices", "kind, issue_date DESC"),
]


def ensure_indexes(verbose: bool = False) -> list[str]:
    """Fehlende Leistungsindizes anlegen — idempotent für SQLite und PostgreSQL."""
    created: list[str] = []
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())
    cols_by_table: dict[str, set[str]] = {}
    idx_by_table: dict[str, set[str]] = {}
    with engine.begin() as conn:
        for idx_name, table, cols_expr in INDEXES:
            if table not in existing_tables:
                continue
            if table not in cols_by_table:
                cols_by_table[table] = {c["name"] for c in inspector.get_columns(table)}
                idx_by_table[table] = {i["name"] for i in inspector.get_indexes(table)}
            if idx_name in idx_by_table[table]:
                continue
            # Prüfen, ob alle genannten Spalten existieren
            col_names = [part.strip().split()[0] for part in cols_expr.split(",")]
            if not all(c in cols_by_table[table] for c in col_names):
                continue
            conn.execute(text(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table} ({cols_expr})"))
            created.append(idx_name)
    if verbose and created:
        print(f"Indizes angelegt: {len(created)}")
    return created


def backfill_delivery_flag(verbose: bool = False) -> int:
    """Bestehende Anschriften auf den neuen Lieferstandard heben.

    ``is_delivery`` startet überall auf 0 — ein Kunde ohne Lieferstandard
    würde an der Auftragserfassung ins Ratefallen. Pro Kunde wird die erste
    Anschrift, die nicht zugleich Rechnungsanschrift ist (sonst die erste
    überhaupt), zum Lieferstandard erklärt. Idempotent: wer schon einen
    Standard hat, bleibt unangetastet.
    """
    have_addresses = "addresses" in set(inspect(engine).get_table_names())
    if not have_addresses:
        return 0
    have = {c["name"] for c in inspect(engine).get_columns("addresses")}
    if "is_delivery" not in have or "is_billing" not in have:
        return 0
    # Schneller Kurzschluss: existiert überhaupt ein Benutzer ohne Lieferstandard?
    with engine.connect() as conn:
        needs = conn.execute(
            text(
                """
                SELECT 1 FROM addresses a
                WHERE a.is_delivery = 0
                  AND NOT EXISTS (
                      SELECT 1 FROM addresses b
                      WHERE b.user_id = a.user_id AND b.is_delivery = 1
                  )
                LIMIT 1
                """
            )
        ).first()
    if needs is None:
        return 0
    stmt = text(
        """
        UPDATE addresses SET is_delivery = 1
        WHERE id IN (
            SELECT x.id FROM addresses x
            WHERE x.user_id IN (
                SELECT user_id FROM addresses
                GROUP BY user_id
                HAVING SUM(CASE WHEN is_delivery = 1 THEN 1 ELSE 0 END) = 0
            )
            AND x.id = (
                SELECT y.id FROM addresses y
                WHERE y.user_id = x.user_id
                ORDER BY y.is_billing ASC, y.id ASC
                LIMIT 1
            )
        )
        """
    )
    with engine.begin() as conn:
        result = conn.execute(stmt)
    if verbose and result.rowcount:
        print(f"Lieferstandard nachgetragen: {result.rowcount} Anschrift(en)")
    return result.rowcount


def backfill_sites(verbose: bool = False) -> int:
    """Den Bestand in Standort → Halle → Ebene heben.

    Bis 2026-11 gab es genau einen Grundriss ohne Halle. Jede Ebene ohne
    Halle kommt in „Halle 1" am ersten Standort; fehlt beides, wird es
    angelegt. Stationen bleiben unberührt: ``floor_id`` leer heißt erste
    Ebene. Idempotent — wer schon eine Halle hat, bleibt, wo er ist.
    """
    from .db import SessionLocal
    from .models import FactoryFloor, FactoryHall, FactorySite

    with SessionLocal() as db:
        orphans = db.query(FactoryFloor).filter(FactoryFloor.hall_id.is_(None)).all()
        if not orphans:
            return 0
        site = db.query(FactorySite).order_by(FactorySite.id.asc()).first()
        if site is None:
            site = FactorySite(name="Standort 1", code="S1")
            db.add(site)
            db.flush()
        hall = (
            db.query(FactoryHall)
            .filter(FactoryHall.site_id == site.id)
            .order_by(FactoryHall.id.asc())
            .first()
        )
        if hall is None:
            hall = FactoryHall(site_id=site.id, name="Halle 1", code="H1")
            db.add(hall)
            db.flush()
        for f in orphans:
            f.hall_id = hall.id
            f.level = f.level or 0
            if not f.level_name:
                f.level_name = "EG"
        db.commit()
        if verbose:
            print(f"Ebenen einer Halle zugeordnet: {len(orphans)}")
        return len(orphans)


def init_db(verbose: bool = True) -> dict:
    Base.metadata.create_all(bind=engine)
    ensure_columns(verbose=verbose)
    ensure_indexes(verbose=verbose)
    backfill_delivery_flag(verbose=verbose)
    backfill_sites(verbose=verbose)
    plugin = active()
    db = SessionLocal()
    try:
        result = dict(plugin.seed(db, verbose)) if plugin and plugin.seed else {}
        admin = seed_admin(db)
        db.commit()
        settings_store.ensure_defaults(db)
        result["admin"] = admin.email if admin else None
    finally:
        db.close()
    if verbose:
        print(
            f"Datenbank bereit — {result.get('products', 0)} Werkstoffe, "
            f"{result.get('rates', 0)} Sätze"
            + (f", Erstzugang {result['admin']}" if result["admin"] else "")
        )
        if result["admin"]:
            print(
                f"  Passwort aus {ENV_PREFIX}BOOTSTRAP_ADMIN_PASSWORD — bitte sofort ändern."
            )
    return result


if __name__ == "__main__":
    init_db()
