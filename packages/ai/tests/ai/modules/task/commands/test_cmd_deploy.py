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

"""cmd_deploy handler tests — the command-layer contract.

The account module is stubbed (its behavior is contract-tested in
test_deployment_backend); these tests pin what the COMMAND layer owns:
per-subcommand team-permission checks against the ADDRESSED team, org/actor
resolution, scheduler resyncs after every mutation, audit calls, and the
preview evaluator.
"""

from types import MethodType, SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import ai.modules.task.commands.cmd_deploy as cmd_mod
from ai.modules.task.commands.cmd_deploy import DeployCommands
from ai.account.models import resolve_team_permissions


# ============================================================================
# Harness
# ============================================================================


def _account_info(*, teams=None, default_team='team-1', user_id='user-1'):
    """AccountInfo-shaped stub with an organization and teams."""
    return SimpleNamespace(
        userId=user_id,
        displayName='Rod C',
        email='rod@example.com',
        defaultTeam=default_team,
        organization={
            'id': 'org-1',
            'name': 'Acme',
            'permissions': [],
            'teams': teams
            if teams is not None
            else [{'id': 'team-1', 'name': 'Development', 'permissions': ['task.control', 'task.monitor']}],
        },
        sysPermissions=[],
    )


def _make_conn(account_info, scheduler=None):
    """A DeployCommands instance with __init__ bypassed, real permission math."""
    conn = DeployCommands.__new__(DeployCommands)
    DeployCommands.__init__(conn, 1, MagicMock(), MagicMock())
    conn._account_info = account_info
    conn.build_response = MagicMock(side_effect=lambda req, body=None: {'type': 'response', 'body': body})
    conn.debug_message = MagicMock()

    # Real team-permission semantics (mirrors TaskConn.verify_team_permission):
    # resolve against the ADDRESSED team, uniform denial.
    def verify_team_permission(self, team_id, perm):
        if perm not in resolve_team_permissions(self._account_info, team_id):
            raise PermissionError(f"Permission '{perm}' denied")

    conn.verify_team_permission = MethodType(verify_team_permission, conn)

    # The _scheduler property walks self._server._server.app.state.scheduler —
    # satisfy the chain on the stub server instead of mutating the class.
    sched = scheduler or MagicMock()
    if scheduler is None:
        # The manual-run overlap guard defaults OPEN (a bare MagicMock would
        # return a truthy mock and refuse every run); tests exercising the
        # refusal flip it to True themselves.
        sched.is_run_active.return_value = False
    server = MagicMock()
    # broadcast_server_event is AWAITED by the deploy-change notifier; a
    # plain MagicMock attribute returns a non-awaitable, the await raises,
    # and the notifier's best-effort catch swallows it — the apaevt_deploy
    # contract would then have zero coverage here.
    server.broadcast_server_event = AsyncMock()
    server._server.app.state.scheduler = sched
    conn._server = server
    conn._test_scheduler = sched
    return conn


@pytest.fixture
def account_stub(monkeypatch):
    """Stub the account module the handlers call."""
    dep = {'teamId': 'team-1', 'projectId': 'proj-1', 'state': 'enabled', 'version': 1, 'schedules': {}}
    stub = SimpleNamespace(
        deployments_publish=AsyncMock(return_value={'version': 3, 'sha256': 'abc'}),
        deployments_deploy=AsyncMock(return_value=dep),
        deployments_set_state=AsyncMock(return_value={**dep, 'state': 'disabled'}),
        deployments_schedule_set=AsyncMock(return_value=dep),
        deployments_schedule_set_paused=AsyncMock(return_value=dep),
        deployments_source_config_set=AsyncMock(return_value=dep),
        deployments_list=AsyncMock(return_value=[dep]),
        deployments_get=AsyncMock(return_value=dep),
        deployments_versions=AsyncMock(return_value=[{'version': 3}]),
        # The artifact carries the source components schedule_set/source_config
        # validate against (and _deploy_run injects its source into).
        deployments_artifact=AsyncMock(
            return_value={'project_id': 'proj-1', 'components': [{'id': 's1'}, {'id': 'webhook_1'}]}
        ),
        deployments_mark_run=AsyncMock(),
        deployments_history=AsyncMock(
            return_value={'rows': [{'action': 'publish', 'seq': 1}], 'total': 1, 'page': 1, 'pageSize': 50}
        ),
        audit=AsyncMock(),
    )
    monkeypatch.setattr(cmd_mod, 'account', stub)
    return stub


PIPE = {'project_id': 'proj-1', 'name': 'P', 'components': []}


# ============================================================================
# publish
# ============================================================================


class TestPublish:
    @pytest.mark.asyncio
    async def test_publish_calls_registry_with_org_and_actor(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_publish({}, {'pipeline': PIPE, 'comment': 'note'})

        args = account_stub.deployments_publish.await_args.args
        assert args[0] == 'org-1' and args[1] == 'proj-1'
        # The audit actor is the denormalized caller identity.
        assert args[3] == {'userId': 'user-1', 'display': 'Rod C', 'email': 'rod@example.com'}
        assert resp['body']['artifact']['version'] == 3
        account_stub.audit.assert_awaited()

    @pytest.mark.asyncio
    async def test_publish_denied_without_control_anywhere(self, account_stub):
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': ['task.monitor']}]))
        with pytest.raises(PermissionError):
            await conn._deploy_publish({}, {'pipeline': PIPE})
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_publish_and_deploy_in_one_step(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_publish({}, {'pipeline': PIPE, 'deployTo': 'team-1'})
        account_stub.deployments_deploy.assert_awaited_once()
        assert resp['body']['deployment']['teamId'] == 'team-1'
        conn._test_scheduler.sync.assert_called_once()

    @pytest.mark.asyncio
    async def test_publish_deploy_to_foreign_team_denied(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(PermissionError):
            await conn._deploy_publish({}, {'pipeline': PIPE, 'deployTo': 'team-foreign'})
        account_stub.deployments_deploy.assert_not_awaited()


# ============================================================================
# deploy
# ============================================================================


class TestDeploy:
    @pytest.mark.asyncio
    async def test_deploy_verifies_control_on_target_team(self, account_stub):
        conn = _make_conn(_account_info())
        await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': 'team-1'})
        account_stub.deployments_deploy.assert_awaited_once_with(
            'org-1', 'team-1', 'proj-1', 3, {'userId': 'user-1', 'display': 'Rod C', 'email': 'rod@example.com'}
        )
        conn._test_scheduler.sync.assert_called_once()

    @pytest.mark.asyncio
    async def test_deploy_foreign_team_denied(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(PermissionError):
            await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': 'team-x'})
        account_stub.deployments_deploy.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_deploy_requires_integer_version(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='version'):
            await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': '3', 'teamId': 'team-1'})

    @pytest.mark.asyncio
    async def test_deploy_broadcasts_the_invalidation_event(self, account_stub):
        # The apaevt_deploy push replaces the deploy surfaces' polling —
        # pin the org-scoped envelope and the identity-only body so the
        # cache-invalidation contract cannot regress silently.
        from rocketride import EVENT_TYPE

        conn = _make_conn(_account_info())
        await conn._deploy_deploy({}, {'projectId': 'proj-1', 'version': 3, 'teamId': 'team-1'})
        conn._server.broadcast_server_event.assert_awaited_once_with(
            EVENT_TYPE.DEPLOY,
            {
                'event': 'apaevt_deploy',
                'body': {'orgId': 'org-1', 'teamId': 'team-1', 'projectId': 'proj-1', 'action': 'deploy'},
            },
            org_id='org-1',
        )


# ============================================================================
# reads
# ============================================================================


class TestReads:
    @pytest.mark.asyncio
    async def test_list_aggregates_monitor_teams_when_no_team_given(self, account_stub):
        teams = [
            {'id': 'team-1', 'name': 'A', 'permissions': ['task.monitor']},
            {'id': 'team-2', 'name': 'B', 'permissions': ['task.monitor']},
            {'id': 'team-3', 'name': 'C', 'permissions': []},
        ]
        conn = _make_conn(_account_info(teams=teams))
        await conn._deploy_list({}, {})
        called_teams = [c.args[1] for c in account_stub.deployments_list.await_args_list]
        assert called_teams == ['team-1', 'team-2']  # team-3 lacks monitor

    @pytest.mark.asyncio
    async def test_list_specific_team_requires_monitor_on_it(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(PermissionError):
            await conn._deploy_list({}, {'teamId': 'team-x'})

    @pytest.mark.asyncio
    async def test_get_missing_deployment_is_a_clean_error(self, account_stub):
        account_stub.deployments_get.return_value = None
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='No deployment'):
            await conn._deploy_get({}, {'projectId': 'proj-1', 'teamId': 'team-1'})

    @pytest.mark.asyncio
    async def test_versions_requires_monitor_somewhere(self, account_stub):
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': []}]))
        with pytest.raises(PermissionError):
            await conn._deploy_versions({}, {'projectId': 'proj-1'})

    @pytest.mark.asyncio
    async def test_publish_requires_a_pipeline_name(self, account_stub):
        # Artifacts are immutable and pipelineName renders everywhere — a
        # nameless publish would show as a GUID forever.
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='pipeline.name'):
            await conn._deploy_publish({}, {'pipeline': {'project_id': 'proj-1', 'components': []}})
        account_stub.deployments_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_run_dispatches_as_the_team_with_manual_trigger(self, account_stub, monkeypatch):
        # Run-now = the scheduler's trusted dispatch with trigger='manual';
        # the run carries NO human identity (who fired it is recorded by the
        # audit call, not on the run); lastRunAt is stamped. The source's
        # execution settings ride along, but its ttl window does NOT — a
        # manual run has no window (the user stops it).
        dispatched = {}

        async def fake_dispatch(
            server, pipeline, *, org_id, team_id, trigger, ttl=None, trace_level=None, debug_out=False
        ):
            dispatched.update(
                pipeline=pipeline,
                org_id=org_id,
                team_id=team_id,
                trigger=trigger,
                ttl=ttl,
                trace_level=trace_level,
                debug_out=debug_out,
            )
            return 'tk_manual'

        monkeypatch.setattr('ai.modules.task.task_server_facade.start_server_task_as_team', fake_dispatch)
        account_stub.deployments_get.return_value = {
            **account_stub.deployments_get.return_value,
            'schedules': {
                'webhook_1': {
                    'cron': '0 * * * *',
                    'paused': False,
                    'ttl': 900,
                    'traceLevel': 'summary',
                    'debugOut': True,
                }
            },
        }
        conn = _make_conn(_account_info())
        result = await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 'webhook_1', 'teamId': 'team-1'})
        assert result['body'] == {'token': 'tk_manual', 'version': 1}
        assert dispatched['trigger'] == 'manual'
        assert dispatched['team_id'] == 'team-1'
        assert dispatched['pipeline']['source'] == 'webhook_1'
        # No actor rides the dispatch — the run is owned by the team alone.
        assert 'actor' not in dispatched
        # The schedule's 900s window is ignored; its execution settings are not.
        assert dispatched['ttl'] is None
        assert dispatched['trace_level'] == 'summary'
        assert dispatched['debug_out'] is True
        account_stub.deployments_mark_run.assert_awaited_once_with('org-1', 'team-1', 'proj-1', 'webhook_1')
        # The manual token lands under the scheduler's overlap guard so the
        # next cron tick sees this run and skips.
        conn._test_scheduler.register_manual_run.assert_called_once_with('team-1', 'proj-1', 'webhook_1', 'tk_manual')

    @pytest.mark.asyncio
    async def test_run_refuses_while_source_run_active(self, account_stub, monkeypatch):
        # The manual path honors the scheduler's overlap guard: a live run of
        # the same (team, project, source) refuses the run-now.
        async def fake_dispatch(*a, **k):
            raise AssertionError('must not dispatch')

        monkeypatch.setattr('ai.modules.task.task_server_facade.start_server_task_as_team', fake_dispatch)
        conn = _make_conn(_account_info())
        conn._test_scheduler.is_run_active.return_value = True
        with pytest.raises(ValueError, match='already active'):
            await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': 'team-1'})

    @pytest.mark.asyncio
    async def test_run_refuses_disabled_and_needs_control(self, account_stub, monkeypatch):
        async def fake_dispatch(*a, **k):
            raise AssertionError('must not dispatch')

        monkeypatch.setattr('ai.modules.task.task_server_facade.start_server_task_as_team', fake_dispatch)
        # Disabled deployment: no back-door single runs.
        account_stub.deployments_get.return_value = {**account_stub.deployments_get.return_value, 'state': 'disabled'}
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='disabled'):
            await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': 'team-1'})
        # No task.control on the team: uniform denial.
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': ['task.monitor']}]))
        with pytest.raises(PermissionError):
            await conn._deploy_run({}, {'projectId': 'proj-1', 'sourceId': 's1', 'teamId': 'team-1'})

    @pytest.mark.asyncio
    async def test_artifact_returns_the_pipeline(self, account_stub):
        # The registry is the source of truth for what a deployed version
        # IS — the read-only DESIGN render is built from this body.
        conn = _make_conn(_account_info())
        result = await conn._deploy_artifact({}, {'projectId': 'proj-1', 'version': 3})
        assert result['body'] == {'project_id': 'proj-1', 'components': [{'id': 's1'}, {'id': 'webhook_1'}]}
        assert account_stub.deployments_artifact.await_args.args == ('org-1', 'proj-1', 3)

    @pytest.mark.asyncio
    async def test_artifact_requires_monitor_and_integer_version(self, account_stub):
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': []}]))
        with pytest.raises(PermissionError):
            await conn._deploy_artifact({}, {'projectId': 'proj-1', 'version': 1})
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError):
            await conn._deploy_artifact({}, {'projectId': 'proj-1', 'version': '1'})

    @pytest.mark.asyncio
    async def test_list_returns_the_standard_envelope(self, account_stub):
        # The DataGrid contract: {rows,total,page,pageSize}, paged at the
        # command layer (rows are bounded by the caller's memberships).
        conn = _make_conn(_account_info())
        result = await conn._deploy_list({}, {'page_size': 1})
        body = result['body']
        assert set(body) == {'rows', 'total', 'page', 'pageSize'}
        assert (body['total'], body['pageSize']) == (1, 1)
        assert body['rows'][0]['projectId'] == 'proj-1'

    @pytest.mark.asyncio
    async def test_versions_returns_the_standard_envelope(self, account_stub):
        conn = _make_conn(_account_info())
        result = await conn._deploy_versions({}, {'projectId': 'proj-1'})
        body = result['body']
        assert set(body) == {'rows', 'total', 'page', 'pageSize'}
        assert body['rows'] == [{'version': 3}]

    @pytest.mark.asyncio
    async def test_history_paging_is_delegated_to_the_backend(self, account_stub):
        # History is unbounded: the COMMAND layer never materializes it —
        # the list-args travel to the backend (SQL on saas) untouched.
        conn = _make_conn(_account_info())
        args = {'projectId': 'proj-1', 'page': 3, 'page_size': 10, 'search': 'rollback'}
        result = await conn._deploy_history({}, args)
        passed = account_stub.deployments_history.await_args.args
        assert passed[1] == 'proj-1' and passed[3] is args
        assert result['body']['rows'] == [{'action': 'publish', 'seq': 1}]


# ============================================================================
# state / schedules
# ============================================================================


class TestStateAndSchedules:
    @pytest.mark.asyncio
    async def test_disable_enable_remove_map_to_states(self, account_stub):
        conn = _make_conn(_account_info())
        await conn._deploy_disable({}, {'projectId': 'proj-1', 'teamId': 'team-1'})
        await conn._deploy_enable({}, {'projectId': 'proj-1', 'teamId': 'team-1'})
        await conn._deploy_remove({}, {'projectId': 'proj-1', 'teamId': 'team-1'})
        states = [c.args[3] for c in account_stub.deployments_set_state.await_args_list]
        assert states == ['disabled', 'enabled', 'removed']
        # Every mutation resyncs the scheduler.
        assert conn._test_scheduler.sync.call_count == 3

    @pytest.mark.asyncio
    async def test_schedule_set_validates_cron_and_normalizes_manual(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='Invalid schedule'):
            await conn._deploy_schedule_set(
                {}, {'projectId': 'proj-1', 'teamId': 'team-1', 'sourceId': 's1', 'schedule': 'nope'}
            )
        # 'manual' means "no schedule row" — persisted as a clear (None).
        await conn._deploy_schedule_set(
            {}, {'projectId': 'proj-1', 'teamId': 'team-1', 'sourceId': 's1', 'schedule': 'manual'}
        )
        assert account_stub.deployments_schedule_set.await_args.args[4] is None

    @pytest.mark.asyncio
    async def test_schedule_set_rejects_source_not_in_artifact(self, account_stub):
        # A schedule for a source the deployed artifact does not contain
        # would fail on every cron tick — refused at write time instead.
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='not a component'):
            await conn._deploy_schedule_set(
                {}, {'projectId': 'proj-1', 'teamId': 'team-1', 'sourceId': 'ghost', 'schedule': '@hourly'}
            )
        account_stub.deployments_schedule_set.assert_not_awaited()
        # source_config shares the guard (same argument, same failure mode).
        with pytest.raises(ValueError, match='not a component'):
            await conn._deploy_source_config(
                {}, {'projectId': 'proj-1', 'teamId': 'team-1', 'sourceId': 'ghost', 'traceLevel': 'none'}
            )
        account_stub.deployments_source_config_set.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_schedule_pause_resume_flip_the_flag(self, account_stub):
        conn = _make_conn(_account_info())
        await conn._deploy_schedule_pause({}, {'projectId': 'proj-1', 'teamId': 'team-1', 'sourceId': 's1'})
        await conn._deploy_schedule_resume({}, {'projectId': 'proj-1', 'teamId': 'team-1', 'sourceId': 's1'})
        flags = [c.args[4] for c in account_stub.deployments_schedule_set_paused.await_args_list]
        assert flags == [True, False]
        # Both flips resync the scheduler and audit.
        assert conn._test_scheduler.sync.call_count == 2
        assert account_stub.audit.await_count == 2

    @pytest.mark.asyncio
    async def test_source_config_validates_and_routes(self, account_stub):
        conn = _make_conn(_account_info())
        # An unknown trace level is refused before anything persists.
        with pytest.raises(ValueError, match='traceLevel'):
            await conn._deploy_source_config(
                {}, {'projectId': 'proj-1', 'teamId': 'team-1', 'sourceId': 's1', 'traceLevel': 'loud'}
            )
        # Valid config routes with the exact (level, debugOut) pair.
        await conn._deploy_source_config(
            {}, {'projectId': 'proj-1', 'teamId': 'team-1', 'sourceId': 's1', 'traceLevel': 'none', 'debugOut': True}
        )
        passed = account_stub.deployments_source_config_set.await_args.args
        assert passed[3] == 's1' and passed[4] == 'none' and passed[5] is True
        account_stub.audit.assert_awaited()

    @pytest.mark.asyncio
    async def test_schedule_pause_requires_source_and_control(self, account_stub):
        conn = _make_conn(_account_info())
        with pytest.raises(ValueError, match='sourceId'):
            await conn._deploy_schedule_pause({}, {'projectId': 'proj-1', 'teamId': 'team-1'})
        # No task.control on the team: uniform denial.
        conn = _make_conn(_account_info(teams=[{'id': 'team-1', 'name': 'D', 'permissions': ['task.monitor']}]))
        with pytest.raises(PermissionError):
            await conn._deploy_schedule_pause({}, {'projectId': 'proj-1', 'teamId': 'team-1', 'sourceId': 's1'})


# ============================================================================
# preview — the single evaluator
# ============================================================================


class TestPreview:
    @pytest.mark.asyncio
    async def test_valid_cron_returns_occurrences(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_preview({}, {'schedule': '*/5 * * * *', 'count': 3})
        body = resp['body']
        assert body['valid'] is True
        assert len(body['next']) == 3
        # Monotonic future timestamps.
        assert body['next'][0] < body['next'][1] < body['next'][2]

    @pytest.mark.asyncio
    async def test_invalid_cron_reports_not_raises(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_preview({}, {'schedule': 'not a cron'})
        assert resp['body']['valid'] is False
        assert resp['body']['error']

    @pytest.mark.asyncio
    async def test_manual_is_valid_with_no_occurrences(self, account_stub):
        conn = _make_conn(_account_info())
        resp = await conn._deploy_preview({}, {'schedule': 'manual'})
        assert resp['body'] == {'valid': True, 'next': []}
