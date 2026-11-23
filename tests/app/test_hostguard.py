"""DNS-Rebinding: eine Anfrage mit fremdem Host-Namen erreicht keine Route."""

from __future__ import annotations

import pytest

from gimel.hostguard import HostGuardMiddleware, host_allowed, parse_allowed, split_host

LOCAL = ["127.0.0.1:8001", "127.0.0.1", "localhost:8001", "LOCALHOST", "[::1]:8001", "[::1]", "10.0.2.15:8001",
         "10.0.2.2:8001", "192.168.1.5", "testserver", "localhost.:8001", None, ""]
REBIND = ["evil.example", "evil.example:8001", "127.0.0.1.evil.example", "localhost.evil.example",
          "attacker.test:8001", "127.0.0.1@evil.example", "evil.example#127.0.0.1", "a b"]


@pytest.mark.parametrize("h", LOCAL)
def test_local_hosts_pass_without_any_setting(h):
    assert host_allowed(h)


@pytest.mark.parametrize("h", REBIND)
def test_foreign_names_are_refused(h):
    assert not host_allowed(h)


def test_setting_adds_names_wildcards_and_the_off_switch():
    extra = parse_allowed("Alef-API, *.fyreflysystems.de ,")
    assert extra == ("alef-api", "*.fyreflysystems.de")
    assert host_allowed("alef-api:8001", extra)
    assert host_allowed("api.fyreflysystems.de", extra)
    assert not host_allowed("fyreflysystems.de", extra)
    assert not host_allowed("evilfyreflysystems.de", extra)
    assert not host_allowed("evil.example", extra)
    assert host_allowed("evil.example", parse_allowed("*"))


def test_split_host():
    assert split_host("[2001:db8::1]:8001") == "2001:db8::1"
    assert split_host("Example.COM:80") == "example.com"


async def _call(mw, host, scope_type="http"):
    sent = []

    async def receive():
        return {"type": "http.request"}

    async def send(m):
        sent.append(m)

    headers = [] if host is None else [(b"host", host.encode())]
    await mw({"type": scope_type, "headers": headers}, receive, send)
    return sent


@pytest.mark.anyio
async def test_middleware_answers_400_and_never_calls_the_app():
    called = []

    async def app(scope, receive, send):
        called.append(1)

    mw = HostGuardMiddleware(app)
    sent = await _call(mw, "evil.example")
    assert sent[0]["status"] == 400 and not called
    await _call(mw, "127.0.0.1:8001")
    assert called == [1]
    ws = await _call(mw, "evil.example", "websocket")
    assert ws == [{"type": "websocket.close", "code": 1008}]


def test_whole_app_refuses_a_rebinding_host(client):
    assert client.get("/api/health", headers={"Host": "127.0.0.1:8001"}).status_code == 200
    assert client.get("/api/health", headers={"Host": "localhost:8001"}).status_code == 200
    r = client.get("/api/health", headers={"Host": "evil.example"})
    assert r.status_code == 400
    # auch mit gültiger Anmeldung (das Token steckt in den Client-Headern)
    assert client.get("/api/admin/orders", headers={"Host": "evil.example:8001"}).status_code == 400
    assert client.get("/app", headers={"Host": "evil.example"}).status_code == 400
