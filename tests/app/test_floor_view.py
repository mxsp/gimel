"""Was die Halle sieht (Aufgabe 46, Inhaber 2026-11-13): keine Kunden, keine Anschriften, keine Beträge.

Die Regel aus ``models.Role``: ``worker`` sieht Aufträge und arbeitet sie ab — keine Preise,
keine Kunden. Bis 2026-11-13 hielt sich nur die Oberfläche daran; der Server schickte Namen,
Anschriften und Beträge mit, und die Laufkarte an der Maschine druckte sie. Geprüft wird
hier die Antwort des Servers, nicht die Oberfläche: kein bekannter Kundenname und keine
Anschrift in irgendeiner Antwort an die Halle, außer im Versand (Packaufgabe).
"""

from __future__ import annotations

import json
import uuid

import pytest

from gimel.db import SessionLocal
from gimel.models import FactoryStation, Order, Role, User, WorkOrder
from gimel.security import create_access_token, hash_password
from gimel.services import floor_view


def _head(role: Role) -> dict:
    email = f"{role.value}-floor-{uuid.uuid4().hex[:6]}@example.test"
    with SessionLocal() as db:
        u = User(email=email, name=role.value, role=role, password_hash=hash_password("maple-river-7429"))
        db.add(u)
        db.commit()
        token = create_access_token(u)
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def worker():
    return _head(Role.worker)


@pytest.fixture(scope="module")
def known():
    """Was die Halle nie lesen darf: Firmen, Ansprechpartner, Straßen der Demo-Aufträge."""
    names: set[str] = set()
    with SessionLocal() as db:
        for o in db.query(Order).filter((Order.kind == None) | (Order.kind != "internal")).all():  # noqa: E711
            for addr in (o.ship_address or {}, o.bill_address or {}):
                for key in ("company", "contact", "street"):
                    v = (addr.get(key) or "").strip()
                    if len(v) >= 4:
                        names.add(v)
    assert names, "die Demo hat externe Aufträge mit Anschrift"
    return names


def _no_person(payload, known: set[str], where: str) -> None:
    text = json.dumps(payload, ensure_ascii=False, default=str) if not isinstance(payload, str) else payload
    leaked = sorted(n for n in known if n in text)
    assert not leaked, f"{where}: Halle sieht {leaked[:3]}"


def _external_order_no() -> str:
    with SessionLocal() as db:
        o = (db.query(Order).filter((Order.kind == None) | (Order.kind != "internal"))  # noqa: E711
             .filter(Order.net > 0).first())
        return o.no


def _work_order_no() -> str:
    with SessionLocal() as db:
        return db.query(WorkOrder).first().no


def test_order_list_and_detail_carry_no_customer_address_or_money(client, worker, known):
    lst = client.get("/api/admin/orders?limit=100", headers=worker)
    assert lst.status_code == 200, lst.text
    _no_person(lst.json(), known, "Auftragsliste")
    for item in lst.json()["items"]:
        assert item["net"] == 0 and item["gross"] == 0
        if item["kind"] == "internal":
            assert "customer" in item  # der Verantwortliche bleibt (Kollege, kein Kunde)

    no = _external_order_no()
    d = client.get(f"/api/admin/orders/{no}", headers=worker).json()
    _no_person(d, known, "Auftrag")
    assert d["customer"] == "" and d["ship_address"] == {} and d["bill_address"] == {}
    assert d["net"] == 0 and d["gross"] == 0 and d["vat"] == 0
    assert d["payment_ref"] == "" and d["price_check"] == {} and d["paid"] is False
    assert all(p["price_gross"] == 0 for p in d["positions"])
    # Die Kennung bleibt: Auftragsnummer und Bestellzeichen des Kunden.
    assert d["no"] == no and "customer_ref" in d


def test_the_office_still_sees_everything(client, known):
    no = _external_order_no()
    d = client.get(f"/api/admin/orders/{no}").json()
    assert d["customer"] and d["ship_address"] and d["net"] > 0
    lst = client.get("/api/admin/orders?limit=100").json()
    assert any(i["customer"] in known for i in lst["items"])


def test_production_views_carry_no_customer(client, worker, known):
    no = _external_order_no()
    r = client.get(f"/api/production/orders/{no}", headers=worker)
    assert r.status_code == 200, r.text
    _no_person(r.json(), known, "Auftrag aus Sicht der Fertigung")
    assert r.json()["ship_address"] == {} and r.json()["net"] == 0

    wo = client.get(f"/api/production/work-orders/{_work_order_no()}", headers=worker)
    assert wo.status_code == 200, wo.text
    _no_person(wo.json(), known, "Innenauftrag")
    for plate in wo.json()["plates"]:
        for item in plate["items"]:
            assert item["customer"] == "" and item["order_no"]


def test_route_card_for_the_floor_has_no_customer_address_or_price(client, worker, known):
    no = _work_order_no()
    floor = client.get(f"/api/production/work-orders/{no}/sheet", headers=worker)
    assert floor.status_code == 200
    _no_person(floor.text, known, "Laufkarte")
    assert "€" not in floor.text, "keine Beträge auf der Laufkarte der Halle"
    assert "Preis brutto" not in floor.text and "Gesamtwert" not in floor.text
    office = client.get(f"/api/production/work-orders/{no}/sheet").text
    assert "Gesamtwert" in office or "€" in office, "das Büro druckt die Karte wie bisher"


def test_station_views_staging_and_pipeline_show_references_not_names(client, worker, known):
    for path in ("/api/factory/staging", "/api/factory/pipeline"):
        r = client.get(path, headers=worker)
        assert r.status_code == 200, f"{path}: {r.text}"
        _no_person(r.json(), known, path)
    with SessionLocal() as db:
        ids = [sid for (sid,) in db.query(FactoryStation.id).limit(25).all()]
    assert ids
    seen = 0
    for sid in ids:
        r = client.get(f"/api/factory/stations/{sid}/view", headers=worker)
        if r.status_code == 200:
            seen += 1
            _no_person(r.json(), known, f"Station {sid}")
    assert seen, "mindestens eine Station ist für die Halle sichtbar"


def test_worklist_keeps_the_recipient_only_on_pack_tasks(client, worker, known):
    r = client.get("/api/factory/worklist", headers=worker)
    assert r.status_code == 200, r.text
    board = r.json()

    def walk(v):
        if isinstance(v, dict):
            if v.get("kind") == "pack":
                return  # Versand: der Empfänger gehört dazu
            if "customers" in v:
                assert v["customers"] == [], f"{v.get('kind')} {v.get('ref')}: {v['customers']}"
            for x in v.values():
                walk(x)
        elif isinstance(v, list):
            for x in v:
                walk(x)

    walk(board)


def test_scrub_keeps_structure_owner_and_kept_entries():
    data = {
        "no": "AB-1", "internal_owner": "M. Kollege", "customer": "Firma", "customer_ref": "PO-7",
        "net": 12.5, "paid": True, "ship_address": {"company": "Firma"},
        "tasks": [{"kind": "cut", "customers": ["Firma"]}, {"kind": "pack", "label": "Firma", "customers": ["Firma"]}],
        "nested": {"ship_city": "Köthen", "price_gross": 3.0},
    }
    out = floor_view.scrub(data, False, keep=floor_view.is_pack_task)
    assert out["no"] == "AB-1" and out["internal_owner"] == "M. Kollege" and out["customer_ref"] == "PO-7"
    assert out["customer"] == "" and out["net"] == 0.0 and out["paid"] is False and out["ship_address"] == {}
    assert out["tasks"][0]["customers"] == [] and out["tasks"][1]["customers"] == ["Firma"]
    assert out["nested"] == {"ship_city": "", "price_gross": 0.0}
    assert data["customer"] == "Firma", "die Eingabe bleibt unverändert"
    assert floor_view.scrub(data, True) is data
    assert floor_view.customer_or_ref("Firma", "PO-7", False) == "PO-7"
    assert floor_view.customer_or_ref("Firma", "PO-7", True) == "Firma"


@pytest.fixture(scope="module")
def emails():
    with SessionLocal() as db:
        found = {u.email for u in db.query(User).filter(User.role == Role.customer).all() if u.email}
        found |= {o.contact_email for o in db.query(Order).all() if getattr(o, "contact_email", None)}
    return found


def test_audit_timeline_queue_and_plate_drawing_stay_clean(client, worker, known, emails):
    """Nachtrag nach der Rechtsprüfung 2026-11-13: Protokoll, Zeitstrahl, Warteschlange, Plattenzeichnung."""
    no = _external_order_no()
    d = client.get(f"/api/admin/orders/{no}", headers=worker).json()
    assert all(a["detail"] == {} for a in d["audit"]), "die Halle sieht keine Protokoll-Einzelheiten"
    _no_person(d, known | emails, "Auftrag samt Protokoll")

    t = client.get(f"/api/admin/orders/{no}/timeline", headers=worker)
    assert t.status_code == 200, t.text
    assert all(st["id"] != "paid" for st in t.json()["steps"]), "kein Zahlungsschritt für die Halle"
    office_steps = client.get(f"/api/admin/orders/{no}/timeline").json()["steps"]
    assert any(st["id"] == "paid" for st in office_steps), "das Büro sieht ihn weiter"

    q = client.get("/api/production/queue", headers=worker)
    assert q.status_code == 200, q.text
    _no_person(q.json(), known | emails, "Warteschlange")

    wo = _work_order_no()
    svg = client.get(f"/api/production/work-orders/{wo}/plate/0.svg", headers=worker)
    assert svg.status_code == 200, svg.text
    _no_person(svg.text, known, "Plattenzeichnung")


def test_sse_listener_filter_drops_unreadable_and_scrubs_money():
    data = {"order_no": "AB-1", "net": 10.0, "gross": 11.9, "paid": True, "customer": "x@y.example"}
    out = floor_view.scrub(data, False)
    assert out == {"order_no": "AB-1", "net": 0.0, "gross": 0.0, "paid": False, "customer": ""}


# --------------------------------------------------------------------------
# Nachtrag nach der Sicherheitsprüfung 2026-11-13/14: Protokoll-Akteur, Schnittdatei-
# Bündel, Haltegrund im Arbeitsvorrat, Assistent-Werkzeuge.
# --------------------------------------------------------------------------
def test_audit_actor_hides_a_customer_email_from_the_floor(client, worker):
    from gimel.models import AuditLog

    no = _external_order_no()
    mail = f"kunde-{uuid.uuid4().hex[:6]}@kunde.example"
    with SessionLocal() as db:
        db.add(AuditLog(actor=mail, action="order_reorder", entity="order", entity_id=no, detail={}))
        db.commit()
    floor = client.get(f"/api/admin/orders/{no}", headers=worker).json()
    assert mail not in json.dumps(floor)
    assert any(a["actor"] == "Kunde" for a in floor["audit"])
    office = client.get(f"/api/admin/orders/{no}").json()
    assert any(a["actor"] == mail for a in office["audit"]), "das Büro sieht, wer es war"


def test_cutfile_bundle_for_the_floor_names_no_customer(client, worker, known):
    import io
    import zipfile

    no = _work_order_no()
    r = client.get(f"/api/production/work-orders/{no}/cutfiles.zip", headers=worker)
    assert r.status_code == 200, r.text[:200]
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        text = "\n".join(z.read(n).decode("utf-8", "replace") for n in z.namelist())
    _no_person(text, known, "Schnittdatei-Bündel")


def test_hold_reason_stays_in_the_office():
    from gimel.services import floor_view as fv

    board = {"pool": [{"kind": "process", "note": "angehalten — Kunde klärt Zeichnung · nicht freigegeben"}],
             "stations": [{"slots": [{"kind": "process", "note": "angehalten — Mahnung offen"},
                                     {"kind": "pack", "label": "Firma GmbH", "customers": ["Firma GmbH"]}]}]}
    out = fv.floor_tasks(board, False)
    assert out["pool"][0]["note"] == "angehalten · nicht freigegeben"
    assert out["stations"][0]["slots"][0]["note"] == "angehalten"
    assert out["stations"][0]["slots"][1]["customers"] == ["Firma GmbH"], "Versand behält den Empfänger"
    assert fv.floor_tasks(board, True) == board


def test_agent_tools_follow_the_same_rule(worker, known):
    from agentlab.models import AgentChat
    from agentlab.tools import ToolContext, execute_tool

    with SessionLocal() as db:
        user = db.query(User).filter(User.role == Role.worker).order_by(User.id.desc()).first()
        chat = AgentChat(user_id=user.id, title="Halle", write_mode=False)
        db.add(chat)
        db.commit()
        db.refresh(chat)
        ctx = ToolContext(db=db, user=user, chat=chat)
        no = _external_order_no()
        for name, args in (("search_orders", {"query": ""}), ("get_order", {"order_no": no}),
                           ("get_order_timeline", {"order_no": no}), ("get_worklist", {}),
                           ("list_tasks", {})):
            res = execute_tool(ctx, name, args, write_mode=False)
            assert res.get("ok", True) is not False or "Berechtigung" in json.dumps(res), f"{name}: {res}"
            # Packaufgaben dürfen den Empfänger tragen (Versand); alles andere nicht.
            _no_person(_without_pack(res), known, f"Werkzeug {name}")


def _without_pack(v):
    if isinstance(v, dict):
        return {k: _without_pack(x) for k, x in v.items() if not (isinstance(x, dict) and x.get("kind") == "pack")}
    if isinstance(v, list):
        return [_without_pack(x) for x in v if not (isinstance(x, dict) and x.get("kind") == "pack")]
    return v
