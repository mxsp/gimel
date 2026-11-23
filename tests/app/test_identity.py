"""Gimel carries no identity of its own: seller and brand come from outside."""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

from gimel.db import SessionLocal
from gimel.extensions import Identity, Plugin, use
from gimel.models import AuditLog, Setting, Shipment
from gimel.services import einvoice, identity

PACKAGE = Path(__file__).resolve().parents[2] / "gimel"
SECRETS = ("FyreFly", "fyreflysystems", "Alef", "Alpha Dichtung", "Bergstraße", "Köthen",
           "DE370197687", "116/174", "Scheinast", "Fabian", "Ahornweg", "Delitzsch")
#: FyreFly's own CRA products and the ALPHA_ settings of Alef, gated on ``STANDALONE``/``active()``.
ALLOWED_FILES = {"routers/compliance.py", "config.py"}


@pytest.fixture
def no_seller(plant):
    """A database that never saw the demo seller."""
    with SessionLocal() as db:
        rows = [(r.key, r.value) for r in db.query(Setting).filter(Setting.key.startswith(identity.PREFIX))]
        db.query(Setting).filter(Setting.key.startswith(identity.PREFIX)).delete(synchronize_session=False)
        db.commit()
    yield
    with SessionLocal() as db:
        db.query(Setting).filter(Setting.key.startswith(identity.PREFIX)).delete(synchronize_session=False)
        for key, value in rows:
            db.add(Setting(key=key, value=value))
        db.commit()


def test_gimel_alone_has_no_seller_and_no_brand(no_seller):
    s = einvoice.seller()
    assert {k: v for k, v in s.items() if k != "country" and v} == {}
    assert s["country"] == "DE"
    t = identity.texts()
    assert (t.mail_footer, t.mail_header, t.mail_from_name, t.brand_name, t.brand_mark, t.paper_name,
            t.manufacturer, t.signature) == ("", "", "", "", "", "", "", "")


def test_validate_says_in_german_what_is_missing_and_where_to_put_it(no_seller):
    data = {"seller": einvoice.seller(), "buyer": {"name": "K", "street": "S", "zip": "1", "city": "O", "country": "DE"},
            "net": 100, "vat": 19, "gross": 119, "rate": 0.19, "order_no": "A",
            "lines": [{"description": "x", "amount_cents": 100}]}
    errors = einvoice.validate(data)
    assert len(errors) == 1
    assert errors[0].startswith("Verkäuferdaten fehlen (Name, Straße, PLZ, Ort, USt-IdNr. oder Steuernummer)")
    assert "GIMEL_SELLER_*" in errors[0]
    with pytest.raises(ValueError, match="Verkäuferdaten fehlen"):
        einvoice.build(data, "RE-1", "2026-10-31")


def test_a_tax_number_is_enough_for_the_seller(plant):
    data = {"seller": {**einvoice.seller(), "vatId": ""}, "buyer": {"name": "K", "street": "S", "zip": "1",
            "city": "O", "country": "DE"}, "net": 100, "vat": 19, "gross": 119, "rate": 0.19,
            "order_no": "A", "lines": [{"description": "x", "amount_cents": 100}]}
    assert einvoice.validate(data) == []


def test_the_environment_wins_over_stored_and_plugin_values(plant, monkeypatch):
    monkeypatch.setenv("GIMEL_SELLER_NAME", "Aus der Umgebung GmbH")
    assert einvoice.seller()["name"] == "Aus der Umgebung GmbH"
    plugin = Plugin(name="x", identity=Identity(name="Plugin GmbH", street="Weg 1"))
    use(plugin)
    try:
        s = einvoice.seller()
        assert (s["name"], s["street"]) == ("Aus der Umgebung GmbH", "Weg 1")
    finally:
        use(None)


def test_a_plugin_identity_never_reads_the_settings_table(plant, monkeypatch):
    def boom(_db):
        raise AssertionError("settings table read")

    monkeypatch.setattr(identity, "_read_rows", boom)
    use(Plugin(name="x", identity=Identity(name="Plugin GmbH", mail_footer="Fuß")))
    try:
        assert einvoice.seller()["name"] == "Plugin GmbH"
        assert identity.texts().mail_footer == "Fuß"
    finally:
        use(None)


def test_admin_edits_the_seller_with_an_audit_line(client):
    before = client.get("/api/invoicing/seller").json()
    assert before["editable"] is True and before["complete"] is True
    body = {**before["values"], "street": "Neue Straße 2"}
    r = client.put("/api/invoicing/seller", json=body)
    assert r.status_code == 200, r.text
    try:
        assert r.json()["values"]["street"] == "Neue Straße 2"
        assert einvoice.seller()["street"] == "Neue Straße 2"
        with SessionLocal() as db:
            line = db.query(AuditLog).filter(AuditLog.action == "seller_update").order_by(AuditLog.id.desc()).first()
            assert line.detail["fields"] == ["street"]
            n = db.query(AuditLog).filter(AuditLog.action == "seller_update").count()
        assert client.put("/api/invoicing/seller", json=body).status_code == 200
        with SessionLocal() as db:
            assert db.query(AuditLog).filter(AuditLog.action == "seller_update").count() == n, "no change, no line"
    finally:
        client.put("/api/invoicing/seller", json=before["values"])
    assert not [s for s in client.get("/api/admin/settings").json() if s["key"].startswith("seller.")]


def test_seller_route_needs_an_admin_and_stays_shut_under_a_plugin(client):
    anon = client.get("/api/invoicing/seller", headers={"Authorization": ""})
    assert anon.status_code == 401
    use(Plugin(name="x", identity=Identity(name="Plugin GmbH")))
    try:
        r = client.put("/api/invoicing/seller", json={"name": "Anders"})
        assert r.status_code == 409
    finally:
        use(None)


def test_standalone_papers_and_mail_name_only_the_demo_plant(client, plant):
    from gimel.render.label import shipment_label
    from gimel.render.plate import work_order_html
    from gimel.services import mailer, mfa, smtp_client

    label = shipment_label(Shipment(no="VS-1", ship_to={}, items=[]))
    wo = {"no": "IA-1", "mat": "m", "mat_name": "m", "thk": 2, "fmt": [100, 100], "n_plates": 0, "n_orders": 0}
    card = work_order_html(wo, [])
    mail = mailer._shell("Titel", "<p>x</p>")
    config = client.get("/api/invoicing/config").json()
    periods = client.get("/api/compliance/support-periods").json()["support_periods"]
    for text in (label, card, mail, str(config), str(periods), mfa.issuer(), smtp_client.config().sender_name):
        assert not [w for w in SECRETS if w in text], text[:200]
    assert "Musterwerk GmbH" in label and "Musterwerk GmbH · Zuschnitt" in card
    assert config["manufacturer"] == "Musterwerk GmbH"
    assert [p["product"] for p in periods] == ["gimel"]


def test_no_identity_literal_in_code_only_in_comments():
    """Docstrings and comments may mention Alef. A string that can reach output may not."""
    hits = []
    for path in PACKAGE.rglob("*.py"):
        rel = path.relative_to(PACKAGE).as_posix()
        if rel in ALLOWED_FILES or rel.startswith(("webapp/", "twin/")):
            continue
        tree = ast.parse(path.read_text(encoding="utf-8-sig"))
        docs = {id(n.value) for n in ast.walk(tree) if isinstance(n, ast.Expr)}  # bare strings
        for node in ast.walk(tree):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docs:
                hits += [f"{rel}:{node.lineno} {w}" for w in SECRETS if w in node.value]
    assert hits == []


def test_no_firm_is_named_in_the_web_apps():
    root = Path(__file__).resolve().parents[2]
    hits = []
    for folder in ("web/src", "web-twin/src"):
        for path in (root / folder).rglob("*"):
            if path.suffix in (".ts", ".tsx", ".css"):
                text = path.read_text(encoding="utf-8")
                hits += [f"{path.name}: {w}" for w in ("FyreFly", "Köthen", "Alpha Dichtung") if w in text]
    assert not hits, hits


def test_small_business_refuses_register_and_bank_print(client):
    from gimel.db import SessionLocal
    from gimel.models import LocalInvoice
    from gimel.render.invoice import invoice_html
    from gimel.services import identity, local_invoices

    assert "smallBusiness" in identity.EDITABLE and "iban" in identity.EDITABLE
    with SessionLocal() as db:
        identity.save(db, {"smallBusiness": "1"}, "test")
        db.commit()
        with pytest.raises(local_invoices.Refused):
            local_invoices.issue(db, "egal", {"seller": {}}, delivery=None, due_days=14, actor="t")
        identity.save(db, {"smallBusiness": ""}, "test")
        db.commit()
    row = LocalInvoice(number="RE-2026-0001", kind="invoice", order_no="A", net_cents=100, vat_cents=19,
                       gross_cents=119, data={"seller": {"name": "M", "iban": "DE00 1", "bic": "XXX", "bank": "B",
                                                         "register": "HRB <1>", "managers": "M. M."},
                                              "buyer": {"name": "K"}, "lines": [], "rate": 0.19})
    html = invoice_html(row)
    assert "IBAN DE00 1" in html and "HRB &lt;1&gt;" in html and "Geschäftsführung: M. M." in html
    assert "maßgeblich ist die XML-Datei" in html


def test_payment_means_appear_in_the_xml_only_with_an_iban():
    base = {"order_no": "A-1", "buyer": {"name": "K", "street": "s", "zip": "1", "city": "c", "country": "DE"},
            "net": 100, "vat": 19, "gross": 119, "rate": 0.19,
            "lines": [{"description": "Teil", "amount_cents": 100}],
            "seller": {"name": "M", "street": "s", "zip": "1", "city": "c", "country": "DE",
                       "vatId": "DE1", "taxNumber": "1"}}
    plain = einvoice.build(base, "RE-1", "2026-01-01", "2026-01-15")
    assert "PaymentMeans" not in plain
    with_iban = {**base, "seller": {**base["seller"], "iban": "DE00 1234"}}
    xml = einvoice.build(with_iban, "RE-1", "2026-01-01", "2026-01-15")
    assert "<cbc:ID>DE001234</cbc:ID>" in xml and "PaymentMeansCode" in xml
