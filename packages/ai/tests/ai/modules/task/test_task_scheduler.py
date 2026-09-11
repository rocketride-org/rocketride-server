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

import asyncio
import time
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
    state='enabled',
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
        'schedules': schedules if schedules is not None else {'src-1': {'cron': '* * * * *', 'paused': False}},
        'updatedBy': updated_by or {'userId': 'user-1', 'display': 'Rod', 'email': ''},
    }


@pytest.fixture
def scheduler():
    """A TaskScheduler over a stub server (no loop started)."""
    server = MagicMock()
    server._task_control = {}
    # broadcast_server_event is AWAITED by the deploy-change notifier; a
    # plain MagicMock attribute returns a non-awaitable, the await raises,
    # and the notifier's best-effort catch swallows it — the apaevt_deploy
    # contract would then have zero coverage here.
    server.broadcast_server_event = AsyncMock()
    return TaskScheduler(server)


@pytest.fixture
def account_stub(monkeypatch):
    """Replace the scheduler's account module with controllable stubs."""
    stub = SimpleNamespace(
        deployments_get=AsyncMock(return_value=_dep()),
        deployments_artifact=AsyncMock(return_value={'project_id': 'proj-1', 'source': 'orig', 'components': []}),
        deployments_set_state=AsyncMock(return_value=_dep(state='errored', schedules={})),
        deployments_mark_run=AsyncMock(),
        deployments_iter_enabled=MagicMock(),
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
    def test_enabled_deployment_adds_one_entry_per_unpaused_schedule(self, scheduler):
        scheduler.sync(
            'org-1',
            _dep(
                schedules={
                    'src-a': {'cron': '* * * * *', 'paused': False},
                    'src-b': {'cron': '@hourly', 'paused': False},
                    'src-off': {'cron': '@hourly', 'paused': True},
                }
            ),
        )
        assert ('team-1', 'proj-1', 'src-a') in scheduler._entries
        assert ('team-1', 'proj-1', 'src-b') in scheduler._entries
        assert ('team-1', 'proj-1', 'src-off') not in scheduler._entries

    def test_disabled_or_removed_drops_all_entries(self, scheduler):
        scheduler.sync('org-1', _dep())
        assert scheduler._entries
        scheduler.sync('org-1', _dep(state='disabled', schedules={}))
        assert not scheduler._entries

    def test_resync_replaces_prior_entries(self, scheduler):
        scheduler.sync('org-1', _dep())
        first = scheduler._entries[('team-1', 'proj-1', 'src-1')]
        scheduler.sync('org-1', _dep(schedules={'src-1': {'cron': '@daily', 'paused': False}}))
        second = scheduler._entries[('team-1', 'proj-1', 'src-1')]
        assert first.cancelled is True
        assert second.cron == '@daily'

    def test_same_project_two_teams_coexist(self, scheduler):
        scheduler.sync('org-1', _dep(team='team-stag'))
        scheduler.sync('org-1', _dep(team='team-prod'))
        assert ('team-stag', 'proj-1', 'src-1') in scheduler._entries
        assert ('team-prod', 'proj-1', 'src-1') in scheduler._entries

    def test_bad_cron_is_skipped_not_fatal(self, scheduler):
        scheduler.sync('org-1', _dep(schedules={'src-1': {'cron': 'not a cron', 'paused': False}}))
        assert not scheduler._entries


# ============================================================================
# _start_run — fire-time behavior
# ============================================================================


def _entry(scheduler, org='org-1', team='team-1', project='proj-1', source='src-1'):
    """A due entry as the loop would pop it."""
    scheduler.sync(org, _dep(team=team, project=project, schedules={source: {'cron': '* * * * *', 'paused': False}}))
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
        # Execution settings ride the dispatch; unset trace defaults to FULL.
        assert kwargs['trace_level'] == 'full'
        assert kwargs['debug_out'] is False
        # No actor rides the dispatch — the run is owned by the team alone;
        # who deployed lives in the deployment history, not on the run.
        assert 'actor' not in kwargs
        # Overlap guard armed + lastRunAt stamped.
        assert scheduler._active_tokens[entry.key] == 'tk_dispatched'
        account_stub.deployments_mark_run.assert_awaited_once()
        # The apaevt_deploy push replaces the deploy surfaces' polling — pin
        # the org-scoped envelope and the identity-only body.
        from rocketride import EVENT_TYPE

        scheduler._server.broadcast_server_event.assert_awaited_once_with(
            EVENT_TYPE.DEPLOY,
            {
                'event': 'apaevt_deploy',
                'body': {'orgId': 'org-1', 'teamId': 'team-1', 'projectId': 'proj-1', 'action': 'run'},
            },
            org_id='org-1',
        )

    @pytest.mark.asyncio
    async def test_fire_time_reread_beats_the_heap(self, scheduler, account_stub, dispatch):
        # Deployment was disabled between ticks: the heap says fire, the
        # store
        # says no — the store must win, and the stale entries must drop.
        entry = _entry(scheduler)
        account_stub.deployments_get.return_value = _dep(state='disabled', schedules={})
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
    async def test_schedule_paused_between_ticks_skips(self, scheduler, account_stub, dispatch):
        # The per-source pause must win at fire time even when the heap
        # entry predates it.
        entry = _entry(scheduler)
        account_stub.deployments_get.return_value = _dep(schedules={'src-1': {'cron': '* * * * *', 'paused': True}})
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

        # Assert the scheduler's OWN predicate — the exact guard the tick
        # loop and the manual run path evaluate.
        assert scheduler._is_previous_run_active(entry.key)

        # And it reopens once the task completes.
        running.task.is_task_complete.return_value = True
        assert not scheduler._is_previous_run_active(entry.key)

    @pytest.mark.asyncio
    async def test_inflight_dispatch_closes_the_guard(self, scheduler):
        # The tick loop marks the key BEFORE the dispatch task exists; the
        # guard must already be closed in that window.
        key = ('team-1', 'proj-1', 'src-1')
        scheduler._active_tokens[key] = sched_mod._DISPATCHING
        assert scheduler._is_previous_run_active(key)

    def test_manual_run_registers_under_the_guard(self, scheduler):
        # A registered manual token with a live control entry closes the
        # guard for the next cron tick.
        running = MagicMock()
        running.task.is_task_complete.return_value = False
        scheduler._server._task_control['tk_manual'] = running
        scheduler.register_manual_run('team-1', 'proj-1', 'src-1', 'tk_manual')
        assert scheduler.is_run_active('team-1', 'proj-1', 'src-1')


# ============================================================================
# Skip visibility (issue #1838) — a non-terminating source closes the
# overlap guard forever, so the schedule stops firing while still reporting
# itself active. These pin the added consecutive-skip counter and its
# threshold warnings; the guard's own skip/dispatch decision is untouched
# and stays covered by TestOverlapGuard/TestStartRun above.
# ============================================================================


class TestSkipVisibility:
    KEY = ('team-1', 'proj-1', 'src-1')

    def test_sync_drops_skip_counts_when_disabled(self, scheduler):
        """Disabling/removing a deployment drops its skip counts, not just its schedule entries."""
        scheduler.sync('org-1', _dep())
        scheduler._skip_counts[self.KEY] = 5

        scheduler.sync('org-1', _dep(state='disabled', schedules={}))

        assert self.KEY not in scheduler._skip_counts

    @pytest.mark.parametrize(
        'remaining_schedules',
        [
            pytest.param({'src-2': {'cron': '* * * * *', 'paused': False}}, id='removed'),
            pytest.param(
                {
                    'src-1': {'cron': '* * * * *', 'paused': True},
                    'src-2': {'cron': '* * * * *', 'paused': False},
                },
                id='paused',
            ),
        ],
    )
    def test_sync_prunes_only_the_affected_sources_skip_count(self, scheduler, remaining_schedules):
        """Removing or pausing one source prunes only its own skip count - a sibling source stays untouched."""
        scheduler.sync(
            'org-1',
            _dep(
                schedules={
                    'src-1': {'cron': '* * * * *', 'paused': False},
                    'src-2': {'cron': '* * * * *', 'paused': False},
                }
            ),
        )
        key1 = ('team-1', 'proj-1', 'src-1')
        key2 = ('team-1', 'proj-1', 'src-2')
        scheduler._skip_counts[key1] = 5
        scheduler._skip_counts[key2] = 7

        scheduler.sync('org-1', _dep(schedules=remaining_schedules))

        assert key1 not in scheduler._skip_counts
        assert scheduler._skip_counts[key2] == 7  # the blanket-wipe failure mode this guards against

    @pytest.mark.parametrize('threshold', sched_mod._SKIP_WARN_THRESHOLDS)
    def test_warns_at_threshold_not_before(self, scheduler, monkeypatch, threshold):
        """A warning fires exactly at each configured threshold, never before it."""
        warn = MagicMock()
        monkeypatch.setattr(sched_mod, 'warning', warn)

        # Seed one skip short of the threshold directly, rather than looping
        # _note_skip from zero - a loop would cross any SMALLER threshold on
        # the way (e.g. 3, on the way to 10), firing a warning that has
        # nothing to do with the one under test here.
        scheduler._skip_counts[self.KEY] = threshold - 2

        scheduler._note_skip(self.KEY)  # count == threshold - 1
        warn.assert_not_called()

        scheduler._note_skip(self.KEY)  # count == threshold
        warn.assert_called_once()
        message = warn.call_args.args[0]
        assert 'src-1' in message
        assert str(threshold) in message

    def test_no_repeat_warning_between_thresholds(self, scheduler, monkeypatch):
        """No warning repeats on every skip between two thresholds."""
        warn = MagicMock()
        monkeypatch.setattr(sched_mod, 'warning', warn)

        for _ in range(9):  # consecutive skips 1-9; next threshold is 10
            scheduler._note_skip(self.KEY)
        assert warn.call_count == 1  # only the 3rd skip warned

    def test_dispatch_resets_the_counter(self, scheduler, monkeypatch):
        """Resetting the counter (as a dispatch does) breaks a skip streak."""
        warn = MagicMock()
        monkeypatch.setattr(sched_mod, 'warning', warn)

        scheduler._note_skip(self.KEY)
        scheduler._note_skip(self.KEY)
        # Mirrors the tick loop's reset line exactly: a tick that dispatches
        # clears the counter before the next skip streak can accumulate.
        scheduler._skip_counts.pop(self.KEY, None)

        scheduler._note_skip(self.KEY)
        scheduler._note_skip(self.KEY)
        warn.assert_not_called()  # only 2 consecutive skips since the reset

    @staticmethod
    async def _run_one_tick(scheduler, monkeypatch):
        """
        Drive _run() itself through exactly one batch of due entries, with
        no real waiting: _run()'s tick-processing is fully synchronous up to
        its trailing `await asyncio.sleep(delay)`, so patching that one call
        to raise immediately stops the loop right after the batch - no
        restructuring of _run(), no real elapsed time, nothing timing-
        dependent to flake.
        """

        async def _stop(_delay):
            raise asyncio.CancelledError

        monkeypatch.setattr(sched_mod.asyncio, 'sleep', _stop)
        with pytest.raises(asyncio.CancelledError):
            await scheduler._run()

    @pytest.mark.asyncio
    async def test_run_loop_increments_skip_count_on_skip(self, scheduler, account_stub, dispatch, monkeypatch):
        """
        Exercises the _note_skip call added inside _run() itself, not a
        reimplementation of it.
        """
        entry = _entry(scheduler)
        entry.next_run = time.time() - 1  # due now, no real wait

        running = MagicMock()
        running.task.is_task_complete.return_value = False
        scheduler._active_tokens[entry.key] = 'tk_running'
        scheduler._server._task_control['tk_running'] = running

        await self._run_one_tick(scheduler, monkeypatch)

        assert scheduler._skip_counts[entry.key] == 1
        # The count alone doesn't prove a skip caused it. dispatch not being
        # awaited plus _active_tokens left untouched (the dispatch branch's
        # own distinguishing side effect, `_active_tokens[key] = _DISPATCHING`)
        # together rule out the dispatch branch having run at all.
        dispatch.assert_not_awaited()
        assert scheduler._active_tokens[entry.key] == 'tk_running'

    @pytest.mark.asyncio
    async def test_run_loop_clears_skip_count_on_dispatch(self, scheduler, account_stub, dispatch, monkeypatch):
        """
        Exercises the reset pop added inside _run() itself, not a
        reimplementation of it.
        """
        entry = _entry(scheduler)
        entry.next_run = time.time() - 1  # due now, no real wait
        scheduler._skip_counts[entry.key] = 5  # a prior skip streak

        await self._run_one_tick(scheduler, monkeypatch)

        assert entry.key not in scheduler._skip_counts
        # Let the dispatch task this tick created finish before the test ends.
        await asyncio.gather(*scheduler._inflight_starts, return_exceptions=True)
        # The count being gone isn't enough on its own - a change that cleared
        # counters without dispatching would pass that alone. Pin that a
        # dispatch is what happened, not merely that the count is absent.
        dispatch.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_skip_and_dispatch_decisions_are_unchanged(self, scheduler, account_stub, dispatch):
        """
        The fix must be purely additive: the same ticks skip and the same
        ticks dispatch, with or without it. This drives the pre-existing
        tick-loop decision (_is_previous_run_active -> skip, else
        _start_run -> dispatch) over a short sequence and pins the exact
        outcome. It references no symbol this change added, so it must
        pass against unmodified source too — that is what proves additive.
        """
        entry = _entry(scheduler)
        decisions = []

        async def _tick():
            if scheduler._is_previous_run_active(entry.key):
                decisions.append('skip')
            else:
                await scheduler._start_run(entry)
                decisions.append('dispatch')

        await _tick()  # nothing active yet -> dispatch

        running = MagicMock()
        running.task.is_task_complete.return_value = False
        scheduler._server._task_control['tk_dispatched'] = running

        await _tick()  # previous run still going -> skip
        await _tick()  # still going -> skip

        running.task.is_task_complete.return_value = True

        await _tick()  # previous run finished -> guard reopens -> dispatch

        assert decisions == ['dispatch', 'skip', 'skip', 'dispatch']
        assert dispatch.await_count == 2
