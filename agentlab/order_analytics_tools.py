"""SQL-gestützte Großdaten-Analytik & Massenaktionen für den Gimel-Assistenten.

Alle Lese-Werkzeuge rechnen direkt per SQL-Aggregation (COUNT, SUM, GROUP BY),
damit auch Datenbanken mit hunderttausenden bis Millionen Aufträgen in
Millisekunden beantwortet werden — ohne ganze Tabellen in Python zu laden.
Strukturierte Ergebnisse liefern optional ein leichtgewichtiges ``chart``-Objekt
für native Balken-, Linien- und Kennzahl-Grafiken in Chat & Copilot.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import and_, case, desc, func, or_

from gimel.db import chunked_in
from gimel.models import (
    AuditLog,
    LocalInvoice,
    NestRun,
    Offcut,
    Order,
    OrderPosition,
    Product,
    Role,
    StockLocation,
    StockMovement,
    User,
    WorkOrder,
    WorkOrderStatus,
)
from gimel.services import floor_view

from .rollback import record
from .tools import ALL, OFFICE, ToolContext, ToolError, ToolSpec, _limit, _need, _parse_due_date

try:
    from .analysis_tools import _readonly
except Exception:  # pragma: no cover
    def _readonly(fn):
        return fn


def _parse_dt(value: Any, *, end_of_day: bool = False) -> datetime | None:
    if not value:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    try:
        if len(raw) == 10 and raw[4] == "-" and raw[7] == "-":
            dt = datetime.fromisoformat(raw + ("T23:59:59+00:00" if end_of_day else "T00:00:00+00:00"))
        else:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ToolError(f"Ungültiges Datum „{raw}“ (erwartet YYYY-MM-DD oder ISO-8601).") from exc


def _office(ctx: ToolContext) -> bool:
    return ctx.user.role in (Role.staff, Role.admin)


def _date_bucket(dialect: str, col, granularity: str):
    if dialect == "sqlite":
        fmt = {
            "day": "%Y-%m-%d",
            "week": "%Y-W%W",
            "month": "%Y-%m",
            "quarter": "%Y-%m",
        }[granularity]
        return func.strftime(fmt, col)
    fmt_pg = {
        "day": "YYYY-MM-DD",
        "week": "IYYY-\"W\"IW",
        "month": "YYYY-MM",
        "quarter": "YYYY-\"Q\"Q",
    }[granularity]
    return func.to_char(col, fmt_pg)


def _apply_order_filters(q, db, args: dict, office: bool):
    now = datetime.now(timezone.utc)
    if args.get("exclude_cancelled", True):
        q = q.filter(Order.cancelled_at.is_(None))
    if args.get("open_only"):
        q = q.filter(Order.stage < 2, Order.cancelled_at.is_(None))
    if args.get("overdue_only"):
        q = q.filter(
            Order.stage < 2,
            Order.cancelled_at.is_(None),
            Order.due_date.isnot(None),
            Order.due_date < now,
        )
    if args.get("stage") is not None:
        q = q.filter(Order.stage == int(args["stage"]))
    if args.get("blocked") is not None:
        q = q.filter(Order.blocked.is_(bool(args["blocked"])))
    if args.get("released") is not None:
        q = q.filter(Order.released.is_(bool(args["released"])))
    if args.get("rush") is not None:
        q = q.filter(Order.rush.is_(bool(args["rush"])))
    if args.get("held") is not None:
        q = q.filter(Order.held_at.isnot(None) if args["held"] else Order.held_at.is_(None))
    if args.get("kind"):
        q = q.filter(Order.kind == str(args["kind"]).strip())
    if args.get("route_scope"):
        q = q.filter(Order.route_scope == str(args["route_scope"]).strip())
    if office:
        if args.get("paid") is not None:
            q = q.filter(Order.paid.is_(bool(args["paid"])))
        if args.get("invoiced") is not None:
            if args["invoiced"]:
                q = q.filter(Order.invoice_no != "")
            else:
                q = q.filter(or_(Order.invoice_no.is_(None), Order.invoice_no == ""))
        if args.get("customer_id") is not None:
            q = q.filter(Order.user_id == int(args["customer_id"]))
        if args.get("min_gross") is not None:
            q = q.filter(Order.gross >= float(args["min_gross"]))
        if args.get("max_gross") is not None:
            q = q.filter(Order.gross <= float(args["max_gross"]))
    if args.get("handler_email"):
        h = db.query(User.id).filter(func.lower(User.email) == str(args["handler_email"]).strip().lower()).first()
        if h is None:
            q = q.filter(Order.id == -1)
        else:
            q = q.filter(Order.handler_user_id == h[0])

    c_from = _parse_dt(args.get("created_from"))
    c_to = _parse_dt(args.get("created_to"), end_of_day=True)
    if c_from:
        q = q.filter(Order.created_at >= c_from)
    if c_to:
        q = q.filter(Order.created_at <= c_to)
    d_from = _parse_dt(args.get("due_from"))
    d_to = _parse_dt(args.get("due_to"), end_of_day=True)
    if d_from:
        q = q.filter(Order.due_date >= d_from)
    if d_to:
        q = q.filter(Order.due_date <= d_to)

    mat = str(args.get("material") or "").strip()
    thk = args.get("thickness")
    if mat or thk is not None:
        from sqlalchemy import exists
        conds = [OrderPosition.order_id == Order.id]
        if mat:
            conds.append(OrderPosition.mat.ilike(f"%{mat}%"))
        if thk is not None:
            conds.append(OrderPosition.thk == float(thk))
        q = q.filter(exists().where(*conds))

    text_q = str(args.get("query") or "").strip()
    if text_q:
        like = f"%{text_q}%"
        if office:
            q = q.outerjoin(User, Order.user_id == User.id).filter(
                or_(
                    Order.no.ilike(like),
                    Order.customer_ref.ilike(like),
                    Order.contact_email.ilike(like),
                    Order.invoice_no.ilike(like),
                    Order.internal_owner.ilike(like),
                    User.company.ilike(like),
                    User.name.ilike(like),
                )
            )
        else:
            q = q.filter(or_(Order.no.ilike(like), Order.internal_owner.ilike(like)))
    return q


@_readonly
def query_orders(ctx: ToolContext, args: dict) -> dict:
    """Strukturierte Großdaten-Abfrage über Aufträge mit SQL-Gesamtsummen und Paginierung."""
    db = ctx.db
    office = _office(ctx)
    q = _apply_order_filters(db.query(Order), db, args, office)

    agg_row = q.with_entities(
        func.count(Order.id),
        func.coalesce(func.sum(Order.net), 0.0),
        func.coalesce(func.sum(Order.gross), 0.0),
    ).one()
    total_count = int(agg_row[0] or 0)
    sum_net = round(float(agg_row[1] or 0.0), 2) if office else None
    sum_gross = round(float(agg_row[2] or 0.0), 2) if office else None

    sort_key = str(args.get("sort_by") or "created_at")
    sort_dir = str(args.get("sort_dir") or "desc").lower()
    col_map = {
        "created_at": Order.created_at,
        "due_date": Order.due_date,
        "gross": Order.gross if office else Order.created_at,
        "no": Order.no,
    }
    col = col_map.get(sort_key, Order.created_at)
    order_expr = col.asc() if sort_dir == "asc" else col.desc()

    limit = _limit(args.get("limit"), 25, 100)
    offset = max(0, int(args.get("offset") or 0))
    rows = q.order_by(order_expr, Order.id.desc()).offset(offset).limit(limit).all()

    user_ids = {o.user_id for o in rows if o.user_id}
    users = (
        {
            uid: (comp or name or email)
            for uid, comp, name, email in db.query(User.id, User.company, User.name, User.email)
            .filter(chunked_in(User.id, user_ids))
            .all()
        }
        if user_ids and office
        else {}
    )
    items = []
    for o in rows:
        internal = (o.kind or "external") == "internal"
        ship = o.ship_address or {}
        cust = (
            o.internal_owner
            if internal
            else floor_view.customer_name(users.get(o.user_id or 0) or ship.get("company") or "", office)
        )
        row: dict[str, Any] = {
            "no": o.no,
            "kind": o.kind or "external",
            "customer": cust,
            "customer_ref": o.customer_ref if office else "",
            "stage": o.stage,
            "released": bool(o.released),
            "blocked": bool(o.blocked),
            "rush": bool(o.rush),
            "held": o.held_at is not None,
            "cancelled": o.cancelled_at is not None,
            "created_at": o.created_at.isoformat() if o.created_at else None,
            "due_date": o.due_date.isoformat() if o.due_date else None,
            "route_scope": o.route_scope or "",
        }
        if office:
            row.update({
                "net": round(float(o.net or 0), 2),
                "gross": round(float(o.gross or 0), 2),
                "paid": bool(o.paid),
                "invoice_no": o.invoice_no or "",
            })
        items.append(row)

    summary = f"{total_count} passende Aufträge gefunden (zeige {len(items)} ab Versatz {offset})."
    if office and sum_gross is not None:
        summary += f" Gesamtsumme brutto: {sum_gross:,.2f} €."
    return {
        "summary": summary,
        "data": {
            "total_count": total_count,
            "offset": offset,
            "limit": limit,
            "has_more": offset + len(items) < total_count,
            "sum_net": sum_net,
            "sum_gross": sum_gross,
            "orders": items,
        },
    }


@_readonly
def aggregate_orders(ctx: ToolContext, args: dict) -> dict:
    """SQL-Aggregation (BI / Zeitreihen / Pivot) über Millionen Aufträge mit Diagramm-Ausgabe."""
    db = ctx.db
    office = _office(ctx)
    group_by = str(args.get("group_by") or "month").strip().lower()
    allowed_groups = {
        "day", "week", "month", "quarter", "customer", "material",
        "thickness", "stage", "handler", "kind", "payment_status", "route_scope",
    }
    if group_by not in allowed_groups:
        raise ToolError(f"Unbekannte Gruppierung „{group_by}“. Erlaubt: {', '.join(sorted(allowed_groups))}.")
    if group_by in ("customer", "payment_status") and not office:
        raise ToolError("Diese Gruppierung ist dem Büro vorbehalten.")

    dialect = db.bind.dialect.name if db.bind is not None else "sqlite"
    limit = _limit(args.get("limit"), 24, 100)
    now = datetime.now(timezone.utc)
    base_q = _apply_order_filters(db.query(Order), db, args, office)
    overdue_case = case(
        (and_(Order.stage < 2, Order.cancelled_at.is_(None), Order.due_date.isnot(None), Order.due_date < now), 1),
        else_=0,
    )

    if group_by in ("day", "week", "month", "quarter"):
        bucket = _date_bucket(dialect, Order.created_at, group_by)
        rows = (
            base_q.with_entities(
                bucket.label("g"),
                func.count(Order.id),
                func.coalesce(func.sum(Order.net), 0.0),
                func.coalesce(func.sum(Order.gross), 0.0),
                func.coalesce(func.sum(overdue_case), 0),
            )
            .group_by(bucket)
            .order_by(bucket.asc())
            .all()
        )
        # Bei SQLite Quartale aus YYYY-MM zusammenfassen
        if group_by == "quarter" and dialect == "sqlite":
            q_agg: dict[str, list[float]] = {}
            for g, cnt, net_s, gross_s, ov in rows:
                s = str(g or "unbekannt")
                if len(s) == 7 and s[4] == "-":
                    qnum = (int(s[5:7]) - 1) // 3 + 1
                    key = f"{s[:4]}-Q{qnum}"
                else:
                    key = s
                slot = q_agg.setdefault(key, [0, 0.0, 0.0, 0])
                slot[0] += int(cnt or 0)
                slot[1] += float(net_s or 0.0)
                slot[2] += float(gross_s or 0.0)
                slot[3] += int(ov or 0)
            rows = [(k, int(v[0]), v[1], v[2], int(v[3])) for k, v in sorted(q_agg.items())]
        rows = rows[-limit:]
        chart_kind = "line"
    elif group_by == "material" or group_by == "thickness":
        key_col = OrderPosition.mat if group_by == "material" else OrderPosition.thk
        rows = (
            base_q.join(OrderPosition, OrderPosition.order_id == Order.id)
            .with_entities(
                key_col.label("g"),
                func.count(func.distinct(Order.id)),
                func.coalesce(func.sum(OrderPosition.qty), 0),
                func.coalesce(func.sum(OrderPosition.mat_cost + OrderPosition.cut_cost), 0.0),
                func.coalesce(func.sum(overdue_case), 0),
            )
            .group_by(key_col)
            .order_by(desc(func.count(func.distinct(Order.id))))
            .limit(limit)
            .all()
        )
        chart_kind = "bar"
    elif group_by == "customer":
        label_col = func.coalesce(func.nullif(User.company, ""), func.nullif(User.name, ""), User.email, "Gast / ohne Konto")
        rows = (
            base_q.outerjoin(User, Order.user_id == User.id)
            .with_entities(
                label_col.label("g"),
                func.count(Order.id),
                func.coalesce(func.sum(Order.net), 0.0),
                func.coalesce(func.sum(Order.gross), 0.0),
                func.coalesce(func.sum(overdue_case), 0),
            )
            .group_by(label_col)
            .order_by(desc(func.coalesce(func.sum(Order.gross), 0.0)))
            .limit(limit)
            .all()
        )
        chart_kind = "bar"
    elif group_by == "handler":
        label_col = func.coalesce(func.nullif(User.name, ""), User.email, "ohne Bearbeiter")
        rows = (
            base_q.outerjoin(User, Order.handler_user_id == User.id)
            .with_entities(
                label_col.label("g"),
                func.count(Order.id),
                func.coalesce(func.sum(Order.net), 0.0),
                func.coalesce(func.sum(Order.gross), 0.0),
                func.coalesce(func.sum(overdue_case), 0),
            )
            .group_by(label_col)
            .order_by(desc(func.count(Order.id)))
            .limit(limit)
            .all()
        )
        chart_kind = "bar"
    elif group_by == "payment_status":
        pay_col = case(
            (Order.paid.is_(True), "bezahlt"),
            (and_(Order.invoice_no != "", Order.invoice_due_at.isnot(None), Order.invoice_due_at < now), "überfällig"),
            (Order.invoice_no != "", "Rechnung offen"),
            else_="ohne Rechnung",
        )
        rows = (
            base_q.with_entities(
                pay_col.label("g"),
                func.count(Order.id),
                func.coalesce(func.sum(Order.net), 0.0),
                func.coalesce(func.sum(Order.gross), 0.0),
                func.coalesce(func.sum(overdue_case), 0),
            )
            .group_by(pay_col)
            .order_by(desc(func.count(Order.id)))
            .limit(limit)
            .all()
        )
        chart_kind = "bar"
    else:
        col_map = {
            "stage": Order.stage,
            "kind": func.coalesce(Order.kind, "external"),
            "route_scope": func.coalesce(func.nullif(Order.route_scope, ""), "alle Standorte"),
        }
        gcol = col_map[group_by]
        rows = (
            base_q.with_entities(
                gcol.label("g"),
                func.count(Order.id),
                func.coalesce(func.sum(Order.net), 0.0),
                func.coalesce(func.sum(Order.gross), 0.0),
                func.coalesce(func.sum(overdue_case), 0),
            )
            .group_by(gcol)
            .order_by(desc(func.count(Order.id)))
            .limit(limit)
            .all()
        )
        chart_kind = "bar"

    buckets = []
    for g, cnt, v1, v2, ov in rows:
        item: dict[str, Any] = {
            "group": str(g) if g is not None else "unbekannt",
            "orders": int(cnt or 0),
            "overdue": int(ov or 0),
        }
        if group_by in ("material", "thickness"):
            item["total_qty"] = int(v1 or 0)
            if office:
                item["est_cost"] = round(float(v2 or 0.0), 2)
        elif office:
            item["net"] = round(float(v1 or 0.0), 2)
            item["gross"] = round(float(v2 or 0.0), 2)
            item["avg_gross"] = round(item["gross"] / item["orders"], 2) if item["orders"] else 0.0
        buckets.append(item)

    metric_key = "gross" if (office and group_by not in ("material", "thickness")) else "orders"
    chart = {
        "kind": chart_kind,
        "title": f"Aufträge nach {group_by}",
        "unit": "€" if metric_key == "gross" else "Aufträge",
        "labels": [b["group"] for b in buckets],
        "series": [{"name": "Brutto (€)" if metric_key == "gross" else "Aufträge", "values": [b.get(metric_key, 0) for b in buckets]}],
    }

    # Optionaler Vorperiodenvergleich bei gesetztem Datumsfenster
    comparison = None
    c_from = _parse_dt(args.get("created_from"))
    c_to = _parse_dt(args.get("created_to"), end_of_day=True) or now
    if args.get("compare_previous") and c_from is not None and c_to > c_from:
        span = c_to - c_from
        prev_args = dict(args, created_from=(c_from - span).isoformat(), created_to=c_from.isoformat())
        prev_q = _apply_order_filters(db.query(Order), db, prev_args, office)
        p_cnt, p_gross = prev_q.with_entities(
            func.count(Order.id), func.coalesce(func.sum(Order.gross), 0.0)
        ).one()
        cur_cnt = sum(b["orders"] for b in buckets)
        cur_gross = sum(b.get("gross", 0.0) for b in buckets)
        comparison = {
            "previous_orders": int(p_cnt or 0),
            "orders_delta_pct": round((cur_cnt - int(p_cnt or 0)) / max(1, int(p_cnt or 0)) * 100, 1) if p_cnt else None,
        }
        if office:
            comparison["previous_gross"] = round(float(p_gross or 0.0), 2)
            comparison["gross_delta_pct"] = (
                round((cur_gross - float(p_gross or 0.0)) / float(p_gross) * 100, 1) if p_gross else None
            )

    return {
        "summary": f"Auftragsaggregation nach {group_by}: {len(buckets)} Gruppe(n), {sum(b['orders'] for b in buckets)} Aufträge.",
        "data": {"group_by": group_by, "buckets": buckets, "comparison": comparison, "chart": chart},
    }


@_readonly
def get_order_aging_and_bottlenecks(ctx: ToolContext, args: dict) -> dict:
    """Pipeline-Trichter, Altersklassen offener Aufträge und SLA-Risiko direkt aus SQL."""
    db = ctx.db
    office = _office(ctx)
    now = datetime.now(timezone.utc)
    d1 = now - timedelta(days=1)
    d3 = now - timedelta(days=3)
    d7 = now - timedelta(days=7)

    base = db.query(Order).filter(Order.stage < 2, Order.cancelled_at.is_(None))
    row = base.with_entities(
        func.count(Order.id),
        func.coalesce(func.sum(case((Order.blocked.is_(True), 1), else_=0)), 0),
        func.coalesce(func.sum(case((Order.held_at.isnot(None), 1), else_=0)), 0),
        func.coalesce(func.sum(case((and_(Order.released.is_(False), Order.blocked.is_(False), Order.held_at.is_(None)), 1), else_=0)), 0),
        func.coalesce(func.sum(case((and_(Order.released.is_(True), Order.stage == 0, Order.blocked.is_(False), Order.held_at.is_(None)), 1), else_=0)), 0),
        func.coalesce(func.sum(case((Order.stage == 1, 1), else_=0)), 0),
        func.coalesce(func.sum(case((Order.created_at >= d1, 1), else_=0)), 0),
        func.coalesce(func.sum(case((and_(Order.created_at < d1, Order.created_at >= d3), 1), else_=0)), 0),
        func.coalesce(func.sum(case((and_(Order.created_at < d3, Order.created_at >= d7), 1), else_=0)), 0),
        func.coalesce(func.sum(case((Order.created_at < d7, 1), else_=0)), 0),
        func.coalesce(func.sum(case((and_(Order.due_date.isnot(None), Order.due_date < now), 1), else_=0)), 0),
        func.coalesce(func.sum(case((and_(Order.due_date.isnot(None), Order.due_date >= now, Order.due_date <= now + timedelta(days=2)), 1), else_=0)), 0),
    ).one()

    funnel = {
        "open_total": int(row[0] or 0),
        "blocked": int(row[1] or 0),
        "held": int(row[2] or 0),
        "awaiting_release": int(row[3] or 0),
        "awaiting_nesting": int(row[4] or 0),
        "in_production": int(row[5] or 0),
        "overdue": int(row[10] or 0),
        "due_within_48h": int(row[11] or 0),
    }
    aging = {
        "<1d": int(row[6] or 0),
        "1-3d": int(row[7] or 0),
        "3-7d": int(row[8] or 0),
        ">7d": int(row[9] or 0),
    }

    # Dringendste gefährdete / überfällige Aufträge (Top 15)
    at_risk_rows = (
        base.filter(Order.due_date.isnot(None), Order.due_date <= now + timedelta(days=3))
        .order_by(Order.due_date.asc())
        .limit(15)
        .all()
    )
    at_risk = []
    for o in at_risk_rows:
        due = o.due_date
        if due and due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        hours_left = round((due - now).total_seconds() / 3600, 1) if due else None
        at_risk.append({
            "no": o.no,
            "due_date": o.due_date.isoformat() if o.due_date else None,
            "hours_until_due": hours_left,
            "stage": o.stage,
            "released": bool(o.released),
            "blocked": bool(o.blocked),
            "rush": bool(o.rush),
            "gross": round(float(o.gross or 0), 2) if office else None,
        })

    chart = {
        "kind": "bar",
        "title": "Offene Aufträge nach Altersklasse",
        "unit": "Aufträge",
        "labels": list(aging.keys()),
        "series": [{"name": "Offene Aufträge", "values": list(aging.values())}],
    }
    return {
        "summary": (
            f"{funnel['open_total']} offene Aufträge: {funnel['overdue']} überfällig, "
            f"{funnel['due_within_48h']} in 48h fällig, {funnel['blocked']} gesperrt, "
            f"{aging['>7d']} älter als 7 Tage."
        ),
        "data": {"funnel": funnel, "aging": aging, "at_risk": at_risk, "chart": chart},
    }


@_readonly
def get_customer_analytics(ctx: ToolContext, args: dict) -> dict:
    """Kunden-Analytik: Top-Kunden, offene Forderungen, Kreditrahmen-Auslastung und Inaktivität."""
    db = ctx.db
    limit = _limit(args.get("limit"), 15, 50)
    days = max(1, min(int(args.get("days") or 365), 3650))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    sort_by = str(args.get("sort_by") or "gross").lower()

    order_q = (
        db.query(
            Order.user_id.label("uid"),
            func.count(Order.id).label("n_orders"),
            func.coalesce(func.sum(Order.net), 0.0).label("total_net"),
            func.coalesce(func.sum(Order.gross), 0.0).label("total_gross"),
            func.coalesce(func.sum(case((Order.paid.is_(False), Order.gross), else_=0.0)), 0.0).label("open_gross"),
            func.max(Order.created_at).label("last_order"),
        )
        .filter(Order.user_id.isnot(None), Order.cancelled_at.is_(None), Order.created_at >= since)
        .group_by(Order.user_id)
        .subquery()
    )
    sort_expr = {
        "orders": desc(order_q.c.n_orders),
        "open_gross": desc(order_q.c.open_gross),
        "gross": desc(order_q.c.total_gross),
    }.get(sort_by, desc(order_q.c.total_gross))

    rows = (
        db.query(
            User.id, User.customer_no, User.company, User.name, User.email,
            User.credit_limit, User.order_block,
            order_q.c.n_orders, order_q.c.total_net, order_q.c.total_gross,
            order_q.c.open_gross, order_q.c.last_order,
        )
        .join(order_q, order_q.c.uid == User.id)
        .filter(User.role == Role.customer)
        .order_by(sort_expr)
        .limit(limit)
        .all()
    )
    customers = []
    for r in rows:
        credit = float(r.credit_limit or 0.0)
        open_g = round(float(r.open_gross or 0.0), 2)
        customers.append({
            "id": r.id,
            "customer_no": r.customer_no or "",
            "customer": r.company or r.name or r.email,
            "orders": int(r.n_orders or 0),
            "total_net": round(float(r.total_net or 0.0), 2),
            "total_gross": round(float(r.total_gross or 0.0), 2),
            "open_gross": open_g,
            "credit_limit": credit,
            "credit_used_pct": round(open_g / credit * 100, 1) if credit > 0 else None,
            "order_block": bool(r.order_block),
            "last_order_at": r.last_order.isoformat() if r.last_order else None,
        })

    chart = {
        "kind": "bar",
        "title": f"Top-Kunden ({days} Tage)",
        "unit": "€",
        "labels": [c["customer"][:24] for c in customers[:10]],
        "series": [{"name": "Brutto (€)", "values": [c["total_gross"] for c in customers[:10]]}],
    }
    return {
        "summary": f"Kundenanalyse ({days} Tage): Top {len(customers)} Kunden ausgewertet.",
        "data": {"days": days, "customers": customers, "chart": chart},
    }


@_readonly
def get_inventory_forecast(ctx: ToolContext, args: dict) -> dict:
    """SQL-Bestandsreichweite: 30/90-Tage-Verbrauch + offener Bedarf + Reststücke + Bestellempfehlung."""
    db = ctx.db
    days = max(7, min(int(args.get("days") or 90), 365))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    only_low = bool(args.get("only_low", False))

    burn_map = dict(
        db.query(
            StockMovement.product_id,
            func.coalesce(
                func.sum(
                    case(
                        ((StockMovement.delta < 0) & (StockMovement.reason == "sammellauf"), -StockMovement.delta),
                        ((StockMovement.delta > 0) & (StockMovement.reason == "storno"), -StockMovement.delta),
                        else_=0,
                    )
                ),
                0,
            ),
        )
        .filter(StockMovement.created_at >= since)
        .group_by(StockMovement.product_id)
        .all()
    )

    pending_map = dict(
        db.query(
            OrderPosition.mat,
            func.coalesce(func.sum(OrderPosition.qty), 0),
        )
        .join(Order, OrderPosition.order_id == Order.id)
        .filter(OrderPosition.production_status == "pending", Order.cancelled_at.is_(None))
        .group_by(OrderPosition.mat)
        .all()
    )

    offcut_map = dict(
        db.query(Offcut.product_id, func.count(Offcut.id))
        .filter(Offcut.status == "available")
        .group_by(Offcut.product_id)
        .all()
    )

    products = db.query(Product).filter(Product.active.is_(True)).order_by(Product.name.asc()).all()
    rows = []
    for p in products:
        stock = int(p.stock or 0)
        net_burn = max(0, int(burn_map.get(p.id, 0) or 0))
        daily = net_burn / days
        reach = round(stock / daily, 1) if daily > 0 else None
        lead = int(p.lead_days or 0)
        pending_parts = int(pending_map.get(p.id, 0) or 0)
        reorder = (stock <= 0 and pending_parts > 0) or (reach is not None and lead > 0 and reach <= lead * 1.2)
        if only_low and not reorder and stock >= 5:
            continue
        rows.append({
            "product_id": p.id,
            "name": p.name,
            "stock_plates": stock,
            "consumed_plates": net_burn,
            "avg_plates_per_day": round(daily, 3),
            "reach_days": reach,
            "lead_days": lead,
            "pending_parts": pending_parts,
            "available_offcuts": int(offcut_map.get(p.id, 0) or 0),
            "reorder_recommended": reorder,
        })

    rows.sort(key=lambda r: (not r["reorder_recommended"], r["reach_days"] if r["reach_days"] is not None else 999999, r["stock_plates"]))
    n_reorder = sum(1 for r in rows if r["reorder_recommended"])
    return {
        "summary": f"Bestandsprognose ({days} Tage): {len(rows)} Werkstoff(e), {n_reorder} mit Bestellempfehlung.",
        "data": {"days": days, "reorder_count": n_reorder, "materials": rows[:60]},
    }


@_readonly
def get_production_trends(ctx: ToolContext, args: dict) -> dict:
    """Wöchentliche oder monatliche Fertigungs- und Schachtel-Trends direkt aus SQL."""
    db = ctx.db
    gran = str(args.get("granularity") or "week").lower()
    if gran not in ("day", "week", "month"):
        raise ToolError("granularity muss day, week oder month sein.")
    days = max(7, min(int(args.get("days") or 90), 730))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    dialect = db.bind.dialect.name if db.bind is not None else "sqlite"

    b_run = _date_bucket(dialect, NestRun.started_at, gran)
    run_rows = (
        db.query(
            b_run.label("g"),
            func.count(NestRun.id),
            func.coalesce(func.sum(NestRun.n_plates), 0),
            func.coalesce(func.sum(NestRun.n_parts), 0),
            func.coalesce(func.sum(NestRun.solo_area_m2), 0.0),
            func.coalesce(func.sum(NestRun.batch_area_m2), 0.0),
        )
        .filter(NestRun.started_at >= since)
        .group_by(b_run)
        .order_by(b_run.asc())
        .all()
    )
    series = []
    for g, cnt, plates, parts, solo, batch in run_rows:
        solo_f, batch_f = float(solo or 0.0), float(batch or 0.0)
        saved = max(0.0, solo_f - batch_f)
        series.append({
            "period": str(g or ""),
            "runs": int(cnt or 0),
            "plates": int(plates or 0),
            "parts": int(parts or 0),
            "saved_m2": round(saved, 3),
            "saved_pct": round(saved / solo_f * 100, 1) if solo_f > 0 else 0.0,
        })

    chart = {
        "kind": "line",
        "title": f"Schachtel-Teile je {gran} ({days} Tage)",
        "unit": "Teile",
        "labels": [s["period"] for s in series],
        "series": [{"name": "Teile", "values": [s["parts"] for s in series]}],
    }
    return {
        "summary": f"Fertigungstrends ({days} Tage, {gran}): {len(series)} Periode(n), {sum(s['parts'] for s in series)} Teile.",
        "data": {"granularity": gran, "days": days, "periods": series, "chart": chart},
    }


@_readonly
def get_ar_aging(ctx: ToolContext, args: dict) -> dict:
    """Offene Forderungen & Altersstruktur (Mahnwesen) über alle Rechnungen direkt aus SQL."""
    db = ctx.db
    now = datetime.now(timezone.utc)
    d14 = now - timedelta(days=14)
    d30 = now - timedelta(days=30)
    d60 = now - timedelta(days=60)
    is_open = and_(Order.invoice_no != "", Order.paid.is_(False), Order.cancelled_at.is_(None))
    is_over = and_(is_open, Order.invoice_due_at.isnot(None), Order.invoice_due_at < now)

    r = db.query(
        func.coalesce(func.sum(case((is_open, 1), else_=0)), 0),
        func.coalesce(func.sum(case((is_open, Order.gross), else_=0.0)), 0.0),
        func.coalesce(func.sum(case((is_over, 1), else_=0)), 0),
        func.coalesce(func.sum(case((is_over, Order.gross), else_=0.0)), 0.0),
        func.coalesce(func.sum(case((and_(is_over, Order.invoice_due_at >= d14), Order.gross), else_=0.0)), 0.0),
        func.coalesce(func.sum(case((and_(is_over, Order.invoice_due_at < d14, Order.invoice_due_at >= d30), Order.gross), else_=0.0)), 0.0),
        func.coalesce(func.sum(case((and_(is_over, Order.invoice_due_at < d30, Order.invoice_due_at >= d60), Order.gross), else_=0.0)), 0.0),
        func.coalesce(func.sum(case((and_(is_over, Order.invoice_due_at < d60), Order.gross), else_=0.0)), 0.0),
    ).one()

    buckets = {
        "1-14 Tage": round(float(r[4] or 0.0), 2),
        "15-30 Tage": round(float(r[5] or 0.0), 2),
        "31-60 Tage": round(float(r[6] or 0.0), 2),
        ">60 Tage": round(float(r[7] or 0.0), 2),
    }
    oldest = (
        db.query(Order)
        .filter(is_over)
        .order_by(Order.invoice_due_at.asc())
        .limit(15)
        .all()
    )
    top_overdue = []
    for o in oldest:
        due = o.invoice_due_at
        if due and due.tzinfo is None:
            due = due.replace(tzinfo=timezone.utc)
        top_overdue.append({
            "order_no": o.no,
            "invoice_no": o.invoice_no,
            "gross": round(float(o.gross or 0.0), 2),
            "days_overdue": max(0, (now - due).days) if due else 0,
            "due_at": o.invoice_due_at.isoformat() if o.invoice_due_at else None,
        })

    chart = {
        "kind": "bar",
        "title": "Überfällige Forderungen nach Alter (€)",
        "unit": "€",
        "labels": list(buckets.keys()),
        "series": [{"name": "Überfällig (€)", "values": list(buckets.values())}],
    }
    return {
        "summary": f"{int(r[0] or 0)} offene Rechnung(en) ({float(r[1] or 0):.2f} €), davon {int(r[2] or 0)} überfällig ({float(r[3] or 0):.2f} €).",
        "data": {
            "open_count": int(r[0] or 0),
            "open_sum": round(float(r[1] or 0.0), 2),
            "overdue_count": int(r[2] or 0),
            "overdue_sum": round(float(r[3] or 0.0), 2),
            "buckets": buckets,
            "top_overdue": top_overdue,
            "chart": chart,
        },
    }


@_readonly
def list_offcuts(ctx: ToolContext, args: dict) -> dict:
    """Reststücke im Lager (verfügbar, reserviert oder geplant)."""
    q = ctx.db.query(Offcut)
    status = str(args.get("status") or "available").strip()
    if status != "all":
        q = q.filter(Offcut.status == status)
    if args.get("material"):
        q = q.filter(Offcut.product_id == str(args["material"]).strip())
    if args.get("thickness") is not None:
        q = q.filter(Offcut.thk == float(args["thickness"]))
    rows = q.order_by(Offcut.id.desc()).limit(_limit(args.get("limit"), 40, 200)).all()
    items = [
        {
            "id": o.id,
            "material": o.product_id,
            "thk": o.thk,
            "w_mm": o.w_mm,
            "h_mm": o.h_mm,
            "area_m2": round((float(o.w_mm or 0) * float(o.h_mm or 0)) / 1_000_000, 3),
            "status": o.status,
            "source_wo": o.source_work_order_no,
            "used_by_wo": o.work_order_no,
            "location": o.location,
        }
        for o in rows
    ]
    return {"summary": f"{len(items)} Reststück(e) ({status}).", "data": {"offcuts": items}}


@_readonly
def list_stock_locations(ctx: ToolContext, args: dict) -> dict:
    """Lagerorte / Regalfächer je Werkstoff."""
    q = ctx.db.query(StockLocation)
    if args.get("material"):
        q = q.filter(StockLocation.product_id == str(args["material"]).strip())
    rows = q.order_by(StockLocation.product_id.asc(), StockLocation.id.asc()).limit(_limit(args.get("limit"), 60, 200)).all()
    items = [
        {
            "id": r.id,
            "material": r.product_id,
            "station_id": r.station_id,
            "rack": r.rack,
            "slot": r.slot,
            "qty": r.qty,
            "note": r.note,
        }
        for r in rows
    ]
    return {"summary": f"{len(items)} Lagerort(e) gelesen.", "data": {"locations": items}}


def bulk_update_orders(ctx: ToolContext, args: dict) -> dict:
    """Sammelaktion für bis zu 50 Aufträge (mit dry_run-Vorschau und Rücknahme je Auftrag)."""
    db, user = ctx.db, ctx.user
    raw_nos = args.get("order_nos")
    if not isinstance(raw_nos, list) or not raw_nos:
        raise ToolError("order_nos muss eine nicht-leere Liste von Auftragsnummern sein.")
    order_nos = list(dict.fromkeys(str(n).strip() for n in raw_nos if str(n).strip()))[:50]
    action = str(_need(args, "action")).strip().lower()
    # Synonyme für Fälligkeitsdatum-Änderung akzeptieren.
    if action in ("change_due_date", "update_due_date", "set_due", "change_due",
                  "update_due", "due_date", "set_order_due_date"):
        action = "set_due_date"
    if action not in ("release", "set_rush", "unset_rush", "assign_handler", "set_due_date"):
        raise ToolError("action muss release, set_rush, unset_rush, assign_handler oder set_due_date sein.")
    dry_run = bool(args.get("dry_run", True))
    note = str(args.get("note") or "")[:200]
    handler_user = None
    new_due_date = None
    if action == "assign_handler":
        email = str(_need(args, "handler_email")).strip().lower()
        handler_user = db.query(User).filter(func.lower(User.email) == email, User.active.is_(True)).first()
        if not handler_user:
            raise ToolError(f"Aktiver Bearbeiter „{email}“ nicht gefunden.")
    if action == "set_due_date":
        raw_due = args.get("due_date", args.get("due", args.get("date")))
        new_due_date = _parse_due_date(raw_due)

    orders = db.query(Order).filter(chunked_in(Order.no, order_nos)).all()
    by_no = {o.no: o for o in orders}
    eligible: list[Order] = []
    skipped: list[dict[str, str]] = []
    for no in order_nos:
        o = by_no.get(no)
        if o is None:
            skipped.append({"order_no": no, "reason": "nicht gefunden"})
            continue
        if o.cancelled_at is not None:
            skipped.append({"order_no": no, "reason": "storniert"})
            continue
        if action == "release" and (o.released or o.blocked):
            skipped.append({"order_no": no, "reason": "bereits freigegeben oder gesperrt"})
            continue
        eligible.append(o)

    if dry_run:
        return {
            "summary": f"Vorschau ({action}): {len(eligible)} Auftrag/Aufträge würden geändert, {len(skipped)} übersprungen. Nichts geschrieben.",
            "data": {
                "dry_run": True,
                "action": action,
                "would_update": [o.no for o in eligible],
                "skipped": skipped,
            },
        }

    updated_nos: list[str] = []
    last_change = None
    for o in eligible:
        if action == "release":
            before = {"released": o.released, "release_note": o.release_note}
            o.released = True
            if note:
                o.release_note = note
            after = {"released": o.released, "release_note": o.release_note}
        elif action in ("set_rush", "unset_rush"):
            before = {"rush": o.rush}
            o.rush = action == "set_rush"
            after = {"rush": o.rush}
        elif action == "set_due_date":
            before = {"due_date": o.due_date}
            o.due_date = new_due_date
            after = {"due_date": o.due_date}
        else:
            before = {"handler_user_id": o.handler_user_id, "handler_reason": o.handler_reason}
            o.handler_user_id = handler_user.id
            o.handler_reason = note or "Sammelzuweisung durch Assistent"
            after = {"handler_user_id": o.handler_user_id, "handler_reason": o.handler_reason}
        last_change = record(
            db, chat=ctx.chat, message_id=ctx.message_id, user=user,
            tool="bulk_update_orders", action=f"bulk_{action}", entity="order", entity_id=o.no,
            before=before, after=after,
            summary=f"Sammelaktion {action}: {o.no}",
        )
        db.add(AuditLog(
            actor=user.email, action=f"agent_bulk_{action}", entity="order", entity_id=o.no,
            detail={"action": action, "agent": True},
        ))
        updated_nos.append(o.no)

    res: dict[str, Any] = {
        "summary": f"Sammelaktion {action}: {len(updated_nos)} Auftrag/Aufträge geändert, {len(skipped)} übersprungen.",
        "data": {"dry_run": False, "action": action, "updated": updated_nos, "skipped": skipped},
    }
    if last_change is not None:
        res["change"] = last_change
    return res


ORDER_ANALYTICS_SPECS: list[ToolSpec] = [
    ToolSpec(
        name="query_orders",
        description="Aufträge gezielt nach vielen Kriterien filtern, sortieren und paginieren (inkl. SQL-Gesamtzahl und Umsatzsumme für Millionen Aufträge).",
        parameters={
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Freitext (Nummer, Kunde, Referenz, Rechnung)."},
                "open_only": {"type": "boolean"},
                "overdue_only": {"type": "boolean"},
                "exclude_cancelled": {"type": "boolean", "default": True},
                "stage": {"type": "integer"},
                "blocked": {"type": "boolean"},
                "released": {"type": "boolean"},
                "paid": {"type": "boolean"},
                "invoiced": {"type": "boolean"},
                "rush": {"type": "boolean"},
                "held": {"type": "boolean"},
                "kind": {"type": "string", "enum": ["external", "internal"]},
                "customer_id": {"type": "integer"},
                "handler_email": {"type": "string"},
                "material": {"type": "string"},
                "thickness": {"type": "number"},
                "created_from": {"type": "string", "description": "YYYY-MM-DD oder ISO-8601"},
                "created_to": {"type": "string"},
                "due_from": {"type": "string"},
                "due_to": {"type": "string"},
                "min_gross": {"type": "number"},
                "max_gross": {"type": "number"},
                "route_scope": {"type": "string"},
                "sort_by": {"type": "string", "enum": ["created_at", "due_date", "gross", "no"]},
                "sort_dir": {"type": "string", "enum": ["asc", "desc"]},
                "limit": {"type": "integer"},
                "offset": {"type": "integer"},
            },
        },
        roles=ALL,
        handler=query_orders,
    ),
    ToolSpec(
        name="aggregate_orders",
        description="SQL-Aggregation / BI-Pivot über alle Aufträge (nach Tag, Woche, Monat, Quartal, Kunde, Werkstoff, Dicke, Status, Bearbeiter, Zahlung) inkl. Vorperiodenvergleich und Diagrammdaten.",
        parameters={
            "type": "object",
            "properties": {
                "group_by": {
                    "type": "string",
                    "enum": ["day", "week", "month", "quarter", "customer", "material", "thickness", "stage", "handler", "kind", "payment_status", "route_scope"],
                },
                "created_from": {"type": "string"},
                "created_to": {"type": "string"},
                "open_only": {"type": "boolean"},
                "paid": {"type": "boolean"},
                "material": {"type": "string"},
                "compare_previous": {"type": "boolean"},
                "limit": {"type": "integer"},
            },
            "required": ["group_by"],
        },
        roles=ALL,
        handler=aggregate_orders,
    ),
    ToolSpec(
        name="get_order_aging_and_bottlenecks",
        description="Pipeline-Trichter offener Aufträge, Altersklassen (<1d, 1–3d, 3–7d, >7d), gesperrte/wartende Aufträge und SLA-gefährdete Liefertermine.",
        parameters={"type": "object", "properties": {}},
        roles=ALL,
        handler=get_order_aging_and_bottlenecks,
    ),
    ToolSpec(
        name="get_customer_analytics",
        description="Top-Kunden nach Umsatz, Auftragszahl oder offenen Beträgen inkl. Kreditrahmen-Auslastung.",
        parameters={
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Zeitraum in Tagen (Vorgabe 365)."},
                "sort_by": {"type": "string", "enum": ["gross", "orders", "open_gross"]},
                "limit": {"type": "integer"},
            },
        },
        roles=OFFICE,
        handler=get_customer_analytics,
    ),
    ToolSpec(
        name="get_inventory_forecast",
        description="Bestandsreichweite in Tagen aus realem Verbrauch, offenem Teilebedarf, Lieferzeit und verfügbaren Reststücken — mit Bestellempfehlung.",
        parameters={
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "Verbrauchszeitraum in Tagen (Vorgabe 90)."},
                "only_low": {"type": "boolean", "description": "Nur Werkstoffe mit Bestellempfehlung oder knappem Bestand."},
            },
        },
        roles=ALL,
        handler=get_inventory_forecast,
    ),
    ToolSpec(
        name="get_production_trends",
        description="Zeitreihe der Sammelläufe: geschnittene Platten, Teile und eingesparte Materialfläche je Tag/Woche/Monat.",
        parameters={
            "type": "object",
            "properties": {
                "granularity": {"type": "string", "enum": ["day", "week", "month"]},
                "days": {"type": "integer"},
            },
        },
        roles=ALL,
        handler=get_production_trends,
    ),
    ToolSpec(
        name="get_ar_aging",
        description="Offene Forderungen und Überfälligkeits-Altersstruktur (1–14, 15–30, 31–60, >60 Tage) mit den ältesten offenen Rechnungen.",
        parameters={"type": "object", "properties": {}},
        roles=OFFICE,
        handler=get_ar_aging,
    ),
    ToolSpec(
        name="list_offcuts",
        description="Reststücke im Lager auflisten (verfügbar, reserviert, geplant, verbraucht).",
        parameters={
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": ["available", "reserved", "pending", "used", "all"]},
                "material": {"type": "string"},
                "thickness": {"type": "number"},
                "limit": {"type": "integer"},
            },
        },
        roles=ALL,
        handler=list_offcuts,
    ),
    ToolSpec(
        name="list_stock_locations",
        description="Lagerorte und Regalfächer der Werkstoffe auflisten.",
        parameters={
            "type": "object",
            "properties": {
                "material": {"type": "string"},
                "limit": {"type": "integer"},
            },
        },
        roles=ALL,
        handler=list_stock_locations,
    ),
    ToolSpec(
        name="bulk_update_orders",
        description="Sammelaktion für bis zu 50 Aufträge (freigeben, Eilauftrag setzen/entfernen, Bearbeiter zuweisen, Fälligkeitsdatum setzen). Standardmäßig dry_run=true als Vorschau.",
        parameters={
            "type": "object",
            "properties": {
                "order_nos": {"type": "array", "items": {"type": "string"}},
                "action": {"type": "string", "enum": ["release", "set_rush", "unset_rush", "assign_handler", "set_due_date"]},
                "handler_email": {"type": "string"},
                "due_date": {"type": "string", "description": "ISO-Datum (YYYY-MM-DD) oder ISO-Zeitstempel; null/leer löscht das Datum (nur bei set_due_date)."},
                "note": {"type": "string"},
                "dry_run": {"type": "boolean", "default": True},
            },
            "required": ["order_nos", "action"],
        },
        roles=OFFICE,
        write=True,
        reversible=True,
        handler=bulk_update_orders,
    ),
]
