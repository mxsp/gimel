"""Beziehungen eines Belegs — von jeder Nummer zu allem, was an ihr hängt.

``trace.py`` beantwortet zwei Fragen (Auftrag → Innenaufträge, Innenauftrag →
Aufträge). Rückfragen aus dem Betrieb gehen weiter: „Welcher Versand hat die
Teile aus IA-26-0042 mitgenommen?“, „Aus welchem Innenauftrag stammt der Rest
R-0017?“, „Welche Rechnung gehört zu dem Auftrag, der auf dieser Platte liegt?“

Diese Datei liefert zu *einer* Nummer (Auftrag, Innenauftrag, Sammellauf,
Versand, Reststück) alle Nachbarn, gruppiert und mit dem Weg in die Oberfläche.
Sie liest nur vorhandene Spuren (``work_items``, ``shipment_items``, ``offcuts``,
``robot_jobs``, ``orders.invoice_no``) — es gibt keine zweite Zuordnungstabelle,
die von der Wahrheit abweichen könnte.
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import (NestRun, Offcut, Order, RobotJob, Shipment, ShipmentItem,
                      WorkItem, WorkOrder)

KIND_LABEL = {
    "order": "Auftrag",
    "work_order": "Innenauftrag",
    "run": "Sammellauf",
    "shipment": "Versand",
    "offcut": "Reststück",
    "invoice": "Rechnung",
    "robot_job": "Roboterauftrag",
}

#: Wohin ein Beleg in der Oberfläche führt. Sammellauf, Versand, Rest und Roboter
#: haben (noch) keine Einzelseite: der Sprung führt auf ihre Liste. Die Rechnung
#: hängt am Auftrag und öffnet ihn (Reiter Rechnung).
ROUTE = {
    "order": "auftraege/{no}",
    "work_order": "produktion/{no}",
    "run": "disposition/{no}",
    "shipment": "versand/{no}",
    "offcut": "lager",
    "invoice": "auftraege/{no}",
    "robot_job": "roboter",
}


def _ref(kind: str, no: str, sub: str = "", **extra) -> dict:
    return {"kind": kind, "no": no, "label": KIND_LABEL[kind], "sub": sub,
            "route": ROUTE[kind].format(no=no), **extra}


def classify(db: Session, no: str) -> str | None:
    """Welche Art Beleg trägt diese Nummer? Die Präfixe sind Einstellung, deshalb
    wird nachgeschlagen statt am Präfix geraten."""
    if db.query(Order.id).filter(Order.no == no).first():
        return "order"
    if db.query(WorkOrder.id).filter(WorkOrder.no == no).first():
        return "work_order"
    if db.query(NestRun.id).filter(NestRun.no == no).first():
        return "run"
    if db.query(Shipment.id).filter(Shipment.no == no).first():
        return "shipment"
    if db.query(Offcut.id).filter(Offcut.code == no).first():
        return "offcut"
    return None


def _group(kind: str, title: str, items: list[dict]) -> dict | None:
    return {"kind": kind, "title": title, "items": items} if items else None


def _order_refs(db: Session, nos: list[str]) -> list[dict]:
    if not nos:
        return []
    rows = {o.no: o for o in db.query(Order).filter(Order.no.in_(nos)).all()}
    out = []
    for no in sorted(nos):
        o = rows.get(no)
        sub = ""
        if o:
            sub = o.internal_owner if o.kind == "internal" else (o.customer_ref or "")
        out.append(_ref("order", no, sub, internal=bool(o and o.kind == "internal")))
    return out


def _wo_refs(db: Session, nos: list[str]) -> list[dict]:
    if not nos:
        return []
    rows = {w.no: w for w in db.query(WorkOrder).filter(WorkOrder.no.in_(nos)).all()}
    out = []
    for no in sorted(nos):
        w = rows.get(no)
        sub = f"{w.mat_name or w.mat} · {w.thk:g} mm · {w.status.value}" if w else ""
        out.append(_ref("work_order", no, sub))
    return out


def _shipment_refs(db: Session, nos: list[str]) -> list[dict]:
    if not nos:
        return []
    rows = {s.no: s for s in db.query(Shipment).filter(Shipment.no.in_(nos)).all()}
    out = []
    for no in sorted(nos):
        s = rows.get(no)
        sub = ""
        if s:
            sub = " · ".join(x for x in (s.status.value, s.carrier, s.tracking) if x)
        out.append(_ref("shipment", no, sub))
    return out


def _run_refs(db: Session, nos: list[str]) -> list[dict]:
    return [_ref("run", n) for n in sorted(set(n for n in nos if n))]


def _offcut_refs(rows: list[Offcut]) -> list[dict]:
    return [_ref("offcut", o.code, f"{o.w:g} × {o.h:g} mm · {o.thk:g} mm · {o.status}")
            for o in sorted(rows, key=lambda o: o.code)]


def _wo_nos_of_order(db: Session, order: Order) -> list[str]:
    return sorted({r[0] for r in db.query(WorkOrder.no)
                   .join(WorkItem, WorkItem.work_order_id == WorkOrder.id)
                   .filter(WorkItem.order_no == order.no).all()})


def _robot_refs(rows: list[RobotJob]) -> list[dict]:
    return [_ref("robot_job", j.ref, f"{j.kind} · {j.state}") for j in
            sorted(rows, key=lambda j: j.ref)]


def related(db: Session, no: str) -> dict | None:
    """Alle Nachbarn einer Belegnummer. ``None`` wenn die Nummer unbekannt ist."""
    kind = classify(db, no)
    if kind is None:
        return None
    groups: list[dict | None] = []

    if kind == "order":
        order = db.query(Order).filter(Order.no == no).one()
        wo_nos = _wo_nos_of_order(db, order)
        wos = db.query(WorkOrder).filter(WorkOrder.no.in_(wo_nos)).all() if wo_nos else []
        groups.append(_group("work_order", "Innenaufträge", _wo_refs(db, wo_nos)))
        groups.append(_group("run", "Sammelläufe", _run_refs(
            db, [w.run.no for w in wos if w.run])))
        ship_nos = sorted({r[0] for r in db.query(Shipment.no)
                           .join(ShipmentItem, ShipmentItem.shipment_id == Shipment.id)
                           .filter(ShipmentItem.order_no == no).all()})
        groups.append(_group("shipment", "Versand", _shipment_refs(db, ship_nos)))
        if order.invoice_no:
            groups.append(_group("invoice", "Rechnung", [
                _ref("invoice", no, order.invoice_no)]))
        if wo_nos:
            made = db.query(Offcut).filter(Offcut.source_work_order_no.in_(wo_nos)).all()
            used = db.query(Offcut).filter(Offcut.work_order_no.in_(wo_nos)).all()
            groups.append(_group("offcut", "Reststücke aus diesen Innenaufträgen",
                                 _offcut_refs(made)))
            groups.append(_group("offcut", "Reststücke, die dort verbraucht wurden",
                                 _offcut_refs(used)))
        groups.append(_group("robot_job", "Roboteraufträge", _robot_refs(
            db.query(RobotJob).filter(RobotJob.order_no == no).all())))
        title = no
        sub = order.internal_owner if order.kind == "internal" else (order.customer_ref or "")

    elif kind == "work_order":
        wo = db.query(WorkOrder).filter(WorkOrder.no == no).one()
        order_nos = sorted({r[0] for r in db.query(WorkItem.order_no)
                            .filter(WorkItem.work_order_id == wo.id).all()})
        groups.append(_group("run", "Sammellauf", _run_refs(db, [wo.run.no] if wo.run else [])))
        groups.append(_group("order", "Aufträge auf den Platten", _order_refs(db, order_nos)))
        ship_nos = sorted({r[0] for r in db.query(Shipment.no)
                           .join(ShipmentItem, ShipmentItem.shipment_id == Shipment.id)
                           .filter(ShipmentItem.work_order_no == no).all()})
        groups.append(_group("shipment", "Versand der Teile", _shipment_refs(db, ship_nos)))
        inv = [o for o in db.query(Order).filter(Order.no.in_(order_nos)).all() if o.invoice_no]
        groups.append(_group("invoice", "Rechnungen", [
            _ref("invoice", o.no, o.invoice_no) for o in sorted(inv, key=lambda o: o.no)]))
        groups.append(_group("offcut", "Reststücke, die hier entstanden",
                             _offcut_refs(db.query(Offcut)
                                          .filter(Offcut.source_work_order_no == no).all())))
        groups.append(_group("offcut", "Reststücke, die hier verbraucht wurden",
                             _offcut_refs(db.query(Offcut)
                                          .filter(Offcut.work_order_no == no).all())))
        groups.append(_group("robot_job", "Roboteraufträge", _robot_refs(
            db.query(RobotJob).filter(RobotJob.work_order_no == no).all())))
        title = no
        sub = f"{wo.mat_name or wo.mat} · {wo.thk:g} mm"

    elif kind == "run":
        run = db.query(NestRun).filter(NestRun.no == no).one()
        wos = db.query(WorkOrder).filter(WorkOrder.run_id == run.id).all()
        wo_ids = [w.id for w in wos]
        order_nos = sorted({r[0] for r in db.query(WorkItem.order_no)
                            .filter(WorkItem.work_order_id.in_(wo_ids)).all()}) if wo_ids else []
        groups.append(_group("work_order", "Innenaufträge", _wo_refs(db, [w.no for w in wos])))
        groups.append(_group("order", "Berührte Aufträge", _order_refs(db, order_nos)))
        title, sub = no, f"{run.n_orders} Aufträge · {run.n_work_orders} Innenaufträge"

    elif kind == "shipment":
        sh = db.query(Shipment).filter(Shipment.no == no).one()
        items = db.query(ShipmentItem).filter(ShipmentItem.shipment_id == sh.id).all()
        groups.append(_group("order", "Aufträge im Paket",
                             _order_refs(db, sorted({i.order_no for i in items if i.order_no}))))
        groups.append(_group("work_order", "Herkunft der Teile",
                             _wo_refs(db, sorted({i.work_order_no for i in items
                                                  if i.work_order_no}))))
        title, sub = no, " · ".join(x for x in (sh.carrier, sh.tracking) if x)

    else:  # offcut
        oc = db.query(Offcut).filter(Offcut.code == no).one()
        groups.append(_group("work_order", "Entstanden in",
                             _wo_refs(db, [oc.source_work_order_no] if oc.source_work_order_no else [])))
        groups.append(_group("work_order", "Verbraucht in",
                             _wo_refs(db, [oc.work_order_no] if oc.work_order_no else [])))
        title, sub = no, f"{oc.w:g} × {oc.h:g} mm"

    return {
        "no": no,
        "kind": kind,
        "label": KIND_LABEL[kind],
        "route": ROUTE[kind].format(no=no),
        "sub": sub,
        "groups": [g for g in groups if g],
    }
