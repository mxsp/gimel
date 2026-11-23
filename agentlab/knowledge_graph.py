"""Plattformweiter Wissensgraph für Gimel Agent Lab.

Verknüpft alle Kerndaten der Plattform (Hallen, Stationen, Roboter, Werkstoffe,
Lieferanten, Bestellungen, Innenaufträge, Aufträge, Sendungen, Kunden & Risiken)
mit dauerhaften Erkenntnissen aus dem Orchestrator-Chat und hält den Graphen über
eine eingebaute Hintergrund-Routine automatisch aktuell.
"""

from __future__ import annotations

from collections import deque
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from gimel.db import SessionLocal
from gimel.models import (
    FactoryFloor,
    FactoryHall,
    FactoryStation,
    Order,
    OrderPosition,
    Product,
    RobotAsset,
    RobotJob,
    Role,
    Shipment,
    ShipmentItem,
    StationTask,
    User,
    WorkItem,
    WorkOrder,
)

from . import settings as agent_settings
from .models import AgentKnowledgeEdge, AgentKnowledgeNode

AUTO_SYNC_INTERVAL_S = 300
_SYNC_STARTED = False
_SYNC_LOCK = threading.Lock()
_REBUILD_LOCK = threading.Lock()
_LAST_REBUILT_AT = ""

NODE_KINDS: dict[str, str] = {
    "material": "Werkstoffe",
    "work_order": "Innenaufträge",
    "station": "Stationen",
    "robot": "Roboter",
    "hall": "Hallen",
    "order": "Aufträge",
    "shipment": "Sendungen",
    "customer": "Kunden",
    "insight": "Erkenntnisse",
}

DANGER_STATUSES = frozenset({"danger", "critical", "blocked", "overdue", "empty", "error", "offline", "cancelled"})
WARNING_STATUSES = frozenset({"warning", "low", "rush", "held", "delayed", "packing"})


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat() if dt else None


def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _attention_for(kind: str, status: str) -> str:
    st = (status or "").strip().lower()
    if kind == "alert":
        return "danger" if st in ("danger", "critical", "high") else "warning"
    if st in DANGER_STATUSES:
        return "danger"
    if st in WARNING_STATUSES:
        return "warning"
    return ""


def rebuild_platform_graph(db: Session) -> dict[str, Any]:
    """Baut den Plattform-Wissensgraphen aus allen Gimel-Modulen neu auf.

    Manuelle / vom Orchestrator gespeicherte Erkenntnis-Knoten und -Kanten
    (``source='insight'``) bleiben vollständig erhalten.
    """
    with _REBUILD_LOCK:
        now = _now()
        nodes: dict[str, dict[str, Any]] = {}
        edges: dict[tuple[str, str, str], int] = {}

        try:
            low_stock_threshold = max(0, agent_settings.get_int(db, "agent_low_stock_threshold"))
        except Exception:  # noqa: BLE001
            low_stock_threshold = 5

        def add_node(
            key: str,
            kind: str,
            label: str,
            subtitle: str = "",
            status: str = "",
            meta: dict | None = None,
        ) -> None:
            nodes[key] = {
                "node_key": key,
                "kind": kind,
                "label": (label or key)[:200],
                "subtitle": (subtitle or "")[:240],
                "status": (status or "")[:40],
                "meta": meta or {},
            }

        def add_edge(src: str, dst: str, rel: str, weight: int = 1) -> None:
            if src == dst or src not in nodes or dst not in nodes:
                return
            k = (src, dst, rel)
            edges[k] = edges.get(k, 0) + weight

        # 1. Hallen, Ebenen & Stationen
        halls = db.query(FactoryHall).all()
        for h in halls:
            add_node(
                f"hall:{h.id}", "hall", h.name or f"Halle {h.id}",
                getattr(h, "code", "") or "", "active",
                {"id": h.id, "code": getattr(h, "code", "") or ""},
            )

        floors = db.query(FactoryFloor).all()
        floor_to_hall: dict[int, int] = {}
        floor_name_by_id: dict[int, str] = {}
        for fl in floors:
            if getattr(fl, "hall_id", None):
                floor_to_hall[fl.id] = int(fl.hall_id)
            elif halls:
                floor_to_hall[fl.id] = int(halls[0].id)
            floor_name_by_id[fl.id] = (
                getattr(fl, "level_name", "") or getattr(fl, "name", "") or f"Ebene {fl.id}"
            )

        stations = db.query(FactoryStation).all()
        for s in stations:
            kind_str = str(getattr(s.type, "value", s.type) or "")
            mkind = str(getattr(s, "machine_kind", "") or "")
            fl_id = getattr(s, "floor_id", None)
            hall_id = floor_to_hall.get(fl_id) if fl_id is not None else (halls[0].id if halls else None)
            fl_label = floor_name_by_id.get(fl_id, "") if fl_id is not None else ""
            sub_parts = [p for p in (mkind or kind_str, fl_label) if p]
            add_node(
                f"station:{s.id}", "station", s.label or f"Station {s.id}",
                " · ".join(sub_parts),
                "active" if s.active else "inactive",
                {
                    "id": s.id,
                    "type": kind_str,
                    "machine_kind": mkind,
                    "active": bool(s.active),
                    "staffed": bool(getattr(s, "staffed", False)),
                    "capacity_min_per_day": float(getattr(s, "capacity_min_per_day", 0) or 0),
                    "floor": fl_label,
                    "materials": list(getattr(s, "materials", None) or []),
                },
            )
            if hall_id and f"hall:{hall_id}" in nodes:
                add_edge(f"station:{s.id}", f"hall:{hall_id}", "steht_in")

        # 2. Roboter
        for r in db.query(RobotAsset).all():
            r_state = str(getattr(r, "state", "") or ("active" if getattr(r, "active", True) else "inactive"))
            r_kind = str(getattr(r, "kind", "") or "agv").upper()
            batt = getattr(r, "battery_pct", None)
            fl_id = getattr(r, "floor_id", None)
            hall_id = floor_to_hall.get(fl_id) if fl_id is not None else (halls[0].id if halls else None)
            sub = f"{r_kind} · {r_state}" + (f" · Akku {batt}%" if batt is not None else "")
            add_node(
                f"robot:{r.id}", "robot", getattr(r, "name", None) or f"Roboter {r.id}",
                sub, r_state,
                {
                    "id": r.id,
                    "kind": r_kind,
                    "state": r_state,
                    "battery_pct": batt,
                    "speed_m_s": float(getattr(r, "speed_m_s", 0) or 0),
                    "gateway_id": str(getattr(r, "gateway_id", "") or ""),
                },
            )
            if hall_id and f"hall:{hall_id}" in nodes:
                add_edge(f"robot:{r.id}", f"hall:{hall_id}", "fährt_in")

        # 3. Werkstoffe & Stations-Fähigkeiten
        for p in db.query(Product).all():
            stock_val = int(getattr(p, "stock", 0) or 0)
            if stock_val <= 0:
                p_status = "empty"
            elif stock_val <= low_stock_threshold:
                p_status = "low"
            else:
                p_status = "ok"
            eur_m2 = float(getattr(p, "eur_m2", 0) or 0)
            add_node(
                f"material:{p.id}", "material", p.name or p.id,
                f"{p.cat or 'Werkstoff'} · Bestand {stock_val} · {eur_m2:.0f} €/m²",
                p_status,
                {
                    "id": p.id,
                    "cat": p.cat or "",
                    "stock": stock_val,
                    "eur_m2": eur_m2,
                },
            )

        for s in stations:
            for mat_id in (getattr(s, "materials", None) or []):
                if f"material:{mat_id}" in nodes:
                    add_edge(f"station:{s.id}", f"material:{mat_id}", "verarbeitet")

        # 4. Kunden
        customers = db.query(User).filter(User.role == Role.customer).limit(100).all()
        customer_by_id: dict[int, User] = {}
        for c in customers:
            customer_by_id[c.id] = c
            label = c.company or c.name or c.email
            add_node(
                f"customer:{c.id}", "customer", label,
                c.email or "", "blocked" if getattr(c, "order_block", False) else "ok",
                {"id": c.id, "email": c.email or "", "order_block": bool(getattr(c, "order_block", False))},
            )

        # 6. Aufträge & Positionen (neueste 100)
        orders = db.query(Order).order_by(Order.id.desc()).limit(100).all()
        order_ids = [o.id for o in orders]
        order_no_by_id: dict[int, str] = {}
        for o in orders:
            order_no_by_id[o.id] = o.no
            due_utc = _as_utc(o.due_date)
            is_overdue = bool(due_utc and due_utc < now and not o.cancelled_at and not getattr(o, "shipped_at", None))
            if o.cancelled_at:
                st = "cancelled"
            elif o.blocked:
                st = "blocked"
            elif getattr(o, "held_at", None):
                st = "held"
            elif is_overdue:
                st = "overdue"
            elif o.rush:
                st = "rush"
            else:
                st = "open"
            cust = customer_by_id.get(o.user_id) if getattr(o, "user_id", None) else None
            who = (
                (cust.company or cust.name or cust.email) if cust
                else (getattr(o, "internal_owner", "") or getattr(o, "customer_ref", "") or "Auftrag")
            )
            gross_val = float(getattr(o, "gross", 0) or 0)
            due_txt = f" · Termin {due_utc.strftime('%d.%m.')}" if due_utc else ""
            gross_txt = f"{gross_val:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
            sub_txt = f"{who} · {gross_txt} €{due_txt}" if gross_val else f"{who}{due_txt}"
            add_node(
                f"order:{o.no}", "order", o.no,
                sub_txt,
                st,
                {
                    "no": o.no,
                    "customer": who,
                    "gross": round(gross_val, 2),
                    "rush": bool(o.rush),
                    "blocked": bool(o.blocked),
                    "overdue": is_overdue,
                    "due_date": _iso(due_utc),
                },
            )
            if o.user_id and f"customer:{o.user_id}" in nodes:
                add_edge(f"customer:{o.user_id}", f"order:{o.no}", "bestellt")

        if order_ids:
            for pos in db.query(OrderPosition).filter(OrderPosition.order_id.in_(order_ids)).all():
                ono = order_no_by_id.get(pos.order_id)
                if ono and pos.mat and f"material:{pos.mat}" in nodes:
                    add_edge(f"order:{ono}", f"material:{pos.mat}", "benötigt", max(1, int(pos.qty or 1)))

        # 7. Innenaufträge, Teilezuordnung (WorkItem) & Stationsaufgaben
        work_orders = db.query(WorkOrder).order_by(WorkOrder.id.desc()).limit(100).all()
        wo_no_by_id: dict[int, str] = {}
        for wo in work_orders:
            wo_no_by_id[wo.id] = wo.no
            wo_st = str(getattr(wo.status, "value", wo.status) or "open")
            add_node(
                f"work_order:{wo.no}", "work_order", wo.no,
                f"{wo.mat_name or wo.mat} · {wo.thk} mm ({wo.n_parts} Teile)", wo_st,
                {"no": wo.no, "mat": wo.mat, "thk": float(wo.thk or 0), "n_parts": int(wo.n_parts or 0), "status": wo_st},
            )
            if wo.mat and f"material:{wo.mat}" in nodes:
                add_edge(f"work_order:{wo.no}", f"material:{wo.mat}", "schneidet")

        if wo_no_by_id:
            for wi in db.query(WorkItem).filter(WorkItem.work_order_id.in_(list(wo_no_by_id))).all():
                wno = wo_no_by_id.get(wi.work_order_id)
                if wno and wi.order_no and f"order:{wi.order_no}" in nodes:
                    add_edge(f"work_order:{wno}", f"order:{wi.order_no}", "fertigt_für", max(1, int(wi.qty or 1)))

        for task in db.query(StationTask).filter(StationTask.state.in_(("open", "running", "queued"))).limit(160).all():
            if task.station_id and f"station:{task.station_id}" in nodes:
                ref = str(task.ref or "")
                if f"work_order:{ref}" in nodes:
                    add_edge(f"work_order:{ref}", f"station:{task.station_id}", "geplant_auf")
                elif f"order:{ref}" in nodes:
                    add_edge(f"order:{ref}", f"station:{task.station_id}", "geplant_auf")

        # Aktive Roboter-Transportaufträge
        for job in db.query(RobotJob).filter(RobotJob.state.in_(("proposed", "approved", "assigned", "running"))).limit(80).all():
            if job.robot_id and f"robot:{job.robot_id}" in nodes:
                if job.to_station_id and f"station:{job.to_station_id}" in nodes:
                    add_edge(f"robot:{job.robot_id}", f"station:{job.to_station_id}", "transportiert_zu")
                if job.work_order_no and f"work_order:{job.work_order_no}" in nodes:
                    add_edge(f"robot:{job.robot_id}", f"work_order:{job.work_order_no}", "transportiert")
                elif job.order_no and f"order:{job.order_no}" in nodes:
                    add_edge(f"robot:{job.robot_id}", f"order:{job.order_no}", "transportiert")

        # 8. Sendungen (Shipments)
        shipments = db.query(Shipment).order_by(Shipment.id.desc()).limit(60).all()
        ship_no_by_id: dict[int, str] = {}
        for sh in shipments:
            ship_no_by_id[sh.id] = sh.no
            sh_st = str(getattr(sh.status, "value", sh.status) or "packing")
            sub_parts = [sh.carrier or "Versand", sh_st, sh.tracking or ""]
            add_node(
                f"shipment:{sh.no}", "shipment", sh.no,
                " · ".join(p for p in sub_parts if p),
                sh_st,
                {"no": sh.no, "status": sh_st, "carrier": sh.carrier or "", "tracking": sh.tracking or ""},
            )
        if ship_no_by_id:
            for item in db.query(ShipmentItem).filter(ShipmentItem.shipment_id.in_(list(ship_no_by_id))).all():
                sno = ship_no_by_id.get(item.shipment_id)
                if sno and item.order_no and f"order:{item.order_no}" in nodes:
                    add_edge(f"order:{item.order_no}", f"shipment:{sno}", "versendet_als", max(1, int(item.qty or 1)))

        # Plattform-Knoten & -Kanten atomar ersetzen (Erkenntnisse & manuelle Kanten bleiben!)
        db.query(AgentKnowledgeEdge).filter(AgentKnowledgeEdge.source == "platform").delete(synchronize_session=False)
        db.query(AgentKnowledgeNode).filter(AgentKnowledgeNode.source == "platform").delete(synchronize_session=False)

        for n in nodes.values():
            db.add(AgentKnowledgeNode(
                node_key=n["node_key"], kind=n["kind"], label=n["label"],
                subtitle=n["subtitle"], status=n["status"], source="platform",
                meta=n["meta"], updated_at=now,
            ))
        for (src, dst, rel), weight in edges.items():
            db.add(AgentKnowledgeEdge(
                source_key=src, target_key=dst, relation=rel,
                weight=weight, source="platform", updated_at=now,
            ))

        global _LAST_REBUILT_AT
        _LAST_REBUILT_AT = now.isoformat()
        db.commit()

        insight_count = db.query(AgentKnowledgeNode).filter(AgentKnowledgeNode.source == "insight").count()
        return {
            "ok": True,
            "platform_nodes": len(nodes),
            "insight_nodes": insight_count,
            "edges": len(edges),
            "rebuilt_at": now.isoformat(),
        }


def _select_balanced(
    candidates: list[AgentKnowledgeNode],
    degree_map: dict[str, int],
    priority_keys: set[str],
    limit: int,
) -> list[AgentKnowledgeNode]:
    """Wählt Knoten ausgewogen über alle Knotentypen statt alphabetisch abzuschneiden."""
    if len(candidates) <= limit:
        return candidates

    picked: list[AgentKnowledgeNode] = []
    seen: set[str] = set()

    def take(node: AgentKnowledgeNode) -> None:
        if node.node_key not in seen and len(picked) < limit:
            seen.add(node.node_key)
            picked.append(node)

    # 1. Direkte Treffer, Erkenntnisse, Risiken und kritische Knoten zuerst
    for n in candidates:
        if n.node_key in priority_keys or n.kind in ("insight", "alert", "hall"):
            take(n)
    for n in candidates:
        if _attention_for(n.kind, n.status) == "danger":
            take(n)

    # 2. Rest proportional (Round-Robin nach Grad sortiert) je Knotentyp
    buckets: dict[str, list[AgentKnowledgeNode]] = {}
    for n in candidates:
        if n.node_key in seen:
            continue
        buckets.setdefault(n.kind, []).append(n)
    for items in buckets.values():
        items.sort(key=lambda item: (-degree_map.get(item.node_key, 0), item.id))

    kind_order = [k for k in NODE_KINDS if k in buckets] + [k for k in buckets if k not in NODE_KINDS]
    idx = 0
    while len(picked) < limit:
        progressed = False
        for k in kind_order:
            items = buckets[k]
            if idx < len(items):
                take(items[idx])
                progressed = True
                if len(picked) >= limit:
                    break
        if not progressed:
            break
        idx += 1

    return picked


def get_graph(
    db: Session,
    *,
    kind: str = "",
    kinds: str = "",
    q: str = "",
    relation: str = "",
    focus: str = "",
    depth: int = 1,
    only_issues: bool = False,
    limit: int = 280,
) -> dict[str, Any]:
    """Liest den gespeicherten Wissensgraphen inkl. Grad-Metriken, Hotspots & Ego-Netz."""
    total_nodes = db.query(AgentKnowledgeNode).count()
    if total_nodes == 0:
        rebuild_platform_graph(db)

    all_nodes = db.query(AgentKnowledgeNode).order_by(AgentKnowledgeNode.kind, AgentKnowledgeNode.id).all()
    all_edges = db.query(AgentKnowledgeEdge).all()
    node_by_key = {n.node_key: n for n in all_nodes}

    by_kind: dict[str, int] = {}
    by_relation: dict[str, int] = {}
    in_deg: dict[str, int] = {}
    out_deg: dict[str, int] = {}
    adj: dict[str, set[str]] = {}
    for n in all_nodes:
        by_kind[n.kind] = by_kind.get(n.kind, 0) + 1
    for e in all_edges:
        if e.source_key in node_by_key and e.target_key in node_by_key:
            by_relation[e.relation] = by_relation.get(e.relation, 0) + 1
            out_deg[e.source_key] = out_deg.get(e.source_key, 0) + 1
            in_deg[e.target_key] = in_deg.get(e.target_key, 0) + 1
            adj.setdefault(e.source_key, set()).add(e.target_key)
            adj.setdefault(e.target_key, set()).add(e.source_key)

    degree_map = {n.node_key: in_deg.get(n.node_key, 0) + out_deg.get(n.node_key, 0) for n in all_nodes}

    # Hotspots (Risiken / Probleme + zentrale Knoten)
    issue_nodes = [
        n for n in all_nodes
        if _attention_for(n.kind, n.status) in ("danger", "warning")
    ]
    issue_nodes.sort(key=lambda n: (0 if _attention_for(n.kind, n.status) == "danger" else 1, -degree_map.get(n.node_key, 0)))
    hub_nodes = sorted(all_nodes, key=lambda n: -degree_map.get(n.node_key, 0))[:8]

    needle = (q or "").strip().lower()
    rel_filter = (relation or "").strip().lower()
    focus_key = (focus or "").strip()
    hop_depth = max(1, min(int(depth or 1), 3))

    allowed_kinds: set[str] = set()
    if kind.strip():
        allowed_kinds.add(kind.strip().lower())
    if kinds.strip():
        for part in kinds.split(","):
            if part.strip():
                allowed_kinds.add(part.strip().lower())

    direct_matches: set[str] = set()
    if focus_key and focus_key in node_by_key:
        # Ego-Netz um Fokus-Knoten (1..3 Hops)
        visited: set[str] = {focus_key}
        frontier: set[str] = {focus_key}
        for _ in range(hop_depth):
            nxt: set[str] = set()
            for cur in frontier:
                for nb in adj.get(cur, ()):
                    if nb not in visited:
                        visited.add(nb)
                        nxt.add(nb)
            frontier = nxt
        matched_keys = visited
        direct_matches.add(focus_key)
    else:
        matched_keys = set()
        for n in all_nodes:
            if allowed_kinds and n.kind not in allowed_kinds:
                continue
            att = _attention_for(n.kind, n.status)
            if only_issues and not att and n.kind != "insight":
                continue
            if needle:
                meta_text = str((n.meta or {}).get("detail") or "")
                hay = f"{n.label} {n.subtitle} {n.node_key} {n.kind} {n.status} {meta_text}".lower()
                if needle not in hay:
                    continue
                direct_matches.add(n.node_key)
            matched_keys.add(n.node_key)

        # Bei Suche oder Risiko-Fokus: 1-Hop-Nachbarn mit einblenden, damit Zusammenhänge sichtbar bleiben
        if (needle or only_issues) and matched_keys:
            neighbors: set[str] = set(matched_keys)
            for e in all_edges:
                if e.source_key in matched_keys and e.target_key in node_by_key:
                    neighbors.add(e.target_key)
                if e.target_key in matched_keys and e.source_key in node_by_key:
                    neighbors.add(e.source_key)
            matched_keys = neighbors

    if rel_filter:
        rel_keys: set[str] = set()
        for e in all_edges:
            if e.relation.lower() == rel_filter and e.source_key in matched_keys and e.target_key in matched_keys:
                rel_keys.add(e.source_key)
                rel_keys.add(e.target_key)
        matched_keys = rel_keys

    candidates = [n for n in all_nodes if n.node_key in matched_keys]
    cap = max(10, min(int(limit or 280), 600))
    selected_nodes = _select_balanced(candidates, degree_map, direct_matches, cap)
    keep = {n.node_key for n in selected_nodes}
    selected_edges = [
        e for e in all_edges
        if e.source_key in keep and e.target_key in keep
        and (not rel_filter or e.relation.lower() == rel_filter)
    ]

    latest_dt = max((n.updated_at for n in all_nodes if n.source == "platform" and n.updated_at), default=None)
    return {
        "nodes": [{
            "key": n.node_key,
            "kind": n.kind,
            "kind_label": NODE_KINDS.get(n.kind, n.kind),
            "label": n.label,
            "subtitle": n.subtitle,
            "status": n.status,
            "attention": _attention_for(n.kind, n.status),
            "degree": degree_map.get(n.node_key, 0),
            "in_degree": in_deg.get(n.node_key, 0),
            "out_degree": out_deg.get(n.node_key, 0),
            "source": n.source,
            "meta": n.meta or {},
            "updated_at": _iso(n.updated_at),
        } for n in selected_nodes],
        "edges": [{
            "id": e.id,
            "source": e.source_key,
            "target": e.target_key,
            "relation": e.relation,
            "weight": int(e.weight or 1),
            "source_kind": e.source,
        } for e in selected_edges],
        "stats": {
            "total_nodes": len(all_nodes),
            "total_edges": len(all_edges),
            "issue_count": len(issue_nodes),
            "by_kind": by_kind,
            "by_relation": by_relation,
            "kinds": NODE_KINDS,
            "hotspots": {
                "issues": [{
                    "key": n.node_key,
                    "kind": n.kind,
                    "kind_label": NODE_KINDS.get(n.kind, n.kind),
                    "label": n.label,
                    "subtitle": n.subtitle,
                    "status": n.status,
                    "attention": _attention_for(n.kind, n.status),
                    "degree": degree_map.get(n.node_key, 0),
                } for n in issue_nodes[:25]],
                "hubs": [{
                    "key": n.node_key,
                    "kind": n.kind,
                    "kind_label": NODE_KINDS.get(n.kind, n.kind),
                    "label": n.label,
                    "degree": degree_map.get(n.node_key, 0),
                } for n in hub_nodes if degree_map.get(n.node_key, 0) > 0][:8],
            },
        },
        "focus": focus_key or None,
        "depth": hop_depth if focus_key else None,
        "last_rebuilt_at": _iso(latest_dt) or _LAST_REBUILT_AT,
        "auto_sync_interval_s": AUTO_SYNC_INTERVAL_S,
        "auto_sync_running": _SYNC_STARTED,
    }


def find_shortest_path(db: Session, source_key: str, target_key: str, max_depth: int = 6) -> dict[str, Any]:
    """Findet die kürzeste Verbindungskette (BFS) zwischen zwei Knoten im Wissensgraphen."""
    src = (source_key or "").strip()
    dst = (target_key or "").strip()
    if not src or not dst:
        raise ValueError("Start- und Zielknoten müssen angegeben werden.")
    if db.query(AgentKnowledgeNode).count() == 0:
        rebuild_platform_graph(db)

    all_nodes = {n.node_key: n for n in db.query(AgentKnowledgeNode).all()}
    if src not in all_nodes:
        raise ValueError(f"Startknoten „{src}“ nicht gefunden.")
    if dst not in all_nodes:
        raise ValueError(f"Zielknoten „{dst}“ nicht gefunden.")
    if src == dst:
        n = all_nodes[src]
        return {
            "ok": True,
            "found": True,
            "hops": 0,
            "node_keys": [src],
            "edge_ids": [],
            "steps": [{"key": n.node_key, "kind": n.kind, "label": n.label}],
        }

    all_edges = db.query(AgentKnowledgeEdge).all()
    adj: dict[str, list[tuple[str, AgentKnowledgeEdge, str]]] = {}
    for e in all_edges:
        if e.source_key in all_nodes and e.target_key in all_nodes:
            adj.setdefault(e.source_key, []).append((e.target_key, e, "→"))
            adj.setdefault(e.target_key, []).append((e.source_key, e, "←"))

    cap = max(1, min(int(max_depth or 6), 8))
    queue: deque[tuple[str, list[str], list[dict[str, Any]]]] = deque([(src, [src], [])])
    visited: set[str] = {src}

    while queue:
        cur, path_nodes, path_edges = queue.popleft()
        if len(path_edges) >= cap:
            continue
        for nxt, edge, direction in adj.get(cur, ()):
            if nxt in visited:
                continue
            next_nodes = [*path_nodes, nxt]
            next_edges = [*path_edges, {
                "id": edge.id,
                "from": cur,
                "to": nxt,
                "direction": direction,
                "relation": edge.relation,
            }]
            if nxt == dst:
                return {
                    "ok": True,
                    "found": True,
                    "hops": len(next_edges),
                    "node_keys": next_nodes,
                    "edge_ids": [e["id"] for e in next_edges],
                    "edges": next_edges,
                    "steps": [{
                        "key": k,
                        "kind": all_nodes[k].kind,
                        "kind_label": NODE_KINDS.get(all_nodes[k].kind, all_nodes[k].kind),
                        "label": all_nodes[k].label,
                        "status": all_nodes[k].status,
                    } for k in next_nodes],
                }
            visited.add(nxt)
            queue.append((nxt, next_nodes, next_edges))

    return {
        "ok": True,
        "found": False,
        "hops": None,
        "node_keys": [],
        "edge_ids": [],
        "edges": [],
        "steps": [],
    }


def add_insight(
    db: Session,
    *,
    title: str,
    detail: str = "",
    linked_keys: list[str] | None = None,
    author: str = "",
    severity: str = "info",
) -> dict[str, Any]:
    """Speichert eine dauerhafte Erkenntnis im Wissensgraphen und verknüpft sie mit Knoten."""
    clean_title = (title or "").strip()[:180]
    if not clean_title:
        raise ValueError("Titel der Erkenntnis fehlt.")
    now = _now()
    key = f"insight:{uuid.uuid4().hex[:10]}"
    node = AgentKnowledgeNode(
        node_key=key,
        kind="insight",
        label=clean_title,
        subtitle=(detail or "")[:240],
        status=(severity or "info")[:40],
        source="insight",
        meta={"detail": (detail or "")[:4000], "author": author},
        updated_at=now,
    )
    db.add(node)
    linked: list[str] = []
    seen_targets: set[str] = set()
    for target in (linked_keys or [])[:25]:
        tk = str(target or "").strip()
        if not tk or tk == key or tk in seen_targets:
            continue
        if db.query(AgentKnowledgeNode).filter_by(node_key=tk).first() is not None:
            db.add(AgentKnowledgeEdge(
                source_key=key, target_key=tk, relation="erkenntnis_zu",
                weight=1, source="insight", updated_at=now,
            ))
            linked.append(tk)
            seen_targets.add(tk)
    db.commit()
    return {"ok": True, "key": key, "label": clean_title, "linked": linked}


def update_insight(
    db: Session,
    node_key: str,
    *,
    title: str | None = None,
    detail: str | None = None,
    severity: str | None = None,
    linked_keys: list[str] | None = None,
) -> dict[str, Any]:
    """Aktualisiert eine gespeicherte Erkenntnis (Titel, Kontext, Schweregrad, Verknüpfungen)."""
    row = db.query(AgentKnowledgeNode).filter_by(node_key=node_key).first()
    if row is None or row.source != "insight":
        raise ValueError("Erkenntnis nicht gefunden oder nicht bearbeitbar.")
    now = _now()
    if title is not None:
        clean_title = title.strip()[:180]
        if not clean_title:
            raise ValueError("Titel der Erkenntnis darf nicht leer sein.")
        row.label = clean_title
    if detail is not None:
        row.subtitle = detail.strip()[:240]
        meta = dict(row.meta or {})
        meta["detail"] = detail.strip()[:4000]
        row.meta = meta
    if severity is not None:
        row.status = (severity.strip() or "info")[:40]
    row.updated_at = now

    linked: list[str] = []
    if linked_keys is not None:
        db.query(AgentKnowledgeEdge).filter(
            AgentKnowledgeEdge.source_key == node_key,
            AgentKnowledgeEdge.source == "insight",
        ).delete(synchronize_session=False)
        seen: set[str] = set()
        for target in linked_keys[:25]:
            tk = str(target or "").strip()
            if not tk or tk == node_key or tk in seen:
                continue
            if db.query(AgentKnowledgeNode).filter_by(node_key=tk).first() is not None:
                db.add(AgentKnowledgeEdge(
                    source_key=node_key, target_key=tk, relation="erkenntnis_zu",
                    weight=1, source="insight", updated_at=now,
                ))
                linked.append(tk)
                seen.add(tk)
    db.commit()
    return {"ok": True, "key": row.node_key, "label": row.label, "linked": linked}


def add_custom_edge(
    db: Session,
    *,
    source_key: str,
    target_key: str,
    relation: str = "verknüpft_mit",
) -> dict[str, Any]:
    """Legt eine dauerhafte manuelle Kante zwischen zwei existierenden Knoten an."""
    src = (source_key or "").strip()
    dst = (target_key or "").strip()
    rel = (relation or "verknüpft_mit").strip()[:60] or "verknüpft_mit"
    if not src or not dst or src == dst:
        raise ValueError("Start- und Zielknoten müssen unterschiedlich sein.")
    if db.query(AgentKnowledgeNode).filter_by(node_key=src).first() is None:
        raise ValueError(f"Knoten „{src}“ nicht gefunden.")
    if db.query(AgentKnowledgeNode).filter_by(node_key=dst).first() is None:
        raise ValueError(f"Knoten „{dst}“ nicht gefunden.")
    existing = db.query(AgentKnowledgeEdge).filter_by(
        source_key=src, target_key=dst, relation=rel
    ).first()
    if existing is not None:
        return {"ok": True, "id": existing.id, "source": src, "target": dst, "relation": rel, "created": False}
    edge = AgentKnowledgeEdge(
        source_key=src, target_key=dst, relation=rel,
        weight=1, source="insight", updated_at=_now(),
    )
    db.add(edge)
    db.commit()
    db.refresh(edge)
    return {"ok": True, "id": edge.id, "source": src, "target": dst, "relation": rel, "created": True}


def delete_edge(db: Session, edge_id: int) -> dict[str, Any]:
    row = db.get(AgentKnowledgeEdge, edge_id)
    if row is None:
        return {"ok": True, "deleted": False}
    if row.source != "insight":
        raise ValueError("Plattform-Kanten können nicht manuell gelöscht werden.")
    db.delete(row)
    db.commit()
    return {"ok": True, "deleted": True, "id": edge_id}


def delete_node(db: Session, node_key: str) -> dict[str, Any]:
    row = db.query(AgentKnowledgeNode).filter_by(node_key=node_key).first()
    if row is None:
        return {"ok": True, "deleted": False}
    db.query(AgentKnowledgeEdge).filter(
        (AgentKnowledgeEdge.source_key == node_key) | (AgentKnowledgeEdge.target_key == node_key)
    ).delete(synchronize_session=False)
    db.delete(row)
    db.commit()
    return {"ok": True, "deleted": True, "key": node_key}


def start_auto_sync(interval_s: int = AUTO_SYNC_INTERVAL_S) -> None:
    """Startet die eingebaute Hintergrund-Routine zum automatischen Aktualisieren des Wissensgraphen."""
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    global _SYNC_STARTED
    with _SYNC_LOCK:
        if _SYNC_STARTED:
            return
        _SYNC_STARTED = True

    def _loop() -> None:
        time.sleep(3.0)
        while True:
            try:
                with SessionLocal() as db:
                    rebuild_platform_graph(db)
            except Exception:  # noqa: BLE001
                pass
            time.sleep(max(30, interval_s))

    threading.Thread(target=_loop, daemon=True, name="gimel-knowledge-graph-sync").start()


# --- LLM-Werkzeuge für den Wissensgraphen -------------------------------------

def build_knowledge_graph_specs() -> list:
    from .tools import ALL, ToolContext, ToolError, ToolSpec, _need, _schema

    def _tool_query_graph(ctx: ToolContext, args: dict) -> dict:
        data = get_graph(
            ctx.db,
            kind=str(args.get("kind") or ""),
            kinds=str(args.get("kinds") or ""),
            q=str(args.get("query") or ""),
            relation=str(args.get("relation") or ""),
            focus=str(args.get("focus") or ""),
            depth=int(args.get("depth") or 1),
            only_issues=bool(args.get("only_issues") or False),
            limit=int(args.get("limit") or 80),
        )
        return {
            "ok": True,
            "summary": f"{len(data['nodes'])} Knoten, {len(data['edges'])} Kanten ({data['stats']['issue_count']} Auffälligkeiten)",
            "stats": data["stats"],
            "last_rebuilt_at": data["last_rebuilt_at"],
            "nodes": data["nodes"][:80],
            "edges": data["edges"][:140],
        }

    def _tool_add_insight(ctx: ToolContext, args: dict) -> dict:
        title = str(_need(args, "title"))
        detail = str(args.get("detail") or "")
        linked = args.get("linked_keys") or []
        if isinstance(linked, str):
            linked = [x.strip() for x in linked.split(",") if x.strip()]
        try:
            return add_insight(
                ctx.db,
                title=title,
                detail=detail,
                linked_keys=list(linked),
                author=ctx.user.email,
                severity=str(args.get("severity") or "info"),
            )
        except ValueError as exc:
            raise ToolError(str(exc)) from exc

    def _tool_trace_path(ctx: ToolContext, args: dict) -> dict:
        src = str(_need(args, "source_key"))
        dst = str(_need(args, "target_key"))
        try:
            res = find_shortest_path(ctx.db, src, dst, max_depth=int(args.get("max_depth") or 6))
            if res["found"]:
                chain = " → ".join(step["label"] for step in res["steps"])
                res["summary"] = f"Pfad mit {res['hops']} Schritt(en): {chain}"
            else:
                res["summary"] = f"Kein Pfad zwischen {src} und {dst} gefunden."
            return res
        except ValueError as exc:
            raise ToolError(str(exc)) from exc

    def _tool_rebuild_graph(ctx: ToolContext, _args: dict) -> dict:
        res = rebuild_platform_graph(ctx.db)
        res["summary"] = f"Wissensgraph aktualisiert: {res['platform_nodes']} Plattform-Knoten, {res['edges']} Kanten."
        return res

    return [
        ToolSpec(
            "query_knowledge_graph",
            "Durchsucht den plattformweiten Wissensgraphen (Lieferanten, Bestellungen, Risiken, Werkstoffe, Innenaufträge, Stationen, Roboter, Hallen, Aufträge, Sendungen, Kunden & Erkenntnisse) inkl. Ego-Netz und Engpass-Filter.",
            _schema({
                "query": {"type": "string", "description": "Suchbegriff (z. B. AB-26-0008, Plotter 1, EPDM)"},
                "kind": {"type": "string", "description": "Optionaler Knotentyp: supplier, purchase_order, alert, material, work_order, station, robot, hall, order, shipment, customer, insight"},
                "kinds": {"type": "string", "description": "Kommagetrennte Liste mehrerer Knotentypen"},
                "relation": {"type": "string", "description": "Optionaler Kantentyp (z. B. benötigt, liefert, fertigt_für, geplant_auf, betrifft)"},
                "focus": {"type": "string", "description": "Knotenschlüssel für Ego-Netz (z. B. material:epdm-70)"},
                "depth": {"type": "integer", "description": "Hop-Tiefe für Ego-Netz (1–3, Standard 1)"},
                "only_issues": {"type": "boolean", "description": "Nur Risiken, Engpässe, blockierte/überfällige Aufträge & knappe Werkstoffe samt Nachbarn"},
                "limit": {"type": "integer", "description": "Maximale Anzahl Knoten (Standard 80)"},
            }),
            _tool_query_graph, roles=frozenset(ALL),
        ),
        ToolSpec(
            "trace_knowledge_path",
            "Findet die kürzeste Wirkungskette zwischen zwei Knoten im Wissensgraphen (z. B. von einem Risiko/Lieferanten bis zu einem Auftrag oder Kunden).",
            _schema({
                "source_key": {"type": "string", "description": "Start-Knotenschlüssel (z. B. supplier:1 oder material:epdm-70)"},
                "target_key": {"type": "string", "description": "Ziel-Knotenschlüssel (z. B. customer:3 oder order:AB-26-0008)"},
                "max_depth": {"type": "integer", "description": "Maximale Pfadlänge (1–8, Standard 6)"},
            }, ["source_key", "target_key"]),
            _tool_trace_path, roles=frozenset(ALL),
        ),
        ToolSpec(
            "add_knowledge_insight",
            "Speichert eine dauerhafte Erkenntnis im Wissensgraphen und verknüpft sie mit Plattform-Knoten (z. B. order:AB-26-0008, station:1).",
            _schema({
                "title": {"type": "string", "description": "Kurzer Titel der Erkenntnis"},
                "detail": {"type": "string", "description": "Zusammenfassung / Begründung"},
                "linked_keys": {"type": "array", "items": {"type": "string"}, "description": "Knotenschlüssel wie order:AB-26-0008, station:1, material:epdm-70"},
                "severity": {"type": "string", "description": "info, warning oder danger"},
            }, ["title"]),
            _tool_add_insight, roles=frozenset(ALL),
        ),
        ToolSpec(
            "rebuild_knowledge_graph",
            "Synchronisiert den plattformweiten Wissensgraphen sofort mit allen aktuellen Gimel-Daten (Erkenntnisse bleiben erhalten).",
            _schema({}),
            _tool_rebuild_graph, roles=frozenset(ALL),
        ),
    ]
