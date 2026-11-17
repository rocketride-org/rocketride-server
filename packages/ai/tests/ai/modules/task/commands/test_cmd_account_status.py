"""
Unit tests for AccountCommands.on_rrext_account_status.

The command reports whether the caller's own account can run pipelines: the
edition, the waitlist flag, the development team and whether the caller may
run on it, the compute token balance (hosted backend only) and the names of
the variables a run would see. The account backend is patched on the
singleton ``cmd_account`` imports; the multi-mixin __init__ is bypassed.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.account.models import AccountInfo
from ai.modules.task.commands import cmd_account
from ai.modules.task.commands.cmd_account import AccountCommands

_SECRET_VALUE = 'sk-canary-value-never-returned'


def _org(team_permissions=('task.control',)):
    return {
        'id': 'org-1',
        'name': "Ada's Workspace",
        'permissions': [],
        'teams': [{'id': 'team-1', 'name': 'Development', 'permissions': list(team_permissions)}],
    }


def _info(**overrides) -> AccountInfo:
    fields = {
        'auth': 'rr_caller-credential',
        'userToken': 'rr_user-token',
        'userId': 'user-1',
        'email': 'ada@example.test',
        'devTeam': 'team-1',
        'organization': _org(),
        'capabilities': ['saas'],
    }
    fields.update(overrides)
    return AccountInfo(**fields)


def _conn(info, *, can_run=True):
    conn = AccountCommands.__new__(AccountCommands)
    conn._account_info = info
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.debug_message = MagicMock()
    conn.verify_team_permission = MagicMock(
        side_effect=None if can_run else PermissionError("Permission 'task.control' denied for team 'team-1'")
    )
    # The waitlist gate the other account commands use must not apply here.
    conn.require_zitadel_auth = MagicMock(side_effect=PermissionError('Account is waitlisted'))
    return conn


@pytest.fixture
def backend(monkeypatch):
    """Patch the three account reads with a funded org and one saved model key."""
    reads = MagicMock()
    reads.check_spend = AsyncMock(return_value=None)
    reads.get_credit_balance = AsyncMock(return_value={'balances': {'tokens': 1500.0}})
    reads.get_merged_env = AsyncMock(
        return_value={'ROCKETRIDE_OPENAI_KEY': _SECRET_VALUE, 'ROCKETRIDE_ANOTHER': 'value-2'}
    )
    monkeypatch.setattr(cmd_account.account, 'check_spend', reads.check_spend)
    monkeypatch.setattr(cmd_account.account, 'get_credit_balance', reads.get_credit_balance)
    monkeypatch.setattr(cmd_account.account, 'get_merged_env', reads.get_merged_env)
    return reads


async def _status(conn, arguments=None):
    response = await AccountCommands.on_rrext_account_status(
        conn, {'command': 'rrext_account_status', 'arguments': arguments or {}}
    )
    return response['body']


@pytest.mark.asyncio
async def test_cloud_account_that_can_run(backend):
    conn = _conn(_info())

    body = await _status(conn)

    assert body == {
        'edition': 'cloud',
        'waitlisted': False,
        'organization': {'name': "Ada's Workspace"},
        'devTeam': {'selected': True, 'name': 'Development', 'canRun': True},
        'credits': {'applies': True, 'canSpend': True, 'tokens': 1500.0},
        'envKeys': ['ROCKETRIDE_ANOTHER', 'ROCKETRIDE_OPENAI_KEY'],
        'capabilities': ['saas'],
    }
    conn.verify_team_permission.assert_called_once_with('team-1', 'task.control')
    backend.check_spend.assert_awaited_once_with('org-1')
    backend.get_credit_balance.assert_awaited_once_with('org-1')
    backend.get_merged_env.assert_awaited_once_with(user_id='user-1', org_id='org-1', team_id='team-1')


@pytest.mark.asyncio
async def test_cloud_account_out_of_tokens(backend):
    backend.check_spend.return_value = 'Out of credits'
    backend.get_credit_balance.return_value = {'balances': {'tokens': 0.0}}

    body = await _status(_conn(_info()))

    assert body['credits'] == {'applies': True, 'canSpend': False, 'tokens': 0.0}


@pytest.mark.asyncio
async def test_a_missing_token_balance_counts_as_zero(backend):
    backend.get_credit_balance.return_value = {'balances': {}}

    body = await _status(_conn(_info()))

    assert body['credits'] == {'applies': True, 'canSpend': True, 'tokens': 0.0}


@pytest.mark.asyncio
async def test_waitlisted_account_reads_nothing_and_is_not_refused(backend):
    """The hosted backend gives a waitlisted account no team and no org. The
    command still answers (it never calls require_zitadel_auth) and reads no
    balance and no variables.
    """
    conn = _conn(_info(waitlisted=True, devTeam='', organization=None))

    body = await _status(conn)

    assert body == {
        'edition': 'cloud',
        'waitlisted': True,
        'organization': None,
        'devTeam': {'selected': False, 'name': '', 'canRun': False},
        'credits': {'applies': True, 'canSpend': None, 'tokens': None},
        'envKeys': None,
        'capabilities': ['saas'],
    }
    conn.require_zitadel_auth.assert_not_called()
    conn.verify_team_permission.assert_not_called()
    backend.check_spend.assert_not_awaited()
    backend.get_credit_balance.assert_not_awaited()
    backend.get_merged_env.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_development_team(backend):
    conn = _conn(_info(devTeam=''))

    body = await _status(conn)

    assert body['devTeam'] == {'selected': False, 'name': '', 'canRun': False}
    conn.verify_team_permission.assert_not_called()
    backend.get_merged_env.assert_awaited_once_with(user_id='user-1', org_id='org-1', team_id=None)


@pytest.mark.asyncio
async def test_team_without_run_permission(backend):
    body = await _status(_conn(_info(), can_run=False))

    assert body['devTeam'] == {'selected': True, 'name': 'Development', 'canRun': False}


@pytest.mark.asyncio
@pytest.mark.parametrize('failing', ['check_spend', 'get_credit_balance'])
async def test_a_failed_credit_read_gives_unknown_for_both(backend, failing):
    getattr(backend, failing).side_effect = RuntimeError('database unavailable')
    conn = _conn(_info())

    body = await _status(conn)

    assert body['credits'] == {'applies': True, 'canSpend': None, 'tokens': None}
    assert body['envKeys'] == ['ROCKETRIDE_ANOTHER', 'ROCKETRIDE_OPENAI_KEY']


@pytest.mark.asyncio
async def test_a_malformed_balance_gives_unknown(backend):
    backend.get_credit_balance.return_value = {'balances': {'tokens': 'lots'}}

    body = await _status(_conn(_info()))

    assert body['credits'] == {'applies': True, 'canSpend': None, 'tokens': None}


@pytest.mark.asyncio
async def test_a_failed_variable_read_gives_unknown(backend):
    backend.get_merged_env.side_effect = RuntimeError('cannot decrypt')

    body = await _status(_conn(_info()))

    assert body['envKeys'] is None
    assert body['credits']['canSpend'] is True


@pytest.mark.asyncio
async def test_cloud_account_with_no_org_reads_no_balance(backend):
    body = await _status(_conn(_info(organization=None, devTeam='')))

    assert body['organization'] is None
    assert body['credits'] == {'applies': True, 'canSpend': None, 'tokens': None}
    backend.check_spend.assert_not_awaited()


@pytest.mark.asyncio
async def test_self_hosted_engine(backend):
    """No 'saas' capability: compute tokens do not apply and are never read."""
    info = _info(capabilities=['oss'], devTeam='team-1')

    body = await _status(_conn(info))

    assert body['edition'] == 'self-hosted'
    assert body['credits'] == {'applies': False}
    assert body['capabilities'] == ['oss']
    backend.check_spend.assert_not_awaited()
    backend.get_credit_balance.assert_not_awaited()


@pytest.mark.asyncio
async def test_the_hosted_models_tag_is_passed_through(backend):
    body = await _status(_conn(_info(capabilities=['saas', 'hosted-models:openai'])))

    assert body['capabilities'] == ['saas', 'hosted-models:openai']


@pytest.mark.asyncio
async def test_arguments_cannot_point_at_another_account(backend):
    """Ids in the request are ignored; the answer is always the caller's own."""
    await _status(_conn(_info()), {'userId': 'user-2', 'orgId': 'org-2', 'teamId': 'team-2'})

    backend.check_spend.assert_awaited_once_with('org-1')
    backend.get_merged_env.assert_awaited_once_with(user_id='user-1', org_id='org-1', team_id='team-1')


@pytest.mark.asyncio
async def test_the_body_holds_no_credential_value_or_id(backend):
    text = json.dumps(await _status(_conn(_info())))

    for leaked in ('rr_caller-credential', 'rr_user-token', 'user-1', 'org-1', 'team-1', 'ada@example.test'):
        assert leaked not in text
    assert _SECRET_VALUE not in text
    assert 'value-2' not in text


@pytest.mark.asyncio
async def test_an_unauthenticated_connection_is_refused(backend):
    with pytest.raises(PermissionError, match='Not authenticated'):
        await _status(_conn(None))
