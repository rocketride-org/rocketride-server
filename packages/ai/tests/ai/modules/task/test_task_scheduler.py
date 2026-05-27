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
stop) and inspect private state only for result assertions. Loop and dispatch
behaviour is driven via frozen-clock tests that use time_machine so overdue
conditions are created deterministically without touching the heap directly.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import time_machine


from ai.account.deployment_store import DeploymentStore
from ai.account.models import DeploymentRecord
from ai.account.store_providers.memory import MemoryStore
from ai.modules.task.task_scheduler import TaskScheduler

# todo: feat/deploy2 - enable TaskScheduler
pytestmark = pytest.mark.skip(reason='TaskScheduler disabled')


# =============================================================================
# Helpers
# =============================================================================


def make_record(
    project_id: str = 'proj-1',
    schedule: str = '*/15 * * * *',
    state: str = 'active',
    created_by: str = 'user-1',
    **kwargs,
) -> DeploymentRecord:
    return DeploymentRecord(
        pipeline={'project_id': project_id, 'components': []},
        created_by=created_by,
        schedule=schedule,
        state=state,
        **kwargs,
    )


def _make_server(task_control=None) -> SimpleNamespace:
    return SimpleNamespace(
        _task_control=task_control if task_control is not None else {},
        start_task=AsyncMock(return_value={'token': 'tk_new'}),
        deployments=DeploymentStore(MemoryStore()),
    )


def _make_scheduler(task_control=None) -> TaskScheduler:
    """Build a TaskScheduler with __init__ bypassed."""
    s = TaskScheduler.__new__(TaskScheduler)
    s._schedule = []
    s._tasks = {}
    s._active_tokens = {}
    s._loop_task = None
    s._server = _make_server(task_control)
    return s


async def _run_loop_once(scheduler: TaskScheduler) -> None:
    """Drive _loop through exactly one iteration, then stop."""

    async def _cancel(_: float) -> None:
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError), patch('asyncio.sleep', _cancel):
        await scheduler._loop()


# =============================================================================
# Scheduling scenarios
# =============================================================================


def test_scheduling_active_deployment_creates_future_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec.created_by, rec)
    assert rec.pipeline['project_id'] in s._tasks
    task = s._tasks[rec.pipeline['project_id']]
    assert task.next_run > datetime.now().timestamp()
    assert task.client_id == rec.created_by
    assert not task.cancelled


def test_scheduling_manual_deployment_is_ignored():
    s = _make_scheduler()
    s.schedule('user-1', make_record(schedule='manual'))
    assert 'proj-1' not in s._tasks


def test_switching_active_to_manual_cancels_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec.created_by, rec)
    old_task = s._tasks[rec.pipeline['project_id']]

    s.schedule(rec.created_by, make_record(schedule='manual'))
    assert old_task.cancelled
    assert rec.pipeline['project_id'] not in s._tasks


def test_switching_active_to_paused_cancels_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec.created_by, rec)
    old_task = s._tasks[rec.pipeline['project_id']]

    s.schedule(rec.created_by, make_record(state='paused'))
    assert old_task.cancelled
    assert rec.pipeline['project_id'] not in s._tasks


def test_switching_active_to_errored_cancels_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec.created_by, rec)
    old_task = s._tasks[rec.pipeline['project_id']]

    s.schedule(rec.created_by, make_record(state='errored'))
    assert old_task.cancelled
    assert rec.pipeline['project_id'] not in s._tasks


def test_rescheduling_replaces_existing_task():
    s = _make_scheduler()
    rec = make_record()
    s.schedule(rec.created_by, rec)
    first_task = s._tasks[rec.pipeline['project_id']]

    s.schedule(rec.created_by, rec)
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
    s.schedule(rec.created_by, rec)
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
# Startup scenarios
# =============================================================================


@pytest.mark.asyncio
async def test_startup_schedules_active_deployments():
    s = _make_scheduler()
    rec = make_record(schedule='@hourly', state='active')
    await s._server.deployments.save(rec.created_by, rec)
    await s.start()
    await s.stop()
    assert rec.pipeline['project_id'] in s._tasks


@pytest.mark.asyncio
async def test_startup_skips_manual_deployments():
    s = _make_scheduler()
    rec = make_record(schedule='manual')
    await s._server.deployments.save(rec.created_by, rec)
    await s.start()
    await s.stop()
    assert rec.pipeline['project_id'] not in s._tasks


@pytest.mark.asyncio
async def test_startup_loads_multiple_deployments():
    s = _make_scheduler()
    records = [make_record('proj-1'), make_record('proj-2'), make_record('proj-3')]
    for r in records:
        await s._server.deployments.save(r.created_by, r)
    await s.start()
    await s.stop()
    assert set(s._tasks) == {'proj-1', 'proj-2', 'proj-3'}


@pytest.mark.asyncio
async def test_startup_survives_store_error():
    s = _make_scheduler()
    failing_iter = MagicMock()
    failing_iter.__aiter__ = MagicMock(return_value=failing_iter)
    failing_iter.__anext__ = AsyncMock(side_effect=OSError('storage unavailable'))
    with patch.object(s._server.deployments, 'iter_all', return_value=failing_iter):
        await s.start()
        await s.stop()
    assert s._tasks == {}


# =============================================================================
# Dispatch and loop scenarios
# =============================================================================


@pytest.mark.asyncio
async def test_overdue_task_triggers_start_task():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await asyncio.sleep(0)

    s._server.start_task.assert_called_once()
    call = s._server.start_task.call_args
    assert call.args[0]['command'] == 'execute'
    assert call.args[0]['arguments']['pipeline'] == rec.pipeline
    assert call.kwargs['user_id'] == rec.created_by
    assert call.kwargs['client_id'] == rec.created_by
    assert call.kwargs['conn'] is None


@pytest.mark.asyncio
async def test_future_task_not_dispatched():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec.created_by, rec)
        await _run_loop_once(s)

    s._server.start_task.assert_not_called()


@pytest.mark.asyncio
async def test_loop_skips_when_previous_run_still_active():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec.created_by, rec)

    s._active_tokens[rec.pipeline['project_id']] = 'tk_old'
    s._server._task_control['tk_old'] = SimpleNamespace(task=SimpleNamespace(is_task_complete=lambda: False))

    with time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await asyncio.sleep(0)

    s._server.start_task.assert_not_called()


@pytest.mark.asyncio
async def test_loop_dispatches_when_previous_run_complete():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec.created_by, rec)

    s._active_tokens[rec.pipeline['project_id']] = 'tk_old'
    s._server._task_control['tk_old'] = SimpleNamespace(task=SimpleNamespace(is_task_complete=lambda: True))

    with time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await asyncio.sleep(0)

    s._server.start_task.assert_called_once()


@pytest.mark.asyncio
async def test_loop_dispatches_when_previous_token_cleaned_up():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec.created_by, rec)

    # token present but not in _task_control — already cleaned up
    s._active_tokens[rec.pipeline['project_id']] = 'tk_old'

    with time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await asyncio.sleep(0)

    s._server.start_task.assert_called_once()


@pytest.mark.asyncio
async def test_dispatch_stores_token_from_start_task():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)
    s._server.start_task = AsyncMock(return_value={'token': 'tk_abc'})

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await asyncio.sleep(0)

    assert s._active_tokens[rec.pipeline['project_id']] == 'tk_abc'


@pytest.mark.asyncio
async def test_dispatch_survives_start_task_failure():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)
    s._server.start_task = AsyncMock(side_effect=RuntimeError('boom'))

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)  # must not raise
        await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_dispatch_noop_for_missing_deployment():
    s = _make_scheduler()
    await s._dispatch('user-1', 'nonexistent')
    s._server.start_task.assert_not_called()


# =============================================================================
# _loop — time-machine variant
# =============================================================================


@pytest.mark.asyncio
async def test_future_task_not_dispatched_before_due_time():
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec.created_by, rec)  # next_run = 12:15:00, still future
        await _run_loop_once(s)

    s._server.start_task.assert_not_called()


@pytest.mark.asyncio
async def test_task_dispatched_after_time_advances():
    """The main value of time-machine: future task → advance clock → now due."""
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)

    with time_machine.travel(datetime(2026, 1, 1, 12, 0, 0), tick=False):
        s.schedule(rec.created_by, rec)  # next_run = 12:15:00
        await _run_loop_once(s)
    s._server.start_task.assert_not_called()

    with time_machine.travel(datetime(2026, 1, 1, 12, 16, 0), tick=False):
        await _run_loop_once(s)
        await asyncio.sleep(0)  # drain background dispatch task
    s._server.start_task.assert_called_once()


@pytest.mark.asyncio
async def test_sleep_delay_matches_time_until_next_task():
    """_loop must request a sleep of ~10 s when the next task is 10 s away."""
    s = _make_scheduler()
    rec = make_record()
    await s._server.deployments.save(rec.created_by, rec)

    sleep_calls: list[float] = []

    # Frozen at :14:50 — next */15 tick is :15:00, exactly 10 s away.
    with time_machine.travel(datetime(2026, 1, 1, 12, 14, 50), tick=False):
        s.schedule(rec.created_by, rec)

        async def _capture(delay: float) -> None:
            sleep_calls.append(delay)
            raise asyncio.CancelledError()

        with patch('asyncio.sleep', _capture), pytest.raises(asyncio.CancelledError):
            await s._loop()

    assert sleep_calls == [pytest.approx(10.0, abs=0.01)]
