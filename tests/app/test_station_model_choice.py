"""Neue Station: Modellart (eingebaut / Quader) und Mitarbeiter am Arbeitsplatz."""

from __future__ import annotations

import pytest

from gimel.routers.factory import MODEL_DIR  # noqa: F401  (Import prüft, dass der Router lädt)

BODY = {"label": "Teststation Modellwahl", "type": "production", "x": 3, "y": 3, "w": 4, "h": 2.5}


@pytest.fixture
def made(client):
    ids: list[int] = []

    def make(**extra):
        r = client.post("/api/factory/stations", json={**BODY, **extra})
        if r.status_code == 200:
            ids.append(r.json()["id"])
        return r

    yield make
    for sid in ids:
        client.delete(f"/api/factory/stations/{sid}")


def test_default_is_automatic_model_without_staff(made):
    r = made()
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["model_kind"] == ""
    assert body["staffed"] is False


@pytest.mark.parametrize("kind", ["box", "plotter", "waterjet", "punch", "manual", "generic", "storage", "packing", "office"])
def test_model_kind_is_kept(made, kind):
    r = made(model_kind=kind, staffed=True)
    assert r.status_code == 200, r.text
    assert r.json()["model_kind"] == kind
    assert r.json()["staffed"] is True


def test_unknown_model_kind_is_refused(made):
    r = made(model_kind="ufo")
    assert r.status_code == 422


def test_model_kind_and_staff_can_change_later(client, made):
    sid = made(model_kind="box").json()["id"]
    r = client.put(f"/api/factory/stations/{sid}", json={**BODY, "model_kind": "plotter", "staffed": True})
    assert r.status_code == 200, r.text
    assert (r.json()["model_kind"], r.json()["staffed"]) == ("plotter", True)
    listed = [s for s in client.get("/api/factory/stations").json() if s["id"] == sid][0]
    assert (listed["model_kind"], listed["staffed"]) == ("plotter", True)
