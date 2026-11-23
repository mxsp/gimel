"""One policy on every response. Pages that run under it carry no inline script."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from gimel.db import SessionLocal
from gimel.models import WorkOrder

ADMIN = Path(__file__).resolve().parents[2] / "gimel" / "admin"
# 'wasm-unsafe-eval' seit 2026-11-09 für MediaPipe (Handführung in der Sortierzelle, WASM
# lokal im Browser). Entscheidung des Inhabers 2026-11-14: WASM bleibt, worker-src blob:
# entfällt (kein Worker im Code). Das erlaubt nur WebAssembly-Übersetzung, kein eval(),
# kein Inline-Skript und keinen Worker aus einem Blob — das hält der Test unten fest.
CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob: https://tile.openstreetmap.org https://server.arcgisonline.com; font-src 'self' data:; connect-src 'self' https://nominatim.openstreetmap.org; "
    "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
)
INLINE_SCRIPT = re.compile(r"<script(?![^>]*\bsrc=)[^>]*>", re.I)


@pytest.mark.parametrize("path", ["/api/health", "/api/version", "/static/laufkarte.js",
                                  "/favicon.ico", "/openapi.json"])
def test_every_response_carries_the_policy(client, path):
    r = client.get(path)
    assert r.status_code == 200
    assert r.headers["content-security-policy"] == CSP


def test_scripts_stay_without_eval_and_inline(client):
    """Die Ausnahme für WASM ist die einzige: kein eval(), kein Inline-Skript, keine fremde Quelle."""
    policy = client.get("/api/health").headers["content-security-policy"]
    script = next(d for d in policy.split(";") if d.strip().startswith("script-src")).split()[1:]
    assert script == ["'self'", "'wasm-unsafe-eval'"]
    assert "'unsafe-eval'" not in policy and "script-src 'self' 'unsafe-inline'" not in policy
    assert "worker-src" not in policy, "kein Worker aus blob: (Inhaber 2026-11-14)"


def test_a_refused_request_carries_it_too(client):
    assert client.get("/api/nothing-here").headers["content-security-policy"] == CSP


@pytest.mark.parametrize("path", ["/docs", "/redoc"])
def test_only_the_docs_pages_get_their_own_policy(client, path):
    policy = client.get(path).headers["content-security-policy"]
    assert policy != CSP
    assert "https://cdn.jsdelivr.net" in policy
    assert "frame-ancestors 'none'" in policy and "object-src 'none'" in policy


@pytest.mark.parametrize("page", sorted(ADMIN.glob("*.html")), ids=lambda p: p.name)
def test_old_pages_have_no_inline_script(page):
    assert not INLINE_SCRIPT.search(page.read_text(encoding="utf-8"))


@pytest.mark.parametrize("name", sorted(p.name for p in ADMIN.glob("*.js")))
def test_old_pages_write_no_inline_handlers(name):
    source = (ADMIN / name).read_text(encoding="utf-8")
    assert not re.search(r"""\son[a-z]+=["']""", source)


def _work_order() -> str:
    with SessionLocal() as db:
        return db.query(WorkOrder).first().no


def test_the_route_card_in_the_portal_loads_its_script_from_the_origin(client):
    html = client.get(f"/api/production/work-orders/{_work_order()}/sheet").text
    assert not INLINE_SCRIPT.search(html)
    assert '<script src="/static/laufkarte.js"></script>' in html
    assert client.get("/static/laufkarte.js").status_code == 200


def test_the_downloaded_route_card_works_without_a_server(client):
    r = client.get(f"/api/production/work-orders/{_work_order()}/sheet", params={"download": True})
    assert "attachment" in r.headers["content-disposition"]
    assert "/static/laufkarte.js" not in r.text
    assert "initInteractivity" in r.text
