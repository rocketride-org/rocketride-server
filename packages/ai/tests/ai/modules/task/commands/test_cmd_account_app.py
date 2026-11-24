"""
Unit tests for ai.modules.task.commands.cmd_account.AccountCommands and
ai.modules.task.commands.cmd_app.AppCommands.

Both classes are thin DAP routers: every ``on_rrext_*`` method is a
one-liner that delegates to ``account.handle_account`` or
``account.handle_app``. Tests bypass the multi-mixin __init__ via
``__new__`` and patch ``account.handle_*`` so the delegation can be
observed. ``on_rrext_account_status`` is the exception: it answers itself,
from the account backend's reads, and its tests patch those reads.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.account.models import AccountInfo
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
# AppCommands — two delegation handlers
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    'handler_name',
    [
        'on_rrext_app',
        'on_rrext_deploy_app',
    ],
)
async def test_app_handler_delegates_to_account_handle_app(monkeypatch, handler_name):
    """Every app-family handler must call account.handle_app(self, request)."""
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


# ---------------------------------------------------------------------------
# AccountCommands — rrext_account_status answers for the caller itself
# ---------------------------------------------------------------------------


def _status_conn(monkeypatch, *, can_run=True, credit_error=False, **identity):
    """A connection with a funded hosted account; ``identity`` overrides AccountInfo fields."""
    fields = {
        'auth': 'rr_caller-credential',
        'userToken': 'rr_user-token',
        'userId': 'user-1',
        'email': 'ada@example.test',
        'devTeam': 'team-1',
        'organization': {
            'id': 'org-1',
            'name': 'Example Workspace',
            'permissions': [],
            'teams': [{'id': 'team-1', 'name': 'Development', 'permissions': ['task.control']}],
        },
        'capabilities': ['saas'],
        **identity,
    }
    reads = MagicMock()
    reads.check_spend = AsyncMock(return_value=None)
    reads.get_credit_balance = AsyncMock(side_effect=RuntimeError('db down') if credit_error else None)
    reads.get_credit_balance.return_value = {'balances': {'tokens': 1500.0}}
    reads.get_merged_env = AsyncMock(return_value={'ROCKETRIDE_OPENAI_KEY': 'sk-canary-never-returned'})
    for name in ('check_spend', 'get_credit_balance', 'get_merged_env'):
        monkeypatch.setattr(cmd_account.account, name, getattr(reads, name))

    conn = AccountCommands.__new__(AccountCommands)
    conn._account_info = AccountInfo(**fields)
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'body': body})
    conn.debug_message = MagicMock()
    conn.verify_team_permission = MagicMock(side_effect=None if can_run else PermissionError('denied'))
    conn.resolve_org_for_team = AsyncMock(return_value=fields['organization']['id'] if fields['organization'] else '')
    # The account commands' waitlist gate must not apply to this one.
    conn.require_zitadel_auth = MagicMock(side_effect=PermissionError('not active'))
    return conn, reads


@pytest.mark.asyncio
@pytest.mark.parametrize('edition', ['cloud', 'self-hosted'])
async def test_account_status_answers_for_the_caller_only(monkeypatch, edition):
    """Ids sent with the request are ignored, and the body holds no credential, value or id."""
    capabilities = ['saas'] if edition == 'cloud' else ['oss']
    conn, reads = _status_conn(monkeypatch, capabilities=capabilities)

    response = await AccountCommands.on_rrext_account_status(
        conn, {'arguments': {'userId': 'user-2', 'orgId': 'org-2', 'teamId': 'team-2'}}
    )
    body = response['body']

    assert body == {
        'edition': edition,
        'waitlisted': False,
        'organization': {'name': 'Example Workspace'},
        'devTeam': {'selected': True, 'name': 'Development', 'canRun': True},
        'credits': {'applies': True, 'canSpend': True, 'tokens': 1500.0} if edition == 'cloud' else {'applies': False},
        'envKeys': ['ROCKETRIDE_OPENAI_KEY'],
        'capabilities': capabilities,
    }
    reads.get_merged_env.assert_awaited_once_with(user_id='user-1', org_id='org-1', team_id='team-1')
    text = json.dumps(body)
    for leaked in (
        'rr_caller-credential',
        'rr_user-token',
        'user-1',
        'org-1',
        'team-1',
        'ada@example.test',
        'sk-canary',
    ):
        assert leaked not in text


@pytest.mark.asyncio
async def test_account_status_reads_the_org_that_owns_the_dev_team(monkeypatch):
    """Credits and variables come from the org a run would bill, as execute resolves it."""
    conn, reads = _status_conn(monkeypatch)
    conn.resolve_org_for_team = AsyncMock(return_value='org-9')

    await AccountCommands.on_rrext_account_status(conn, {'arguments': {}})

    conn.resolve_org_for_team.assert_awaited_once_with('team-1')
    reads.check_spend.assert_awaited_once_with('org-9')
    reads.get_merged_env.assert_awaited_once_with(user_id='user-1', org_id='org-9', team_id='team-1')


@pytest.mark.asyncio
async def test_account_status_ignores_a_dev_team_the_caller_cannot_run_on(monkeypatch):
    """A stale devTeam in another org picks neither the org that is read nor a team layer."""
    conn, reads = _status_conn(monkeypatch, can_run=False, devTeam='team-x')
    conn.resolve_org_for_team = AsyncMock(return_value='org-9')

    body = (await AccountCommands.on_rrext_account_status(conn, {'arguments': {}}))['body']

    assert body['devTeam'] == {'selected': True, 'name': '', 'canRun': False}
    conn.resolve_org_for_team.assert_not_awaited()
    reads.check_spend.assert_awaited_once_with('org-1')
    reads.get_merged_env.assert_awaited_once_with(user_id='user-1', org_id='org-1', team_id=None)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ('identity', 'credit_error', 'credits', 'env_keys'),
    [
        # Not active: nothing is read, and the account commands' gate is not used.
        (
            {'waitlisted': True, 'devTeam': '', 'organization': None},
            False,
            {'applies': True, 'canSpend': None, 'tokens': None, 'reason': 'waitlisted'},
            None,
        ),
        (
            {'devTeam': '', 'organization': None},
            False,
            {'applies': True, 'canSpend': None, 'tokens': None, 'reason': 'noOrganization'},
            ['ROCKETRIDE_OPENAI_KEY'],
        ),
        (
            {},
            True,
            {'applies': True, 'canSpend': None, 'tokens': None, 'reason': 'readFailed'},
            ['ROCKETRIDE_OPENAI_KEY'],
        ),
    ],
)
async def test_account_status_says_why_credits_are_unknown(monkeypatch, identity, credit_error, credits, env_keys):
    conn, reads = _status_conn(monkeypatch, credit_error=credit_error, **identity)

    body = (await AccountCommands.on_rrext_account_status(conn, {'arguments': {}}))['body']

    assert body['credits'] == credits
    assert body['envKeys'] == env_keys
    conn.require_zitadel_auth.assert_not_called()
    if identity.get('waitlisted'):
        assert body['devTeam'] == {'selected': False, 'name': '', 'canRun': False}
        reads.check_spend.assert_not_awaited()
        reads.get_merged_env.assert_not_awaited()
