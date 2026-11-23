"""Tests for the composable module & semi-external application registry."""

from __future__ import annotations

from fastapi import APIRouter
from fastapi.testclient import TestClient

from gimel import modules as mod_registry


def test_version_and_modules_list_builtins(client):
    v = client.get("/api/version").json()
    ids = [m["id"] for m in v["modules"]]
    assert "erp" in ids
    assert "twin" in ids
    assert "grundriss" in ids

    res = client.get("/api/modules")
    assert res.status_code == 200
    body = res.json()
    assert body["can_manage"] is True
    assert any(m["id"] == "erp" and m["placement"] == "switcher" for m in body["modules"])


def test_crud_custom_semi_external_module_and_csp(client):
    # Create an embedded semi-external tool
    r = client.post(
        "/api/modules",
        json={
            "label": "Werkzeug-BI",
            "short_label": "BI",
            "icon": "chart",
            "description": "Lokales Grafana-Dashboard",
            "kind": "embedded",
            "href": "http://127.0.0.1:3000/dashboards",
            "placement": "switcher",
            "area": "leitstand",
        },
    )
    assert r.status_code == 201, r.text
    created = r.json()
    mid = created["id"]
    assert mid == "werkzeug-bi"
    assert created["editable"] is True
    assert created["embed_url"] == "http://127.0.0.1:3000/dashboards"

    try:
        # Appears in /api/modules and updates CSP frame-src automatically
        listed = client.get("/api/modules").json()["modules"]
        assert any(m["id"] == mid for m in listed)

        csp_resp = client.get("/api/version")
        csp = csp_resp.headers.get("Content-Security-Policy", "")
        assert "frame-src 'self' http://127.0.0.1:3000" in csp

        # Update label & disable
        upd = client.patch(f"/api/modules/{mid}", json={"label": "Grafana Werk", "enabled": False})
        assert upd.status_code == 200
        assert upd.json()["label"] == "Grafana Werk"
        assert upd.json()["enabled"] is False

        # Hidden when disabled unless all=true
        active_ids = [m["id"] for m in client.get("/api/modules").json()["modules"]]
        assert mid not in active_ids
        all_ids = [m["id"] for m in client.get("/api/modules?all=true").json()["modules"]]
        assert mid in all_ids
    finally:
        dele = client.delete(f"/api/modules/{mid}")
        assert dele.status_code == 204


def test_rejects_unsafe_urls_and_builtin_overwrite(client):
    bad = client.post(
        "/api/modules",
        json={"label": "Evil", "kind": "external", "href": "javascript:alert(1)"},
    )
    assert bad.status_code == 422

    clash = client.post(
        "/api/modules",
        json={"id": "erp", "label": "Fake ERP", "kind": "external", "href": "https://example.com"},
    )
    assert clash.status_code == 409

    # Built-in modules cannot be deleted
    assert client.delete("/api/modules/erp").status_code == 404


def test_python_module_mounts_router_and_spa(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html><body>CAD Viewer</body></html>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log('ok');", encoding="utf-8")

    def build_routers():
        r = APIRouter(prefix="/api/cad-demo", tags=["cad-demo"])

        @r.get("/ping")
        def ping():
            return {"ok": True}

        return [r]

    mod = mod_registry.AppModule(
        id="cad-demo",
        label="CAD Viewer",
        short_label="CAD",
        kind="mounted",
        href="/cad-demo/",
        placement="switcher",
        mount_path="/cad-demo",
        dist_dir=dist,
        routers=build_routers,
    )
    mod_registry.register_module(mod)
    try:
        from gimel.app import create_app

        with TestClient(create_app()) as c:
            assert c.get("/api/cad-demo/ping").json() == {"ok": True}
            html = c.get("/cad-demo")
            assert html.status_code == 200
            assert "CAD Viewer" in html.text
            assert html.headers.get("Cache-Control") == "no-cache"

            asset = c.get("/cad-demo/assets/app.js")
            assert asset.status_code == 200
            assert "immutable" in asset.headers.get("Cache-Control", "")
    finally:
        mod_registry.unregister_module("cad-demo")
