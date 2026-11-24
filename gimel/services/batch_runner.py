"""Der Sammellauf: wartende Positionen einsammeln, gemeinsam schachteln,
Innenaufträge mit Plattenzeichnung und Zuordnungstabelle erzeugen.

Ablauf eines Laufs:

  1. Alle Positionen mit ``production_status = "pending"`` aus bezahlten,
     nicht gesperrten Aufträgen holen — über *alle* Kunden hinweg.
  2. Je Eimer (Werkstoff, Dicke; in Betriebsart ``sofort`` zusätzlich je
     Auftrag) entscheiden, ob geschnitten wird. Sechs Gründe, jeder für sich
     genügt: von Hand ausgelöst, Betriebsart sofort, Eilauftrag, Zusage rückt
     näher, Wartezeit über der Grenze, Platte voll oder Stückzahl beisammen.
     Sonst bleibt der Eimer liegen und sammelt weiter — das ist der ganze Sinn
     der Übung, und der Grund steht danach im Lauf.
  3. Die freigegebenen Eimer gemeinsam schachteln (domain/batch.py), Platte für
     Platte und je Platte im günstigsten Format.
  4. Je Eimer einen Innenauftrag anlegen, je Platte die Belegung speichern,
     je Teil eine Marke mit Auftrag und Kunde.
  5. Die verarbeiteten Positionen auf ``batched`` setzen; zurückgestellte
     bleiben ``pending`` und laufen im nächsten Takt wieder mit.

Was ein Lauf **nicht** tut: Preise anfassen. Der Kundenpreis steht mit der
Bestellung fest (CLAUDE.md §8.1/§8.2); der Sammellauf erzeugt nur Papiere für
die Fertigung. Die Plattenwahl des Kunden geht bewusst nicht mit ein: sie hat
seinen Preis bestimmt, die Werkstatt optimiert davon unabhängig — genau das ist
die Marge aus §8.2.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..core.batch import (MODE_BATCH, MODE_IMMEDIATE, BatchPart, NestOptions,
                            ReleasePolicy, plan_batch, release_times, solo_area)
from ..core.nesting import ENGINE_VERSION
from ..core.kerf import KERF_VERSION
from ..extensions import active
from ..core.nesting_gre import engine_label as gre_engine_label
from ..core.nesting_gre import gre_available
from ..db import chunked_in as _chunked_in
from ..models import (AuditLog, BatchPolicy, NestRun, Order, OrderPosition, Product,
                      WorkItem, WorkOrder, WorkOrderStatus, WorkPlate)
from . import batch_report, run_lock, settings_store
from .catalog import load_products, load_rates
from .events import bus
from .inventory import move_stock
from . import offcuts as offcut_svc
from .numbering import next_number

log = logging.getLogger("alpha.batch")


_run_lock = threading.RLock()
#: Ohne Anwendung darf ein Schachtelkandidat nicht unbegrenzt laufen. Alef bleibt
#: ohne Grenze: dort ist die Lage eines Laufs bisher reproduzierbar, und das bleibt so.
STANDALONE_NEST_MS = 5000.0


def _actual_label(engine: str, plates) -> str:
    """Die Wahrheit für Lauf und Innenauftrag: hat Kerf auf keiner Platte gewonnen,
    steht dort lite. Ein Etikett, das nur die Einstellung nachspricht, wäre falsch."""
    if engine == "kerf" and not any(p.engine.startswith("kerf") for p in plates):
        return ENGINE_VERSION
    return _engine_label(engine)


def nesting_engine(db: Session) -> str:
    """Der Schachtel-Motor der Fertigung — „kerf" (Vorgabe), „lite" oder „gre".

    „kerf" ist echte Konturschachtelung ohne Fremdinstallation; „lite" rechnet
    dabei als Untergrenze mit (``core/nesting_kerf.py``).

    „gre" schachtelt mit 5.3.0 und spart Material; die Kasse rechnet
    unangetastet mit 2.9.0-lite weiter (Preise sind bindend, §8.1). Fehlt die
    Installation, fällt der Schalter laut — nicht still — auf lite zurück:
    der Lauf zeigt in der Engine-Version, wer wirklich geschachtelt hat.
    """
    raw = settings_store.get(db, "nesting_engine", "kerf").strip().lower()
    if raw == "kerf":
        return "kerf"
    if raw == "gre" and gre_available():
        return "gre"
    if raw == "gre":
        return "lite"
    return "lite"


def _engine_label(engine: str) -> str:
    """Die Versionszeile für Lauf und Innenauftrag — die wahre Herkunft."""
    if engine == "kerf":
        return f"kerf-{KERF_VERSION}"
    return gre_engine_label() if engine == "gre" else ENGINE_VERSION


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _as_aware(dt: datetime | None) -> datetime | None:
    """SQLite gibt naive Zeitstempel zurück; für den Altersvergleich brauchen
    wir UTC-behaftete."""
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# --------------------------------------------------------------------------
# Freigaberegel: global, je Werkstoff überschreibbar
# --------------------------------------------------------------------------
def global_policy(db: Session) -> ReleasePolicy:
    mode = settings_store.get(db, "batch_mode", MODE_BATCH).strip().lower()
    return ReleasePolicy(
        mode=mode if mode in (MODE_BATCH, MODE_IMMEDIATE) else MODE_BATCH,
        min_parts=max(1, settings_store.get_int(db, "batch_min_parts", 1)),
        min_utilisation=min(1.0, max(0.0, settings_store.get_float(db, "batch_min_utilisation", 0.70))),
        max_age_minutes=max(0, settings_store.get_int(db, "batch_max_age_minutes", 1440)),
        due_lead_hours=max(0, settings_store.get_int(db, "batch_due_lead_hours", 48)),
        max_orders_per_group=max(0, settings_store.get_int(db, "batch_max_orders_per_work_order", 0)),
        max_plates_per_group=max(0, settings_store.get_int(db, "batch_max_plates_per_work_order", 0)),
    )


def global_grouping(db: Session) -> str:
    """Die gespeicherte Schachtelgruppe: Kunden mischen oder je Kunde trennen."""
    raw = settings_store.get(db, "batch_group_by", "material").strip().lower()
    return raw if raw in ("material", "customer") else "material"


def _policy_rows(db: Session, trial: BatchPolicy | None = None) -> list[BatchPolicy]:
    """Die Ausnahmezeilen; ``trial`` ist eine nie gespeicherte Probezeile für die
    Vorschau „was würde diese Regel ändern“ und ersetzt die Zeile mit ihrem Schlüssel."""
    rows = db.query(BatchPolicy).all()
    if trial is None:
        return rows
    return [r for r in rows if (r.mat, r.thk) != (trial.mat, trial.thk)] + [trial]


def policy_resolver(db: Session, trial: BatchPolicy | None = None):
    """``policy_for(mat, thk)`` — die genauere Zeile gewinnt.

    Reihenfolge: (Werkstoff, Dicke) schlägt (Werkstoff, alle Dicken) schlägt
    die globale Einstellung. Ein leeres Feld in der Ausnahmezeile erbt vom
    globalen Wert, damit eine Ausnahme nur das sagen muss, was sie ändert.
    """
    base = global_policy(db)
    rows = _policy_rows(db, trial)
    exact: dict[tuple[str, float], BatchPolicy] = {}
    any_thk: dict[str, BatchPolicy] = {}
    for r in rows:
        if r.thk is None:
            any_thk[r.mat] = r
        else:
            exact[(r.mat, float(r.thk))] = r

    def resolve(mat: str, thk: float) -> ReleasePolicy:
        row = exact.get((mat, float(thk))) or any_thk.get(mat)
        if row is None:
            return base
        mode = (row.mode or base.mode).strip().lower()
        return ReleasePolicy(
            mode=mode if mode in (MODE_BATCH, MODE_IMMEDIATE) else base.mode,
            min_parts=row.min_parts if row.min_parts is not None else base.min_parts,
            min_utilisation=(row.min_utilisation if row.min_utilisation is not None
                             else base.min_utilisation),
            max_age_minutes=(row.max_age_minutes if row.max_age_minutes is not None
                             else base.max_age_minutes),
            due_lead_hours=(row.due_lead_hours if row.due_lead_hours is not None
                            else base.due_lead_hours),
            max_orders_per_group=(row.max_orders_per_group if row.max_orders_per_group is not None
                                  else base.max_orders_per_group),
            max_plates_per_group=(row.max_plates_per_group if row.max_plates_per_group is not None
                                  else base.max_plates_per_group),
        )

    return resolve


def _opt_float(db: Session, key: str) -> float | None:
    """Ein leerer Betriebsparameter heißt „erben", nicht „null“."""
    raw = settings_store.get(db, key, "").strip()
    if raw == "":
        return None
    try:
        return float(raw.replace(",", "."))
    except ValueError:
        return None


def _opt_int(db: Session, key: str) -> int | None:
    v = _opt_float(db, key)
    return int(v) if v is not None else None


def _opt_bool(db: Session, key: str) -> bool | None:
    """Leer = Vorgabe des Kerns; sonst derselbe Wortlaut wie ``get_bool``."""
    raw = settings_store.get(db, key, "").strip().lower()
    if raw == "":
        return None
    return raw in ("1", "true", "yes", "ja", "on")


def global_options(db: Session) -> NestOptions:
    cand = _opt_float(db, "nest_max_candidates")
    gravity = settings_store.get(db, "nest_kerf_gravity", "top").strip().lower()
    return NestOptions(
        gap=_opt_float(db, "nest_gap_mm"),
        margin=_opt_float(db, "nest_margin_mm"),
        trim_w=max(0.0, settings_store.get_float(db, "nest_trim_w_mm", 0.0)),
        trim_h=max(0.0, settings_store.get_float(db, "nest_trim_h_mm", 0.0)),
        # Suchvorgaben: nur für die Fertigung. Die Kalkulation ruft nest()
        # ohne Richtlinie und bleibt damit unberührt (CLAUDE.md §5.5).
        max_ms=_opt_float(db, "nest_max_ms") or (None if active() else STANDALONE_NEST_MS),
        max_candidates=int(cand) if cand is not None else None,
        corner_max_dist=_opt_float(db, "nest_corner_max_mm"),
        allow_rotation=_opt_bool(db, "nest_allow_rotation"),
        allow_mirror=_opt_bool(db, "nest_allow_mirror"),
        kerf_steps=_opt_int(db, "nest_kerf_steps"),
        kerf_stall=_opt_int(db, "nest_kerf_stall"),
        kerf_cell=_opt_float(db, "nest_kerf_cell"),
        kerf_gravity=gravity if gravity in ("top", "left") else None,
        kerf_seed=_opt_int(db, "nest_kerf_seed"),
        kerf_refine=_opt_bool(db, "nest_kerf_refine"),
    )


def options_resolver(db: Session, trial: BatchPolicy | None = None):
    """``options_for(mat, thk)`` — wie die Freigaberegel, nur für die Geometrie.

    Dieselbe Vererbung: die genauere Zeile gewinnt, ein leeres Feld erbt. Ein
    Werkstoff mit grober Schnittfuge braucht mehr Abstand, ein Blechlaminat eine
    breitere Spannkante — beides ist eine Eigenschaft des Materials und keine
    des Betriebs.
    """
    base = global_options(db)
    rows = _policy_rows(db, trial)
    exact = {(r.mat, float(r.thk)): r for r in rows if r.thk is not None}
    any_thk = {r.mat: r for r in rows if r.thk is None}

    def resolve(mat: str, thk: float) -> NestOptions:
        row = exact.get((mat, float(thk))) or any_thk.get(mat)
        if row is None:
            return base
        return NestOptions(
            gap=row.nest_gap if row.nest_gap is not None else base.gap,
            margin=row.nest_margin if row.nest_margin is not None else base.margin,
            trim_w=row.nest_trim_w if row.nest_trim_w is not None else base.trim_w,
            trim_h=row.nest_trim_h if row.nest_trim_h is not None else base.trim_h,
            # Die Suchvorgaben sind betriebsweit; eine Materialzeile stellt
            # Geometrie ein, nicht wie lange gerechnet werden darf.
            max_ms=base.max_ms,
            max_candidates=base.max_candidates,
            corner_max_dist=base.corner_max_dist,
            allow_rotation=base.allow_rotation,
            allow_mirror=base.allow_mirror,
            kerf_steps=base.kerf_steps,
            kerf_stall=base.kerf_stall,
            kerf_cell=base.kerf_cell,
            kerf_gravity=base.kerf_gravity,
            kerf_seed=base.kerf_seed,
            kerf_refine=base.kerf_refine,
        )

    return resolve


# --------------------------------------------------------------------------
# Einsammeln
# --------------------------------------------------------------------------
def collect_pending(db: Session, *, customer_ids: set[int] | None = None) -> list[BatchPart]:
    """Alle wartenden Positionen mit ihrer Herkunft.

    Der Filter auf ``released`` ist ausdrücklich und nicht beiläufig: er ist
    die eine Stelle, an der entschieden wird, ob für einen Auftrag Material
    geschnitten werden darf. Über die Kasse setzt ihn der Zahlungseingang, bei
    einer verbindlichen Bestellung auf Rechnung die Bestellung selbst, und das
    Personal kann ihn jederzeit zurückziehen.

    ``customer_ids`` ist der ausdrückliche Wunsch „nur diese Kunden jetzt“ —
    eine leere Auswahl heißt nicht „niemand“, sondern „keine Eingrenzung“.
    """
    q = (db.query(OrderPosition, Order)
              .join(Order, OrderPosition.order_id == Order.id)
              .filter(OrderPosition.production_status == "pending")
              .filter(OrderPosition.kind == "gasket")
              .filter(Order.blocked.is_(False))
              .filter(Order.released.is_(True))
              # Angehaltene und stornierte Aufträge bleiben liegen (Aufgabe 45).
              .filter(Order.held_at.is_(None))
              .filter(Order.cancelled_at.is_(None)))
    if customer_ids:
        q = q.filter(Order.user_id.in_(sorted(customer_ids)))
    rows = q.order_by(OrderPosition.id).all()
    from . import sites

    scopes: dict[int, str] = {}
    for _, order in rows:
        if order.id not in scopes:
            scopes[order.id] = sites.resolve_received(order, db)
    return [_batch_part(pos, order, scopes[order.id]) for pos, order in rows]


def _batch_part(pos: OrderPosition, order: Order, route_scope: str = "") -> BatchPart:
    ship = order.ship_address or {}
    if (order.kind or "external") == "internal":
        # Die Werkstatt liest statt eines Kundennamens den verantwortlichen
        # Mitarbeiter — ohne ihn wäre der interne Auftrag anonym.
        customer = order.internal_owner or "Intern"
        customer_key = f"internal:{(order.internal_owner or order.no).strip().lower()}"
    else:
        customer = (ship.get("company") or ship.get("contact")
                    or (order.user.company if order.user else "")
                    or (order.user.email if order.user else "Gast"))
        # Das Konto ist die stabile Kennung; der Name ist nur die Anzeige.
        customer_key = (f"user:{order.user_id}" if order.user_id is not None
                        else f"name:{customer.strip().lower()}")
    return BatchPart(
        position_id=pos.id, order_no=order.no, customer=customer,
        customer_ref=order.customer_ref, label=pos.label or pos.mat,
        mat=pos.mat, thk=float(pos.thk), od=float(pos.od), di=float(pos.di or 0),
        q=int(pos.qty), bn=int(pos.bolt_count or 0), bd=float(pos.bolt_d or 0),
        bc=float(pos.bolt_circle or 0), cut_len=float(pos.cut_len or 0),
        shape=pos.shape,
        ordered_at=_as_aware(order.created_at),
        due_date=_as_aware(order.due_date),
        rush=bool(order.rush),
        route_scope=route_scope,
        customer_key=customer_key,
        customer_id=order.user_id,
    )


# --------------------------------------------------------------------------
# Der Lauf
# --------------------------------------------------------------------------
def run_batch(db: Session, *, trigger: str = "interval", actor: str = "system",
              force: bool = False,
              only: set[tuple[str, float]] | None = None,
              customers: set[int] | None = None,
              group_by: str | None = None,
              only_positions: set[int] | None = None) -> NestRun:
    """Einen Sammellauf ausführen und speichern. Gibt den Lauf zurück, auch
    wenn nichts zu tun war — ein leerer Lauf ist eine Information, kein Fehler.

    Immer nur einer zugleich. Das Schachteln selbst hält keine Schreibsperre mehr:
    der Lauf wird erst danach angelegt, sonst stünde bei langen Läufen die ganze
    Anwendung (SQLite kennt nur einen Schreiber).

    ``only`` beschränkt den Lauf auf diese (Werkstoff, Dicke), ``customers``
    auf diese Kundenkonten. Es bleibt derselbe Lauf durch dieselbe Rechnung,
    nur mit weniger Teilen; wartet dort nichts mehr, gibt es einen Fehler statt
    eines leeren Laufs. ``group_by="customer"`` trennt zusätzlich die Eimer.

    """
    with _run_lock:
        with run_lock.hold("batch"):
            return _run_batch(db, trigger=trigger, actor=actor, force=force, only=only,
                              customers=customers, group_by=group_by,
                              only_positions=only_positions)


def _run_batch(db: Session, *, trigger: str, actor: str, force: bool,
               only: set[tuple[str, float]] | None = None,
               customers: set[int] | None = None,
               group_by: str | None = None,
               only_positions: set[int] | None = None) -> NestRun:
    prefix = settings_store.get(db, "run_prefix", "SL-26")
    engine = nesting_engine(db)

    def new_run() -> NestRun:
        started = NestRun(no=next_number(db, "nest_run", prefix), trigger=trigger,
                          engine_version=_engine_label(engine))
        db.add(started)
        db.flush()
        return started

    pending = collect_pending(db, customer_ids=customers)
    if only_positions is not None:
        pending = [p for p in pending if p.position_id in only_positions]
        if not pending:
            raise RenestError(
                "Die zurückgestellten Positionen sind nicht mehr offen — "
                "vielleicht wurde der Lauf schon gestartet."
            )
    if only is not None:
        pending = [p for p in pending if (p.mat, float(p.thk)) in only]
        if not pending:
            raise RenestError("In diesem Eimer wartet nichts mehr — er wurde schon geschnitten.")
    if not pending and customers:
        raise RenestError("Für diese Kundenauswahl wartet nichts mehr — bitte Auswahl prüfen.")
    if not pending:
        run = new_run()
        run.finished_at = _now()
        db.commit()
        return run

    products = load_products(db)
    rates = load_rates(db)
    mixed = settings_store.get_bool(db, "batch_mixed_formats", True)
    grouping = (group_by if group_by in ("material", "customer")
                else global_grouping(db))
    groups, held_buckets = plan_batch(pending, products, rates,
                                      policy_for=policy_resolver(db),
                                      options_for=options_resolver(db),
                                      force=force, mixed_formats=mixed,
                                      now=_now(), engine=engine, group_by=grouping)
    # Lese-Transaktion vor Schreibbeginn schließen, damit SQLite WAL die
    # zwischenzeitlichen Änderungen anderer Anfragen sieht.
    if not (db.new or db.dirty or db.deleted):
        db.commit()
    run = new_run()

    # Unter der Schreibsperre gegen den aktuellen Datenbankstand gegenprüfen:
    # während plan_batch() kann ein Auftrag storniert, angehalten oder
    # zurückgezogen worden sein.
    stale_notes: list[str] = []
    if groups:
        all_pos_ids = {
            pid
            for g in groups
            for pid in (
                *(p.position_id for p in g.parts),
                *(p.position_id for p in g.oversize),
                *(item["position_id"] for pl in g.plates for item in pl.placements),
            )
        }
        eligible_ids: set[int] = set()
        if all_pos_ids:
            eligible_ids = {
                pid
                for (pid,) in (
                    db.query(OrderPosition.id)
                    .join(Order, OrderPosition.order_id == Order.id)
                    .filter(_chunked_in(OrderPosition.id, all_pos_ids))
                    .filter(OrderPosition.production_status == "pending")
                    .filter(OrderPosition.kind == "gasket")
                    .filter(Order.blocked.is_(False))
                    .filter(Order.released.is_(True))
                    .filter(Order.held_at.is_(None))
                    .filter(Order.cancelled_at.is_(None))
                    .all()
                )
            }
        valid_groups = []
        for g in groups:
            g_ids = (
                {p.position_id for p in g.parts}
                | {p.position_id for p in g.oversize}
                | {item["position_id"] for pl in g.plates for item in pl.placements}
            )
            if g_ids.issubset(eligible_ids):
                valid_groups.append(g)
            else:
                stale_notes.append(
                    f"{g.mat} {g.thk:g} mm (Auftrag während Schachtelung geändert)"
                )
        groups = valid_groups

    # Plattendeckel: eine Bremse, kein Auslöser. Dringendes zuerst, dann die
    # ältere Zusage — was nicht mehr hineinpasst, bleibt ganz liegen. Ganze
    # Gruppen und keine halben: eine halb freigegebene Gruppe wäre ein Plan,
    # den niemand nachvollziehen kann.
    cap = max(0, settings_store.get_int(db, "batch_max_plates_per_run", 0))
    if cap:
        far = datetime.max.replace(tzinfo=timezone.utc)
        budget = cap
        keep: set[int] = set()
        for g in sorted(groups, key=lambda g: (g.due_date or far, g.mat, g.thk)):
            if len(g.plates) <= budget:
                budget -= len(g.plates)
                keep.add(id(g))
        held_buckets += [_capped_bucket(g, cap) for g in groups if id(g) not in keep]
        # Reihenfolge der verbleibenden Gruppen unangetastet lassen — ein Lauf
        # muss mit demselben Bestand denselben Plan ergeben (Invariante 5).
        groups = [g for g in groups if id(g) in keep]

    notes: list[str] = []
    for h in held_buckets:
        notes.append(f"{h.mat} {h.thk:g} mm ({h.reason})")
    for g in groups:
        if g.held:
            pieces = sum(max(1, p.q) for p in g.held)
            notes.append(f"{g.mat} {g.thk:g} mm ({pieces} Teile auf angebrochener Platte "
                         f"sammeln weiter)")
    notes.extend(stale_notes)
    if notes:
        run.note = "Zurückgestellt: " + " · ".join(notes)

    if not groups:
        run.n_positions = len(pending) if not stale_notes else 0
        run.finished_at = _now()
        db.commit()
        return run

    wo_prefix = settings_store.get(db, "work_order_prefix", "IA-26")
    product_rows = {p.id: p for p in db.query(Product).all()}
    # Reststücke: erst die Zustände nachziehen (fertige Quellen liegen jetzt im
    # Lager), dann je Gruppe prüfen, welche Platte auf ein Reststück passt.
    off_cfg = offcut_svc.config(db)
    if off_cfg["enabled"]:
        offcut_svc.refresh(db)
    off_place = offcut_svc.default_place(db) if off_cfg["enabled"] else (None, "")
    product_names = {p.id: p.name for p in product_rows.values()}

    n_plates = n_parts = 0
    order_nos: set[str] = set()
    batched_position_ids: set[int] = set()
    manual_position_ids: set[int] = set()
    released_position_ids: set[int] = set()

    for g in groups:
        oversize_ids = {p.position_id for p in g.oversize}
        # Übergrößen werden nie automatisch eingeplant — sie gehen als Anfrage
        # an die Technik (CLAUDE.md §5.1). Sie bleiben aus dem Innenauftrag raus.
        manual_position_ids |= oversize_ids
        released_position_ids |= {p.position_id for p in g.parts}
        if not g.plates or all(not pl.placements for pl in g.plates):
            continue

        # Welche Platten auf ein Reststück kommen. Die Lage bleibt dieselbe; nur
        # das Format wird das des Reststücks, so wie es aufgelegt wird.
        on_offcut: dict = {}
        if off_cfg["enabled"]:
            pool = offcut_svc.available_for(db, g.mat, g.thk)
            if pool:
                margin = float((g.nest_options or {}).get("margin") or 0.0)
                on_offcut = offcut_svc.choose(g.plates, pool, margin)
        if on_offcut:
            counts: dict[tuple[float, float], int] = {}
            for pl in g.plates:
                dims = on_offcut[pl.idx][1] if pl.idx in on_offcut else (pl.fmt[0], pl.fmt[1])
                counts[dims] = counts.get(dims, 0) + 1
            g_formats = [[w, h, n] for (w, h), n in sorted(counts.items())]
        else:
            g_formats = g.formats
        n_full = len(g.plates) - len(on_offcut)

        wo = WorkOrder(
            no=next_number(db, "work_order", wo_prefix), run_id=run.id, mat=g.mat,
            mat_name=product_names.get(g.mat, g.mat), thk=g.thk,
            fmt=[g.fmt[0], g.fmt[1]], formats=g_formats, status=WorkOrderStatus.open,
            n_plates=len(g.plates), n_parts=g.n_parts, n_orders=len(g.order_nos),
            used_area_m2=round(g.used_area_m2, 6), plate_area_m2=round(g.plate_area_m2, 6),
            utilisation=round(g.utilisation, 6),
            engine_version=_actual_label(engine, g.plates),
            due_date=g.due_date, release_reason=g.release_reason[:200],
            policy_mode=g.policy_mode, nest_options=g.nest_options,
            # In einem Eimer haben alle Teile dieselbe Vorgabe (group_key).
            route_scope=(g.parts[0].route_scope if g.parts else ""),
        )
        db.add(wo)
        db.flush()

        # Jede geplante Platte ist eine, die gleich vom Regal in die Maschine
        # geht — der Bestand zieht mit, nicht erst wenn der Werker den Schnitt
        # meldet. Ohne Zeile im Lager (Werkstoff nur aus der Domäne bekannt,
        # nie angelegt) bleibt die Buchung aus, statt gegen nichts zu schreiben.
        # Platten aus einem Reststück ziehen keine volle Platte ab.
        product_row = product_rows.get(g.mat)
        if product_row is not None and n_full > 0:
            extra = f" · {len(on_offcut)} aus Reststück" if on_offcut else ""
            move_stock(db, product_row, -n_full, reason="sammellauf",
                      actor="system", work_order_no=wo.no,
                      note=f"{wo.no} · {g.thk:g} mm · {wo.fmt[0]:g}×{wo.fmt[1]:g} mm{extra}")

        for pl in g.plates:
            pick = on_offcut.get(pl.idx)
            fmt = [pick[1][0], pick[1][1]] if pick else [pl.fmt[0], pl.fmt[1]]
            plate = WorkPlate(
                work_order_id=wo.id, idx=pl.idx, fmt=fmt,
                used_h=round(pl.used_h, 3), turned=pl.turned,
                n_parts=len(pl.placements),
                utilisation=round(pl.utilisation, 6), placements=pl.placements,
                offcut_id=pick[0].id if pick else None,
            )
            db.add(plate)
            db.flush()
            if pick:
                pick[0].status, pick[0].work_order_no = "reserved", wo.no
                pick[0].updated_by = "system"
            if off_cfg["enabled"]:
                offcut_svc.record_leftover(db, wo, plate, off_cfg, off_place)
            # Bulk statt Stück: zehntausend WorkItem-Zeilen in einem Flush,
            # nicht zehntausend Einzel-INSERTs mit Objektbuchhaltung dazwischen.
            db.add_all(
                WorkItem(
                    plate_id=plate.id, work_order_id=wo.id,
                    position_id=item["position_id"], tag=item["tag"],
                    order_no=item["order_no"], customer=item["customer"],
                    customer_ref=item["customer_ref"], label=item["label"],
                    od=item["od"], di=item["di"], qty=1,
                    from_remnant=item["from_remnant"], shape=item.get("shape"),
                )
                for item in pl.placements
            )
            for item in pl.placements:
                if item["position_id"] not in oversize_ids:
                    batched_position_ids.add(item["position_id"])
                order_nos.add(item["order_no"])
            n_plates += 1
            n_parts += len(pl.placements)

    if batched_position_ids:
        (db.query(OrderPosition)
           .filter(_chunked_in(OrderPosition.id, batched_position_ids))
           .update({OrderPosition.production_status: "batched"}, synchronize_session=False))
    if manual_position_ids:
        (db.query(OrderPosition)
           .filter(_chunked_in(OrderPosition.id, manual_position_ids))
           .update({OrderPosition.production_status: "manual"}, synchronize_session=False))

    run.n_orders = len(order_nos)
    run.n_positions = len(released_position_ids)
    run.n_parts = n_parts
    run.engine_version = _actual_label(engine, [p for g in groups for p in g.plates])
    run.n_plates = n_plates
    run.n_work_orders = len([g for g in groups if g.plates])
    run.batch_area_m2 = round(sum(g.used_area_m2 for g in groups), 6)
    # Der Vergleich, der die Sammelschachtelung rechtfertigt: dieselben Teile,
    # aber je Auftrag getrennt geschachtelt — mit demselben Motor, sonst
    # vergleicht der Bericht Äpfel mit Birnen.
    released_parts = [p for g in groups for p in g.parts]
    run.solo_area_m2 = round(solo_area(released_parts, products, rates, engine), 6)
    run.finished_at = _now()

    db.add(AuditLog(actor=actor, action="nest_run", entity="nest_run", entity_id=run.no,
                    detail={"trigger": trigger, "work_orders": run.n_work_orders,
                            "plates": run.n_plates, "parts": run.n_parts,
                            "solo_area_m2": run.solo_area_m2,
                            "batch_area_m2": run.batch_area_m2,
                            "held": len(held_buckets),
                            "group_by": grouping,
                            **({"buckets": sorted([m, t] for m, t in only)} if only else {}),
                            **({"customers": sorted(customers)} if customers else {})}))
    db.commit()
    db.refresh(run)
    bus.publish("batch_run", {
        "run_no": run.no,
        "n_work_orders": run.n_work_orders,
        "n_plates": run.n_plates,
        "n_parts": run.n_parts,
        "trigger": trigger,
    })

    # Fertigungsmeldung: welche Form wie oft, mit den Schnittdateien im Anhang
    # (services/batch_report.py). Nach dem commit, damit die Meldung nur
    # beschreibt, was tatsächlich in der Datenbank steht — und in einem eigenen
    # try, weil ein Postfehler keinen fertigen Lauf zurücknehmen darf. Der
    # Versand selbst läuft im Hintergrundfaden; der Taktgeber wartet nicht auf
    # IONOS.
    try:
        batch_report.send_run_report(db, run)
    except Exception:  # noqa: BLE001
        log.exception("Fertigungsmeldung zu %s fehlgeschlagen — Lauf bleibt gültig", run.no)

    return run


def _rule_source(db: Session):
    """Woher die Regel eines Eimers kommt: ``dicke``, ``werkstoff`` oder ``global``."""
    rows = db.query(BatchPolicy.mat, BatchPolicy.thk).all()
    exact = {(m, float(t)) for m, t in rows if t is not None}
    any_thk = {m for m, t in rows if t is None}

    def source(mat: str, thk: float) -> str:
        if (mat, float(thk)) in exact:
            return "dicke"
        return "werkstoff" if mat in any_thk else "global"

    return source


def _preview_engine(db: Session) -> str:
    """Vorschauen bleiben auf lite: Kerf gehört dem echten Lauf."""
    engine = nesting_engine(db)
    return "lite" if engine == "kerf" else engine


def _forecast_plan(db: Session, mat: str, thk: float,
                   customer_id: int | None = None) -> tuple[list[BatchPart], list]:
    ids = {customer_id} if customer_id is not None else None
    parts = [p for p in collect_pending(db, customer_ids=ids)
             if (p.mat, float(p.thk)) == (mat, float(thk))]
    if not parts:
        return [], []
    groups, _ = plan_batch(parts, load_products(db), load_rates(db),
                           policy_for=policy_resolver(db), options_for=options_resolver(db),
                           force=True, mixed_formats=settings_store.get_bool(db, "batch_mixed_formats", True),
                           now=_now(), engine=_preview_engine(db),
                           group_by=global_grouping(db))
    return parts, groups


def forecast_bucket(db: Session, mat: str, thk: float,
                    customer_id: int | None = None) -> dict | None:
    """Was herauskäme, wenn genau dieser Eimer jetzt geschnitten wird — ohne etwas
    zu speichern. Dieselbe Rechnung wie der Lauf (``plan_batch`` mit ``force``);
    ``None``, wenn dort nichts wartet."""
    parts, groups = _forecast_plan(db, mat, thk, customer_id)
    if not parts:
        return None
    plates = [pl for g in groups for pl in g.plates]
    orders: dict[str, dict] = {}
    for p in parts:
        o = orders.setdefault(p.order_no, {"order_no": p.order_no, "n_pieces": 0, "rush": p.rush,
                                           "due_date": p.due_date.isoformat() if p.due_date else None,
                                           "ordered_at": p.ordered_at.isoformat() if p.ordered_at else None})
        o["n_pieces"] += max(1, p.q)
    used = sum(g.used_area_m2 for g in groups)
    plate_area = sum(g.plate_area_m2 for g in groups)
    return {
        "mat": mat, "thk": thk, "customer_id": customer_id,
        "customer": (next(iter({p.customer for p in parts}), "")),
        "engine": _preview_engine(db),
        "n_plates": len(plates),
        "n_oversize": sum(len(g.oversize) for g in groups),
        "used_area_m2": round(used, 4), "plate_area_m2": round(plate_area, 4),
        "utilisation": round(used / plate_area, 4) if plate_area else 0.0,
        "plates": [{"idx": i, "fmt": list(pl.fmt), "fill": round(pl.fill, 4),
                    "utilisation": round(pl.utilisation, 4), "n_parts": len(pl.placements)}
                   for i, pl in enumerate(plates)],
        "orders": sorted(orders.values(), key=lambda o: (not o["rush"], o["due_date"] or "~", o["order_no"])),
    }


def forecast_plate(db: Session, mat: str, thk: float, idx: int,
                   customer_id: int | None = None):
    """Die Platte ``idx`` aus ``forecast_bucket`` mit ihrer Belegung, oder ``None``."""
    plates = [pl for g in _forecast_plan(db, mat, thk, customer_id)[1] for pl in g.plates]
    return (plates[idx], len(plates)) if 0 <= idx < len(plates) else None


def trial_policy(db: Session, trial: BatchPolicy) -> list[dict]:
    """Welche Eimer des Werkstoffs diese Regel anders entschiede. Schreibt nichts."""
    parts = [p for p in collect_pending(db) if p.mat == trial.mat
             and (trial.thk is None or float(p.thk) == float(trial.thk))]
    if not parts:
        return []
    products, rates = load_products(db), load_rates(db)
    mixed = settings_store.get_bool(db, "batch_mixed_formats", True)

    def states(with_trial: BatchPolicy | None) -> dict[float, tuple[str, str]]:
        groups, held = plan_batch(parts, products, rates,
                                  policy_for=policy_resolver(db, with_trial),
                                  options_for=options_resolver(db, with_trial),
                                  force=False, mixed_formats=mixed, now=_now(),
                                  engine=_preview_engine(db), group_by=global_grouping(db))
        out = {float(h.thk): ("sammelt", h.reason) for h in held}
        out.update({float(g.thk): ("bereit", g.release_reason) for g in groups})
        return out

    before, after = states(None), states(trial)
    return [{"mat": trial.mat, "thk": thk, "before": before.get(thk, ("—", ""))[0],
             "after": after.get(thk, ("—", ""))[0], "reason": after.get(thk, ("—", ""))[1]}
            for thk in sorted(set(before) | set(after))]


class RenestError(Exception):
    """Eine Neu-Schachtelung, die nicht gelten darf — mit Klartext für das Panel."""

    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


def renest_work_orders(db: Session, *, nos: list[str] | None, actor: str) -> NestRun:
    """Offene Innenaufträge zurück in die Warteschlange und mit den **aktuellen**
    Parametern neu schachteln — der Knopf neben den Betriebsparametern.

    Was neu geschachtelt werden darf, entscheidet der Zustand, nicht die höfliche
    Bitte: nur ``open``. Ein Innenauftrag, der läuft oder fertig gemeldet ist,
    hat bereits zugeschnittenes Material gegen sich — seine Belegung bleibt
    eingefroren, die Zeichnung an der Maschine sagt die Wahrheit. ``cancelled``
    scheidet aus demselben Grund aus: seine Positionen sind längst zurück in der
    Warteschlange.

    Der Lauf danach ist ein ganz normaler Sammellauf (Trigger ``renest``), nur
    **freigegeben**: der Bediener hat mit dem Knopf entschieden, dass geschnitten
    wird — eine bucket, die mit dem neuen Abstand unter der Belegungsschwelle
    liegt, würde sonst still weiter sammeln und der Knopf täte scheinbar nichts.
    Er sieht die zurückgestellten Positionen zusammen mit allem, was inzwischen
    neu bezahlt wurde, und legt **neue** Innenaufträge an. Die alten bleiben als
    stornierte Zeilen lesbar — warum der erste Plan verworfen wurde, steht im
    Prüfprotokoll, nicht nur im Bauchgefühl des Bedieners. Der Plattenbestand
    geht zurück: gebucht war er für einen Schnitt, der nie stattfand.
    """
    from .work_orders import cancel_work_order

    with _run_lock:
        with run_lock.hold("batch"):
            query = db.query(WorkOrder).filter(WorkOrder.status == WorkOrderStatus.open)
            if nos:
                rows = query.filter(WorkOrder.no.in_(nos)).all()
                missing = set(nos) - {wo.no for wo in rows}
                if missing:
                    raise RenestError(
                        "Innenauftrag nicht gefunden: " + ", ".join(sorted(missing))
                    )
            else:
                rows = query.all()
            if not rows:
                raise RenestError("Es gibt keinen offenen Innenauftrag zum Neuschachteln.")

            position_ids: set[int] = set()
            for wo in rows:
                result = cancel_work_order(
                    db, wo, actor=actor, reason="neu geschachtelt", commit=False
                )
                position_ids.update(result["position_ids"])
                db.add(AuditLog(actor=actor, action="work_order_renest", entity="work_order",
                                entity_id=wo.no,
                                detail={"positions": len(result["position_ids"]),
                                        "plates": wo.n_plates}))
            if not position_ids:
                db.rollback()
                raise RenestError(
                    "Die gewählten Innenaufträge enthalten keine Positionen — "
                    "es gibt nichts neu zu schachteln."
                )
            db.commit()

            # Nur die zurückgestellten Positionen gehen in den neuen Lauf. Ein
            # ``force=True`` über alle Eimer würde fremde, noch sammelnde Aufträge
            # mitreißen — genau das war der Fehler.
            run = _run_batch(db, trigger="renest", actor=actor, force=True,
                             only_positions=position_ids)
    try:
        from .worklist import reconcile
        reconcile(db, who=actor)
    except Exception:
        pass  # Der 30-Sekunden-Takt gleicht Aufgaben ohnehin nach.
    return run


def _capped_bucket(group, cap: int):
    """Ein vom Plattendeckel gestoppter Eimer als zurückgestellter Eintrag."""
    from ..core.batch import HeldBucket
    return HeldBucket(
        mat=group.mat, thk=group.thk, parts=group.parts,
        reason=f"Plattendeckel erreicht ({cap} Platten je Lauf) — nächster Takt",
        n_pieces=sum(max(1, p.q) for p in group.parts),
        fill=max((pl.fill for pl in group.plates), default=0.0),
        releases_at=None,
    )


# --------------------------------------------------------------------------
# Vorschau für das Panel: was wartet, warum, und wann geht es raus
# --------------------------------------------------------------------------
def preview_queue(db: Session) -> dict:
    """Der Zustand der Warteschlange, ohne etwas zu verändern.

    Beantwortet die eine Frage, an der eine Freigaberegel steht oder fällt:
    „warum ist das noch nicht geschnitten, und wann wird es das“. Eine Regel,
    die das nicht beantwortet, wird beim ersten Zweifel abgeschaltet.
    """
    parts = collect_pending(db)
    products = load_products(db)
    rates = load_rates(db)
    mixed = settings_store.get_bool(db, "batch_mixed_formats", True)
    grouping = global_grouping(db)
    engine = nesting_engine(db)
    resolve = policy_resolver(db)
    # Die Vorschau läuft alle paar Sekunden; Kerf bleibt dem echten Lauf vorbehalten.
    preview_engine = "lite" if engine == "kerf" else engine
    groups, held = plan_batch(parts, products, rates, policy_for=resolve,
                              options_for=options_resolver(db),
                              force=False, mixed_formats=mixed, now=_now(),
                              engine=preview_engine, group_by=grouping)

    def _iso(dt):
        return dt.isoformat() if dt else None

    source = _rule_source(db)

    def rule(mat: str, thk: float) -> dict:
        p = resolve(mat, thk)
        return {
            "source": source(mat, thk), "mode": p.mode, "min_parts": p.min_parts,
            "min_utilisation": p.min_utilisation, "max_age_minutes": p.max_age_minutes,
            "due_lead_hours": p.due_lead_hours,
        }

    def clocks(bucket, mat: str, thk: float) -> dict:
        by_age, by_due = release_times(bucket, resolve(mat, thk).for_mode())
        return {
            "rule": rule(mat, thk),
            "rush": any(p.rush for p in bucket),
            "oldest_at": _iso(min((p.ordered_at for p in bucket if p.ordered_at), default=None)),
            "first_due": _iso(min((p.due_date for p in bucket if p.due_date), default=None)),
            "release_by": ("due" if by_due and (not by_age or by_due < by_age)
                           else "age" if by_age else None),
        }

    def customer_fields(bucket) -> dict:
        ids = {p.customer_id for p in bucket if p.customer_id is not None}
        names = {p.customer for p in bucket if p.customer}
        return {
            "customer_id": next(iter(ids)) if len(ids) == 1 else None,
            "customer": next(iter(names)) if len(names) == 1 else "",
        }

    ready = [{
        **clocks(g.parts, g.mat, g.thk),
        **customer_fields(g.parts),
        "mat": g.mat, "thk": g.thk, "mode": g.policy_mode,
        "reason": g.release_reason,
        "n_plates": len(g.plates),
        "n_parts": g.n_parts,
        "n_orders": len(g.order_nos),
        "orders": g.order_nos,
        "formats": g.formats,
        "utilisation": round(g.utilisation, 4),
        "fill": round(max((pl.fill for pl in g.plates), default=0.0), 4),
        "due_date": _iso(g.due_date),
        "held_positions": len(g.held),
        "hold_reason": g.hold_reason,
    } for g in groups]

    waiting = [{
        **clocks(h.parts, h.mat, h.thk),
        **customer_fields(h.parts),
        "mat": h.mat, "thk": h.thk,
        "reason": h.reason,
        "n_pieces": h.n_pieces,
        "n_positions": len(h.parts),
        "n_orders": len({p.order_no for p in h.parts}),
        "orders": sorted({p.order_no for p in h.parts}),
        "fill": round(h.fill, 4),
        "releases_at": _iso(h.releases_at),
    } for h in held]

    # Kundenauswahl für „Jetzt schachteln“ — nur Konten, keine Namen raten.
    customer_rows: dict[int, dict] = {}
    for p in parts:
        if p.customer_id is None:
            continue
        row = customer_rows.setdefault(p.customer_id, {
            "id": p.customer_id, "name": p.customer, "n_parts": 0, "orders": set(),
        })
        row["n_parts"] += max(1, p.q)
        row["orders"].add(p.order_no)
    customers = sorted(
        ({"id": c["id"], "name": c["name"], "n_parts": c["n_parts"],
          "n_orders": len(c["orders"])} for c in customer_rows.values()),
        key=lambda c: (c["name"].lower(), c["id"]),
    )

    base = global_policy(db)
    opts = global_options(db)
    return {
        "waiting_positions": len(parts),
        "waiting_parts": sum(max(1, p.q) for p in parts),
        "customers": customers,
        "ready": ready,
        "held": waiting,
        "policy": {
            "mode": base.mode,
            "min_parts": base.min_parts,
            "min_utilisation": base.min_utilisation,
            "max_age_minutes": base.max_age_minutes,
            "due_lead_hours": base.due_lead_hours,
            "max_plates_per_run": settings_store.get_int(db, "batch_max_plates_per_run", 0),
            "max_orders_per_work_order": base.max_orders_per_group,
            "max_plates_per_work_order": base.max_plates_per_group,
            "mixed_formats": mixed,
            "group_by": grouping,
            "interval_minutes": settings_store.get_int(db, "batch_interval_minutes", 10),
            "enabled": settings_store.get_bool(db, "batch_enabled", True),
        },
        # Geometrie der Fertigungsschachtelung — bewusst getrennt ausgewiesen,
        # damit niemand sie für die Kalkulationssätze hält.
        "nest": {
            "gap": opts.gap, "margin": opts.margin,
            "trim_w": opts.trim_w, "trim_h": opts.trim_h,
        },
        # Welcher Motor schachtelt — und wird er tatsächlich erreicht?
        "engine": engine,
        "engine_version": _engine_label(engine),
    }
