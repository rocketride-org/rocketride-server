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

"""TaskScheduler unit tests — teams-as-environments scheduling.

Covers the heap/sync lifecycle keyed (team, project, source), the fire-time
re-read (store state always beats the in-memory heap), sha-verified artifact
dispatch through the trusted team path, per-source pipeline targeting, the
overlap guard, and errored-marking on permanent (permission-shaped) failures.

The account module and the dispatch facade are monkeypatched at the
scheduler's module scope — these are unit tests of scheduling behavior, not
of the backend (covered by test_deployment_backend) or dispatch (covered by
cmd/task tests).
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

import ai.modules.task.task_scheduler as sched_mod
from ai.modules.task.task_scheduler import TaskScheduler


# ============================================================================
# Helpers
# ============================================================================


def _dep(
    *,
    team='team-1',
    project='proj-1',
    state='active',
    version=1,
    schedules=None,
    updated_by=None,
):
    """An account-module deployment dict as deployments_get returns it."""
    return {
        'teamId': team,
        'projectId': project,
        'state': state,
        'version': version,
        'schedules': schedules if schedules is not None else {'src-1': {'cron': '* * * * *', 'enabled': True}},
        'updatedBy': updated_by or {'userId': 'user-1', 'display': 'Rod', 'email': ''},
    }


@pytest.fixture
def scheduler():
    """A TaskScheduler over a stub server (no loop started)."""
    server = MagicMock()
    server._task_control = {}
    return TaskScheduler(server)


@pytest.fixture
def account_stub(monkeypatch):
    """Replace the scheduler's account module with controllable stubs."""
    stub = SimpleNamespace(
        deployments_get=AsyncMock(return_value=_dep()),
        deployments_artifact=AsyncMock(return_value={'project_id': 'proj-1', 'source': 'orig', 'components': []}),
        deployments_set_state=AsyncMock(return_value=_dep(state='errored', schedules={})),
        deployments_mark_run=AsyncMock(),
        deployments_iter_active=MagicMock(),
    )
    monkeypatch.setattr(sched_mod, 'account', stub)
    return stub


@pytest.fixture
def dispatch(monkeypatch):
    """Replace the trusted dispatch with a capture mock."""
    mock = AsyncMock(return_value='tk_dispatched')
    monkeypatch.setattr(sched_mod, 'start_server_task_as_team', mock)
    return mock


# ============================================================================
# sync — heap reconciliation
# ============================================================================


class TestSync:
    def test_active_deployment_adds_one_entry_per_enabled_schedule(self, scheduler):
        scheduler.sync(
            'org-1',
            _dep(
                schedules={
                    'src-a': {'cron': '* * * * *', 'enabled': True},
                    'src-b': {'cron': '@hourly', 'enabled': True},
                    'src-off': {'cron': '@hourly', 'enabled': False},
                }
            ),
        )
        assert ('team-1', 'proj-1', 'src-a') in scheduler._entries
        assert ('team-1', 'proj-1', 'src-b') in scheduler._entries
        assert ('team-1', 'proj-1', 'src-off') not in scheduler._entries

    def test_paused_or_removed_drops_all_entries(self, scheduler):
        scheduler.sync('org-1', _dep())
        assert scheduler._entries
        scheduler.sync('org-1', _dep(state='paused', schedules={}))
        assert not scheduler._entries

    def test_resync_replaces_prior_entries(self, scheduler):
        scheduler.sync('org-1', _dep())
        first = scheduler._entries[('team-1', 'proj-1', 'src-1')]
        scheduler.sync('org-1', _dep(schedules={'src-1': {'cron': '@daily', 'enabled': True}}))
        second = scheduler._entries[('team-1', 'proj-1', 'src-1')]
        assert first.cancelled is True
        assert second.cron == '@daily'

    def test_same_project_two_teams_coexist(self, scheduler):
        scheduler.sync('org-1', _dep(team='team-stag'))
        scheduler.sync('org-1', _dep(team='team-prod'))
        assert ('team-stag', 'proj-1', 'src-1') in scheduler._entries
        assert ('team-prod', 'proj-1', 'src-1') in scheduler._entries

    def test_bad_cron_is_skipped_not_fatal(self, scheduler):
        scheduler.sync('org-1', _dep(schedules={'src-1': {'cron': 'not a cron', 'enabled': True}}))
        assert not scheduler._entries


# ============================================================================
# _start_run — fire-time behavior
# ============================================================================


def _entry(scheduler, org='org-1', team='team-1', project='proj-1', source='src-1'):
    """A due entry as the loop would pop it."""
    scheduler.sync(org, _dep(team=team, project=project, schedules={source: {'cron': '* * * * *', 'enabled': True}}))
    return scheduler._entries[(team, project, source)]


class TestStartRun:
    @pytest.mark.asyncio
    async def test_happy_path_dispatches_as_team_with_source_override(self, scheduler, account_stub, dispatch):
        entry = _entry(scheduler)
        await scheduler._start_run(entry)

        dispatch.assert_awaited_once()
        kwargs = dispatch.await_args.kwargs
        pipeline = dispatch.await_args.args[1]
        # Per-source execution: the schedule's source becomes the entry point.
        assert pipeline['source'] == 'src-1'
        assert kwargs['org_id'] == 'org-1'
        assert kwargs['team_id'] == 'team-1'
        assert kwargs['trigger'] == 'schedule'
        # The deploying user rides as attribution.
        assert kwargs['actor']['userId'] == 'user-1'
        # Overlap guard armed + lastRunAt stamped.
        assert scheduler._active_tokens[entry.key] == 'tk_dispatched'
        account_stub.deployments_mark_run.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_fire_time_reread_beats_the_heap(self, scheduler, account_stub, dispatch):
        # Deployment was paused between ticks: the heap says fire, the store
        # says no — the store must win, and the stale entries must drop.
        entry = _entry(scheduler)
        account_stub.deployments_get.return_value = _dep(state='paused', schedules={})
        await scheduler._start_run(entry)
        dispatch.assert_not_awaited()
        assert not scheduler._entries

    @pytest.mark.asyncio
    async def test_schedule_removed_between_ticks_skips(self, scheduler, account_stub, dispatch):
        entry = _entry(scheduler)
        account_stub.deployments_get.return_value = _dep(schedules={})
        await scheduler._start_run(entry)
        dispatch.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_unusable_artifact_marks_errored(self, scheduler, account_stub, dispatch):
        from ai.account.store import StorageError

        entry = _entry(scheduler)
        account_stub.deployments_artifact.side_effect = StorageError('sha256 mismatch')
        await scheduler._start_run(entry)
        dispatch.assert_not_awaited()
        account_stub.deployments_set_state.assert_awaited_once()
        assert account_stub.deployments_set_state.await_args.args[3] == 'errored'

    @pytest.mark.asyncio
    async def test_permission_failure_marks_errored(self, scheduler, account_stub, dispatch):
        entry = _entry(scheduler)
        dispatch.side_effect = PermissionError('denied')
        await scheduler._start_run(entry)
        account_stub.deployments_set_state.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_transient_failure_does_not_mark_errored(self, scheduler, account_stub, dispatch):
        entry = _entry(scheduler)
        dispatch.side_effect = RuntimeError('subprocess died')
        await scheduler._start_run(entry)
        account_stub.deployments_set_state.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_deployment_gone_drops_entries(self, scheduler, account_stub, dispatch):
        entry = _entry(scheduler)
        account_stub.deployments_get.return_value = None
        await scheduler._start_run(entry)
        dispatch.assert_not_awaited()
        assert not scheduler._entries


# ============================================================================
# Overlap guard (loop-level state exercised directly)
# ============================================================================


class TestOverlapGuard:
    @pytest.mark.asyncio
    async def test_active_previous_run_is_detectable(self, scheduler, account_stub, dispatch):
        entry = _entry(scheduler)
        await scheduler._start_run(entry)

        # Simulate the previous task still running in the registry.
        running = MagicMock()
        running.task.is_task_complete.return_value = False
        scheduler._server._task_control['tk_dispatched'] = running

        # The loop's guard consults _active_tokens + the control registry.
        prev = scheduler._active_tokens.get(entry.key)
        ctrl = scheduler._server._task_control.get(prev)
        assert ctrl and not ctrl.task.is_task_complete()
