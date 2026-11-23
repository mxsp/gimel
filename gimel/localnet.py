"""Localnet-only ASGI guard.

Restricts HTTP and WebSocket access to loopback and private local-network
addresses (RFC 1918, IPv4/IPv6 link-local, IPv6 ULA) plus any explicitly
configured extra CIDRs (``GIMEL_LOCALNET_ALLOW``).

Also inspects common proxy forwarding headers (``X-Forwarded-For``,
``X-Real-IP``, ``CF-Connecting-IP``, ``True-Client-IP``, ``Forwarded``) and
rejects requests carrying a non-localnet forwarded client IP so the app cannot
accidentally be exposed to the public internet through a reverse proxy or
tunnel while ``localnet_only`` is enabled.
"""

from __future__ import annotations

import ipaddress
import re
from collections.abc import Iterable

IPNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network

LOCAL_NETWORKS: tuple[IPNetwork, ...] = (
    ipaddress.ip_network("127.0.0.0/8"),       # IPv4 loopback
    ipaddress.ip_network("10.0.0.0/8"),        # RFC 1918
    ipaddress.ip_network("172.16.0.0/12"),     # RFC 1918
    ipaddress.ip_network("192.168.0.0/16"),    # RFC 1918
    ipaddress.ip_network("169.254.0.0/16"),    # IPv4 link-local
    ipaddress.ip_network("::1/128"),           # IPv6 loopback
    ipaddress.ip_network("fc00::/7"),          # IPv6 unique local (ULA)
    ipaddress.ip_network("fe80::/10"),         # IPv6 link-local
)

_FORWARDED_FOR_RE = re.compile(r'for=(?:"?\[?([^;\s",\]]+)\]?"?)', re.IGNORECASE)
_FORWARD_HEADERS = (
    b"x-forwarded-for",
    b"x-real-ip",
    b"cf-connecting-ip",
    b"true-client-ip",
)


def parse_extra_networks(raw: str) -> tuple[IPNetwork, ...]:
    nets: list[IPNetwork] = []
    for item in (raw or "").split(","):
        token = item.strip()
        if not token:
            continue
        try:
            nets.append(ipaddress.ip_network(token, strict=False))
        except ValueError:
            continue
    return tuple(nets)


def _clean_ip(raw: str) -> str:
    val = (raw or "").strip().strip('"').strip("'")
    if not val:
        return ""
    if val.startswith("["):
        end = val.find("]")
        if end > 0:
            val = val[1:end]
    elif val.count(":") == 1 and "." in val:
        # IPv4:port
        val = val.split(":", 1)[0]
    # Strip IPv6 scope/zone identifier (e.g. fe80::1%eth0)
    if "%" in val:
        val = val.split("%", 1)[0]
    return val.strip()


def is_localnet_ip(raw: str | None, extra: Iterable[IPNetwork] = ()) -> bool:
    if not raw:
        return False
    cleaned = _clean_ip(raw)
    if not cleaned:
        return False
    if cleaned.lower() in ("testclient", "localhost"):
        return True
    try:
        addr = ipaddress.ip_address(cleaned)
    except ValueError:
        return False
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    for net in LOCAL_NETWORKS:
        if addr in net:
            return True
    for net in extra:
        if addr in net:
            return True
    return False


def _forwarded_ips(headers: Iterable[tuple[bytes, bytes]]) -> list[str]:
    ips: list[str] = []
    for k, v in headers:
        kl = k.lower()
        if kl in _FORWARD_HEADERS:
            text = v.decode("latin-1", errors="ignore")
            for part in text.split(","):
                part = part.strip()
                if part:
                    ips.append(part)
        elif kl == b"forwarded":
            text = v.decode("latin-1", errors="ignore")
            for match in _FORWARDED_FOR_RE.findall(text):
                if match and match.lower() != "unknown" and not match.startswith("_"):
                    ips.append(match)
    return ips


def request_is_localnet(scope: dict, extra: Iterable[IPNetwork] = ()) -> bool:
    client = scope.get("client")
    # Unix domain socket / in-process local transport has client=None.
    if client is not None:
        peer = client[0] if isinstance(client, (tuple, list)) and client else ""
        if not is_localnet_ip(str(peer), extra):
            return False
    for fwd in _forwarded_ips(scope.get("headers") or ()):
        if not is_localnet_ip(fwd, extra):
            return False
    return True


class LocalnetGuardMiddleware:
    """ASGI middleware: blocks non-localnet HTTP and WebSocket connections."""

    def __init__(self, app, *, enabled: bool = True, allow: str = ""):
        self.app = app
        self.enabled = enabled
        self.extra = parse_extra_networks(allow)

    async def __call__(self, scope, receive, send):
        if not self.enabled or scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        if request_is_localnet(scope, self.extra):
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = b"Forbidden: Gimel is restricted to local network (localnet) access only."
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                    (b"cache-control", b"no-store"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
