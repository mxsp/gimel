"""Die Gateway-Naht ohne Netz: Adapter, Ablehnung, Ausfall und LAN-Regel."""

from __future__ import annotations

from types import SimpleNamespace

import httpx
import pytest

from gimel.services import robot_gateway


class FakeResponse:
    def __init__(self, status_code: int = 200, body=None, text: str = ""):
        self.status_code = status_code
        self._body = body
        self.text = text

    def json(self):
        if self._body is None:
            raise ValueError("kein JSON")
        return self._body


class FakeClient:
    def __init__(self, response=None, error=None):
        self.response = response or FakeResponse()
        self.error = error
        self.calls: list[dict] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def post(self, url, json=None, headers=None):
        self.calls.append({"method": "POST", "url": url, "json": json, "headers": headers})
        if self.error is not None:
            raise self.error
        return self.response

    def get(self, url, headers=None):
        self.calls.append({"method": "GET", "url": url, "headers": headers})
        if self.error is not None:
            raise self.error
        return self.response


def gateway(**extra):
    base = dict(kind="http", base_url="http://gw.local", enabled=True, token="secret",
                endpoints={"command": "/robots/orders", "health": "/health"})
    base.update(extra)
    return SimpleNamespace(**base)


def use(monkeypatch, client: FakeClient) -> None:
    monkeypatch.setattr(robot_gateway, "CLIENT_FACTORY", lambda **_kw: client)


def test_an_http_order_is_sent_locally_with_its_token(monkeypatch):
    client = FakeClient(FakeResponse(202, {"message": "angenommen"}))
    use(monkeypatch, client)

    result = robot_gateway.deliver(gateway(), "command", {"type": "job.command"})

    assert result["ok"] is True and result["state"] == "accepted"
    assert result["message"] == "angenommen"
    call = client.calls[0]
    assert call["method"] == "POST"
    assert call["url"] == "http://gw.local/robots/orders"
    assert call["headers"]["Authorization"] == "Bearer secret"


def test_a_rejection_is_returned_as_visible_state(monkeypatch):
    client = FakeClient(FakeResponse(409, {"detail": "Auftrag belegt"}))
    use(monkeypatch, client)

    result = robot_gateway.deliver(gateway(), "command", {})

    assert result["ok"] is False and result["state"] == "rejected"
    assert result["message"] == "Auftrag belegt"
    assert result["http_status"] == 409


def test_an_unreachable_gateway_fails_instead_of_hanging(monkeypatch):
    use(monkeypatch, FakeClient(error=httpx.ConnectError("kein Netz")))

    result = robot_gateway.deliver(gateway(), "command", {})

    assert result["ok"] is False and result["state"] == "failed"
    assert "nicht erreichbar" in result["message"]


def test_a_disabled_gateway_is_not_called(monkeypatch):
    client = FakeClient()
    use(monkeypatch, client)

    result = robot_gateway.deliver(gateway(enabled=False), "command", {})

    assert result["state"] == "rejected"
    assert "ausgeschaltet" in result["message"]
    assert client.calls == []


def test_simulation_never_touches_the_network(monkeypatch):
    client = FakeClient()
    use(monkeypatch, client)

    assert robot_gateway.deliver(gateway(kind="sim"), "command", {})["ok"] is True
    assert robot_gateway.probe(gateway(kind="sim"))["ok"] is True
    assert client.calls == []


def test_probe_asks_only_for_health(monkeypatch):
    client = FakeClient(FakeResponse(204))
    use(monkeypatch, client)

    result = robot_gateway.probe(gateway())

    assert result["ok"] is True
    assert client.calls[0]["method"] == "GET"
    assert client.calls[0]["url"] == "http://gw.local/health"


def test_vda5050_is_refused_honestly(monkeypatch):
    client = FakeClient()
    use(monkeypatch, client)

    result = robot_gateway.deliver(gateway(kind="vda5050"), "command", {})

    assert result["ok"] is False and result["state"] == "rejected"
    assert "nicht verdrahtet" in result["message"]
    assert client.calls == []


@pytest.mark.parametrize("url", [
    "https://example.com/orders",
    "http://8.8.8.8/orders",
    "http://user:pass@gw.local/orders",
    "ftp://gw.local/orders",
])
def test_only_local_addresses_are_accepted(url):
    with pytest.raises(robot_gateway.GatewayError):
        robot_gateway.check_url(url)


def test_local_addresses_are_normalised():
    assert robot_gateway.check_url("http://gw.local/") == "http://gw.local"
    assert robot_gateway.check_url("http://192.168.1.5:8080") == "http://192.168.1.5:8080"
    assert robot_gateway.check_url("http://robot-gw") == "http://robot-gw"
