"""Angebot mit Gimels schlichter Formel: jede Gruppe trägt alle Schlüssel, die /api/quote liest.

Bis 2026-11-03 fehlten ``nRest``, ``waste``, ``usedA`` und die Restwerte; jede Preisberechnung
der eigenständigen Installation endete mit „Interner Fehler“.
"""

from __future__ import annotations

from gimel.db import SessionLocal
from gimel.models import Product


def a_material() -> tuple[str, float]:
    with SessionLocal() as db:
        p = db.query(Product).filter(Product.active.is_(True)).first()
        thk = (p.thicknesses or [2.0])[0]
        return p.id, float(thk)


def test_a_plain_quote_prices_and_answers(client):
    mat, thk = a_material()
    body = {"lines": [{"id": 1, "mat": mat, "thk": thk, "q": 4, "od": 120, "di": 60, "label": "Ring"}]}
    r = client.post("/api/quote", json=body)
    assert r.status_code == 200, r.text
    q = r.json()
    group = q["groups"][0]
    assert group["n_sheets"] >= 1 and group["used_area"] > 0
    assert 0 <= group["waste"] < 1
