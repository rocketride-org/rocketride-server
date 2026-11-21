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
    # The wire protocol major rides beside the version: it decides compatibility
    assert body['protocol'] == 2
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
async def test_on_rrext_public_probe_includes_posthog_config_when_configured(monkeypatch):
    """
    A configured RR_POSTHOG_PUBLISHABLE_KEY is advertised on the probe with
    its host, so browsers initialise telemetry with the key matching this
    environment instead of a value baked into app bundles. The host defaults
    to the managed analytics proxy when RR_POSTHOG_HOST is unset.
    """
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')
    monkeypatch.setenv('RR_POSTHOG_PUBLISHABLE_KEY', 'phc_test_probe')
    monkeypatch.delenv('RR_POSTHOG_HOST', raising=False)

    account = SimpleNamespace(capabilities=[], get_public_apps=AsyncMock(return_value=[]))
    server = MagicMock()
    server._server = SimpleNamespace(account=account)

    conn = _make_conn(server=server)
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'})

    assert result['body']['posthogPublishableKey'] == 'phc_test_probe'
    assert result['body']['posthogHost'] == 'https://e.rocketride.ai'


@pytest.mark.asyncio
async def test_on_rrext_public_probe_posthog_host_passes_through_when_configured(monkeypatch):
    """A configured RR_POSTHOG_HOST overrides the default proxy address."""
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')
    monkeypatch.setenv('RR_POSTHOG_PUBLISHABLE_KEY', 'phc_test_probe')
    monkeypatch.setenv('RR_POSTHOG_HOST', 'https://e.staging.example.test')

    account = SimpleNamespace(capabilities=[], get_public_apps=AsyncMock(return_value=[]))
    server = MagicMock()
    server._server = SimpleNamespace(account=account)

    conn = _make_conn(server=server)
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'})

    assert result['body']['posthogHost'] == 'https://e.staging.example.test'


@pytest.mark.asyncio
async def test_on_rrext_public_probe_omits_posthog_when_unset(monkeypatch):
    """
    Servers without telemetry (OSS, unset env) omit both fields entirely —
    telemetry is structurally off, and the host is meaningless without a key.
    """
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')
    monkeypatch.delenv('RR_POSTHOG_PUBLISHABLE_KEY', raising=False)
    monkeypatch.setenv('RR_POSTHOG_HOST', 'https://e.rocketride.ai')

    account = SimpleNamespace(capabilities=[], get_public_apps=AsyncMock(return_value=[]))
    server = MagicMock()
    server._server = SimpleNamespace(account=account)

    conn = _make_conn(server=server)
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'})

    assert 'posthogPublishableKey' not in result['body']
    assert 'posthogHost' not in result['body']


@pytest.mark.asyncio
async def test_on_rrext_public_probe_refuses_non_project_posthog_key(monkeypatch):
    """
    A misconfigured personal/server key (phx_*, or any non-phc_ value) must
    never reach every browser — the probe omits both fields rather than
    publishing a credential.
    """
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')
    monkeypatch.setenv('RR_POSTHOG_PUBLISHABLE_KEY', 'phx_personal_api_key')

    account = SimpleNamespace(capabilities=[], get_public_apps=AsyncMock(return_value=[]))
    server = MagicMock()
    server._server = SimpleNamespace(account=account)

    conn = _make_conn(server=server)
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'})

    assert 'posthogPublishableKey' not in result['body']
    assert 'posthogHost' not in result['body']


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


# ---------------------------------------------------------------------------
# on_rrext_public_catalog — kind 'pipe' (the pipe picker's feed, plan 3.6)
# ---------------------------------------------------------------------------


def _catalog_conn(account_info=None):
    """A PublicCommands instance with a caller and both response builders seeded."""
    conn = _make_conn()
    conn._account_info = account_info
    conn.build_error = MagicMock(side_effect=lambda req, message: {'type': 'error', 'message': message})
    return conn


def _catalog_request(**arguments):
    """One rrext_public_catalog request."""
    return {'command': 'rrext_public_catalog', 'arguments': arguments}


@pytest.mark.asyncio
async def test_catalog_without_a_kind_is_the_app_catalog(monkeypatch):
    """No kind (and kind 'app') delegates to the account layer unchanged."""
    handle_public = AsyncMock(return_value={'type': 'response', 'body': {'apps': []}})
    monkeypatch.setattr(cmd_public.account, 'handle_public', handle_public, raising=False)
    conn = _catalog_conn()

    await PublicCommands.on_rrext_public_catalog(conn, _catalog_request())
    await PublicCommands.on_rrext_public_catalog(conn, _catalog_request(kind='app'))

    assert handle_public.await_count == 2


@pytest.mark.asyncio
async def test_catalog_refuses_an_unknown_kind():
    """A kind the verb does not browse is refused by name."""
    result = await PublicCommands.on_rrext_public_catalog(_catalog_conn(), _catalog_request(kind='node'))
    assert result['type'] == 'error' and "'node'" in result['message']


@pytest.mark.asyncio
async def test_pipe_catalog_needs_a_signed_in_caller(monkeypatch):
    """An anonymous connection lists no pipes and searches no store."""
    own = AsyncMock()
    monkeypatch.setattr('ai.account.pipe_deploy.own_pipe_publications', own)
    for args in ({'kind': 'pipe'}, {'kind': 'pipe', 'search': 'doc'}):
        result = await PublicCommands.on_rrext_public_catalog(_catalog_conn(), _catalog_request(**args))
        assert result == {'type': 'error', 'message': 'Sign in to list pipelines'}
    own.assert_not_awaited()


@pytest.mark.asyncio
async def test_pipe_catalog_lists_own_publications_without_a_term_and_searches_the_store_with_one(monkeypatch):
    """Blank search = the caller's own rungs; a term = the store search; the page is sliced here."""
    caller = SimpleNamespace(userId='u-1')
    own_rows = [{'id': f'acme.p{i}', 'rung': 'team'} for i in range(5)]
    own = AsyncMock(return_value=own_rows)
    search = AsyncMock(return_value=[{'id': 'zeta.docBrain', 'rung': 'public'}])
    monkeypatch.setattr('ai.account.pipe_deploy.own_pipe_publications', own)
    monkeypatch.setattr('ai.account.pipe_deploy.search_public_pipes', search)
    conn = _catalog_conn(caller)

    page = await PublicCommands.on_rrext_public_catalog(
        conn, _catalog_request(kind='pipe', search='  ', offset=1, limit=2)
    )
    assert page['body'] == {'apps': own_rows[1:3], 'total': 5, 'offset': 1, 'limit': 2}
    own.assert_awaited_once_with(cmd_public.account, caller)
    search.assert_not_awaited()

    found = await PublicCommands.on_rrext_public_catalog(conn, _catalog_request(kind='pipe', search='doc'))
    assert found['body'] == {'apps': [{'id': 'zeta.docBrain', 'rung': 'public'}], 'total': 1, 'offset': 0, 'limit': 20}
    search.assert_awaited_once_with(cmd_public.account, caller, 'doc')


@pytest.mark.asyncio
async def test_pipe_catalog_refuses_malformed_arguments():
    """A non-string term and non-integer paging are refused by name."""
    conn = _catalog_conn(SimpleNamespace(userId='u-1'))
    bad_search = await PublicCommands.on_rrext_public_catalog(conn, _catalog_request(kind='pipe', search=['doc']))
    assert bad_search['message'] == 'search must be a string'
    bad_page = await PublicCommands.on_rrext_public_catalog(conn, _catalog_request(kind='pipe', limit='many'))
    assert bad_page['message'] == 'offset and limit must be integers'
