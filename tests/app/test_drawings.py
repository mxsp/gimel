"""Zeichnungsbibliothek: Punkte, DXF und SVG werden geprüft, nie die Datei gespeichert."""

from __future__ import annotations

import io
import math
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

import ezdxf
import pytest

from gimel.db import SessionLocal
from gimel.models import AuditLog, Drawing, Role, User
from gimel.security import create_access_token

from gimel.services import drawings as drawings_service
from gimel.services.drawings import DrawingError

ROOT = Path(__file__).resolve().parents[2]
SQUARE = "0,0 100,0 100,60 0,60"
HOLE = "20,20 40,20 40,40 20,40"


@pytest.fixture(autouse=True)
def clean_library():
    yield
    with SessionLocal() as db:
        db.query(Drawing).delete()
        db.commit()


def lines(action: str) -> list[AuditLog]:
    with SessionLocal() as db:
        return db.query(AuditLog).filter(AuditLog.action == action).order_by(AuditLog.id).all()


def points(client, text: str, name: str = "Platte", **extra):
    return client.post("/api/drawings", json={"name": name, "text": text, **extra})


def dxf_of(build) -> bytes:
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 4
    build(doc.modelspace())
    out = io.StringIO()
    doc.write(out)
    return out.getvalue().encode()


def rect(msp, x, y, w, h):
    msp.add_lwpolyline([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], close=True)


def post_file(client, kind: str, body: bytes, name: str = "datei"):
    return client.post(f"/api/drawings/import/{kind}", content=body,
                       headers={"X-Name": quote(name), "Content-Type": "application/octet-stream"})


# ---------------------------------------------------------------- points
def test_points_make_a_drawing_moved_to_the_origin_with_its_figures(client):
    r = points(client, "10,10 110,10 110,70 10,70\n\n30,30 50,30 50,50 30,50", "Blech mit Loch")
    assert r.status_code == 200, r.text
    d = r.json()["created"][0]
    assert d["source"] == "points" and d["n_holes"] == 1
    assert (d["width"], d["height"]) == (100, 60)
    assert d["area"] == 100 * 60 - 20 * 20
    assert d["cut_len"] == pytest.approx(320 + 80)
    full = client.get(f"/api/drawings/{d['id']}").json()
    assert min(p[0] for p in full["outer"]) == 0 and min(p[1] for p in full["outer"]) == 0
    assert full["holes"][0][0] == [20, 20]


def test_json_rings_work_like_text(client):
    r = client.post("/api/drawings", json={"name": "J", "outer": [[0, 0], [10, 0], [10, 5]]})
    assert r.status_code == 200 and r.json()["created"][0]["area"] == 25


@pytest.mark.parametrize("text,fragment", [
    ("0,0 10,0", "drei"),
    ("0,0 10,0 20,0", "Fläche"),
    ("0,0 0,0 10,0 10,0 0,0", "drei"),
    ("0,0 10,0 1e999,5", "nicht endlich"),
    ("0,0 10,0 2000000,5", "außerhalb"),
    ("0,0 10,0 10", "ungerade"),
    ("0,0 10,0 abc,5", "nur Zahlen"),
    ("", "Keine Punkte"),
])
def test_bad_points_are_refused_with_a_reason(client, text, fragment):
    r = points(client, text)
    assert r.status_code == 422, r.text
    assert fragment in r.json()["detail"]


def test_a_hole_outside_the_outline_and_a_hole_that_fills_it_are_refused(client):
    assert "liegt nicht" in points(client, SQUARE + "\n\n200,200 220,200 220,220").json()["detail"]
    assert points(client, SQUARE + "\n\n0,0 100,0 100,60 0,60").status_code == 422


def test_limits_on_vertices_and_rings(client):
    n = 5003
    ring = " ".join(f"{50 * math.cos(2 * math.pi * i / n):.4f},{50 * math.sin(2 * math.pi * i / n):.4f}"
                    for i in range(n))
    assert "Eckpunkte" in points(client, ring).json()["detail"]
    many = SQUARE + "".join(f"\n\n{x},5 {x + 1},5 {x + 1},6 {x},6" for x in range(10, 10 + 64))
    assert "Konturen" in points(client, many).json()["detail"]
    assert points(client, SQUARE).status_code == 200


def test_text_and_rings_together_are_refused(client):
    r = client.post("/api/drawings", json={"text": SQUARE, "outer": [[0, 0], [1, 0], [1, 1]]})
    assert r.status_code == 422


# ---------------------------------------------------------------- DXF
def test_a_dxf_with_several_shapes_makes_one_drawing_each_and_says_what_it_skipped(client):
    def build(msp):
        rect(msp, 0, 0, 100, 60)
        msp.add_circle((30, 30), 10)                # Aussparung des ersten
        rect(msp, 200, 0, 50, 50)                   # zweites Teil
        msp.add_line((500, 500), (600, 500))        # offen
        msp.add_text("Beschriftung")

    before = len(lines("drawing_create"))
    r = post_file(client, "dxf", dxf_of(build), "Muster Teil.dxf")
    assert r.status_code == 200, r.text
    out = r.json()
    names = [d["name"] for d in out["created"]]
    assert names == ["Muster Teil.dxf 1", "Muster Teil.dxf 2"]
    big, small = out["created"]
    assert (big["width"], big["height"], big["n_holes"]) == (100, 60, 1)
    assert (small["width"], small["height"], small["n_holes"]) == (50, 50, 0)
    assert any("offene" in s for s in out["skipped"]), out
    assert any("Text" in s for s in out["skipped"]), out
    assert all(d["source"] == "dxf" for d in out["created"])
    assert len(lines("drawing_create")) - before == 2


def test_a_dxf_without_unit_is_read_as_mm_and_says_so(client):
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 0
    rect(doc.modelspace(), 0, 0, 10, 10)
    out = io.StringIO()
    doc.write(out)
    r = post_file(client, "dxf", out.getvalue().encode())
    assert r.status_code == 200
    assert any("Millimeter" in n for n in r.json()["notes"])


def test_dxf_in_inches_is_scaled(client):
    doc = ezdxf.new("R2010")
    doc.header["$INSUNITS"] = 1
    rect(doc.modelspace(), 0, 0, 4, 2)
    out = io.StringIO()
    doc.write(out)
    d = post_file(client, "dxf", out.getvalue().encode()).json()["created"][0]
    assert (d["width"], d["height"]) == (101.6, 50.8)


@pytest.mark.parametrize("body,fragment", [
    (b"AutoCAD Binary DXF\r\n\x1a\x00xxx", "binäre"),
    (b"<svg xmlns='http://www.w3.org/2000/svg'/>", "SVG"),
    (b"nonsense", "nicht lesbar"),
    (b"  \n", "leer"),
])
def test_bad_dxf_is_refused(client, body, fragment):
    r = post_file(client, "dxf", body)
    assert r.status_code == 422 and fragment in r.json()["detail"], r.text


def test_a_dxf_with_only_open_lines_is_refused(client):
    r = post_file(client, "dxf", dxf_of(lambda m: m.add_line((0, 0), (10, 0))))
    assert r.status_code == 422 and "geschlossene" in r.json()["detail"]


def test_the_body_is_limited_before_anything_reads_it(client):
    r = post_file(client, "dxf", b"0\n" * (1024 * 1024 + 1))
    assert r.status_code == 413
    r = client.post("/api/drawings/import/svg", content=iter([b"x" * 65536] * 40))   # ohne Content-Length
    assert r.status_code == 413


def test_import_leaves_no_file_behind_and_uses_no_form_parser(client, monkeypatch):
    import tempfile

    def no_file(*a, **k):
        raise AssertionError("a temp file was opened")

    monkeypatch.setattr(tempfile, "SpooledTemporaryFile", no_file)
    monkeypatch.setattr(tempfile, "NamedTemporaryFile", no_file)
    assert post_file(client, "dxf", dxf_of(lambda m: rect(m, 0, 0, 5, 5))).status_code == 200
    assert not hasattr(Drawing, "dxf_blob")


# ---------------------------------------------------------------- SVG
def svg(inner: str, attrs: str = "") -> bytes:
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" {attrs}>{inner}</svg>'.encode()


def test_svg_shapes_become_drawings_y_up_with_mm_note(client):
    inner = ('<rect x="10" y="10" width="100" height="60"/>'
             '<circle cx="40" cy="40" r="10"/>'
             '<polygon points="200,10 260,10 230,70"/>')
    r = post_file(client, "svg", svg(inner), "form")
    assert r.status_code == 200, r.text
    out = r.json()
    assert any("Millimeter" in n for n in out["notes"])
    rect_d, tri = out["created"]
    assert (rect_d["width"], rect_d["height"], rect_d["n_holes"]) == (100, 60, 1)
    assert (tri["width"], tri["height"]) == (60, 60)
    full = client.get(f"/api/drawings/{tri['id']}").json()
    pts = {tuple(p) for p in full["outer"]}
    assert pts == {(0.0, 60.0), (60.0, 60.0), (30.0, 0.0)}, "SVG counts down: the apex that is low on screen is y=0 here"


def test_svg_paths_with_lines_arcs_and_beziers_are_sampled(client):
    d = "M0 0 H100 V50 C100 80 60 100 50 100 S0 80 0 50 Z"
    arc = "M200 0 A25 25 0 1 1 250 0 A25 25 0 1 1 200 0 Z"
    quad = "M300 0 Q350 100 400 0 Z"
    out = post_file(client, "svg", svg(f'<path d="{d}"/><path d="{arc}"/><path d="{quad}"/>')).json()
    a, quad, circle = out["created"]                                    # nach Fläche geordnet
    assert a["width"] == pytest.approx(100, abs=0.01) and a["height"] > 90
    assert circle["width"] == pytest.approx(50, abs=0.1)
    assert circle["area"] == pytest.approx(math.pi * 25**2, rel=0.01)
    assert quad["area"] == pytest.approx(100 * 50 * 2 / 3, rel=0.01)    # Parabelsegment


def test_svg_arc_flags_may_be_packed(client):
    out = post_file(client, "svg", svg('<path d="M0 0a10 10 0 0110 10h-10z"/>')).json()
    assert out["created"], out


def test_svg_with_a_transform_is_refused_not_guessed(client):
    r = post_file(client, "svg", svg('<g transform="scale(2)"><rect width="10" height="10"/></g>'))
    assert r.status_code == 422 and "transform" in r.json()["detail"]


@pytest.mark.parametrize("head", [
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
    '<!DOCTYPE svg [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;">]>',
    '<!doctype svg>',
    '<!ENTITY x "y">',
])
def test_doctype_and_entity_are_refused(client, head):
    body = f'<?xml version="1.0"?>{head}<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5"/></svg>'
    r = post_file(client, "svg", body.encode())
    assert r.status_code == 422 and ("DOCTYPE" in r.json()["detail"]), r.text
    with SessionLocal() as db:
        assert db.query(Drawing).count() == 0


def test_svg_open_paths_and_unread_elements_are_reported(client):
    inner = ('<rect width="40" height="40"/><path d="M0 0 L50 50"/><text>Hallo</text>'
             '<line x1="0" y1="0" x2="5" y2="5"/>')
    out = post_file(client, "svg", svg(inner)).json()
    assert len(out["created"]) == 1
    assert any("offene" in s for s in out["skipped"]) and any("Text" in s for s in out["skipped"])


def test_svg_that_is_not_utf8_or_not_svg_is_refused(client):
    assert post_file(client, "svg", b"\xff\xfe<svg/>").status_code == 422
    assert "svg" in post_file(client, "svg", b"<html/>").json()["detail"].lower()
    assert post_file(client, "svg", svg("<rect width='0' height='5'/>")).status_code == 422


def test_svg_width_in_other_units_is_noted(client):
    out = post_file(client, "svg", svg('<rect width="10" height="10"/>', 'width="10in" height="10in"')).json()
    assert any("in" in n and "Millimeter" in n for n in out["notes"])


# ---------------------------------------------------------------- library
def test_search_rename_delete_and_their_audit_lines(client):
    a = points(client, SQUARE, "Konsole links").json()["created"][0]
    points(client, SQUARE, "Deckel", note="für Kunde Müller")
    assert client.get("/api/drawings?q=konsole").json()["total"] == 1
    assert client.get("/api/drawings?q=müller").json()["total"] == 1
    assert client.get("/api/drawings?q=100%25").json()["total"] == 0
    assert client.get("/api/drawings").json()["total"] == 2

    r = client.patch(f"/api/drawings/{a['id']}", json={"name": "  Konsole\trechts "})
    assert r.status_code == 200 and r.json()["name"] == "Konsole rechts"
    assert len(lines("drawing_rename")) == 1
    client.patch(f"/api/drawings/{a['id']}", json={"name": "Konsole rechts"})
    assert len(lines("drawing_rename")) == 1, "no change, no line"
    assert client.patch(f"/api/drawings/{a['id']}", json={"name": "  "}).status_code == 422

    assert client.delete(f"/api/drawings/{a['id']}").status_code == 200
    assert len(lines("drawing_delete")) == 1
    assert client.get(f"/api/drawings/{a['id']}").status_code == 404
    assert client.delete(f"/api/drawings/{a['id']}").status_code == 404
    assert len(lines("drawing_delete")) == 1, "a miss leaves no line"


def test_writes_name_the_signed_in_user(client):
    from gimel import demo
    points(client, SQUARE)
    assert lines("drawing_create")[-1].actor == demo.ADMIN_EMAIL


def test_workers_and_anonymous_users_are_kept_out(client):
    from fastapi.testclient import TestClient

    from gimel.app import create_app

    with SessionLocal() as db:
        u = db.query(User).filter(User.email == "halle@example.test").first()
        if u is None:
            u = User(email="halle@example.test", name="Halle", role=Role.worker, password_hash="x")
            db.add(u)
            db.commit()
        head = {"Authorization": f"Bearer {create_access_token(u)}"}
    assert client.get("/api/drawings", headers=head).status_code == 403
    assert client.post("/api/drawings", json={"text": SQUARE}, headers=head).status_code == 403
    assert client.post("/api/drawings/import/dxf", content=b"x", headers=head).status_code == 403
    with TestClient(create_app()) as anon:
        assert anon.get("/api/drawings").status_code == 401


def test_the_library_has_a_ceiling(client, monkeypatch):
    from gimel.services import drawings
    monkeypatch.setattr(drawings, "MAX_LIBRARY", 2)
    assert points(client, SQUARE).status_code == 200
    assert points(client, SQUARE).status_code == 200
    r = points(client, SQUARE)
    assert r.status_code == 409 and "2" in r.json()["detail"]


def test_a_file_with_too_many_parts_creates_the_first_ones_and_says_so(client, monkeypatch):
    from gimel.services import drawings
    monkeypatch.setattr(drawings, "MAX_PER_IMPORT", 2)
    out = post_file(client, "dxf", dxf_of(lambda m: [rect(m, i * 20, 0, 10, 10) for i in range(4)])).json()
    assert len(out["created"]) == 2 and any("2 weitere" in s for s in out["skipped"])


def test_the_table_is_plain_geometry(client):
    d = points(client, SQUARE).json()["created"][0]
    with SessionLocal() as db:
        row = db.get(Drawing, d["id"])
        assert {c.name for c in Drawing.__table__.columns} == {
            "id", "name", "note", "source", "outer", "holes", "width", "height", "area", "cut_len",
            "created_at", "created_by", "updated_at"}
        assert row.outer[0] == [0, 0]


# ---------------------------------------------------------------- CPU and memory bounds (security review)
def raw_dxf(entities: str) -> bytes:
    return ("0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n" + entities
            + "0\nENDSEC\n0\nEOF\n").encode()


def timed(call):
    t = time.perf_counter()
    try:
        call()
    except DrawingError as e:
        return time.perf_counter() - t, e.detail
    raise AssertionError("not refused")


def test_a_dxf_with_tens_of_thousands_of_lines_is_refused_in_two_seconds(client):
    body = raw_dxf("0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n" * 50000)
    assert len(body) < 2 * 1024 * 1024
    took, detail = timed(lambda: drawings_service.parse_dxf(body))
    print(f"50,000 LINEs refused in {took:.2f} s")
    assert took < 2 and "5000" in detail
    t = time.perf_counter()
    r = post_file(client, "dxf", body)
    assert r.status_code == 422 and time.perf_counter() - t < 2.5


def test_dxf_circles_ellipses_and_closed_entities_have_caps(client):
    r = post_file(client, "dxf", dxf_of(lambda m: [m.add_circle((i * 5, 0), 1) for i in range(600)]))
    assert r.status_code == 422 and "Kreise" in r.json()["detail"]
    r = post_file(client, "dxf", dxf_of(lambda m: [m.add_ellipse((i * 5, 0), (2, 0), 0.5) for i in range(501)]))
    assert r.status_code == 422 and "Kreise und Ellipsen" in r.json()["detail"]
    r = post_file(client, "dxf", dxf_of(lambda m: [rect(m, i * 20, 0, 10, 10) for i in range(250)]))
    assert r.status_code == 422 and "geschlossene" in r.json()["detail"]
    ok = post_file(client, "dxf", dxf_of(lambda m: [m.add_circle((i * 5, 0), 1) for i in range(200)]))
    assert ok.status_code == 200 and len(ok.json()["created"]) == 50, "200 loops still import, 50 at most"


def test_many_block_references_are_refused_before_ezdxf_expands_them(client):
    def build(msp):
        blk = msp.doc.blocks.new("B")
        for i in range(60):
            blk.add_line((i, 0), (i, 5))
        for i in range(101):
            msp.add_blockref("B", (i * 100, 0))

    r = post_file(client, "dxf", dxf_of(build))
    assert r.status_code == 422 and "Blockverweise" in r.json()["detail"]


def test_the_order_import_parser_is_untouched():
    """The caps live in the drawing import, not in parse_dxf that the order desk uses."""
    from gimel.services.dxf_import import parse_dxf
    assert "error" in parse_dxf("nonsense")
    assert "MAX_OPEN_SEGMENTS" not in open(parse_dxf.__code__.co_filename).read()


def svg_arcs(n: int) -> bytes:
    return svg('<path d="M0 0' + "a1 1 0 0 1 2 0" * n + 'z"/>')


def test_a_svg_with_fifty_thousand_arcs_is_refused_fast_and_small(client):
    body = svg_arcs(50000)
    assert len(body) < 2 * 1024 * 1024
    took, detail = timed(lambda: drawings_service.parse_svg(body))
    print(f"50,000 arcs refused in {took:.2f} s")
    assert took < 3 and "Eckpunkte" in detail
    code = ("import resource,sys\nfrom gimel.services import drawings as d\n"
            "body=sys.stdin.buffer.read()\n"
            "before=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss\n"
            "try:\n    d.parse_svg(body)\nexcept d.DrawingError:\n    pass\n"
            "print((resource.getrusage(resource.RUSAGE_SELF).ru_maxrss-before)/1024)\n")
    out = subprocess.run([sys.executable, "-c", code], input=body, capture_output=True, cwd=ROOT,
                         env={**os.environ, "PYTHONPATH": str(ROOT)}, check=True)
    grown = float(out.stdout.decode().strip().splitlines()[-1])
    print(f"memory growth {grown:.0f} MB")
    assert grown < 300
    assert client.post("/api/drawings/import/svg", content=body).status_code == 422


def test_svg_vertices_are_counted_across_shapes_and_commands(client):
    many = "".join(f'<circle cx="{i * 3}" cy="0" r="1"/>' for i in range(900))      # 24 points each
    assert client.post("/api/drawings/import/svg", content=svg(many)).status_code == 422
    rects = "".join(f'<rect x="{i * 3}" width="2" height="2" rx="1"/>' for i in range(900))
    assert client.post("/api/drawings/import/svg", content=svg(rects)).status_code == 422
    poly = '<polygon points="' + " ".join(f"{i},{i % 7}" for i in range(21000)) + '"/>'
    assert client.post("/api/drawings/import/svg", content=svg(poly)).status_code == 422


@pytest.mark.parametrize("d", [
    "M0 0 C1e308 0 0 1e308 5 5Z", "M0 0 Q1e308 1e308 5 5Z", "M0 0 A1e308 1e308 0 0 1 5 5Z",
    "M0 0 L1e308 0 L0 5Z", "M0 0 h4e5 h4e5 h4e5 v5Z",
    "M0 0 A1e-300 1e-300 0 0 1 5 5Z", "M0 0 C0 0 0 0 0 0 1e400 0 5 5Z",
])
def test_huge_numbers_in_paths_are_422_not_500(client, d):
    r = client.post("/api/drawings/import/svg", content=svg(f'<path d="{d}"/>'))
    assert r.status_code == 422, (d, r.status_code, r.text)


def test_huge_shape_attributes_and_dxf_numbers_are_not_500(client):
    assert client.post("/api/drawings/import/svg", content=svg('<rect width="1e308" height="5"/>')).status_code == 422
    for r_ in (1e300, 1e7):
        got = post_file(client, "dxf", dxf_of(lambda m: m.add_circle((0, 0), r_))).status_code
        assert got in (200, 422), got


def test_a_five_thousand_vertex_drawing_is_simplified_not_stored_whole(client):
    n = 5000
    ring = [[round(50 * math.cos(2 * math.pi * i / n), 5), round(50 * math.sin(2 * math.pi * i / n), 5)] for i in range(n)]
    r = client.post("/api/drawings", json={"name": "Rund", "outer": ring})
    assert r.status_code == 200, r.text
    d = client.get(f"/api/drawings/{r.json()['created'][0]['id']}").json()
    assert 3 <= len(d["outer"]) < 600
    assert d["area"] == pytest.approx(math.pi * 50 ** 2, rel=0.002)
    assert (d["width"], d["height"]) == pytest.approx((100, 100), abs=0.05)


def test_a_drawing_that_cannot_be_simplified_enough_is_refused(client):
    zig = [[i * 0.1, (i % 2) * 2.0] for i in range(4500)] + [[450, 40], [0, 40]]
    r = client.post("/api/drawings", json={"name": "Zacken", "outer": zig})
    assert r.status_code == 422 and "1500" in r.json()["detail"]
    assert drawings_service.MAX_DRAWING_VERTICES == 1500
    assert drawings_service.MAX_RING_VERTICES == 5000 and drawings_service.MAX_VERTICES == 20000    # not loosened


def test_simplifying_keeps_holes_inside_and_rings_valid(client):
    n = 2600
    big = [[round(100 * math.cos(2 * math.pi * i / n), 5), round(100 * math.sin(2 * math.pi * i / n), 5)] for i in range(n)]
    hole = [[round(30 * math.cos(2 * math.pi * i / n), 5), round(30 * math.sin(2 * math.pi * i / n), 5)] for i in range(n)]
    r = client.post("/api/drawings", json={"name": "Scheibe", "outer": big, "holes": [hole]})
    assert r.status_code == 200, r.text
    d = client.get(f"/api/drawings/{r.json()['created'][0]['id']}").json()
    assert len(d["holes"]) == 1 and len(d["outer"]) + len(d["holes"][0]) < 4000
    assert d["area"] == pytest.approx(math.pi * (100 ** 2 - 30 ** 2), rel=0.003)


# ---------------------------------------------------------------- second review: N1 .. N5
def measured(body: bytes) -> tuple[float, float, str]:
    """Seconds and peak memory growth (MB) of parse_dxf in a fresh process, and the refusal."""
    code = ("import resource,sys,time\nfrom gimel.services import drawings as d\nbody=sys.stdin.buffer.read()\n"
            "before=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss\nt=time.perf_counter()\nmsg='accepted'\n"
            "try:\n    d.parse_dxf(body)\nexcept d.DrawingError as e:\n    msg=e.detail\n"
            "print(time.perf_counter()-t, (resource.getrusage(resource.RUSAGE_SELF).ru_maxrss-before)/1024, msg)\n")
    out = subprocess.run([sys.executable, "-c", code], input=body, capture_output=True, cwd=ROOT,
                         env={**os.environ, "PYTHONPATH": str(ROOT)}, check=True)
    sec, mb, msg = out.stdout.decode().strip().splitlines()[-1].split(" ", 2)
    return float(sec), float(mb), msg


def test_a_nested_block_bomb_is_refused_in_under_a_second(client):
    def build(msp):
        doc = msp.doc
        doc.blocks.new("B0").add_line((0, 0), (1, 1))
        for k in range(1, 5):
            blk = doc.blocks.new(f"B{k}")
            for i in range(19):
                blk.add_blockref(f"B{k - 1}", (i * 2, 0))
        msp.add_blockref("B4", (0, 0))

    body = dxf_of(build)
    assert len(body) < 40_000
    sec, mb, msg = measured(body)
    print(f"nested block bomb ({len(body)} bytes): refused in {sec:.2f} s, +{mb:.0f} MB: {msg}")
    assert sec < 1 and mb < 200 and "Entitäten" in msg
    assert post_file(client, "dxf", body).status_code == 422


def test_twenty_thousand_bulged_vertices_are_refused_fast_and_small(client):
    def build(msp):
        msp.add_lwpolyline([(i * 3.0, (i % 2) * 40.0, 0, 0, 0.9) for i in range(20000)], format="xyseb", close=True)

    body = dxf_of(build)
    assert len(body) < 2 * 1024 * 1024
    sec, mb, msg = measured(body)
    print(f"20,000 bulged vertices ({len(body) // 1024} KB): refused in {sec:.2f} s, +{mb:.0f} MB: {msg}")
    assert sec < 1 and mb < 200 and "Eckpunkte" in msg
    assert post_file(client, "dxf", body).status_code == 422


def test_generated_points_are_counted_for_bulges_below_the_vertex_cap(client):
    def build(msp):
        msp.add_lwpolyline([(i * 400.0, (i % 2) * 2000.0, 0, 0, 1.0) for i in range(4000)], format="xyseb", close=True)

    sec, mb, msg = measured(dxf_of(build))
    print(f"4,000 big bulges: refused in {sec:.2f} s, +{mb:.0f} MB: {msg}")
    assert sec < 3 and mb < 200 and "Punkte" in msg


def test_a_spline_heavy_file_is_bounded(client):
    def build(msp):
        for i in range(300):
            msp.add_spline(fit_points=[(0, i), (50000, 40000 + i), (100000, i)])

    body = dxf_of(build)
    sec, mb, msg = measured(body)
    print(f"300 long splines ({len(body) // 1024} KB): refused in {sec:.2f} s, +{mb:.0f} MB: {msg}")
    assert sec < 3 and mb < 200 and "Punkte" in msg


def test_crlf_files_are_counted_like_lf_files(client):
    body = raw_dxf("0\nLINE\n8\n0\n10\n0\n20\n0\n11\n1\n21\n1\n" * 6000)
    for variant in (body, body.replace(b"\n", b"\r\n"), body.replace(b"\n", b"\r")):
        took, detail = timed(lambda: drawings_service.parse_dxf(variant))
        assert took < 2 and "5000" in detail, detail
        assert post_file(client, "dxf", variant).status_code == 422
    ok = raw_dxf("0\nLINE\n8\n0\n10\n0\n20\n0\n11\n9\n21\n0\n0\nLINE\n8\n0\n10\n9\n20\n0\n11\n9\n21\n9\n"
                 "0\nLINE\n8\n0\n10\n9\n20\n9\n11\n0\n21\n0\n0\nLINE\n8\n0\n10\n0\n20\n9\n11\n0\n21\n0\n").replace(b"\n", b"\r\n")
    assert post_file(client, "dxf", ok).status_code == 200, "a small CRLF file still imports"


def _old_chain(segments):
    """The quadratic _chain as it was before the endpoint grid (copy, for comparison only)."""
    from gimel.services.dxf_import import CHAIN_TOL
    segs = [s[:] for s in segments if len(s) >= 2]

    def near(a, b):
        return math.hypot(a[0] - b[0], a[1] - b[1]) <= CHAIN_TOL

    out = []
    while segs:
        cur = segs.pop(0)
        grew = True
        while grew:
            if len(cur) > 2 and near(cur[0], cur[-1]):
                break
            grew = False
            for i, s in enumerate(segs):
                a, b = cur[0], cur[-1]
                if near(b, s[0]):
                    cur = cur + s[1:]
                elif near(b, s[-1]):
                    cur = cur + list(reversed(s))[1:]
                elif near(a, s[-1]):
                    cur = s[:-1] + cur
                elif near(a, s[0]):
                    cur = list(reversed(s))[:-1] + cur
                else:
                    continue
                segs.pop(i)
                grew = True
                break
        out.append(cur)
    return out


def test_the_endpoint_grid_chain_equals_the_old_chain_on_random_data():
    import random
    from gimel.services.dxf_import import _chain
    rnd = random.Random(20261102)
    for trial in range(400):
        lattice = [(rnd.randint(0, 6) * 10.0, rnd.randint(0, 6) * 10.0) for _ in range(rnd.randint(3, 14))]

        def jitter(p):
            return [p[0] + rnd.uniform(-0.04, 0.04), p[1] + rnd.uniform(-0.04, 0.04)]

        segs = []
        for _ in range(rnd.randint(1, 40)):
            a, b = rnd.choice(lattice), rnd.choice(lattice)
            mid = [[rnd.uniform(0, 60), rnd.uniform(0, 60)] for _ in range(rnd.randint(0, 2))]
            seg = [jitter(a), *mid, jitter(b)]
            segs.append(seg if rnd.random() < 0.5 else seg[::-1])
        segs.append([[1.0, 1.0]])                           # a one-point piece is dropped by both
        assert _chain(segs) == _old_chain(segs), trial
    ring = [[10 * math.cos(t / 20 * math.tau), 10 * math.sin(t / 20 * math.tau)] for t in range(20)]
    pieces = [ring[i:i + 4] for i in range(0, 16, 3)] + [ring[15:] + ring[:1]]
    rnd.shuffle(pieces)
    assert _chain(pieces) == _old_chain(pieces)


def test_chaining_five_thousand_segments_is_no_longer_quadratic():
    from gimel.services.dxf_import import _chain
    segs = [[[float(i), 0.0], [float(i + 1), 0.0]] for i in range(5000)]
    t = time.perf_counter()
    out = _chain(segs)
    took = time.perf_counter() - t
    print(f"chain of 5,000 segments: {took:.2f} s")
    assert len(out) == 1 and len(out[0]) == 5001 and took < 3


def test_the_order_import_keeps_generous_caps():
    from gimel.services import dxf_import
    assert dxf_import.MAX_ENTITIES >= 50_000 and dxf_import.MAX_POINTS >= 1_000_000 and dxf_import.MAX_POLY_VERTICES >= 10_000
    assert drawings_service.MAX_DXF_ENTITIES < dxf_import.MAX_ENTITIES                    # the library is tighter
    plain = dxf_of(lambda m: [m.add_line((i, 0), (i, 1)) for i in range(5)])
    assert "error" not in dxf_import.parse_dxf(plain.decode()) or "Keine geschlossene" in dxf_import.parse_dxf(plain.decode())["error"]


def test_order_desk_dxf_refuses_too_many_open_segments_before_chaining():
    """Liegen viele Enden aufeinander, wäre das Verketten quadratisch: vorher abgelehnt."""
    from gimel.services.dxf_import import MAX_CHAIN_SEGMENTS, parse_dxf

    line = "0\nLINE\n8\n0\n10\n0\n20\n0\n11\n0\n21\n1\n"
    text = "0\nSECTION\n2\nENTITIES\n" + line * (MAX_CHAIN_SEGMENTS + 1) + "0\nENDSEC\n0\nEOF\n"
    t0 = time.perf_counter()
    r = parse_dxf(text)
    assert "offene Linienstücke" in r.get("error", "")
    assert time.perf_counter() - t0 < 5
