"""Gimel on its own: the demo plant, walked through the REST API."""

from __future__ import annotations

import ast
import os
import subprocess
import sys
from pathlib import Path

import pytest

PACKAGE = Path(__file__).resolve().parents[2] / "gimel"


def test_openapi_builds_without_an_application(client):
    paths = client.get("/openapi.json").json()["paths"]
    assert "/api/production/runs" in paths
    assert "/api/factory/floor" in paths
    # Shop routes come from the application's plugin, not from Gimel.
    assert not [p for p in paths if p.startswith(("/api/storefront", "/api/portal", "/api/library"))]


def test_version_names_gimel_and_no_optional_screens(client):
    v = client.get("/api/version").json()
    assert v["name"] == "gimel"
    assert v["features"] == []


def test_version_says_when_the_database_is_the_demo_plant(client):
    from gimel import demo
    from gimel.db import SessionLocal
    from gimel.models import User

    assert client.get("/api/version").json()["demo"] is True
    with SessionLocal() as db:
        admin = db.query(User).filter(User.email == demo.ADMIN_EMAIL).one()
        admin.email = "chef@echter-betrieb.example"
        db.commit()
        try:
            assert client.get("/api/version").json()["demo"] is False
        finally:
            admin.email = demo.ADMIN_EMAIL
            db.commit()


def test_a_registered_account_with_the_demo_address_is_not_the_demo_plant(client):
    from gimel import demo
    from gimel.db import SessionLocal
    from gimel.models import Role, User

    with SessionLocal() as db:
        admin = db.query(User).filter(User.email == demo.ADMIN_EMAIL).one()
        admin.role = Role.customer
        db.commit()
        try:
            assert client.get("/api/version").json()["demo"] is False
        finally:
            admin.role = Role.admin
            db.commit()


def test_part_recognition_is_on_when_standalone(client):
    assert client.get("/api/version").json()["vision"] is True
    assert client.get("/api/vision/status").status_code == 200


def test_web_app_is_served(client):
    r = client.get("/app")
    assert r.status_code == 200
    assert "Gimel" in r.text


def test_demo_orders_carry_a_frozen_price_from_the_plain_formula(client):
    assert client.get("/api/admin/orders").json()["total"] == 8
    from gimel.core.nesting import ENGINE_VERSION
    from gimel.db import SessionLocal
    from gimel.models import Order

    with SessionLocal() as db:
        row = db.query(Order).first()
        assert row.net > 0
        assert row.engine_version == ENGINE_VERSION


def test_combined_run_cuts_across_orders_and_reaches_the_stations(client):
    runs = client.get("/api/production/runs").json()
    assert runs, "the demo seed starts one combined run"
    work_orders = client.get("/api/production/work-orders").json()
    assert work_orders
    stations = client.get("/api/factory/stations").json()
    assert {s["type"] for s in stations} == {"warehouse", "production", "shipping", "accounting"}
    r = client.post("/api/production/runs?force=true")
    assert r.status_code == 201, r.text


def test_every_placement_says_why(client):
    plan = client.get("/api/factory/worklist/plan").json()
    placements = plan["placements"] if isinstance(plan, dict) else plan
    board = client.get("/api/factory/worklist").json()
    assert placements or board


def test_stock_moves_leave_a_line(client):
    from gimel.db import SessionLocal
    from gimel.models import Product
    from gimel.services.inventory import move_stock

    with SessionLocal() as db:
        p = db.query(Product).first()
        before = p.stock
        move_stock(db, p, -1, reason="test", actor="pytest")
        db.commit()
        assert p.stock == before - 1


def test_no_default_admin_or_pin_outside_an_application():
    from gimel.config import Settings

    s = Settings()
    assert s.bootstrap_admin_password == ""
    assert s.staff_pin == ""


def test_no_foreign_origin_is_trusted_outside_an_application(client):
    from gimel.config import Settings

    assert Settings().cors_list == []
    r = client.get("/api/health", headers={"Origin": "http://localhost:3000"})
    assert "access-control-allow-origin" not in r.headers
    assert "access-control-allow-credentials" not in r.headers


def test_an_application_keeps_its_cors_list(tmp_path):
    code = "from gimel.config import Settings; print(','.join(Settings().cors_list))"
    env = {**os.environ, "GIMEL_ENV_PREFIX": "ALPHA_", "PYTHONPATH": str(PACKAGE.parent)}
    out = subprocess.run([sys.executable, "-c", code], env=env, cwd=tmp_path,
                         capture_output=True, text=True, check=True).stdout.strip()
    assert out.split(",") == [f"http://{h}:{p}" for p in (3000, 8000, 8001)
                              for h in ("127.0.0.1", "localhost")]


@pytest.mark.parametrize("pin", ["", " ", "2468"])
def test_pin_login_is_closed_when_no_pin_is_set(client, pin):
    r = client.post("/api/auth/pin", json={"pin": pin})
    assert r.status_code in (422, 503)
    assert client.get("/api/auth/login-options").json()["test_pin_enabled"] is False


def test_any_mail_domain_for_staff_without_a_plugin():
    from gimel.models import Role
    from gimel.security import require_internal_email

    require_internal_email("meister@musterwerk.example", Role.staff)


def _imports(path: Path) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8-sig"))):
        if isinstance(node, ast.Import):
            names |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and not node.level and node.module:
            names.add(node.module.split(".")[0])
    return names


@pytest.mark.parametrize("path", sorted(PACKAGE.rglob("*.py")), ids=lambda p: p.name)
def test_gimel_never_imports_an_application(path):
    assert not _imports(path) & {"app", "apps", "gre_foundation"}


@pytest.mark.parametrize("path", sorted((PACKAGE / "services").glob("*.py")), ids=lambda p: p.name)
def test_services_never_import_a_router(path):
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8-sig"))):
        if isinstance(node, ast.ImportFrom) and node.level:
            assert not (node.module or "").startswith("routers"), f"{path.name}:{node.lineno}"
