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

"""
Scenario-based tests for ai.modules.task.task_scheduler.TaskScheduler.

Tests exercise combinations of public methods (schedule, unschedule, start,
shutdown) and inspect private state only for result assertions. Loop and
dispatch behaviour is driven via frozen-clock tests that use time_machine so
overdue conditions are created deterministically without touching the heap
directly. The TaskServer interaction is mocked at the start_server_task
boundary (the facade), so these tests stay focused on scheduling logic.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import time_machine


from ai.account.deployment_store import DeploymentStore
from ai.account.models import DeploymentRecord
from ai.account.store_providers.memory import MemoryStore
from ai.modules.task.task_scheduler import TaskScheduler
from ai.modules.task.task_server_facade import ServerTaskAuthError


# =============================================================================
# Helpers
# =============================================================================


def make_record(
    project_id: str = 'proj-1',
    schedule: str = '*/15 * * * *',
    state: str = 'active',
    userId: str = 'user-1',
    userToken: str = 'rr_test',
    **kwargs,
) -> DeploymentRecord:
    return DeploymentRecord(
        pipeline={'project_id': project_id, 'components': []},
        userId=userId,
        userToken=userToken,
        schedule=schedule,
        state=state,
        **kwargs,
    )


def _make_server(task_control=None) -> SimpleNamespace:
    return SimpleNamespace(
        _task_control=task_control if task_control is not None else {},
        deployments=DeploymentStore(MemoryStore()),
    )


def _make_scheduler(task_control=None) -> TaskScheduler:
    """Build a TaskScheduler with __init__ bypassed."""
    s = TaskScheduler.__new__(TaskScheduler)
    s._schedule = []
    s._tasks = {}
    s._active_tokens = {}
    s._scheduling = None
    s._inflight_starts = set()
    s._server = _make_server(task_control)
    return s


async def _run_loop_once(scheduler: TaskScheduler) -> None:
    """Drive the scheduling loop (_run) through exactly one iteration, then stop."""

    async def _cancel(_: float) -> None:
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError), patch('asyncio.sleep', _cancel):
        await scheduler._run()


async def _drain() -> None:
    """Yield repeatedly so a background _start_task can run to completion."""
    for _ in range(50):
        await asyncio.sleep(0)


@contextmanager
def _patch_start_server_task(*, token='tk_new', exc=None):
    """Patch start_server_task in the scheduler module; yield the AsyncMock.

    With ``exc`` set, the mock raises it (e.g. ServerTaskAuthError); otherwise it
    returns ``token`` as the new task token.
    """

    def impl(server, user_token, pipeline):
        if exc is not None:
            raise exc
        return token

    mock = AsyncMock(side_effect=impl)
    with patch('ai.modules.task.task_scheduler.start_server_task', mock):
        yield mock


# =============================================================================
# Scheduling scenarios
# =============================================================================


def test_scheduling_active_deployment_creates_future_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec)
    assert rec.pipeline['project_id'] in s._tasks
    task = s._tasks[rec.pipeline['project_id']]
    assert task.next_run > datetime.now().timestamp()
    assert task.client_id == rec.userId
    assert not task.cancelled


def test_scheduling_manual_deployment_is_ignored():
    s = _make_scheduler()
    s.schedule(make_record(schedule='manual'))
    assert 'proj-1' not in s._tasks


def test_switching_active_to_manual_cancels_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec)
    old_task = s._tasks[rec.pipeline['project_id']]

    s.schedule(make_record(schedule='manual'))
    assert old_task.cancelled
    assert rec.pipeline['project_id'] not in s._tasks


def test_switching_active_to_paused_cancels_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec)
    old_task = s._tasks[rec.pipeline['project_id']]

    s.schedule(make_record(state='paused'))
    assert old_task.cancelled
    assert rec.pipeline['project_id'] not in s._tasks


def test_switching_active_to_errored_cancels_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec)
    old_task = s._tasks[rec.pipeline['project_id']]

    s.schedule(make_record(state='errored'))
    assert old_task.cancelled
    assert rec.pipeline['project_id'] not in s._tasks


def test_rescheduling_replaces_existing_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec)
    first_task = s._tasks[rec.pipeline['project_id']]

    s.schedule(rec)
    assert first_task.cancelled
    assert len(s._tasks) == 1
    new_task = s._tasks[rec.pipeline['project_id']]
    assert new_task is not first_task
    assert new_task.next_run > datetime.now().timestamp()


# =============================================================================
# Unschedule scenarios
# =============================================================================


def test_unschedule_cancels_and_removes_scheduled_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec)
    task = s._tasks[rec.pipeline['project_id']]

    s.unschedule(rec.pipeline['project_id'])
    assert rec.pipeline['project_id'] not in s._tasks
    assert task.cancelled


def test_unschedule_removes_active_token():
    s = _make_scheduler()
    s._active_tokens['proj-1'] = 'tk_old'
    s.unschedule('proj-1')
    assert 'proj-1' not in s._active_tokens


def test_unschedule_unknown_deployment_is_noop():
    s = _make_scheduler()
    s.unschedule('nonexistent')  # must not raise


# =============================================================================
# Load scenarios (startup scan)
# =============================================================================


@pytest.mark.asyncio
async def test_load_schedules_active_deployments():
    s = _make_scheduler()
    rec = make_record(schedule='@hourly', state='active')
    await s._server.deployments.save(rec.userId, rec)
    await s._load()
    assert rec.pipeline['project_id'] in s._tasks


@pytest.mark.asyncio
async def test_load_skips_manual_deployments():
    s = _make_scheduler()
    rec = make_record(schedule='manual')
    await s._server.deployments.save(rec.userId, rec)
    await s._load()
    assert rec.pipeline['project_id'] not in s._tasks


@pytest.mark.asyncio
async def test_load_loads_multiple_deployments():
    s = _make_scheduler()
    records = [make_record('proj-1'), make_record('proj-2'), make_record('proj-3')]
    for r in records:
        await s._server.deployments.save(r.userId, r)
    await s._load()
    assert set(s._tasks) == {'proj-1', 'proj-2', 'proj-3'}


@pytest.mark.asyncio
async def test_load_skips_bad_record_and_continues():
    """One unschedulable record (e.g. corrupt cron expression on disk) must not
    abort loading the records after it.
    """
    s = _make_scheduler()
    bad = make_record('proj-bad', schedule='not-a-cron')  # store does not validate cron
    good = make_record('proj-good')
    await s._server.deployments.save(bad.userId, bad)
    await s._server.deployments.save(good.userId, good)

    await s._load()  # must not raise

    assert 'proj-good' in s._tasks
    assert 'proj-bad' not in s._tasks


@pytest.mark.asyncio
async def test_load_survives_store_error():
    s = _make_scheduler()
    failing_iter = MagicMock()
    failing_iter.__aiter__ = MagicMock(return_value=failing_iter)
    failing_iter.__anext__ = AsyncMock(side_effect=OSError('storage unavailable'))
    with patch.object(s._server.deployments, 'iter_all', return_value=failing_iter):
        await s._load()  # must not raise
    assert s._tasks == {}


# =============================================================================
# Dispatch and loop scenarios
# =============================================================================


@pytest.mark.asyncio
async def test_overdue_task_triggers_dispatch():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec)

    with _patch_start_server_task() as start, time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await _drain()

    start.assert_awaited_once_with(s._server, rec.userToken, rec.pipeline)
    assert s._active_tokens[rec.pipeline['project_id']] == 'tk_new'
    assert s._inflight_starts == set()  # completed task starts discard themselves


@pytest.mark.asyncio
async def test_future_task_not_dispatched():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with _patch_start_server_task() as start, time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec)
        await _run_loop_once(s)
        await _drain()

    start.assert_not_awaited()
    assert s._active_tokens == {}


@pytest.mark.asyncio
async def test_loop_skips_when_previous_run_still_active():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec)

    s._active_tokens[rec.pipeline['project_id']] = 'tk_old'
    s._server._task_control['tk_old'] = SimpleNamespace(task=SimpleNamespace(is_task_complete=lambda: False))

    with _patch_start_server_task() as start, time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await _drain()

    start.assert_not_awaited()
    assert s._active_tokens[rec.pipeline['project_id']] == 'tk_old'


@pytest.mark.asyncio
async def test_loop_dispatches_when_previous_run_complete():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec)

    s._active_tokens[rec.pipeline['project_id']] = 'tk_old'
    s._server._task_control['tk_old'] = SimpleNamespace(task=SimpleNamespace(is_task_complete=lambda: True))

    with _patch_start_server_task() as start, time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await _drain()

    start.assert_awaited_once()
    assert s._active_tokens[rec.pipeline['project_id']] == 'tk_new'


@pytest.mark.asyncio
async def test_loop_dispatches_when_previous_token_cleaned_up():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec)

    # token present but not in _task_control — already cleaned up
    s._active_tokens[rec.pipeline['project_id']] = 'tk_old'

    with _patch_start_server_task() as start, time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await _drain()

    start.assert_awaited_once()
    assert s._active_tokens[rec.pipeline['project_id']] == 'tk_new'


@pytest.mark.asyncio
async def test_dispatch_calls_start_server_task_and_stores_token():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with _patch_start_server_task(token='tk_abc') as start:
        await s._start_task(rec.userId, rec.pipeline['project_id'])

    start.assert_awaited_once_with(s._server, rec.userToken, rec.pipeline)
    assert s._active_tokens[rec.pipeline['project_id']] == 'tk_abc'


@pytest.mark.asyncio
async def test_dispatch_survives_execute_failure():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with _patch_start_server_task(exc=RuntimeError('execute failed: boom')):
        await s._start_task(rec.userId, rec.pipeline['project_id'])  # must not raise

    assert rec.pipeline['project_id'] not in s._active_tokens


@pytest.mark.asyncio
async def test_dispatch_auth_failure_marks_errored_and_unschedules():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)
    s.schedule(rec)

    with _patch_start_server_task(exc=ServerTaskAuthError('bad token')):
        await s._start_task(rec.userId, rec.pipeline['project_id'])

    saved = await s._server.deployments.get(rec.userId, rec.pipeline['project_id'])
    assert saved.state == 'errored'
    assert rec.pipeline['project_id'] not in s._active_tokens
    assert rec.pipeline['project_id'] not in s._tasks


@pytest.mark.asyncio
async def test_dispatch_skips_when_no_user_token():
    s = _make_scheduler()
    rec = make_record(userToken='')
    await s._server.deployments.save(rec.userId, rec)

    with _patch_start_server_task() as start:
        await s._start_task(rec.userId, rec.pipeline['project_id'])

    start.assert_not_awaited()
    assert rec.pipeline['project_id'] not in s._active_tokens


@pytest.mark.asyncio
async def test_dispatch_noop_for_missing_deployment():
    s = _make_scheduler()
    with _patch_start_server_task() as start:
        await s._start_task('user-1', 'nonexistent')
    start.assert_not_awaited()
    assert 'nonexistent' not in s._active_tokens


# =============================================================================
# _run loop — time-machine variant
# =============================================================================


@pytest.mark.asyncio
async def test_future_task_not_dispatched_before_due_time():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with _patch_start_server_task() as start, time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec)  # next_run = 12:15:00, still future
        await _run_loop_once(s)
        await _drain()

    start.assert_not_awaited()


@pytest.mark.asyncio
async def test_task_dispatched_after_time_advances():
    """The main value of time-machine: future task → advance clock → now due."""
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with _patch_start_server_task() as start:
        with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
            s.schedule(rec)  # next_run = 12:15:00
            await _run_loop_once(s)
            await _drain()
        start.assert_not_awaited()

        with time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
            await _run_loop_once(s)
            await _drain()  # drain background dispatch task
        start.assert_awaited_once()
        assert s._active_tokens[rec.pipeline['project_id']] == 'tk_new'


@pytest.mark.asyncio
async def test_sleep_delay_matches_time_until_next_task():
    """_run must request a sleep of ~10 s when the next task is 10 s away."""
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    sleep_calls: list[float] = []

    # Frozen at :14:50 — next */15 tick is :15:00, exactly 10 s away.
    with time_machine.travel(datetime(2026, 1, 1, 12, 14, 50), tick=False):
        s.schedule(rec)

        async def _capture(delay: float) -> None:
            sleep_calls.append(delay)
            raise asyncio.CancelledError()

        with patch('asyncio.sleep', _capture), pytest.raises(asyncio.CancelledError):
            await s._run()

    assert sleep_calls == [pytest.approx(10.0, abs=0.01)]


# =============================================================================
# _run loop — robustness
# =============================================================================


@pytest.mark.asyncio
async def test_run_survives_record_deleted_while_due():
    """deploy_remove deletes the record from the store before calling unschedule;
    a task due inside that window must not kill the scheduling loop.
    """
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec)

    await s._server.deployments.delete(rec.userId, rec.pipeline['project_id'])

    with _patch_start_server_task() as start, time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)  # must not raise
        await _drain()

    # Dispatch aborted (record gone), but the loop stayed alive and rescheduled
    # from the in-memory cron expression without touching the store.
    start.assert_not_awaited()
    assert rec.pipeline['project_id'] in s._tasks
    assert rec.pipeline['project_id'] not in s._active_tokens


@pytest.mark.asyncio
async def test_run_survives_tick_error():
    """An unexpected exception while processing one task is logged and skipped;
    it must not propagate out of _run and stop scheduling for everyone.
    """
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec)

    # Poison the overlap guard: the task-control lookup explodes.
    s._active_tokens[rec.pipeline['project_id']] = 'tk_old'
    s._server._task_control = MagicMock()
    s._server._task_control.get.side_effect = RuntimeError('boom')

    with _patch_start_server_task() as start, time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)  # must not raise
        await _drain()

    start.assert_not_awaited()
    # Rescheduling happens before the failing guard, so the deployment survives.
    assert rec.pipeline['project_id'] in s._tasks


# =============================================================================
# Shutdown
# =============================================================================


@pytest.mark.asyncio
async def test_shutdown_drains_inflight_starts():
    """shutdown() must wait for task starts that already left the loop, not abandon them."""
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.userId, rec)

    release = asyncio.Event()

    async def slow_start(server, user_token, pipeline):
        await release.wait()
        return 'tk_slow'

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec)

    with patch('ai.modules.task.task_scheduler.start_server_task', AsyncMock(side_effect=slow_start)):
        with time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
            await _run_loop_once(s)
            await _drain()
        assert len(s._inflight_starts) == 1

        shutdown = asyncio.create_task(s.shutdown())
        await _drain()
        assert not shutdown.done()  # blocked on the in-flight dispatch

        release.set()
        await asyncio.wait_for(shutdown, timeout=5)

    assert s._inflight_starts == set()
    assert s._active_tokens[rec.pipeline['project_id']] == 'tk_slow'
