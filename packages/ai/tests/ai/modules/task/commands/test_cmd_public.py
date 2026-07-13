"""
Unit tests for ai.modules.task.commands.cmd_public.PublicCommands.

PublicCommands routes ``rrext_public_*`` commands that bypass the auth
gate. The probe handler is the replacement for the former
``auth { infoOnly: true }`` short-circuit and returns server metadata
(version, capabilities, platform, home app) without requiring a
prior auth handshake.

Tests bypass the mixin's no-op ``__init__`` via ``__new__`` and seed
only the attributes the handler under test reads.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from ai.account.models import RequestContext
from ai.modules.task.commands import cmd_public
from ai.modules.task.commands.cmd_public import PublicCommands


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ctx(account_info=None, conn_id='conn-1', source='local'):
    """Build a per-request RequestContext for handler calls."""
    return RequestContext(account_info=account_info, conn_id=conn_id, source=source)


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
    Probe returns version + capabilities + platform + home in a single
    response. The handler reads metadata from the module-level ``account``
    singleton and does not consult ``_authenticated``, so the same response
    is produced for authenticated and unauthenticated callers alike.

    Apps are no longer part of the probe — clients fetch them separately via
    ``rrext_public_catalog`` / ``rrext_account_me`` — so the response carries
    no ``apps`` key.
    """
    monkeypatch.setattr(cmd_public, 'getVersion', lambda: '9.9.9')
    # Probe reads capabilities + home app off the module-level account singleton.
    monkeypatch.setattr(cmd_public.account, 'capabilities', {'feature': True}, raising=False)
    monkeypatch.setattr(cmd_public.account, '_home_app', {'id': 'app-home'}, raising=False)

    conn = _make_conn()
    result = await PublicCommands.on_rrext_public_probe(conn, {'command': 'rrext_public_probe'}, _ctx())

    assert result['type'] == 'response'
    body = result['body']
    assert body['version'] == '9.9.9'
    assert body['capabilities'] == {'feature': True}
    assert 'platform' in body  # sys.platform is OS-dependent; existence is enough
    assert body['home'] == {'id': 'app-home'}
    assert 'apps' not in body


# ---------------------------------------------------------------------------
# Constructor (no-op)
# ---------------------------------------------------------------------------


def test_public_commands_init_is_noop():
    """The mixin's __init__ accepts the standard arguments without setting state."""
    instance = PublicCommands.__new__(PublicCommands)
    PublicCommands.__init__(instance, connection_id=1, server=None, transport=None)
