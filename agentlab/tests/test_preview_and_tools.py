"""Tests für Seiten-Vorschau, Artefakte, verbesserte Werkzeugaufrufe und neue Werkzeuge."""

from __future__ import annotations

import json

import pytest


def _invoke(client, chat_id: int, name: str, args: dict | None = None):
    return client.post(
        f"/api/agent/chats/{chat_id}/tools/{name}",
        json={"arguments": args or {}},
    )


@pytest.fixture()
def chat(client):
    data = client.post("/api/agent/chats", json={"write_mode": False}).json()
    yield data
    client.delete(f"/api/agent/chats/{data['id']}")


def test_artifact_tools_and_rest_crud(client, chat):
    # Artefakte funktionieren bewusst auch mit write_mode=False
    created = _invoke(client, chat["id"], "create_artifact", {
        "title": "Test-Webseite",
        "kind": "html",
        "content": "<!doctype html><h1>Hallo Gimel</h1>",
    })
    assert created.status_code == 200, created.text
    body = created.json()
    assert body["client_action"]["type"] == "open_preview"
    assert body["client_action"]["source"] == "artifact"
    aid = body["data"]["artifact"]["id"]

    # Patch via find/replace erhöht Version auf 2
    patched = _invoke(client, chat["id"], "update_artifact", {
        "artifact_id": aid,
        "find": "Hallo Gimel",
        "replace": "Hallo Agent Lab",
    })
    assert patched.status_code == 200, patched.text
    assert patched.json()["data"]["artifact"]["version"] == 2
    assert "Hallo Agent Lab" in patched.json()["client_action"]["content"]

    # list_artifacts & get_artifact
    listed = _invoke(client, chat["id"], "list_artifacts").json()
    assert any(a["id"] == aid for a in listed["data"]["artifacts"])
    fetched = _invoke(client, chat["id"], "get_artifact", {"artifact_id": aid}).json()
    assert "Hallo Agent Lab" in fetched["data"]["content"]

    # REST-Endpunkte & ChatDetail liefern Artefakte mit
    detail = client.get(f"/api/agent/chats/{chat['id']}").json()
    assert any(a["id"] == aid for a in detail["artifacts"])

    put_resp = client.put(
        f"/api/agent/chats/{chat['id']}/artifacts/{aid}",
        json={"content": "<!doctype html><h1>Manuell editiert</h1>"},
    )
    assert put_resp.status_code == 200
    assert put_resp.json()["version"] == 3

    del_resp = client.delete(f"/api/agent/chats/{chat['id']}/artifacts/{aid}")
    assert del_resp.status_code == 200
    assert client.get(f"/api/agent/chats/{chat['id']}/artifacts").json()["artifacts"] == []


def test_chart_and_report_generators_are_self_contained(client, chat):
    chart = _invoke(client, chat["id"], "generate_chart_artifact", {
        "title": "Durchsatz nach Werkstoff",
        "chart_type": "bar",
        "labels": ["EPDM", "NBR", "PTFE"],
        "series": [{"name": "Stück", "values": [120, 85, 42]}],
        "unit": "Stk",
        "kpis": [{"label": "Gesamt", "value": "247", "tone": "good"}],
    })
    assert chart.status_code == 200, chart.text
    html_doc = chart.json()["client_action"]["content"]
    assert "<!doctype html>" in html_doc.lower()
    assert "Durchsatz nach Werkstoff" in html_doc
    assert "https://cdn" not in html_doc  # 100% offline-fähig

    report = _invoke(client, chat["id"], "generate_report_html", {
        "title": "Schichtbericht",
        "kpis": [{"label": "Überfällig", "value": "2", "tone": "warn"}],
        "sections": [{
            "heading": "Lage",
            "callout": "Kein Maschinenausfall.",
            "bullets": ["Plotter 1 ausgelastet"],
            "table": {"columns": ["Station", "Last"], "rows": [["Plotter 1", "92%"]]},
        }],
    })
    assert report.status_code == 200, report.text
    rep_html = report.json()["client_action"]["content"]
    assert "Schichtbericht" in rep_html
    assert "Plotter 1" in rep_html


def test_html_attachment_preview_and_search_tools(client, chat):
    html_bytes = b"<!doctype html><html><body><h1>Demo-Seite</h1><p>Stichwort: Dichtung-42</p></body></html>"
    up = client.post(
        f"/api/agent/chats/{chat['id']}/attachments",
        files={"file": ("demo.html", html_bytes, "text/html")},
    )
    assert up.status_code == 201, up.text
    att_id = up.json()["id"]

    # Content-Endpunkt für die Seiten-Vorschau
    content = client.get(f"/api/agent/chats/{chat['id']}/attachments/{att_id}/content")
    assert content.status_code == 200, content.text
    assert "Dichtung-42" in content.json()["text"]

    # read_attachment & search_attachments
    read_res = _invoke(client, chat["id"], "read_attachment", {"attachment_id": att_id}).json()
    assert "Demo-Seite" in read_res["data"]["text"]

    search_res = _invoke(client, chat["id"], "search_attachments", {"query": "Dichtung-42"}).json()
    assert len(search_res["data"]["matches"]) == 1

    # open_preview akzeptiert Anhang, URL und lehnt javascript: ab
    prev_att = _invoke(client, chat["id"], "open_preview", {"attachment_id": att_id})
    assert prev_att.status_code == 200
    assert prev_att.json()["client_action"]["source"] == "attachment"

    prev_bad = _invoke(client, chat["id"], "open_preview", {"url": "javascript:alert(1)"})
    assert prev_bad.status_code == 422


def test_new_analysis_tools(client, chat):
    # parse_structured_data (CSV)
    csv_text = "Werkstoff;Menge;Preis\nEPDM;10;25,5\nEPDM;20;50,0\nNBR;5;15,0"
    parsed = _invoke(client, chat["id"], "parse_structured_data", {
        "text": csv_text,
        "group_by": "Werkstoff",
        "sum_column": "Menge",
    })
    assert parsed.status_code == 200, parsed.text
    data = parsed.json()["data"]
    assert data["row_count"] == 3
    assert data["stats"]["Menge"]["sum"] == pytest.approx(35.0)
    assert data["groups"][0]["group"] == "EPDM"
    assert data["groups"][0]["sum"] == pytest.approx(30.0)

    # convert_units
    conv = _invoke(client, chat["id"], "convert_units", {"value": 25.4, "from_unit": "mm", "to_unit": "in"})
    assert conv.status_code == 200
    assert conv.json()["data"]["result"] == pytest.approx(1.0)

    temp = _invoke(client, chat["id"], "convert_units", {"value": 100, "from_unit": "C", "to_unit": "F"})
    assert temp.status_code == 200
    assert temp.json()["data"]["result"] == pytest.approx(212.0)

    bad_conv = _invoke(client, chat["id"], "convert_units", {"value": 10, "from_unit": "mm", "to_unit": "kg"})
    assert bad_conv.status_code == 422

    # get_daily_briefing, compare_orders & discover_tools
    brief = _invoke(client, chat["id"], "get_daily_briefing")
    assert brief.status_code == 200, brief.text
    assert "counts" in brief.json()["data"]

    from gimel.db import SessionLocal
    from gimel.models import Order

    with SessionLocal() as db:
        nos = [o.no for o in db.query(Order).order_by(Order.id).limit(2).all()]
    if len(nos) >= 2:
        cmp_res = _invoke(client, chat["id"], "compare_orders", {"order_nos": nos})
        assert cmp_res.status_code == 200, cmp_res.text
        assert len(cmp_res.json()["data"]["orders"]) == 2

    disc = _invoke(client, chat["id"], "discover_tools", {"query": "artifact"})
    assert disc.status_code == 200
    names = {t["name"] for t in disc.json()["data"]["tools"]}
    assert "create_artifact" in names


def test_better_tool_calling_repair_coercion_and_think_splitter():
    from agentlab.llm import _ThinkSplitter
    from agentlab.tools import TOOLS, ToolError, coerce_and_validate_args, parse_tool_arguments

    # JSON-Reparatur (Code-Zaun + Trailing-Comma + umschließender Text)
    args, err = parse_tool_arguments('```json\n{"limit": "10",}\n```')
    assert err is None and args == {"limit": "10"}

    args2, err2 = parse_tool_arguments('Hier sind die Argumente: {"value": "12,5", "from_unit": "mm", "to_unit": "m"}')
    assert err2 is None and args2["value"] == "12,5"

    _, err_bad = parse_tool_arguments("kein json hier")
    assert err_bad is not None

    # Typ-Koerzion + Enum-Prüfung
    coerced = coerce_and_validate_args(TOOLS["convert_units"], {"value": "25,4", "from_unit": "mm", "to_unit": "in"})
    assert coerced["value"] == pytest.approx(25.4)

    with pytest.raises(ToolError, match="Erlaubt"):
        coerce_and_validate_args(TOOLS["create_artifact"], {"title": "X", "kind": "exe", "content": "hi"})

    with pytest.raises(ToolError, match="Pflichtparameter"):
        coerce_and_validate_args(TOOLS["create_artifact"], {"title": "X"})

    # Streaming <think>...</think>-Splitter über Chunk-Grenzen
    splitter = _ThinkSplitter()
    events = []
    for chunk in ("<thi", "nk>Schritt 1", " denken</th", "ink>Antwort!"):
        events.extend(splitter.feed(chunk))
    events.extend(splitter.flush())
    reasoning = "".join(t for k, t in events if k == "reasoning")
    answer = "".join(t for k, t in events if k == "text")
    assert reasoning == "Schritt 1 denken"
    assert answer == "Antwort!"


def test_runner_emits_step_duration_and_stops_repeat_loops(client, monkeypatch):
    import agentlab.runner as runner

    providers = client.get("/api/agent/providers").json()["providers"]
    pid = providers[0]["id"]
    client.put(f"/api/agent/providers/{pid}", json={"api_key": "sk-test-loop"})
    state = {"n": 0}

    async def fake(provider, **kwargs):
        state["n"] += 1
        if state["n"] <= 3:
            yield {"type": "tool_call_start", "index": 0, "id": f"c_{state['n']}", "name": "platform_overview"}
            yield {
                "type": "done", "content": "",
                "tool_calls": [{"id": f"c_{state['n']}", "type": "function",
                                "function": {"name": "platform_overview", "arguments": "{}"}}],
                "usage": {}, "finish_reason": "tool_calls",
            }
        else:
            yield {"type": "text", "text": "Fertig nach Schutz."}
            yield {"type": "done", "content": "Fertig nach Schutz.", "tool_calls": [],
                   "usage": {}, "finish_reason": "stop"}

    monkeypatch.setattr(runner, "stream_completion", fake)
    chat = client.post("/api/agent/chats", json={}).json()
    try:
        with client.stream("POST", f"/api/agent/chats/{chat['id']}/messages",
                           json={"content": "Prüfe alles"}) as r:
            assert r.status_code == 200
            raw = "".join(r.iter_text())
        assert "event: step" in raw
        assert "event: tool_call_start" in raw
        assert "duration_ms" in raw
        assert "identischen Argumenten" in raw
        assert "Fertig nach Schutz." in raw
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")
        client.delete(f"/api/agent/providers/{pid}/key")


def test_preview_csp_and_web_proxy_ssrf_guard(client):
    lab = client.get("/lab")
    assert lab.status_code == 200
    csp = lab.headers.get("content-security-policy", "")
    assert "frame-src 'self' blob: data: https: http:" in csp

    # Web-Preview-Proxy sperrt lokale/private Ziele (SSRF-Schutz)
    blocked = client.get("/api/agent/preview/web", params={"url": "http://127.0.0.1:8008/lab"})
    assert blocked.status_code == 422
    assert "gesperrt" in blocked.json()["detail"].lower() or "ports" in blocked.json()["detail"].lower()


def test_runner_supports_more_than_20_steps_and_budget_reached(client, monkeypatch):
    import json
    import agentlab.runner as runner

    providers = client.get("/api/agent/providers").json()["providers"]
    pid = providers[0]["id"]
    client.put(f"/api/agent/providers/{pid}", json={"api_key": "sk-test-steps"})
    state = {"n": 0}

    async def fake_many_steps(provider, **kwargs):
        state["n"] += 1
        # 24 verschiedene Werkzeugschritte + 1 finale Antwort = 25 Schritte (> altes 20er Limit)
        if state["n"] <= 24:
            arg_str = json.dumps({"query": f"q{state['n']}", "limit": 5})
            yield {
                "type": "done", "content": "",
                "tool_calls": [{"id": f"c_{state['n']}", "type": "function",
                                "function": {"name": "query_knowledge_graph", "arguments": arg_str}}],
                "usage": {}, "finish_reason": "tool_calls",
            }
        else:
            yield {"type": "text", "text": "25 Schritte sauber abgeschlossen."}
            yield {"type": "done", "content": "25 Schritte sauber abgeschlossen.", "tool_calls": [],
                   "usage": {}, "finish_reason": "stop"}

    monkeypatch.setattr(runner, "stream_completion", fake_many_steps)
    chat = client.post("/api/agent/chats", json={"kind": "orchestrator"}).json()
    try:
        with client.stream("POST", f"/api/agent/chats/{chat['id']}/messages",
                           json={"content": "Lange Kette", "max_steps": 30}) as r:
            assert r.status_code == 200
            raw = "".join(r.iter_text())
        assert '"step": 25' in raw
        assert '"max_steps": 30' in raw
        assert '"budget_reached": false' in raw
        assert "25 Schritte sauber abgeschlossen." in raw

        # Budget-Grenze testen (max_steps=2 → budget_reached=true + Synthese)
        state["n"] = 0
        with client.stream("POST", f"/api/agent/chats/{chat['id']}/messages",
                           json={"content": "Kurz begrenzt", "max_steps": 2}) as r2:
            assert r2.status_code == 200
            raw2 = "".join(r2.iter_text())
        assert '"budget_reached": true' in raw2
        assert '"synthesizing": true' in raw2
    finally:
        client.delete(f"/api/agent/chats/{chat['id']}")
        client.delete(f"/api/agent/providers/{pid}/key")


def test_knowledge_graph_http_endpoints(client):
    rebuilt = client.post("/api/agent/graph/rebuild")
    assert rebuilt.status_code == 200, rebuilt.text
    g = rebuilt.json()["graph"]
    assert "stats" in g and "hotspots" in g["stats"]

    nodes = g["nodes"]
    assert len(nodes) >= 2
    k0, k1 = nodes[0]["key"], nodes[1]["key"]

    # Manuelle Kante + Pfadsuche + Löschen
    edge_resp = client.post("/api/agent/graph/edges", json={
        "source_key": k0, "target_key": k1, "relation": "http_test_rel",
    })
    assert edge_resp.status_code == 201, edge_resp.text
    edge_id = edge_resp.json()["id"]

    path_resp = client.get(f"/api/agent/graph/path?source={k0}&target={k1}")
    assert path_resp.status_code == 200, path_resp.text
    assert path_resp.json()["found"] is True

    # Erkenntnis anlegen, bearbeiten, löschen
    ins_resp = client.post("/api/agent/graph/insights", json={
        "title": "HTTP Test Insight",
        "detail": "Details dazu",
        "linked_keys": [k0],
        "severity": "warning",
    })
    assert ins_resp.status_code == 201, ins_resp.text
    ins_key = ins_resp.json()["key"]

    upd_resp = client.put(f"/api/agent/graph/insights/{ins_key}", json={
        "title": "HTTP Test Insight V2",
        "detail": "Aktualisiert",
        "linked_keys": [k0, k1],
        "severity": "danger",
    })
    assert upd_resp.status_code == 200, upd_resp.text
    assert upd_resp.json()["label"] == "HTTP Test Insight V2"

    del_edge = client.delete(f"/api/agent/graph/edges/{edge_id}")
    assert del_edge.status_code == 200
    del_node = client.delete(f"/api/agent/graph/nodes/{ins_key}")
    assert del_node.status_code == 200
