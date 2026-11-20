"""URL safety helpers shared across nodes (SSRF guards)."""

from __future__ import annotations

from .pinned_http import resolve_public_addresses


def validate_public_url(raw_url: str) -> str:
    """Return ``raw_url`` if it points at a public host; raise ``ValueError`` otherwise.

    Rejects non-http(s) URLs, URLs with userinfo or an invalid port, and hosts
    that resolve to any non-public address. The address rules are those of
    :func:`ai.common.utils.pinned_http.is_public_address` (non-global ranges
    including shared/CGNAT 100.64.0.0/10, multicast, and IPv6 forms that embed
    a private IPv4 address: mapped, 6to4, Teredo, NAT64), so this check and
    the pinned client cannot drift apart. Use this before following or
    returning URLs supplied by third-party APIs to prevent SSRF.

    This check alone leaves a DNS-rebinding gap if the URL is then fetched by
    a client that resolves the host again; to fetch, use
    ``resolve_public_addresses`` + ``pinned_session`` instead.
    """
    resolve_public_addresses(raw_url)
    return raw_url
