# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for the visibility tools (`tools/visibility.py`): `monitor` and
`list_running_pipelines`.

`monitor` is a **bounded poll** of `get_task_status` (not event streaming --
see tool-specs.md Visibility section for why the original event-based design
was abandoned). These tests monkeypatch `asyncio.sleep` to a no-op so the
poll loop never actually waits in the test suite.
"""

import asyncio
import itertools

import pytest

from ai.modules.mcp.registry import TaskRegistry
from ai.modules.mcp.tools import register_all
from ai.modules.mcp.tools import visibility
from ai.modules.mcp.tooling import ToolRegistry


def _no_sleep(monkeypatch):
    async def _sleep(_seconds):
        return None

    monkeypatch.setattr(asyncio, 'sleep', _sleep)


# --- registration ------------------------------------------------------------


def test_register_all_registers_monitor():
    registry = ToolRegistry()

    register_all(registry)

    assert 'monitor' in set(registry.names())


def test_visibility_register_binds_handler_directly():
    registry = ToolRegistry()

    visibility.register(registry)

    assert registry.handler('monitor') is not None


def test_register_all_yields_the_expected_tool_surface():
    registry = ToolRegistry()

    register_all(registry)

    from .conftest import EXPECTED_TOOL_NAMES

    # A set diff names the tool that changed, unlike a bare count.
    assert set(registry.names()) == set(EXPECTED_TOOL_NAMES)


# --- monitor -------------------------------------------------------------


@pytest.mark.asyncio
async def test_monitor_requires_task_token(fake_engine):
    registry = ToolRegistry()
    visibility.register(registry)

    result = await registry.handler('monitor')(fake_engine, None, {})

    assert result['ok'] is False
    assert result['error_type'] == 'BadRequest'
    assert fake_engine.get_task_status_calls == []


@pytest.mark.asyncio
async def test_monitor_polls_until_terminal_state(fake_engine, monkeypatch):
    _no_sleep(monkeypatch)
    fake_engine._task_statuses = [
        {'state': 3, 'completed': False},
        {'state': 5, 'completed': True, 'completedCount': 1, 'totalCount': 1},
    ]

    registry = ToolRegistry()
    visibility.register(registry)
    tasks = TaskRegistry()
    tasks.add('tok-1', pipeline_ref='p.pipe')

    result = await registry.handler('monitor')(fake_engine, tasks, {'task_token': 'tok-1'})

    assert result['ok'] is True
    assert result['task_token'] == 'tok-1'
    assert result['state'] == 5
    assert result['state_label'] == 'completed'
    assert result['completed'] is True
    assert result['terminal'] is True
    assert result['polls'] >= 2
    assert result['counts'] == {'completedCount': 1, 'failedCount': 0, 'totalCount': 1}
    assert result['errors'] == []
    assert result['warnings'] == []
    assert fake_engine.get_task_status_calls == ['tok-1', 'tok-1']
    # Terminal -> the registry should no longer be tracking this token (#1: leak fix).
    assert tasks.get('tok-1') is None


@pytest.mark.asyncio
async def test_monitor_terminates_on_cancelled_state(fake_engine, monkeypatch):
    _no_sleep(monkeypatch)
    fake_engine._task_statuses = [{'state': 6, 'completed': False}]

    registry = ToolRegistry()
    visibility.register(registry)
    tasks = TaskRegistry()
    tasks.add('tok-1', pipeline_ref='p.pipe')

    result = await registry.handler('monitor')(fake_engine, tasks, {'task_token': 'tok-1'})

    assert result['ok'] is True
    assert result['state'] == 6
    assert result['state_label'] == 'cancelled'
    assert result['terminal'] is True
    assert tasks.get('tok-1') is None


@pytest.mark.asyncio
async def test_monitor_terminates_when_status_completed_flag_true_even_if_state_not_terminal(fake_engine, monkeypatch):
    """A `status.completed` truthy flag is terminal even if `state` itself
    hasn't reached 5/6 -- the spec ORs the two signals.
    """
    _no_sleep(monkeypatch)
    fake_engine._task_statuses = [{'state': 3, 'completed': True}]

    registry = ToolRegistry()
    visibility.register(registry)
    tasks = TaskRegistry()
    tasks.add('tok-1', pipeline_ref='p.pipe')

    result = await registry.handler('monitor')(fake_engine, tasks, {'task_token': 'tok-1'})

    assert result['ok'] is True
    assert result['terminal'] is True
    assert result['completed'] is True
    assert tasks.get('tok-1') is None


@pytest.mark.asyncio
async def test_monitor_always_running_returns_non_terminal_snapshot_at_timeout(fake_engine, monkeypatch):
    """Long-lived sources (e.g. webhook) stay at running(3) forever -- monitor
    must bound the poll by `timeout` and return the current (non-terminal)
    snapshot rather than hang.
    """
    _no_sleep(monkeypatch)
    fake_engine._task_statuses = [{'state': 3, 'completed': False}]

    # A deterministic counter, not a finite iterator: the event loop and
    # pytest internals also read time.monotonic during the test, and a
    # finite clock would make the outcome depend on who reads it first.
    ticks = itertools.count(start=0.0, step=0.5)
    monkeypatch.setattr('time.monotonic', lambda: next(ticks))

    registry = ToolRegistry()
    visibility.register(registry)

    result = await registry.handler('monitor')(fake_engine, None, {'task_token': 'tok-1', 'timeout': 2, 'interval': 1})

    assert result['ok'] is True
    assert result['terminal'] is False
    assert result['state'] == 3
    assert result['state_label'] == 'running'
    assert fake_engine.get_task_status_calls  # at least one poll happened


@pytest.mark.asyncio
async def test_monitor_handles_get_task_status_raising(fake_engine, monkeypatch):
    """`get_task_status` may raise on a terminated/unknown token -- monitor
    must tolerate this and normalize rather than crash.
    """
    _no_sleep(monkeypatch)
    fake_engine._task_statuses = [RuntimeError('task not found')]

    registry = ToolRegistry()
    visibility.register(registry)

    result = await registry.handler('monitor')(fake_engine, None, {'task_token': 'tok-1'})

    assert result['ok'] is False
    assert result['error_type'] == 'RuntimeError'


@pytest.mark.asyncio
async def test_monitor_polls_counter_matches_call_count(fake_engine, monkeypatch):
    _no_sleep(monkeypatch)
    fake_engine._task_statuses = [
        {'state': 1, 'completed': False},
        {'state': 3, 'completed': False},
        {'state': 5, 'completed': True},
    ]

    registry = ToolRegistry()
    visibility.register(registry)
    tasks = TaskRegistry()
    tasks.add('tok-1', pipeline_ref='p.pipe')

    result = await registry.handler('monitor')(fake_engine, tasks, {'task_token': 'tok-1'})

    assert result['polls'] == len(fake_engine.get_task_status_calls) == 3
    assert tasks.get('tok-1') is None


@pytest.mark.asyncio
async def test_monitor_default_counts_when_status_lacks_them(fake_engine, monkeypatch):
    _no_sleep(monkeypatch)
    fake_engine._task_statuses = [{'state': 5, 'completed': True}]

    registry = ToolRegistry()
    visibility.register(registry)
    tasks = TaskRegistry()
    tasks.add('tok-1', pipeline_ref='p.pipe')

    result = await registry.handler('monitor')(fake_engine, tasks, {'task_token': 'tok-1'})

    assert result['counts'] == {'completedCount': 0, 'failedCount': 0, 'totalCount': 0}
    assert result['status'] == {'state': 5, 'completed': True}
    assert tasks.get('tok-1') is None


@pytest.mark.asyncio
async def test_monitor_single_poll_timeout_returns_current_snapshot_not_hard_error(fake_engine, monkeypatch):
    """A single `get_task_status` call exceeding the per-poll budget must not
    surface as a hard error (#2) -- it should break the loop and return the
    current (necessarily non-terminal) snapshot instead.
    """
    _no_sleep(monkeypatch)
    fake_engine._task_statuses = [asyncio.TimeoutError()]

    registry = ToolRegistry()
    visibility.register(registry)
    tasks = TaskRegistry()
    tasks.add('tok-1', pipeline_ref='p.pipe')

    result = await registry.handler('monitor')(fake_engine, tasks, {'task_token': 'tok-1'})

    assert result['ok'] is True
    assert result['terminal'] is False
    # The marker is the only way a caller separates "the poll timed out"
    # from "the engine reports state none".
    assert result['poll_timed_out'] is True
    assert fake_engine.get_task_status_calls == ['tok-1']
    # Not terminal -- the token must remain registered.
    assert tasks.get('tok-1') is not None


# --- list_running_pipelines ---------------------------------------------


@pytest.mark.asyncio
async def test_list_running_pipelines_returns_tasks(fake_engine):
    registry = ToolRegistry()
    visibility.register(registry)

    result = await registry.handler('list_running_pipelines')(fake_engine, None, {})

    assert result['ok'] is True
    assert result['count'] == len(result['tasks'])
    assert result['tasks'][0]['token']


def test_list_running_pipelines_registered():
    registry = ToolRegistry()

    visibility.register(registry)

    assert 'list_running_pipelines' in set(registry.names())


@pytest.mark.asyncio
async def test_monitor_clamps_poll_parameters(fake_engine, monkeypatch):
    """`interval: 0` (or negative) must not busy-loop, and an oversized
    `timeout` is capped — pins the clamps on the caller-supplied bounds.
    """
    slept = []

    async def _record_sleep(seconds):
        slept.append(seconds)

    monkeypatch.setattr(asyncio, 'sleep', _record_sleep)
    # Two non-terminal polls, then terminal so the loop exits.
    fake_engine._task_statuses = [
        {'state': 3, 'completed': False},
        {'state': 3, 'completed': False},
        {'state': 5, 'completed': True},
    ]

    registry = ToolRegistry()
    visibility.register(registry)

    result = await registry.handler('monitor')(
        fake_engine, TaskRegistry(), {'task_token': 'tok-1', 'timeout': 999999, 'interval': 0}
    )

    assert result['ok'] is True
    assert slept, 'expected at least one inter-poll sleep'
    assert all(s >= visibility.MIN_INTERVAL_SECONDS for s in slept)


@pytest.mark.asyncio
async def test_monitor_oversized_timeout_is_clamped_to_max(fake_engine, monkeypatch):
    """A never-terminal task with `timeout: 999999` must stop polling at
    MAX_TIMEOUT_SECONDS. The clamp test above only pins the interval floor
    (its status sequence turns terminal before any deadline applies); this
    one pins the timeout cap itself, deterministically via a fake clock.
    """
    _no_sleep(monkeypatch)
    # Always-running: exhaustion repeats the last status, so the poll loop
    # can only be ended by the (clamped) deadline.
    fake_engine._task_statuses = [{'state': 3, 'completed': False}]

    # Each clock read advances 100s: the MAX_TIMEOUT_SECONDS=300 deadline is
    # crossed within a handful of polls, while an unclamped 999999s deadline
    # would need thousands.
    ticks = itertools.count(start=0.0, step=100.0)
    monkeypatch.setattr('time.monotonic', lambda: next(ticks))

    registry = ToolRegistry()
    visibility.register(registry)

    result = await registry.handler('monitor')(
        fake_engine, None, {'task_token': 'tok-1', 'timeout': 999999, 'interval': 1}
    )

    assert result['ok'] is True
    assert result['terminal'] is False
    assert len(fake_engine.get_task_status_calls) <= 10, 'deadline was not clamped to MAX_TIMEOUT_SECONDS'
