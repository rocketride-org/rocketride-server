"""
Unit tests for ai.modules.task.commands.cmd_public.PublicCommands.

PublicCommands routes ``rrext_public_*`` commands that bypass the auth
gate. The probe handler is the replacement for the former
``auth { infoOnly: true }`` short-circuit and returns server metadata
(version, capabilities, platform, public apps) without requiring a
prior auth handshake.

Tests bypass the mixin's no-op ``__init__`` via ``__new__`` and seed
only the attributes the handler under test reads.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task.commands import cmd_public
from ai.modules.task.commands.cmd_public import PublicCommands


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_conn(*, server=None):
    """
    Build a PublicCommands instance with __init__ bypassed.

    Only ``_server`` and the ``build_response`` helper are seeded — the
    probe handler does not touch any other attribute.

    Args:
        server: optional TaskServer-shaped stub. A default ``MagicMock`` is
            used when None is passed.

    Returns:
        PublicCommands: a test-ready instance whose interactions can be
            inspected on its attributes.
    """
    conn = PublicCommands.__new__(PublicCommands)
    conn._server = server or MagicMock()
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    return conn


# ---------------------------------------------------------------------------
# on_rrext_public_probe
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_on_rrext_public_probe_returns_server_info_without_authenticating(monkeypatch):
    """
    Probe returns version + capabilities + platform + public apps in a single
    response. The handler does not consult ``_authenticated``, so the same
    response is produced for authenticated and unauthenticated callers alike.
    """
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')

    account = SimpleNamespace(
        capabilities={'feature': True},
        get_public_apps=AsyncMock(return_value=[{'id': 'app-1'}]),
    )
    server = MagicMock()
    server._server = SimpleNamespace(account=account)

    conn = _make_conn(server=server)
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'})

    assert result['type'] == 'response'
    body = result['body']
    assert body['version'] == '9.9.9'
    assert body['capabilities'] == {'feature': True}
    assert 'platform' in body  # sys.platform is OS-dependent; existence is enough
    assert body['apps'] == [{'id': 'app-1'}]
    account.get_public_apps.assert_awaited_once()


@pytest.mark.asyncio
async def test_on_rrext_public_probe_includes_stripe_key_when_configured(monkeypatch):
    """
    A configured RR_STRIPE_PUBLISHABLE_KEY is advertised on the probe so
    clients can initialise Stripe with the key matching this server's
    Stripe account instead of a value baked into their bundles.
    """
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')
    monkeypatch.setenv('RR_STRIPE_PUBLISHABLE_KEY', 'pk_test_probe')

    account = SimpleNamespace(capabilities=[], get_public_apps=AsyncMock(return_value=[]))
    server = MagicMock()
    server._server = SimpleNamespace(account=account)

    conn = _make_conn(server=server)
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'})

    assert result['body']['stripePublishableKey'] == 'pk_test_probe'


@pytest.mark.asyncio
async def test_on_rrext_public_probe_omits_stripe_key_when_unset(monkeypatch):
    """
    Servers without billing (OSS, unset env) omit the field entirely rather
    than sending an empty string.
    """
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')
    monkeypatch.delenv('RR_STRIPE_PUBLISHABLE_KEY', raising=False)

    account = SimpleNamespace(capabilities=[], get_public_apps=AsyncMock(return_value=[]))
    server = MagicMock()
    server._server = SimpleNamespace(account=account)

    conn = _make_conn(server=server)
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'})

    assert 'stripePublishableKey' not in result['body']


@pytest.mark.asyncio
async def test_on_rrext_public_probe_endpoints_default_to_origin(monkeypatch):
    """
    The endpoints block is ALWAYS present with BOTH keys — clients never
    branch on absence. With neither RR_*_ORIGIN variable set, both values
    are the literal 'origin' ("the address you probed me at").
    """
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')
    monkeypatch.delenv('RR_BACKEND_ORIGIN', raising=False)
    monkeypatch.delenv('RR_FRONTEND_ORIGIN', raising=False)

    account = SimpleNamespace(capabilities=[], get_public_apps=AsyncMock(return_value=[]))
    server = MagicMock()
    server._server = SimpleNamespace(account=account)

    conn = _make_conn(server=server)
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'})

    assert result['body']['endpoints'] == {'api': 'origin', 'ui': 'origin'}


@pytest.mark.asyncio
async def test_on_rrext_public_probe_endpoints_carry_configured_origins(monkeypatch):
    """
    Configured RR_BACKEND_ORIGIN / RR_FRONTEND_ORIGIN pass through as
    absolute URLs — the CDN-split shape where the API lives somewhere other
    than the address the UI is served from.
    """
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')
    monkeypatch.setenv('RR_BACKEND_ORIGIN', 'https://api.example.test')
    monkeypatch.setenv('RR_FRONTEND_ORIGIN', 'https://app.example.test')

    account = SimpleNamespace(capabilities=[], get_public_apps=AsyncMock(return_value=[]))
    server = MagicMock()
    server._server = SimpleNamespace(account=account)

    conn = _make_conn(server=server)
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'})

    assert result['body']['endpoints'] == {
        'api': 'https://api.example.test',
        'ui': 'https://app.example.test',
    }


# ---------------------------------------------------------------------------
# Constructor (no-op)
# ---------------------------------------------------------------------------


def test_public_commands_init_is_noop():
    """The mixin's __init__ accepts the standard arguments without setting state."""
    instance = PublicCommands.__new__(PublicCommands)
    PublicCommands.__init__(instance, connection_id=1, server=None, transport=None)
