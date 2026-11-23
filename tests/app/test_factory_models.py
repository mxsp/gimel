"""3D-Modelle im Digitalen Grundriss: GLB, OBJ und STL, mit der richtigen Endung."""

from __future__ import annotations

from pathlib import Path

import pytest

from gimel.routers.factory import MODEL_DIR

GLB = b"glTF" + b"\x02\x00\x00\x00" + b"\x00" * 32
OBJ = b"# Testmodell\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"
STL = (b"solid test\n"
       b"  facet normal 0 0 1\n"
       b"    outer loop\n"
       b"      vertex 0 0 0\n"
       b"      vertex 1 0 0\n"
       b"      vertex 0 1 0\n"
       b"    endloop\n"
       b"  endfacet\n"
       b"endsolid test\n")


def first_station(client) -> int:
    r = client.get("/api/factory/stations")
    assert r.status_code == 200, r.text
    return r.json()[0]["id"]


@pytest.fixture(autouse=True)
def no_model_left_behind(client):
    yield
    for station in client.get("/api/factory/stations").json():
        if station.get("model_file"):
            client.delete(f"/api/factory/stations/{station['id']}/model")


@pytest.mark.parametrize(
    ("name", "body", "media"),
    [
        ("werk.glb", GLB, "model/gltf-binary"),
        ("werk.obj", OBJ, "model/obj"),
        ("werk.stl", STL, "model/stl"),
    ],
)
def test_model_upload_accepts_glb_obj_and_stl(client, name, body, media):
    sid = first_station(client)
    r = client.post(f"/api/factory/stations/{sid}/model",
                    files={"file": (name, body, "application/octet-stream")})
    assert r.status_code == 200, r.text
    station = r.json()
    assert station["model_file"].endswith(Path(name).suffix)
    assert station["model_url"].startswith(f"/api/factory/stations/{sid}/model?v=")

    got = client.get(f"/api/factory/stations/{sid}/model")
    assert got.status_code == 200
    assert got.content == body
    assert got.headers["content-type"].split(";")[0] == media


def test_upload_replaces_the_old_file(client):
    sid = first_station(client)
    first = client.post(f"/api/factory/stations/{sid}/model",
                        files={"file": ("alt.glb", GLB, "application/octet-stream")})
    assert first.status_code == 200, first.text
    old = first.json()["model_file"]

    second = client.post(f"/api/factory/stations/{sid}/model",
                         files={"file": ("neu.stl", STL, "application/octet-stream")})
    assert second.status_code == 200, second.text
    assert second.json()["model_file"].endswith(".stl")
    assert not (MODEL_DIR / old).exists()


def test_an_unknown_suffix_is_refused(client):
    r = client.post(f"/api/factory/stations/{first_station(client)}/model",
                    files={"file": ("werk.fbx", b"not a model", "application/octet-stream")})
    assert r.status_code == 400
    assert "glb, .obj oder .stl" in r.json()["detail"]


def test_an_empty_file_is_refused(client):
    r = client.post(f"/api/factory/stations/{first_station(client)}/model",
                    files={"file": ("leer.obj", b"", "application/octet-stream")})
    assert r.status_code == 400
    assert "leer" in r.json()["detail"]


def test_a_fake_glb_is_refused(client):
    r = client.post(f"/api/factory/stations/{first_station(client)}/model",
                    files={"file": ("fake.glb", b"not a glb", "application/octet-stream")})
    assert r.status_code == 400
    assert "GLB" in r.json()["detail"]
