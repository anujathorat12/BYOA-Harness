import ipaddress

import pytest

from byoa_harness.broker.egress import EgressError, is_forbidden_ip, parse_url, resolve_public


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.1.2.3", "192.168.0.1", "172.16.5.5", "169.254.169.254",
                                "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "::ffff:127.0.0.1", "fc00::1"])
def test_forbidden_addresses(ip):
    assert is_forbidden_ip(ipaddress.ip_address(ip))


def test_public_address_allowed():
    assert not is_forbidden_ip(ipaddress.ip_address("93.184.216.34"))


@pytest.mark.parametrize("url", ["file:///etc/passwd", "gopher://x", "http://user:pw@example.com/", "http:///x",
                                 "http://exa mple.com", "http://example.com:99999/", "ftp://example.com",
                                 "http://example.com/\nHost: evil", "x" * 3000])
def test_bad_urls_rejected(url):
    with pytest.raises(EgressError):
        parse_url(url)


def test_host_is_canonicalized():
    assert parse_url("HTTP://Example.COM./a?b=1")[:3] == ("http", "example.com", 80)


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "[::1]"])
async def test_loopback_forms_are_blocked_after_resolution(host):
    with pytest.raises(EgressError):
        await resolve_public(host.strip("[]"), 80, allow_private=False)


async def test_mixed_public_and_private_answer_is_refused(monkeypatch):
    import asyncio
    import socket

    async def fake(self, host, port, **kw):
        return [(socket.AF_INET, 1, 6, "", ("93.184.216.34", port)), (socket.AF_INET, 1, 6, "", ("10.0.0.5", port))]
    monkeypatch.setattr(asyncio.get_running_loop().__class__, "getaddrinfo", fake)
    with pytest.raises(EgressError):
        await resolve_public("rebind.example", 80, allow_private=False)


def test_ssl_context_keeps_verification_and_loads_extra_ca():
    import ssl

    import certifi

    from byoa_harness.broker.llm import build_ssl_context
    ctx = build_ssl_context(certifi.where())
    assert ctx.verify_mode == ssl.CERT_REQUIRED and ctx.check_hostname is True
