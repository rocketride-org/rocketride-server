"""
Unit tests for ai.web.metrics.metrics.MetricsManager.

MetricsManager tracks per-task and per-pipe metrics (timers, counters,
event log). It is a thin layer on top of the Timer primitive (already
covered by test_metrics_timer.py) plus a threading.Lock-protected merge.

Tests construct a **fresh** MetricsManager per case so the global
``metrics`` singleton in ai.web.metrics is never touched.
"""

from __future__ import annotations

import pytest

from ai.web.metrics.metrics import MetricsManager, Timer


# ---------------------------------------------------------------------------
# begin_task / end_task
# ---------------------------------------------------------------------------


def test_begin_task_registers_task_with_metrics_namespace():
    """begin_task creates a metrics dict with timers / counters / events keys."""
    mm = MetricsManager()
    mm.begin_task('t1')

    assert 't1' in mm._task_metrics
    info = mm._task_metrics['t1']
    assert isinstance(info['total_time'], Timer)
    assert info['metrics'] == {'timers': {}, 'counters': {}, 'events': []}


def test_begin_task_twice_with_same_id_raises():
    """begin_task is idempotent-by-error: a duplicate task id raises RuntimeError."""
    mm = MetricsManager()
    mm.begin_task('t1')
    with pytest.raises(RuntimeError, match='already initialized'):
        mm.begin_task('t1')


def test_end_task_pops_the_task_from_registry():
    """end_task removes the task from _task_metrics and stops its total_time timer."""
    mm = MetricsManager()
    mm.begin_task('t1')
    assert 't1' in mm._task_metrics
    mm.end_task('t1')
    assert 't1' not in mm._task_metrics


def test_end_task_unknown_raises():
    """end_task for a non-registered id raises RuntimeError."""
    mm = MetricsManager()
    with pytest.raises(RuntimeError, match='not initialized'):
        mm.end_task('does-not-exist')


# ---------------------------------------------------------------------------
# begin_object / end_object — per-pipe metrics
# ---------------------------------------------------------------------------


def test_begin_object_creates_pipe_metrics_with_cpu_timer():
    """begin_object registers a pipe and seeds a 'cpu' timer."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)

    assert 42 in mm._pipe_metrics
    pipe = mm._pipe_metrics[42]
    assert isinstance(pipe['timers']['cpu'], Timer)
    assert pipe['counters'] == {'request': 1}  # auto-incremented on begin_object
    assert pipe['events'] == []


def test_begin_object_duplicate_pipe_raises():
    """A duplicate pipe id raises RuntimeError."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)
    with pytest.raises(RuntimeError, match='already initialized for pipe'):
        mm.begin_object('t1', pipe_id=42)


def test_end_object_removes_pipe_and_merges_into_task():
    """end_object stops timers, pops the pipe, and merges counters/timers into the task."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)
    mm.counter(42, 'rows', 7)

    mm.end_object('t1', pipe_id=42)
    assert 42 not in mm._pipe_metrics

    task_counters = mm._task_metrics['t1']['metrics']['counters']
    # request=1 was auto-counted by begin_object, plus the rows=7 we added.
    assert task_counters['request'] == 1
    assert task_counters['rows'] == 7


def test_end_object_unknown_pipe_raises():
    """end_object for a pipe that was never begun raises RuntimeError."""
    mm = MetricsManager()
    mm.begin_task('t1')
    with pytest.raises(RuntimeError, match='not initialized for pipe'):
        mm.end_object('t1', pipe_id=99)


def test_end_object_unknown_task_raises():
    """end_object when the task is gone raises RuntimeError."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)
    mm.end_task('t1')  # remove the task
    with pytest.raises(RuntimeError, match='not initialized for task'):
        mm.end_object('t1', pipe_id=42)


# ---------------------------------------------------------------------------
# counter / event
# ---------------------------------------------------------------------------


def test_counter_increments_per_pipe():
    """counter() adds to the named counter on the pipe."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)
    mm.counter(42, 'rows', 5)
    mm.counter(42, 'rows', 3)
    mm.counter(42, 'errors', 1)
    assert mm._pipe_metrics[42]['counters']['rows'] == 8
    assert mm._pipe_metrics[42]['counters']['errors'] == 1


def test_counter_on_unknown_pipe_raises():
    """counter() against a pipe that has not been begun raises RuntimeError."""
    mm = MetricsManager()
    with pytest.raises(RuntimeError, match='not initialized for pipe'):
        mm.counter(99, 'rows', 1)


def test_event_appends_to_pipe_event_log():
    """event() appends to the pipe's event list."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)
    mm.event(42, {'kind': 'audit', 'msg': 'hello'})
    mm.event(42, {'kind': 'audit', 'msg': 'world'})
    assert mm._pipe_metrics[42]['events'] == [
        {'kind': 'audit', 'msg': 'hello'},
        {'kind': 'audit', 'msg': 'world'},
    ]


# ---------------------------------------------------------------------------
# Timer control API per pipe
# ---------------------------------------------------------------------------


def test_start_timer_creates_named_timer_on_demand():
    """start_timer creates a timer for an unknown resource and starts it."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)
    mm.start_timer(42, 'gpu')
    assert 'gpu' in mm._pipe_metrics[42]['timers']


def test_stop_timer_only_stops_known_resources():
    """stop_timer is a no-op for an unknown resource (no exception)."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)
    mm.stop_timer(42, 'never-started')  # must not raise


def test_pause_resume_timer_does_not_double_count(monkeypatch):
    """Pausing then resuming a timer skips the paused interval."""
    import sys

    metrics_mod = sys.modules['ai.web.metrics.metrics']

    clock = [0.0]
    monkeypatch.setattr(metrics_mod.time, 'perf_counter', lambda: clock[0])

    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)

    timer = mm._pipe_metrics[42]['timers']['cpu']
    # The cpu timer was created with autostart=False inside begin_object,
    # so start it now via the public API.
    clock[0] = 0.0
    mm.start_timer(42, 'cpu')
    clock[0] = 1.0
    mm.pause_timer(42, 'cpu')
    clock[0] = 5.0  # 4 paused seconds
    mm.resume_timer(42, 'cpu')
    clock[0] = 7.0
    mm.stop_timer(42, 'cpu')

    # 1.0 s before pause + 2.0 s after resume = 3.0 s = 3000 ms
    assert timer.total() == pytest.approx(3000.0)


# ---------------------------------------------------------------------------
# resource() context manager
# ---------------------------------------------------------------------------


def test_resource_context_starts_and_stops_named_timer():
    """The ``resource`` context manager auto-starts and auto-stops the timer."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)

    with mm.resource(42, 'gpu'):
        timer = mm._pipe_metrics[42]['timers']['gpu']
        assert timer.start_time is not None

    # After the block exits the timer is stopped.
    assert timer.start_time is None


def test_resource_context_stops_timer_on_exception():
    """If the body raises, the resource context still stops the timer."""
    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)

    with pytest.raises(ValueError):
        with mm.resource(42, 'gpu'):
            raise ValueError('boom')

    timer = mm._pipe_metrics[42]['timers']['gpu']
    assert timer.start_time is None


# ---------------------------------------------------------------------------
# pause_all() context manager
# ---------------------------------------------------------------------------


def test_pause_all_pauses_running_timers_only(monkeypatch):
    """pause_all only pauses timers that are currently running; idle timers stay idle."""
    import sys

    metrics_mod = sys.modules['ai.web.metrics.metrics']

    clock = [0.0]
    monkeypatch.setattr(metrics_mod.time, 'perf_counter', lambda: clock[0])

    mm = MetricsManager()
    mm.begin_task('t1')
    mm.begin_object('t1', pipe_id=42)
    mm.start_timer(42, 'cpu')  # running
    mm.start_timer(42, 'gpu')
    mm.stop_timer(42, 'gpu')  # idle

    cpu_timer = mm._pipe_metrics[42]['timers']['cpu']
    gpu_timer = mm._pipe_metrics[42]['timers']['gpu']

    with mm.pause_all(42):
        assert cpu_timer.paused is True
        # gpu was idle to begin with, so it's not flagged paused.
        assert gpu_timer.paused is False

    # After the block exits, the previously-paused timer is resumed.
    assert cpu_timer.paused is False
