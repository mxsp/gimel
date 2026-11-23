"""The ERP seam says what is there. Without an adapter nothing pretends to be SAP."""

from __future__ import annotations

from gimel.config import get_settings


def test_without_an_adapter_health_says_not_configured(client):
    body = client.get("/api/integration/health").json()
    assert body["configured"] is False
    assert body["reachable"] is False
    assert "latency_ms" not in body


def test_without_an_adapter_reads_are_empty_not_invented(client):
    for path in ("/api/integration/stock", "/api/integration/plates"):
        assert client.get(path).json() == {"configured": False, "items": []}


def test_without_an_adapter_a_sync_is_refused(client):
    r = client.post("/api/integration/sync", json={})
    assert r.status_code == 503
    assert "Keine ERP-Anbindung" in r.json()["detail"]


def test_a_configured_adapter_reports_itself_and_does_not_claim_a_connection(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "sap_base_url", "http://sap.example.invalid")
    body = client.get("/api/integration/health").json()
    assert body["mode"] == "sap-rest"
    assert body["configured"] is True
    assert body["reachable"] is False


def test_the_unbuilt_adapter_answers_501_instead_of_crashing(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "sap_base_url", "http://sap.example.invalid")
    assert client.get("/api/integration/stock").status_code == 501
    assert client.post("/api/integration/sync", json={}).status_code == 501
