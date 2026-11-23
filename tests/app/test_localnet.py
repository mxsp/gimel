"""Localnet-only guard: blocks public peers and public forwarded proxy IPs."""

from __future__ import annotations

import pytest

from gimel.localnet import (
    LocalnetGuardMiddleware,
    is_localnet_ip,
    parse_extra_networks,
    request_is_localnet,
)

LOCAL_IPS = [
    "127.0.0.1",
    "127.0.0.42",
    "::1",
    "10.0.0.1",
    "10.255.255.254",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.1",
    "192.168.178.44",
    "169.254.10.20",
    "fc00::1",
    "fd12:3456:789a::1",
    "fe80::1%eth0",
    "::ffff:192.168.1.50",
    "::ffff:127.0.0.1",
    "testclient",
]

PUBLIC_IPS = [
    "8.8.8.8",
    "1.1.1.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.167.1.1",
    "203.0.113.5",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "not-an-ip",
    "",
]


@pytest.mark.parametrize("ip", LOCAL_IPS)
def test_local_ips_are_allowed(ip):
    assert is_localnet_ip(ip)


@pytest.mark.parametrize("ip", PUBLIC_IPS)
def test_public_and_invalid_ips_are_blocked(ip):
    assert not is_localnet_ip(ip)


def test_extra_allow_cidrs():
    extra = parse_extra_networks("100.64.0.0/10, 198.51.100.42")
    assert is_localnet_ip("100.100.5.9", extra)
    assert is_localnet_ip("198.51.100.42", extra)
    assert not is_localnet_ip("198.51.100.43", extra)


def test_forwarded_public_ip_is_rejected_even_from_local_peer():
    scope = {
        "type": "http",
        "client": ("127.0.0.1", 54321),
        "headers": [(b"x-forwarded-for", b"203.0.113.9, 10.0.0.2")],
    }
    assert not request_is_localnet(scope)

    cf_scope = {
        "type": "http",
        "client": ("192.168.1.1", 54321),
        "headers": [(b"cf-connecting-ip", b"1.1.1.1")],
    }
    assert not request_is_localnet(cf_scope)

    rfc7239_scope = {
        "type": "http",
        "client": ("127.0.0.1", 54321),
        "headers": [(b"forwarded", b'for=203.0.113.9;proto=https')],
    }
    assert not request_is_localnet(rfc7239_scope)

    lan_proxy_scope = {
        "type": "http",
        "client": ("127.0.0.1", 54321),
        "headers": [(b"x-forwarded-for", b"192.168.1.44")],
    }
    assert request_is_localnet(lan_proxy_scope)


async def _run_mw(mw, client, headers=(), scope_type="http"):
    sent = []

    async def receive():
        return {"type": "http.request"}

    async def send(msg):
        sent.append(msg)

    await mw(
        {"type": scope_type, "client": client, "headers": list(headers)},
        receive,
        send,
    )
    return sent


@pytest.mark.anyio
async def test_middleware_returns_403_and_closes_public_websockets():
    called = []

    async def app(scope, receive, send):
        called.append(scope["client"])

    mw = LocalnetGuardMiddleware(app, enabled=True)

    sent = await _run_mw(mw, ("203.0.113.5", 12345))
    assert sent[0]["status"] == 403
    assert not called

    ws_sent = await _run_mw(mw, ("203.0.113.5", 12345), scope_type="websocket")
    assert ws_sent == [{"type": "websocket.close", "code": 1008}]
    assert not called

    await _run_mw(mw, ("192.168.10.5", 12345))
    assert called == [("192.168.10.5", 12345)]


def test_app_enforces_localnet_only_by_default(client):
    r_ok = client.get("/api/version")
    assert r_ok.status_code == 200
    assert r_ok.json()["localnet_only"] is True

    r_blocked = client.get("/api/health", headers={"X-Forwarded-For": "8.8.8.8"})
    assert r_blocked.status_code == 403
    assert "localnet" in r_blocked.text.lower()

    r_lan = client.get("/api/health", headers={"X-Forwarded-For": "192.168.1.25"})
    assert r_lan.status_code == 200
