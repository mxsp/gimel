"""Wege von Hand liegen im Gang-JSON des Grundrisses und überleben Speichern und Laden."""

from __future__ import annotations


def test_manual_paths_are_saved_with_the_aisles_and_read_back(client):
    floor = client.get("/api/factory/floor").json()
    keep = {k: floor[k] for k in ("name", "outline", "zones", "obstacles", "doors",
                                  "scale", "grid", "snap", "bg")}
    keep["aisles"] = {
        "nodes": [[0, 0], [10, 0]], "edges": [[0, 1]],
        "paths": [{"station": 3, "points": [[5, 4], [5, 0]]}],
    }
    assert client.put("/api/factory/floor", json=keep).status_code == 200
    back = client.get("/api/factory/floor").json()["aisles"]
    assert back["paths"] == [{"station": 3, "points": [[5, 4], [5, 0]]}]


def test_an_old_floor_without_paths_still_loads(client):
    aisles = client.get("/api/factory/floor").json()["aisles"]
    assert aisles.get("paths", []) == [] or isinstance(aisles["paths"], list)
