# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""The rung table (plan 8.3, C.34, C.35): owner, payer, ledger user and team, environment and watchers.

Every row of both tables, the way a request reaches it: a caller's name call
through ``TaskServer.resolve_target`` (the first table), and a run with no
caller through the trusted dispatch the scheduler and run-now take (the
second table). Each row asserts the control's owner, the paying org, the
ledger user and team (``TaskControl.billing``), the environment chain the
account was asked for, and who may watch the run.
"""

from __future__ import annotations

from typing import List, Tuple

import pytest

from ai.account.models import AccountInfo, resolve_run_permissions
from ai.modules.task import run_log
from ai.modules.task.task_control import (
    Attribution,
    DeploymentRef,
    caller_attribution,
    control_key,
    unattended_attribution,
)
from ai.modules.task.task_server_facade import start_server_task_as_team
from ai.modules.task.types import TaskError

from . import test_task_engine_sharing as sharing
from .test_task_engine_sharing import ADDRESS, _caller, _pipeline, _resolve, _server, _start

catalog = sharing.catalog
deployments = sharing.deployments
engines = sharing.engines
serving = sharing.serving

#: A pipeline whose prompt reads one placeholder: the control asks the account for its environment.
TONED = _pipeline(instructions=['${ROCKETRIDE_TONE}'])

#: The publications' artifact, the same pipeline.
NAME = 'acme.docBrain'


# =============================================================================
# HELPERS
# =============================================================================


@pytest.fixture
def env_asked(deployments, monkeypatch) -> List[Tuple[str, str, str]]:
    """Record every environment chain the account is asked for; each user brings their own value."""
    asked: List[Tuple[str, str, str]] = []

    async def merged(user_id, org_id, team_id):
        asked.append((user_id, org_id, team_id))
        return {'ROCKETRIDE_TONE': f'tone-of-{user_id or team_id or org_id}'}

    monkeypatch.setattr(deployments, 'get_merged_env', merged)
    return asked


def _member(user_id='user-a', *, order=('development', 'production'), org_admin=False) -> AccountInfo:
    """A member of Development and Production, home team first in ``order``."""
    account = _caller(user_id, dev_team=order[0], teams=tuple(order))
    account.teamOrder = list(order)
    if org_admin:
        account.organization['permissions'] = ['org.admin']
    return account


def _row(control) -> Tuple[str, str, str, str, str, str]:
    """The control's row: owner kind and id, payer, ledger user, ledger team, environment team."""
    return (control.owner_kind, control.owner_id, control.orgId, control.userId, control.teamId, control.env_team)


def _publish(deployments, slot, **kwargs) -> None:
    """Publish the toned pipeline to ``slot``."""
    deployments.deploy(slot, pipeline=_pipeline(instructions=['${ROCKETRIDE_TONE}']), **kwargs)


# =============================================================================
# THE FIRST TABLE: A CALLER IS PRESENT
# =============================================================================


@pytest.mark.asyncio
async def test_spec_is_the_callers_own_billed_to_their_home_team(catalog, engines, env_asked):
    """@spec | the caller | the caller's org | the caller | the home team | org, home team, user | the caller."""
    ts = _server()
    control = await _start(ts, TONED, user='user-a', team='development')

    assert _row(control) == ('user', 'user-a', 'org-1', 'user-a', 'development', 'development')
    assert control.caller_id == 'user-a' and control.rung == 'spec'
    assert env_asked == [('user-a', 'org-1', 'development')]
    assert control.env == {'ROCKETRIDE_TONE': 'tone-of-user-a'}
    assert resolve_run_permissions(_member('user-a'), control) and not resolve_run_permissions(
        _member('user-b'), control
    )


@pytest.mark.asyncio
async def test_me_is_the_callers_billed_to_the_stamp_with_the_current_home_team(
    catalog, engines, deployments, env_asked
):
    """@me | the caller | the caller's org | the caller | the billing stamp | org, home team, user | the caller.

    After a team reorder the run takes its environment from the CURRENT home
    team and its ledger team from the stamp; a private engine starts with
    that same one environment (the owner's chain, which is the caller's).
    """
    _publish(deployments, '=user/user-a', billing='stamp-team')
    deployments.artifacts[('org-1', NAME, 1)]['source'] = 'prompt_1'
    ts = _server()
    reordered = _member('user-a', order=('production', 'development'))

    control = await _resolve(ts, f'{NAME}.prompt_1', reordered, 'task.data')

    assert control.rung == 'me' and control.index_key == f'me.user-a.{NAME}.prompt_1'
    assert _row(control) == ('user', 'user-a', 'org-1', 'user-a', 'stamp-team', 'production')
    assert (control.billing.org_id, control.billing.user_id, control.billing.team_id) == (
        'org-1',
        'user-a',
        'stamp-team',
    )
    # One environment: the control's and the private engine's default are one chain
    engine = control.task
    assert not engine.shared and engine.engine_key.endswith(':user-a')
    assert await engine._env_source() == {'ROCKETRIDE_TONE': 'tone-of-user-a'}
    assert set(env_asked) == {('user-a', 'org-1', 'production')}
    assert not resolve_run_permissions(_member('user-b'), control)


@pytest.mark.asyncio
async def test_a_development_member_calling_production_is_a_row_on_production(catalog, engines, deployments, env_asked):
    """@<team> | the team (one control per caller) | the caller's org | the caller | that team | org, home team, user.

    The exit of C.34: a Development member calling Production's publication
    is a row on Production with the member as user, run with Development's
    variables; watchers are the members with task.monitor on Production.
    """
    _publish(deployments, '=team/production', billing='production')
    ts = _server()

    control = await _resolve(ts, f'@production/{ADDRESS}', _member('user-a'), 'task.data')

    assert control.rung == 'team' and control.index_key == control_key('team', 'production', ADDRESS, 'user-a')
    assert _row(control) == ('team', 'production', 'org-1', 'user-a', 'production', 'development')
    assert env_asked == [('user-a', 'org-1', 'development')]
    assert control.env == {'ROCKETRIDE_TONE': 'tone-of-user-a'}
    # The watchers: Production's members with task.monitor; nobody outside it
    assert 'task.monitor' in resolve_run_permissions(_member('user-z', order=('production',)), control)
    assert not resolve_run_permissions(_caller('user-x', dev_team='staging', teams=('staging',)), control)


@pytest.mark.asyncio
async def test_two_members_of_one_team_publication_get_two_controls_each_with_their_environment(
    catalog, engines, deployments, env_asked
):
    """One control per caller (plan 8.3): two members are two controls, two attributions, two environments.

    With C.25 the published shape's engine is shared and started as nobody:
    neither caller's environment is on it, each rides its own control.
    """
    _publish(deployments, '=team/production', billing='production')
    ts = _server()
    a = await _resolve(ts, ADDRESS, _member('user-a', order=('production',)), 'task.data')
    b = await _resolve(ts, ADDRESS, _member('user-b', order=('production',)), 'task.data')

    assert a is not b and a.task is b.task and a.task.shared
    assert (a.index_key, b.index_key) == (
        f'team.production.user-a.{ADDRESS}',
        f'team.production.user-b.{ADDRESS}',
    )
    assert (a.env, b.env) == ({'ROCKETRIDE_TONE': 'tone-of-user-a'}, {'ROCKETRIDE_TONE': 'tone-of-user-b'})
    assert (a.billing.user_id, b.billing.user_id) == ('user-a', 'user-b')
    assert await a.task._env_source() == {}
    # Each resolves their own again; nobody attaches to the other's
    assert await _resolve(ts, ADDRESS, _member('user-b', order=('production',)), 'task.data') is b


@pytest.mark.asyncio
async def test_the_org_rung_is_the_orgs_paid_by_it_with_no_ledger_team(catalog, engines, deployments, env_asked):
    """@org | the org (one control per caller) | the org | the caller | none | org, home team, user | org admins."""
    _publish(deployments, '=org/org-1')
    ts = _server()
    member = _member('user-a')

    control = await _resolve(ts, ADDRESS, member, 'task.data')

    assert control.rung == 'org' and control.index_key == f'org.org-1.user-a.{ADDRESS}'
    assert _row(control) == ('org', 'org-1', 'org-1', 'user-a', '', 'development')
    assert control.owner == '=org/org-1' and env_asked == [('user-a', 'org-1', 'development')]
    # The watchers are the org's admins; the caller uses their own control and nothing more
    assert 'task.monitor' in resolve_run_permissions(_member('user-z', org_admin=True), control)
    assert resolve_run_permissions(member, control) == ['task.data']
    assert not resolve_run_permissions(_member('user-b'), control)
    with pytest.raises(PermissionError):
        await _resolve(ts, ADDRESS, member, 'task.monitor')


@pytest.mark.asyncio
async def test_the_ladder_takes_the_org_between_the_teams_and_the_store(catalog, engines, deployments):
    """Plan 3.2: @me, then the teams, then @org, then @public; the first rung that holds the name answers."""
    deployments.publish(org='org-1')
    deployments.deploy('=org/org-1', version=2)
    ts = _server()
    assert (await _resolve(ts, ADDRESS, _member('user-a'), 'task.data')).rung == 'org'
    deployments.deploy('=team/production', version=3)
    assert (await _resolve(ts, ADDRESS, _member('user-b'), 'task.data')).rung == 'team'
    # Another org's member reaches the store only: the org rung is the active org's
    stranger = _caller('user-z', dev_team='team-z', teams=('team-z',), org='org-2', developer_id='globex')
    assert (await _resolve(ts, ADDRESS, stranger, 'task.data')).rung == 'public'
    with pytest.raises(TaskError) as err:
        await _resolve(ts, f'@org/{ADDRESS}', stranger, 'task.data')
    assert err.value.code == TaskError.NOT_REGISTERED and err.value.rungsTried == ['@org']


@pytest.mark.asyncio
async def test_public_is_the_callers_with_no_ledger_team_and_their_own_keys(catalog, engines, deployments, env_asked):
    """@public | the caller | the caller's org | the caller | none | org, home team, user | the caller.

    A caller whose keys are only at user level runs a @public pipe and the
    keys reach it: on the control and on every frame's caller stamp.
    """
    from ai.modules.task.caller_stamp import mint

    deployments.publish(org='org-1')
    deployments.artifacts[('org-1', NAME, 1)] = _pipeline(instructions=['${ROCKETRIDE_TONE}'])
    ts = _server()
    stranger = _caller('user-z', dev_team='team-z', teams=('team-z',), org='org-2', developer_id='globex')

    control = await _resolve(ts, ADDRESS, stranger, 'task.data')

    assert _row(control) == ('user', 'user-z', 'org-2', 'user-z', '', 'team-z')
    assert env_asked == [('user-z', 'org-2', 'team-z')]
    stamp = mint(stranger, control, correlation_id='c1', subcommand='open')
    assert stamp['env'] == {'ROCKETRIDE_TONE': 'tone-of-user-z'} and stamp['teamId'] == 'team-z'


# =============================================================================
# THE SECOND TABLE: NO CALLER (schedules, run-now, listeners)
# =============================================================================


async def _unattended(ts, deployments, audience, *, billing=''):
    """Fire ``audience``'s publication the way the scheduler does: no caller, the table's second row set."""
    _publish(deployments, audience, billing=billing)
    pipeline = await deployments.deployments_artifact('org-1', NAME, 1)
    pipeline['source'] = 'webhook_1'
    key = await start_server_task_as_team(
        ts,
        pipeline,
        attribution=unattended_attribution(audience, org_id='org-1', billing_stamp=billing),
        deployment=DeploymentRef(org_id='org-1', team_id=audience, project_id=NAME),
        trigger='schedule',
    )
    return ts.control_by_key(key)


@pytest.mark.asyncio
async def test_an_unattended_me_run_is_the_publishers_billed_to_the_stamp(catalog, engines, deployments, env_asked):
    """@me | the publisher | the publisher's org | the publisher | the billing stamp | org, the stamp, the publisher."""
    control = await _unattended(_server(), deployments, '=user/user-a', billing='stamp-team')

    assert _row(control) == ('user', 'user-a', 'org-1', 'user-a', 'stamp-team', 'stamp-team')
    assert control.caller_id == '' and control.rung == 'me' and control.trigger == 'schedule'
    assert env_asked == [('user-a', 'org-1', 'stamp-team')]
    assert control.owner == '=user/user-a' and run_log.scope_paths(control.owner)[0] == '=user/user-a/'


@pytest.mark.asyncio
async def test_a_scheduled_team_run_writes_a_row_with_the_team_and_no_user(catalog, engines, deployments, env_asked):
    """@<team> | the team | the org | none | that team | org, that team | members with task.monitor on that team."""
    ts = _server()
    control = await _unattended(ts, deployments, '=team/production', billing='production')

    assert _row(control) == ('team', 'production', 'org-1', '', 'production', 'production')
    assert (control.billing.org_id, control.billing.user_id, control.billing.team_id) == ('org-1', '', 'production')
    # A run with no caller borrows no user layer
    assert env_asked == [('', 'org-1', 'production')]
    assert control.index_key == f'team.production.-.{ADDRESS}'
    # ...and never answers a caller: a member's name call gets their own control
    mine = await _resolve(ts, ADDRESS, _member('user-a', order=('production',)), 'task.data')
    assert mine is not control and mine.caller_id == 'user-a'
    assert 'task.monitor' in resolve_run_permissions(_member('user-b', order=('production',)), control)


@pytest.mark.asyncio
async def test_an_org_schedule_bills_the_org_alone(catalog, engines, deployments, env_asked):
    """@org | the org | the org | none | none | org | org admins."""
    control = await _unattended(_server(), deployments, '=org/org-1')

    assert _row(control) == ('org', 'org-1', 'org-1', '', '', '')
    assert env_asked == [('', 'org-1', '')]
    assert run_log.scope_paths(control.owner)[0] == '=org/org-1/'
    assert resolve_run_permissions(_member('user-z', org_admin=True), control)
    assert not resolve_run_permissions(_member('user-a'), control)


@pytest.mark.asyncio
async def test_a_public_schedule_is_org_owned_and_logs_in_the_org_tree(catalog, engines, deployments, env_asked):
    """@public | the org | the org | none | none | org | org admins."""
    control = await _unattended(_server(), deployments, '@public')

    assert control.rung == 'public'
    assert _row(control) == ('org', 'org-1', 'org-1', '', '', '')
    assert env_asked == [('', 'org-1', '')]
    assert control.owner == '=org/org-1' and run_log.scope_paths(control.owner)[0] == '=org/org-1/'


# =============================================================================
# THE TABLE AS A FUNCTION
# =============================================================================


def test_the_caller_table_is_exactly_plan_8_3():
    """Each row of the first table, from ``caller_attribution``."""
    caller = _member('user-a')
    team = DeploymentRef('org-1', '=team/production', NAME)
    rows = {
        'spec': caller_attribution('spec', caller),
        'me': caller_attribution('me', caller, billing_stamp='stamp'),
        'team': caller_attribution('team', caller, deployment=team),
        'org': caller_attribution('org', caller),
        'public': caller_attribution('public', caller),
    }
    expected = {
        'spec': ('user', 'user-a', 'org-1', 'user-a', 'development'),
        'me': ('user', 'user-a', 'org-1', 'user-a', 'stamp'),
        'team': ('team', 'production', 'org-1', 'user-a', 'production'),
        'org': ('org', 'org-1', 'org-1', 'user-a', ''),
        'public': ('user', 'user-a', 'org-1', 'user-a', ''),
    }
    for rung, row in rows.items():
        assert isinstance(row, Attribution) and row.rung == rung
        assert (row.owner_kind, row.owner_id, row.org_id, row.user_id, row.team_id) == expected[rung], rung
        assert (row.env_team, row.caller_id) == ('development', 'user-a'), rung
    with pytest.raises(ValueError, match='billing team'):
        caller_attribution('me', caller)
    with pytest.raises(ValueError):
        caller_attribution('team', caller)


def test_the_unattended_table_is_exactly_plan_8_3():
    """Each row of the second table, from ``unattended_attribution``: no caller anywhere."""
    expected = {
        '=user/user-a': ('me', 'user', 'user-a', 'org-1', 'user-a', 'stamp', 'stamp'),
        '=team/production': ('team', 'team', 'production', 'org-1', '', 'production', 'production'),
        '=org/org-1': ('org', 'org', 'org-1', 'org-1', '', '', ''),
        '@public': ('public', 'org', 'org-1', 'org-1', '', '', ''),
    }
    for audience, row in expected.items():
        a = unattended_attribution(audience, org_id='org-1', billing_stamp='stamp')
        assert (a.rung, a.owner_kind, a.owner_id, a.org_id, a.user_id, a.team_id, a.env_team) == row, audience
        assert a.caller_id == ''
    with pytest.raises(ValueError, match='billing team'):
        unattended_attribution('=user/user-a', org_id='org-1')
    with pytest.raises(ValueError, match='another organization'):
        unattended_attribution('=org/org-2', org_id='org-1')


def test_the_index_key_names_the_caller_on_the_team_and_org_rungs_and_a_pinned_version():
    """Plan 7.5: ``<rung>.<ownerId>.<callerId>.<address>`` on team/org (``-`` for no caller), ``:<version>`` pinned."""
    assert control_key('spec', 'user-a', ADDRESS) == f'spec.user-a.{ADDRESS}'
    assert control_key('me', 'user-a', ADDRESS, 'user-a', 3) == f'me.user-a.{ADDRESS}:3'
    assert control_key('team', 'production', ADDRESS, 'user-a') == f'team.production.user-a.{ADDRESS}'
    assert control_key('org', 'org-1', ADDRESS) == f'org.org-1.-.{ADDRESS}'
    assert control_key('public', 'user-z', ADDRESS, 'user-z', 2) == f'public.user-z.{ADDRESS}:2'
    with pytest.raises(ValueError):
        control_key('spec', 'user-a', ADDRESS, version=1)
    with pytest.raises(ValueError):
        control_key('service', 'x', ADDRESS)


# =============================================================================
# DECLARED ROOTS AT THE START
# =============================================================================


@pytest.mark.asyncio
async def test_a_root_outside_the_owners_reach_refuses_the_start(catalog, engines):
    """Plan 2.5: the start resolves every declared root through the owner; one it cannot reach refuses."""
    ts = _server()
    spec = {**_pipeline(), 'roots': ['=team/team-1/kb']}
    with pytest.raises(PermissionError, match='outside'):
        await _start(ts, spec, user='user-a')
    assert list(ts._task_control) == []

    # The caller holds task.store on team-1: the root resolves and rides the control
    owner = _caller('user-a')
    owner.organization['teams'][0]['permissions'].append('task.store')
    request = {'command': 'execute', 'arguments': {'pipeline': spec}}
    result = await ts.start_task(
        request,
        None,
        client_id='user-a',
        user_id='user-a',
        team_id='team-1',
        org_id='org-1',
        developer_id='acme',
        owner_account=owner,
    )
    control = ts._task_control[result['token']]
    assert [(r.kind, r.ref_id, r.rest, r.physical) for r in control.roots] == [
        ('team', 'team-1', 'kb', 'teams/team-1/files')
    ]
