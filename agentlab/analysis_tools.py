"""Analyse- und Planungswerkzeuge des Assistenten (roadmap task 36 A+B).

Alle Werkzeuge hier lesen oder rechnen nur. Sie erreichen, was Gimel schon
berechnen kann (Rückverfolgung, Zwillingsbefunde, Disposition, Flotte, Preis,
Maßgrenzen), aber dem Katalog bisher fehlte. Damit ein Rechenweg nie doch
etwas in die Live-Datenbank schreibt, nimmt ``_readonly`` nach jedem Aufruf
die Sitzung zurück: was immer ein Dienst unterwegs angelegt hätte, verfällt.

Unbekannt bleibt unbekannt — eine fehlende Kennzahl ist ``None`` mit Grund,
nie 0.
"""

from __future__ import annotations

import ast
import math
import operator
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from gimel.models import (
    FactoryFloor,
    FactoryStation,
    LibraryShape,
    NestRun,
    Order,
    OrderPosition,
    Product,
    Shipment,
    ShipmentItem,
    WorkItem,
    WorkOrder,
    WorkOrderStatus,
)
from gimel.schemas import QuoteLine
from gimel.services.catalog import load_products
from gimel.services.dimension_limits import load_limits, validate_all
from gimel.services.orders import quote

from .tools import (
    ALL,
    OFFICE,
    ToolContext,
    ToolError,
    ToolSpec,
    _iso,
    _limit,
    _need,
    _normalize_line,
    _office,
    _position_line,
    _schema,
)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _parse_iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        return _aware(datetime.fromisoformat(str(value).replace("Z", "+00:00")))
    except ValueError:
        return None


def _readonly(fn: Callable[[ToolContext, dict], dict]) -> Callable[[ToolContext, dict], dict]:
    """Nach dem Rechnen alles verwerfen, was die Sitzung angesammelt hat.

    ``execute_tool`` bestätigt nach jedem Werkzeug. Für ein lesendes Werkzeug
    soll dabei nachweislich nichts übrig sein — auch dann nicht, wenn ein
    Dienst unterwegs ein Objekt anhängt oder ein Autoflush schon lief.
    """
    def wrapped(ctx: ToolContext, args: dict) -> dict:
        try:
            return fn(ctx, args)
        finally:
            ctx.db.rollback()

    wrapped.__name__ = fn.__name__
    wrapped.__doc__ = fn.__doc__
    return wrapped


def _days(args: dict, default: int = 30, cap: int = 365) -> int:
    try:
        value = int(args.get("days") or default)
    except (TypeError, ValueError) as exc:
        raise ToolError("„days“ muss eine ganze Zahl sein.") from exc
    return max(1, min(cap, value))


def _int_arg(args: dict, key: str, *, required: bool = True) -> int | None:
    raw = _need(args, key, required=required)
    if raw is None or raw == "":
        return None
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise ToolError(f"„{key}“ muss eine ganze Zahl sein.") from exc


def _work_order_brief(wo: WorkOrder) -> dict:
    return {
        "no": wo.no, "status": wo.status.value, "mat": wo.mat, "thk": wo.thk,
        "n_plates": wo.n_plates, "n_parts": wo.n_parts,
        "utilisation": round(float(wo.utilisation), 3) if wo.utilisation is not None else None,
        "station_id": wo.station_id, "due_date": _iso(wo.due_date),
        "created_at": _iso(wo.created_at), "done_at": _iso(wo.done_at),
    }


# ---- A. Analyse ------------------------------------------------------------
def get_order_trace(ctx: ToolContext, args: dict) -> dict:
    from gimel.services.trace import order_trace

    no = str(_need(args, "order_no")).strip()
    order = ctx.db.query(Order).filter(Order.no == no).first()
    if order is None:
        raise ToolError(f"Auftrag {no} nicht gefunden.")
    trace = order_trace(ctx.db, order)
    shipments = (
        ctx.db.query(Shipment)
        .join(ShipmentItem, ShipmentItem.shipment_id == Shipment.id)
        .filter(ShipmentItem.order_no == no)
        .distinct().all()
    )
    stages = list(order.stages or [])
    return {
        "summary": (f"Weg von Auftrag {no}: {len(trace.get('work_orders') or [])} Innenauftrag/"
                    f"-aufträge, {len(shipments)} Sendung(en)."),
        "data": {
            "order_no": no, "stage": order.stage, "stages_at": stages,
            "created_at": _iso(order.created_at), "due_date": _iso(order.due_date),
            "released": order.released, "blocked": order.blocked,
            "trace": trace,
            "shipments": [{"no": s.no, "status": s.status.value, "carrier": s.carrier,
                           "tracking": s.tracking, "created_at": _iso(s.created_at)}
                          for s in shipments],
        },
    }


def get_run_trace(ctx: ToolContext, args: dict) -> dict:
    from gimel.services.trace import run_trace

    no = str(args.get("run_no") or "").strip()
    query = ctx.db.query(NestRun)
    run = (query.filter(NestRun.no == no).first() if no
           else query.order_by(NestRun.id.desc()).first())
    if run is None:
        raise ToolError(f"Sammellauf {no} nicht gefunden." if no else "Noch kein Sammellauf.")
    wos = ctx.db.query(WorkOrder).filter(WorkOrder.run_id == run.id).all()
    used = sum(float(w.used_area_m2 or 0) for w in wos)
    plate = sum(float(w.plate_area_m2 or 0) for w in wos)
    saved = None
    if run.solo_area_m2 and run.batch_area_m2 is not None:
        saved = round(float(run.solo_area_m2) - float(run.batch_area_m2), 4)
    return {
        "summary": (f"Sammellauf {run.no}: {len(wos)} Innenauftrag/-aufträge, "
                    f"{run.n_plates} Platte(n)."),
        "data": {
            "run": {"no": run.no, "trigger": run.trigger, "started_at": _iso(run.started_at),
                    "finished_at": _iso(run.finished_at), "engine_version": run.engine_version,
                    "n_orders": run.n_orders, "n_positions": run.n_positions,
                    "n_parts": run.n_parts, "n_plates": run.n_plates, "note": run.note},
            "utilisation": round(used / plate, 3) if plate else None,
            "used_area_m2": round(used, 4), "plate_area_m2": round(plate, 4),
            "waste_area_m2": round(plate - used, 4) if plate else None,
            "area_saved_vs_solo_m2": saved,
            "work_orders": [_work_order_brief(w) for w in wos],
            "orders": run_trace(ctx.db, run)["orders"],
        },
    }


def analyse_twin(ctx: ToolContext, args: dict) -> dict:
    from gimel.services import twin_analysis

    result = twin_analysis.analyse(ctx.db)
    findings = result.get("findings") or []
    limit = _limit(args.get("limit"), 20, 60)
    severity = str(args.get("severity") or "").strip()
    if severity:
        findings = [f for f in findings if str(f.get("severity")) == severity]
    data = dict(result)
    data["findings"] = findings[:limit]
    data["findings_total"] = len(findings)
    return {"summary": f"Zwillingsanalyse: {len(findings)} Befund(e).", "data": data}


def get_factory_plan(ctx: ToolContext, args: dict) -> dict:
    from gimel.services import factory_router as fr

    sugs = fr.plan_open_work_orders(
        ctx.db, limit=_limit(args.get("limit"), 40, 200),
        include_assigned=bool(args.get("include_assigned")),
    )
    rows = []
    for sug in sugs:
        row = sug.to_dict()
        # Die volle Rangliste trägt je Station Dutzende Teilwerte; dem Modell
        # reichen die besten drei mit Punktzahl und Zeit.
        ranking = row.get("ranking") or []
        row["ranking"] = [
            {k: r.get(k) for k in ("station_id", "label", "eligible", "score", "minutes", "reason")
             if k in r}
            for r in ranking[:3]
        ]
        row["ranking_total"] = len(ranking)
        rows.append(row)
    counts = {mode: sum(1 for s in sugs if s.mode == mode) for mode in ("auto", "suggest", "none")}
    return {
        "summary": (f"Dispositionsvorschlag für {len(rows)} Innenauftrag/-aufträge "
                    f"(automatisch {counts['auto']}, Vorschlag {counts['suggest']}, "
                    f"ohne Station {counts['none']}). Nichts angewendet."),
        "data": {"auto_routing": fr.auto_routing_enabled(ctx.db), "counts": counts,
                 "suggestions": rows},
    }


def get_material_flow(ctx: ToolContext, args: dict) -> dict:
    from gimel.services import factory_router as fr

    edges = fr.material_flow(ctx.db, limit=_limit(args.get("limit"), 300, 1000))
    edges = sorted(edges, key=lambda e: -float(e.get("metres", 0)) * int(e.get("count", 0)))
    total = sum(float(e.get("metres", 0)) * int(e.get("count", 0)) for e in edges)
    return {
        "summary": f"{len(edges)} Materialweg(e), zusammen {total:.0f} m Transport.",
        "data": {"edges": edges[:80], "edges_total": len(edges),
                 "total_transport_m": round(total, 1),
                 "exact": all(e.get("exact") for e in edges) if edges else False},
    }


def _median(values: list[float]) -> float | None:
    return round(statistics.median(values), 2) if values else None


def get_kpis(ctx: ToolContext, args: dict) -> dict:
    from sqlalchemy import and_, case, func

    db = ctx.db
    days = _days(args)
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days)

    ext_only = bool(args.get("external_only"))
    order_base = db.query(Order).filter(Order.cancelled_at.is_(None))
    if ext_only:
        order_base = order_base.filter(Order.kind != "internal")

    # Zählungen direkt in SQL statt alle historischen Aufträge in Python zu laden!
    created_cnt, open_cnt, overdue_cnt, blocked_cnt, rush_cnt, gross_created_sum = order_base.with_entities(
        func.coalesce(func.sum(case((Order.created_at >= since, 1), else_=0)), 0),
        func.coalesce(func.sum(case((Order.stage < 2, 1), else_=0)), 0),
        func.coalesce(
            func.sum(
                case(
                    (and_(Order.stage < 2, Order.due_date.isnot(None), Order.due_date < now, Order.blocked.is_(False)), 1),
                    else_=0,
                )
            ),
            0,
        ),
        func.coalesce(func.sum(case((and_(Order.stage < 2, Order.blocked.is_(True)), 1), else_=0)), 0),
        func.coalesce(func.sum(case((and_(Order.stage < 2, Order.rush.is_(True)), 1), else_=0)), 0),
        func.coalesce(func.sum(case((Order.created_at >= since, Order.gross), else_=0.0)), 0.0),
    ).one()

    overdue_nos = [
        no
        for (no,) in order_base.with_entities(Order.no)
        .filter(Order.stage < 2, Order.due_date.isnot(None), Order.due_date < now, Order.blocked.is_(False))
        .order_by(Order.due_date.asc())
        .limit(20)
        .all()
    ]

    # Für Durchlaufzeit & Termintreue nur abgeschlossene Aufträge (stage >= 2) der letzten Zeit prüfen.
    done_candidates = (
        order_base.with_entities(Order.created_at, Order.due_date, Order.stages, Order.gross)
        .filter(Order.stage >= 2)
        .order_by(Order.id.desc())
        .limit(5000)
        .all()
    )
    completed_count = 0
    gross_completed_sum = 0.0
    lead: list[float] = []
    with_due_cnt = 0
    on_time = 0
    for c_at, d_at, st_json, gross_val in done_candidates:
        stages = list(st_json or [])
        done_at = _parse_iso(stages[2]) if len(stages) > 2 else None
        if done_at is not None and done_at >= since:
            completed_count += 1
            gross_completed_sum += float(gross_val or 0.0)
            if c_at:
                lead.append((done_at - _aware(c_at)).total_seconds() / 86400)
            if d_at:
                with_due_cnt += 1
                if done_at <= _aware(d_at):
                    on_time += 1

    wo_base = db.query(WorkOrder).filter(WorkOrder.status != WorkOrderStatus.cancelled)
    wo_created_cnt, wo_open_cnt, used_sum, plate_sum, plates_used = wo_base.with_entities(
        func.coalesce(func.sum(case((WorkOrder.created_at >= since, 1), else_=0)), 0),
        func.coalesce(func.sum(case((WorkOrder.status.in_((WorkOrderStatus.open, WorkOrderStatus.running)), 1), else_=0)), 0),
        func.coalesce(func.sum(case((WorkOrder.created_at >= since, WorkOrder.used_area_m2), else_=0.0)), 0.0),
        func.coalesce(func.sum(case((WorkOrder.created_at >= since, WorkOrder.plate_area_m2), else_=0.0)), 0.0),
        func.coalesce(func.sum(case((WorkOrder.created_at >= since, WorkOrder.n_plates), else_=0)), 0),
    ).one()
    wo_done_rows = (
        wo_base.with_entities(WorkOrder.created_at, WorkOrder.done_at)
        .filter(WorkOrder.done_at.isnot(None), WorkOrder.done_at >= since)
        .all()
    )
    wo_lead = [(_aware(d_at) - _aware(c_at)).total_seconds() / 3600 for c_at, d_at in wo_done_rows if c_at]
    used = float(used_sum or 0.0)
    plate = float(plate_sum or 0.0)

    data: dict[str, Any] = {
        "days": days, "since": _iso(since),
        "orders": {
            "created": int(created_cnt or 0), "completed": completed_count,
            "throughput_per_day": round(completed_count / days, 2),
            "lead_time_days_median": _median(lead),
            "lead_time_days_mean": round(sum(lead) / len(lead), 2) if lead else None,
            "on_time_rate": round(on_time / with_due_cnt, 3) if with_due_cnt else None,
            "on_time_basis": with_due_cnt,
            "open": int(open_cnt or 0), "overdue_open": int(overdue_cnt or 0),
            "overdue_nos": overdue_nos,
            "blocked_open": int(blocked_cnt or 0),
            "rush_open": int(rush_cnt or 0),
        },
        "work_orders": {
            "created": int(wo_created_cnt or 0), "done": len(wo_done_rows),
            "open": int(wo_open_cnt or 0),
            "lead_time_hours_median": _median(wo_lead),
            "material_utilisation": round(used / plate, 3) if plate else None,
            "plates_used": int(plates_used or 0),
        },
        "not_recorded": ["Ausschuss", "Maschinenstillstand"],
    }
    if _office(ctx.user):
        data["orders"]["gross_created"] = round(float(gross_created_sum or 0.0), 2)
        data["orders"]["gross_completed"] = round(gross_completed_sum, 2)
    rate = data["orders"]["on_time_rate"]
    rate_text = f"{rate * 100:.0f} %" if rate is not None else "unbekannt"
    return {
        "summary": (f"Kennzahlen {days} Tage: {completed_count} fertig, termintreu {rate_text}, "
                    f"{int(overdue_cnt or 0)} überfällig offen."),
        "data": data,
    }


#: Mehr Positionen schätzt das Werkzeug nicht in einem Aufruf — der Preis-Kern
#: läuft im Anfrageprozess.
MAX_DEMAND_POSITIONS = 500


def get_material_demand(ctx: ToolContext, args: dict) -> dict:
    """Was die wartenden Positionen an Platten brauchen — gegen den Bestand.

    Gerechnet wird mit demselben Kern wie der Preis (je Werkstoff und Dicke
    geschachtelt). Der Sammellauf schachtelt über Aufträge hinweg und braucht
    eher weniger; die Zahl ist deshalb eine obere Schätzung.
    """
    db = ctx.db
    rows = (
        db.query(OrderPosition)
        .join(Order, OrderPosition.order_id == Order.id)
        .filter(OrderPosition.production_status == "pending")
        .filter(OrderPosition.kind != "custom")
        .order_by(OrderPosition.id)
        .limit(MAX_DEMAND_POSITIONS + 1)
        .all()
    )
    capped = len(rows) > MAX_DEMAND_POSITIONS
    rows = rows[:MAX_DEMAND_POSITIONS]
    mat_filter = str(args.get("material") or "").strip()
    if mat_filter:
        rows = [p for p in rows if p.mat == mat_filter]
    products = {p.id: p for p in db.query(Product).all()}
    need: dict[str, dict] = {}

    def bucket(mat: str) -> dict:
        product = products.get(mat)
        return need.setdefault(mat, {
            "material": mat, "name": product.name if product else mat,
            "stock_plates": int(product.stock) if product else None,
            "lead_days": int(product.lead_days or 0) if product else None,
            "plates_needed": 0, "positions": 0, "pieces": 0, "orders": set(),
            "by_thickness": {},
        })

    gasket_lines: list[QuoteLine] = []
    owner: dict[int, OrderPosition] = {}
    for i, pos in enumerate(rows, start=1):
        entry = bucket(pos.mat)
        entry["positions"] += 1
        entry["pieces"] += int(pos.qty or 0)
        entry["orders"].add(pos.order.no)
        if pos.kind == "sheet":
            entry["plates_needed"] += int(pos.qty or 0)
            continue
        try:
            line = _position_line(pos)
        except Exception:  # noqa: BLE001 — eine kaputte Altposition stoppt nicht die Liste
            continue
        line = line.model_copy(update={"id": i})
        owner[i] = pos
        gasket_lines.append(line)

    unpriced = 0
    if gasket_lines:
        try:
            result = quote(db, gasket_lines)
            for group in result.get("groups", []):
                entry = bucket(group["mat"])
                sheets = int(group["g"]["nSheets"])
                entry["plates_needed"] += sheets
                key = f"{float(group['thk']):g}"
                entry["by_thickness"][key] = entry["by_thickness"].get(key, 0) + sheets
        except Exception:  # noqa: BLE001
            unpriced = len(gasket_lines)

    out = []
    for entry in need.values():
        entry["orders"] = sorted(entry["orders"])
        stock = entry["stock_plates"]
        entry["after_plates"] = stock - entry["plates_needed"] if stock is not None else None
        entry["short"] = entry["after_plates"] is not None and entry["after_plates"] < 0
        out.append(entry)
    out.sort(key=lambda e: (not e["short"], e["after_plates"] if e["after_plates"] is not None else 1e9))
    short = [e["material"] for e in out if e["short"]]
    return {
        "summary": (f"Materialbedarf wartender Positionen: {len(out)} Werkstoff(e), "
                    f"{len(short)} mit Fehlmenge."
                    + (" Schätzung nicht vollständig." if unpriced or capped else "")),
        "data": {
            "materials": out, "short": short, "pending_positions": len(rows),
            "basis": ("Je Werkstoff und Dicke geschachtelt wie beim Preis; der Sammellauf "
                      "schachtelt über Aufträge hinweg und braucht eher weniger Platten."),
            "unestimated_positions": unpriced,
            "capped_at": MAX_DEMAND_POSITIONS if capped else None,
        },
    }


def get_shape_usage(ctx: ToolContext, args: dict) -> dict:
    db = ctx.db
    shape_id = _int_arg(args, "shape_id", required=False)
    query_text = str(args.get("query") or "").strip()
    shape = None
    if shape_id:
        shape = db.get(LibraryShape, shape_id)
    elif query_text:
        like = f"%{query_text}%"
        shape = (db.query(LibraryShape)
                 .filter((LibraryShape.label.ilike(like)) | (LibraryShape.key.ilike(like))
                         | (LibraryShape.norm_ref.ilike(like)))
                 .order_by(LibraryShape.id).first())
    else:
        raise ToolError("Bitte „shape_id“ oder „query“ angeben.")
    if shape is None:
        raise ToolError("Form nicht gefunden.")
    positions = db.query(OrderPosition).filter(OrderPosition.shape_id == shape.id).all()
    orders: dict[str, dict] = {}
    for pos in positions:
        row = orders.setdefault(pos.order.no, {"no": pos.order.no, "qty": 0,
                                               "created_at": _iso(pos.order.created_at),
                                               "stage": pos.order.stage})
        row["qty"] += int(pos.qty or 0)
    pos_ids = [p.id for p in positions]
    wo_nos: set[str] = set()
    if pos_ids:
        items = (db.query(WorkItem, WorkOrder)
                 .join(WorkOrder, WorkItem.work_order_id == WorkOrder.id)
                 .filter(WorkItem.position_id.in_(pos_ids)).all())
        wo_nos = {wo.no for _, wo in items}
    return {
        "summary": (f"Form „{shape.label}“: {len(orders)} Auftrag/Aufträge, "
                    f"{len(wo_nos)} Innenauftrag/-aufträge."),
        "data": {
            "shape": {"id": shape.id, "key": shape.key, "label": shape.label, "cat": shape.cat,
                      "norm_ref": shape.norm_ref, "od": shape.od, "di": shape.di,
                      "active": shape.active},
            "n_positions": len(positions), "n_pieces": sum(int(p.qty or 0) for p in positions),
            "orders": sorted(orders.values(), key=lambda r: r["no"]),
            "work_orders": sorted(wo_nos),
        },
    }


# ---- B. Planen und Rechnen (nichts wird gespeichert) -----------------------
def quote_price(ctx: ToolContext, args: dict) -> dict:
    from gimel.routers.quotes import QuoteRequest, calculate

    raw_lines = args.get("lines") or []
    if not isinstance(raw_lines, list) or not raw_lines:
        raise ToolError("Ohne Positionen gibt es nichts zu rechnen.")
    if len(raw_lines) > 50:
        raise ToolError("Höchstens 50 Positionen je Preisrechnung.")
    lines = []
    for i, raw in enumerate(raw_lines, start=1):
        payload = _normalize_line(raw, i)
        try:
            lines.append(QuoteLine(**payload))
        except Exception as exc:  # noqa: BLE001
            raise ToolError(f"Position {i}: {exc}") from exc
    body: dict[str, Any] = {"lines": lines, "cert": str(args.get("cert") or "2.2")}
    if args.get("customer_id"):
        body["customer_id"] = int(args["customer_id"])
    if args.get("discount_pct") is not None:
        body["discount_pct"] = float(args["discount_pct"])
    try:
        request = QuoteRequest(**body)
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Preisrechnung: {exc}") from exc
    from fastapi import HTTPException

    try:
        result = calculate(request, ctx.db, ctx.user).model_dump()
    except HTTPException as exc:
        raise ToolError(str(exc.detail)) from exc
    return {
        "summary": (f"Preis ohne Auftrag: {result['gross']:.2f} € brutto "
                    f"({result['total']:.2f} € netto) für {len(lines)} Position(en)."),
        "data": result,
    }


def check_part_fit(ctx: ToolContext, args: dict) -> dict:
    def number(key: str, *, required: bool = False) -> float | None:
        raw = args.get(key)
        if raw is None or raw == "":
            if required:
                raise ToolError(f"„{key}“ fehlt.")
            return None
        try:
            value = float(str(raw).replace(",", "."))
        except ValueError as exc:
            raise ToolError(f"„{key}“ ist keine Zahl.") from exc
        if value < 0 or value > 100_000:
            raise ToolError(f"„{key}“ liegt außerhalb 0…100000 mm.")
        return value

    od = number("od", required=True) or 0.0
    di = number("di") or 0.0
    w, h = number("width"), number("height")
    mat = str(args.get("material") or "").strip()
    limits = load_limits(ctx.db)
    product = load_products(ctx.db).get(mat) if mat else None
    if mat and product is None:
        raise ToolError(f"Werkstoff {mat} unbekannt.")
    errors = validate_all(od, di, w, h, limits, product.min_web if product else None)
    fits_sheets = None
    if product is not None:
        fits_sheets = []
        for sw, sh in product.sheets:
            part_w, part_h = (w, h) if (w and h) else (od, od)
            fits_sheets.append({"fmt": [sw, sh],
                                "fits": (part_w <= sw and part_h <= sh) or (part_w <= sh and part_h <= sw)})
    ok = not errors and (fits_sheets is None or any(s["fits"] for s in fits_sheets))
    return {
        "summary": "Teil ist fertigbar." if ok else "Teil verletzt Grenzen: " + " ".join(errors or ["passt auf keine Platte des Werkstoffs."]),
        "data": {
            "ok": ok, "errors": errors, "sheets": fits_sheets,
            "web_mm": round((od - di) / 2, 2) if di else None,
            "limits": {"max_od": limits.max_od, "min_od": limits.min_od,
                       "min_web": limits.min_web if limits.min_web is not None
                       else (product.min_web if product else None),
                       "min_corner": limits.min_corner,
                       "max_plate": [limits.max_plate_w, limits.max_plate_h]},
        },
    }


def plan_robot_way(ctx: ToolContext, args: dict) -> dict:
    from gimel.services import robot_ways

    a = _int_arg(args, "from_station_id")
    b = _int_arg(args, "to_station_id")
    try:
        way = robot_ways.plan_between_stations(ctx.db, a, b)
    except (robot_ways.WayError, ValueError, LookupError) as exc:
        raise ToolError(str(exc)) from exc
    speed = float(args.get("speed_m_s") or 1.0)
    if not 0.1 <= speed <= 3.0:
        raise ToolError("Geschwindigkeit 0,1 … 3 m/s.")
    seconds = robot_ways.drive_seconds(float(way["route_m"]), speed)
    route = way.pop("route", [])
    return {
        "summary": (f"Weg {way['from'].get('label', a)} → {way['to'].get('label', b)}: "
                    f"{way['route_m']:.1f} m, {seconds / 60:.1f} min bei {speed:g} m/s"
                    + ("" if way.get("route_exact") else " (geschätzt)") + "."),
        "data": {**way, "speed_m_s": speed, "drive_s": round(seconds, 1),
                 "waypoints": len(route), "route": route[:60]},
    }


def simulate_fleet(ctx: ToolContext, args: dict) -> dict:
    from gimel.routers.factory import FleetSimParams
    from gimel.services import fleet_sim

    floor_id = _int_arg(args, "floor_id", required=False)
    raw = {k: v for k, v in args.items() if k != "floor_id"}
    if "planned" not in raw:
        raw["planned"] = [{"name": "Geplant", "kind": "amr", "speed_m_s": 1.0,
                           "count": int(args.get("robots") or 2)}]
    raw.pop("robots", None)
    if "per_shift" not in raw:
        try:
            raw["per_shift"] = max(1, int(fleet_sim.defaults(ctx.db, floor_id)["per_shift"]) or 1)
        except fleet_sim.SimError as exc:
            raise ToolError(str(exc)) from exc
    try:
        params = FleetSimParams(**raw)
    except Exception as exc:  # noqa: BLE001
        raise ToolError(f"Szenario ungültig: {exc}") from exc
    if sum(p.count for p in params.planned) > 12:
        raise ToolError("Höchstens 12 geplante Roboter je Szenario.")
    try:
        result = fleet_sim.run(ctx.db, floor_id, params.model_dump())
    except fleet_sim.SimError as exc:
        raise ToolError(str(exc)) from exc
    slim = _strip_timelines(result)
    return {
        "summary": "Flottensimulation gerechnet (nichts gespeichert).",
        "data": {"params": params.model_dump(), "result": slim},
    }


def _strip_timelines(value: Any, depth: int = 0) -> Any:
    """Zeitleisten und Wegpunkte sind für die Anzeige; das Modell braucht die Kennzahlen."""
    drop = {"timeline", "timelines", "track", "tracks", "events", "route", "points", "legs", "frames"}
    if isinstance(value, dict):
        return {k: (f"[{len(v)} Einträge ausgelassen]" if k in drop and isinstance(v, list)
                    else _strip_timelines(v, depth + 1))
                for k, v in value.items()}
    if isinstance(value, list):
        if len(value) > 40:
            return [_strip_timelines(v, depth + 1) for v in value[:40]] + [f"… {len(value) - 40} weitere"]
        return [_strip_timelines(v, depth + 1) for v in value]
    return value


# ---- calculate: exakte Arithmetik ohne eval --------------------------------
_BINOPS: dict[type, Callable[[Any, Any], Any]] = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY: dict[type, Callable[[Any], Any]] = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def _mean(*xs: float) -> float:
    if not xs:
        raise ToolError("mean() braucht Werte.")
    return sum(xs) / len(xs)


def _round(value: float, digits: float = 0) -> float:
    """``round`` mit begrenzter Stellenzahl — ``round(1, -30000000)`` rechnete 40 s."""
    if isinstance(digits, float) and not digits.is_integer():
        raise ToolError("round() braucht eine ganze Stellenzahl.")
    digits = int(digits)
    if not -15 <= digits <= 15:
        raise ToolError("round(): Stellen zwischen −15 und 15.")
    return round(value, digits)


#: Jeder Zwischenwert bleibt unter dieser Größe (Bits bei Ganzzahlen, Betrag
#: bei Kommazahlen). Sonst wächst eine Kette aus Quadraten so, dass eine
#: einzige Multiplikation den Prozess minutenlang blockiert (GIL).
_MAX_INT_BITS = 1000
_MAX_FLOAT = 1e300


def _guard(value: Any) -> Any:
    if isinstance(value, bool):
        raise ToolError("Wahrheitswerte sind keine Zahlen.")
    if isinstance(value, int):
        if value.bit_length() > _MAX_INT_BITS:
            raise ToolError("Zwischenergebnis zu groß.")
        return value
    if isinstance(value, float):
        if not math.isfinite(value) or abs(value) > _MAX_FLOAT:
            raise ToolError("Zwischenergebnis außerhalb des darstellbaren Bereichs.")
        return value
    raise ToolError("Nur Zahlen sind erlaubt.")


def _check_pow(base: float, exponent: float) -> None:
    if abs(exponent) > 100:
        raise ToolError("Potenz zu groß (Exponent höchstens 100).")
    if base != 0 and abs(exponent) * math.log10(abs(base)) > 300:
        raise ToolError("Potenz zu groß.")


_FUNCS: dict[str, Callable[..., float]] = {
    "sqrt": math.sqrt, "abs": abs, "round": _round, "floor": math.floor, "ceil": math.ceil,
    "min": min, "max": max, "sum": lambda *xs: sum(xs), "mean": _mean,
    "log": math.log, "log10": math.log10, "exp": math.exp,
    "sin": math.sin, "cos": math.cos, "tan": math.tan, "atan2": math.atan2,
    "radians": math.radians, "degrees": math.degrees, "hypot": math.hypot,
    "circle_area": lambda d: math.pi * d * d / 4,
    "ring_area": lambda od, di=0.0: math.pi * (od * od - di * di) / 4,
    "circumference": lambda d: math.pi * d,
}
_CONSTS = {"pi": math.pi, "e": math.e}
_MAX_EXPR = 600
_MAX_NODES = 300
_MAX_ABS = 1e15


def _evaluate(node: ast.AST, names: dict[str, float]) -> float:
    if isinstance(node, ast.Expression):
        return _evaluate(node.body, names)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) \
            and not isinstance(node.value, bool):
        return _guard(node.value)
    if isinstance(node, ast.Name):
        if node.id in names:
            return names[node.id]
        if node.id in _CONSTS:
            return _CONSTS[node.id]
        raise ToolError(f"Unbekannter Name „{node.id}“.")
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _guard(_UNARY[type(node.op)](_evaluate(node.operand, names)))
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        left = _evaluate(node.left, names)
        right = _evaluate(node.right, names)
        if isinstance(node.op, ast.Pow):
            _check_pow(left, right)
        return _guard(_BINOPS[type(node.op)](left, right))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
        fn = _FUNCS.get(node.func.id)
        if fn is None:
            raise ToolError(f"Unbekannte Funktion „{node.func.id}“.")
        values = [_evaluate(a, names) for a in node.args]
        if len(values) > 100:
            raise ToolError("Höchstens 100 Werte je Funktion.")
        return _guard(fn(*values))
    raise ToolError("Erlaubt sind Zahlen, + − × ÷ // % **, Klammern, Variablen und "
                    "die Funktionen " + ", ".join(sorted(_FUNCS)) + ".")


def safe_calculate(expression: str, variables: dict | None = None) -> float:
    """Ein Ausdruck, sicher ausgewertet — öffentlich für die Tests."""
    expression = str(expression or "").strip().replace("×", "*").replace("÷", "/").replace("^", "**")
    if not expression:
        raise ToolError("Ausdruck fehlt.")
    if len(expression) > _MAX_EXPR:
        raise ToolError(f"Ausdruck länger als {_MAX_EXPR} Zeichen.")
    names: dict[str, float] = {}
    for key, value in (variables or {}).items():
        if not str(key).isidentifier() or str(key) in _FUNCS:
            raise ToolError(f"Variablenname „{key}“ ist nicht erlaubt.")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            try:
                value = float(str(value).replace(",", "."))
            except ValueError as exc:
                raise ToolError(f"Variable „{key}“ ist keine Zahl.") from exc
        names[str(key)] = _guard(value)
    if len(names) > 50:
        raise ToolError("Höchstens 50 Variablen.")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise ToolError(f"Ausdruck nicht lesbar: {exc.msg}") from exc
    if sum(1 for _ in ast.walk(tree)) > _MAX_NODES:
        raise ToolError("Ausdruck zu verschachtelt.")
    try:
        value = _evaluate(tree, names)
    except ToolError:
        raise
    except ZeroDivisionError as exc:
        raise ToolError("Division durch null.") from exc
    except (OverflowError, ValueError, TypeError) as exc:
        raise ToolError(f"Rechnung nicht möglich: {exc}") from exc
    if isinstance(value, complex) or not math.isfinite(float(value)) or abs(value) > _MAX_ABS:
        raise ToolError("Ergebnis außerhalb des darstellbaren Bereichs.")
    return value


def calculate(ctx: ToolContext, args: dict) -> dict:
    expression = str(_need(args, "expression"))
    variables = args.get("variables") or {}
    if not isinstance(variables, dict):
        raise ToolError("„variables“ muss ein Objekt sein.")
    value = safe_calculate(expression, variables)
    digits = args.get("digits")
    shown = round(value, max(0, min(12, int(digits)))) if digits is not None else value
    return {"summary": f"{expression} = {shown}",
            "data": {"expression": expression, "variables": variables, "result": shown}}


# ---- Katalog ---------------------------------------------------------------
_LINE_SCHEMA = {
    "type": "array", "maxItems": 50,
    "items": {"type": "object", "properties": {
        "mat": {"type": "string", "description": "material id, e.g. epdm-70"},
        "qty": {"type": "integer"}, "thk": {"type": "number", "description": "thickness mm"},
        "od": {"type": "number", "description": "outer diameter mm"},
        "di": {"type": "number", "description": "inner diameter mm"},
        "kind": {"type": "string", "description": "gasket (default), sheet or custom"},
        "label": {"type": "string"},
        "fmt": {"type": "array", "items": {"type": "number"}, "description": "[width, height] mm of a non-round part"},
    }, "required": ["mat"]},
}

ANALYSIS_SPECS = [
    ToolSpec("get_order_trace",
             "Trace one customer order end to end: work orders, plates, stations, shipments and stage timestamps.",
             _schema({"order_no": {"type": "string"}}, ["order_no"]),
             _readonly(get_order_trace)),
    ToolSpec("get_run_trace",
             "Read one nesting run (latest if run_no is empty): work orders, utilisation, waste, area saved vs. solo nesting, orders touched.",
             _schema({"run_no": {"type": "string"}}),
             _readonly(get_run_trace)),
    ToolSpec("analyse_twin",
             "Digital twin findings: bottlenecks, idle stations, changeovers, transport, layout and date risks, with station load table. Recommends, changes nothing.",
             _schema({"limit": {"type": "integer"}, "severity": {"type": "string"}}),
             _readonly(analyse_twin)),
    ToolSpec("get_factory_plan",
             "What the dispatcher would assign next (station per open work order, mode auto/suggest/none, reason). Does not apply anything.",
             _schema({"limit": {"type": "integer"}, "include_assigned": {"type": "boolean"}}),
             _readonly(get_factory_plan), roles=frozenset(OFFICE)),
    ToolSpec("get_material_flow",
             "Material flow between stations: transports, metres, exact or estimated, largest first.",
             _schema({"limit": {"type": "integer"}}),
             _readonly(get_material_flow)),
    ToolSpec("get_kpis",
             "Key figures over the last N days: throughput, lead time, on-time rate, overdue, material utilisation, work order lead time. Unknown values are null.",
             _schema({"days": {"type": "integer"}, "external_only": {"type": "boolean"}}),
             _readonly(get_kpis)),
    ToolSpec("get_material_demand",
             "Sheets needed by positions waiting for nesting, per material and thickness, against stock; flags shortages.",
             _schema({"material": {"type": "string"}}),
             _readonly(get_material_demand)),
    ToolSpec("get_shape_usage",
             "Where a library shape is used: orders, pieces, work orders. Find it by id or by label/key/norm text.",
             _schema({"shape_id": {"type": "integer"}, "query": {"type": "string"}}),
             _readonly(get_shape_usage), roles=frozenset(OFFICE)),
    ToolSpec("quote_price",
             "Calculate a price without creating an order, with the same engine the shop uses (nesting, sheets, setup, freight, VAT).",
             _schema({"lines": _LINE_SCHEMA, "cert": {"type": "string"},
                      "customer_id": {"type": "integer"}, "discount_pct": {"type": "number"}},
                     ["lines"]),
             _readonly(quote_price), roles=frozenset(OFFICE)),
    ToolSpec("check_part_fit",
             "Check whether a part can be made: diameter limits, minimum web, corner distance, which sheet formats of a material it fits on.",
             _schema({"od": {"type": "number"}, "di": {"type": "number"},
                      "width": {"type": "number"}, "height": {"type": "number"},
                      "material": {"type": "string"}}, ["od"]),
             _readonly(check_part_fit)),
    ToolSpec("plan_robot_way",
             "Plan a robot way between two stations on the same floor: metres, drive time, exact or estimated.",
             _schema({"from_station_id": {"type": "integer"}, "to_station_id": {"type": "integer"},
                      "speed_m_s": {"type": "number"}}, ["from_station_id", "to_station_id"]),
             _readonly(plan_robot_way)),
    ToolSpec("simulate_fleet",
             "Simulate planned transport robots on a floor (what-if, nothing is stored): waiting times, utilisation, encounters, recommended fleet size.",
             _schema({"floor_id": {"type": "integer"}, "robots": {"type": "integer"},
                      "planned": {"type": "array", "items": {"type": "object", "properties": {
                          "name": {"type": "string"}, "kind": {"type": "string"},
                          "speed_m_s": {"type": "number"}, "count": {"type": "integer"}}}},
                      "per_shift": {"type": "integer"}, "horizon_h": {"type": "number"},
                      "load_factor": {"type": "number"}, "include_existing": {"type": "boolean"},
                      "wait_target_min": {"type": "number"}, "seed": {"type": "integer"}}),
             _readonly(simulate_fleet), roles=frozenset(OFFICE)),
    ToolSpec("calculate",
             "Exact arithmetic. Use it for every sum, area, percentage or unit conversion instead of computing in your head. Supports + - * / // % **, parentheses, variables, pi, e, sqrt, round, min, max, sum, mean, log, sin/cos/tan, hypot, circle_area(d), ring_area(od, di), circumference(d).",
             _schema({"expression": {"type": "string"}, "variables": {"type": "object"},
                      "digits": {"type": "integer"}}, ["expression"]),
             calculate),
]

#: Bereich je Werkzeug — für die Gruppen der Werkzeugansicht.
CATEGORY_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("Container & Sandbox", ("sandbox_",)),
    ("Subagenten", ("subagent",)),
    ("Lieferkette", ("supplier", "purchase_order", "goods_receipt", "material_lot", "plate_lot",
                     "scrap_event", "downtime", "supply_alert", "mrp_projection", "order_ctp",
                     "supply_shock", "margin_ppv", "oee_summary", "twin_supply_risk",
                     "action_proposal", "propose_", "world_event", "world_intel",
                     "macro_and_chokepoints", "outgoing_orders", "supply_chain_dossier")),
    ("Analyse", ("get_order_trace", "get_run_trace", "analyse_twin", "get_factory_plan",
                 "get_material_flow", "get_kpis", "get_material_demand", "get_shape_usage",
                 "quote_price", "check_part_fit", "calculate", "platform_overview",
                 "global_search", "get_activity", "query_orders", "aggregate_orders",
                 "get_order_aging", "get_customer_analytics", "get_inventory_forecast",
                 "get_production_trends", "get_ar_aging")),
    ("Web", ("web_search", "fetch_url")),
    ("Vorschau & Dateien", ("artifact", "side_preview", "report_html", "chart_artifact",
                            "attachment", "daily_briefing", "csv_table", "export_csv",
                            "convert_units", "inspect_json")),
    ("Zwilling", ("floor_layout", "station_details", "nearby_stations", "free_spot", "find_route",
                  "measure_between", "twin_finding", "rank_stations", "twin_view", "whatif",
                  "show_in_view", "move_station", "rotate_station")),
    ("Roboter", ("robot", "fleet")),
    ("Konten", ("user", "account")),
    ("Compliance", ("advisory", "support_period", "compliance")),
    ("Rechnungen", ("invoice",)),
    ("Versand", ("shipment", "shipping")),
    ("Lager & Werkstoffe", ("stock", "product", "price", "offcut")),
    ("Halle & Stationen", ("station", "site", "hall", "floor", "topology", "worklist",
                           "task", "picking", "staging", "where_am_i")),
    ("Fertigung", ("work_order", "run", "plate", "batch", "production_queue", "nesting",
                   "layout", "drawing")),
    ("Kunden", ("customer",)),
    ("Aufträge", ("order",)),
    ("Einstellungen & Protokoll", ("setting", "rate", "audit")),
]


def category_of(name: str) -> str:
    for label, needles in CATEGORY_RULES:
        if any(n in name for n in needles):
            return label
    return "Sonstiges"
