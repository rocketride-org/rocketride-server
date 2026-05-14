"""
Unit tests for ai.modules.task.commands.cmd_account.AccountCommands and
ai.modules.task.commands.cmd_app.AppCommands.

Both classes are thin DAP routers: every ``on_rrext_*`` method is a
one-liner that delegates to ``account.handle_account`` or
``account.handle_app``. Tests bypass the multi-mixin __init__ via
``__new__`` and patch ``account.handle_*`` so the delegation can be
observed.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from ai.modules.task.commands import cmd_account, cmd_app
from ai.modules.task.commands.cmd_account import AccountCommands
from ai.modules.task.commands.cmd_app import AppCommands


# ---------------------------------------------------------------------------
# AccountCommands — six delegation handlers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'handler_name',
    [
        'on_rrext_account_me',
        'on_rrext_account_keys',
        'on_rrext_account_org',
        'on_rrext_account_members',
        'on_rrext_account_teams',
        'on_rrext_account_billing',
    ],
)
async def test_account_handler_delegates_to_account_handle_account(monkeypatch, handler_name):
    """Every rrext_account_* handler must call account.handle_account(self, request)."""
    fake_handler = AsyncMock(return_value={'type': 'response', 'body': {'ok': True}})
    monkeypatch.setattr(cmd_account.account, 'handle_account', fake_handler)

    conn = AccountCommands.__new__(AccountCommands)
    request = {'command': handler_name.replace('on_', ''), 'arguments': {'x': 1}}

    result = await getattr(AccountCommands, handler_name)(conn, request)

    fake_handler.assert_awaited_once_with(conn, request)
    assert result == {'type': 'response', 'body': {'ok': True}}


# ---------------------------------------------------------------------------
# AppCommands — five delegation handlers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'handler_name',
    [
        'on_rrext_app_developer',
        'on_rrext_app_submission',
        'on_rrext_app_catalog',
        'on_rrext_app_admin',
        'on_rrext_app_pricing',
    ],
)
async def test_app_handler_delegates_to_account_handle_app(monkeypatch, handler_name):
    """Every rrext_app_* handler must call account.handle_app(self, request)."""
    fake_handler = AsyncMock(return_value={'type': 'response', 'body': {'ok': True}})
    monkeypatch.setattr(cmd_app.account, 'handle_app', fake_handler)

    conn = AppCommands.__new__(AppCommands)
    request = {'command': handler_name.replace('on_', ''), 'arguments': {'y': 2}}

    result = await getattr(AppCommands, handler_name)(conn, request)

    fake_handler.assert_awaited_once_with(conn, request)
    assert result == {'type': 'response', 'body': {'ok': True}}


# ---------------------------------------------------------------------------
# Constructors are no-ops
# ---------------------------------------------------------------------------


def test_account_commands_init_is_noop():
    """AccountCommands.__init__ accepts the standard args and does nothing."""
    instance = AccountCommands.__new__(AccountCommands)
    AccountCommands.__init__(instance, connection_id=1, server=None, transport=None)
    # No attributes are added — the mixin is intentionally stateless.


def test_app_commands_init_is_noop():
    """AppCommands.__init__ accepts the standard args and does nothing."""
    instance = AppCommands.__new__(AppCommands)
    AppCommands.__init__(instance, connection_id=1, server=None, transport=None)
