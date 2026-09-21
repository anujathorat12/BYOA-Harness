"""Outbound network guard for the http tool. Blocks SSRF targets before any connection is made."""
from __future__ import annotations

import asyncio
import ipaddress
import socket
import unicodedata
from urllib.parse import urlsplit


class EgressError(ValueError):
    pass


def parse_url(url: str) -> tuple[str, str, int, str]:
    """Return (scheme, canonical host, port, path). Raises EgressError on anything unusual."""
    if not isinstance(url, str) or len(url) > 2048:
        raise EgressError("url must be a string of at most 2048 chars")
    if any(ord(c) < 33 or ord(c) == 127 for c in url):
        raise EgressError("url contains whitespace or control characters")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise EgressError("only http/https are allowed")
    if parts.username or parts.password:
        raise EgressError("credentials in url are not allowed")
    if not parts.hostname:
        raise EgressError("url has no host")
    host = unicodedata.normalize("NFKC", parts.hostname).lower().rstrip(".")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as e:
        raise EgressError("invalid port") from e
    return parts.scheme, host, port, parts.path or "/"


def is_forbidden_ip(ip: ipaddress._BaseAddress) -> bool:
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved
            or ip.is_unspecified or (isinstance(ip, ipaddress.IPv4Address)
                                     and ip in ipaddress.ip_network("100.64.0.0/10")))


async def resolve_public(host: str, port: int, allow_private: bool) -> list[str]:
    """Resolve and verify every address is public. All-or-nothing, so a mixed answer is refused."""
    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as e:
        raise EgressError("host does not resolve") from e
    addrs = sorted({i[4][0] for i in infos})
    if not addrs:
        raise EgressError("host does not resolve")
    if not allow_private:
        for a in addrs:
            if is_forbidden_ip(ipaddress.ip_address(a.split("%")[0])):
                raise EgressError("destination address is not permitted")
    return addrs
