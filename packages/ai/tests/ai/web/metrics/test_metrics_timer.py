"""
Unit tests for ai.web.metrics.metrics.Timer.

Timer is a small stateful arithmetic class on top of time.perf_counter. It is
the primitive used by the rest of the metrics machinery (counters, events,
context managers). These tests pin the start / stop / pause / resume / reset
state machine and the elapsed() / total() ms conversions by patching
time.perf_counter so the assertions are deterministic.
"""

import sys

import pytest

# Import the submodule directly. `from ai.web.metrics import metrics` would
# return the global MetricsManager() INSTANCE (re-exported by
# ai/web/metrics/__init__.py), not the module — and we need to patch
# ``time.perf_counter`` on the module's own ``time`` reference.
from ai.web.metrics.metrics import Timer  # noqa: F401 — forces submodule load

metrics_mod = sys.modules['ai.web.metrics.metrics']


@pytest.fixture
def fake_clock(monkeypatch):
    """
    Replace time.perf_counter with a controllable counter.

    Returns a list whose first element is the current 'time' in seconds. Tests
    advance time by mutating fake_clock[0]. perf_counter is patched on the
    metrics module's time reference so the Timer picks it up.

    Args:
        monkeypatch: pytest's monkeypatch fixture, used to swap the time module
            attribute for the duration of the test.

    Returns:
        list: one-element list holding the current fake time in seconds.
    """
    clock = [0.0]
    monkeypatch.setattr(metrics_mod.time, 'perf_counter', lambda: clock[0])
    return clock


# ---------------------------------------------------------------------------
# Construction
# ---------------------------------------------------------------------------


def test_init_autostart_default_starts_running(fake_clock):
    """Timer() with no args is running immediately (start_time set, paused=False)."""
    fake_clock[0] = 10.0
    t = Timer()
    assert t.start_time == 10.0
    assert t.paused is False
    assert t.total_time == 0.0
    assert t.elapsed_time == 0.0


def test_init_autostart_false_is_idle(fake_clock):
    """Timer(autostart=False) is idle: start_time is None until start() is called."""
    fake_clock[0] = 10.0
    t = Timer(autostart=False)
    assert t.start_time is None
    assert t.paused is False


# ---------------------------------------------------------------------------
# elapsed() / total() conversions
# ---------------------------------------------------------------------------


def test_elapsed_returns_milliseconds_while_running(fake_clock):
    """elapsed() includes the currently-running interval and returns ms (×1000)."""
    fake_clock[0] = 0.0
    t = Timer()  # start_time = 0.0
    fake_clock[0] = 1.5
    assert t.elapsed() == pytest.approx(1500.0)


def test_total_returns_milliseconds_while_running(fake_clock):
    """total() also includes the currently-running interval and returns ms."""
    fake_clock[0] = 0.0
    t = Timer()
    fake_clock[0] = 2.0
    assert t.total() == pytest.approx(2000.0)


def test_elapsed_zero_when_idle(fake_clock):
    """An idle (autostart=False, never started) timer reports 0 elapsed ms."""
    t = Timer(autostart=False)
    assert t.elapsed() == 0.0
    assert t.total() == 0.0


# ---------------------------------------------------------------------------
# stop() — accumulates and clears start_time
# ---------------------------------------------------------------------------


def test_stop_accumulates_elapsed_and_clears_start(fake_clock):
    """stop() rolls the current run into total_time / elapsed_time and goes idle."""
    fake_clock[0] = 0.0
    t = Timer()
    fake_clock[0] = 1.0
    t.stop()
    assert t.start_time is None
    assert t.elapsed_time == pytest.approx(1.0)
    assert t.total_time == pytest.approx(1.0)
    # After stop, elapsed() reports stored ms, no live increment.
    fake_clock[0] = 5.0
    assert t.elapsed() == pytest.approx(1000.0)


def test_stop_when_idle_is_a_noop(fake_clock):
    """Calling stop() on an idle timer does not move total_time."""
    t = Timer(autostart=False)
    t.stop()
    assert t.total_time == 0.0
    assert t.elapsed_time == 0.0


# ---------------------------------------------------------------------------
# pause() / resume()
# ---------------------------------------------------------------------------


def test_pause_then_resume_does_not_double_count(fake_clock):
    """Time spent in the paused state must not be added to total_time."""
    fake_clock[0] = 0.0
    t = Timer()  # running
    fake_clock[0] = 1.0
    t.pause()  # accumulates 1.0 s, paused=True
    assert t.paused is True
    assert t.total_time == pytest.approx(1.0)

    # 4 seconds of paused wall-clock — must NOT be counted.
    fake_clock[0] = 5.0
    t.resume()  # paused=False, start_time = 5.0
    assert t.paused is False

    fake_clock[0] = 6.0
    t.stop()  # adds 1.0 more second
    assert t.total_time == pytest.approx(2.0)


def test_total_includes_running_interval_after_resume(fake_clock):
    """After resume(), total() reflects accumulated + currently-running time."""
    fake_clock[0] = 0.0
    t = Timer()
    fake_clock[0] = 1.0
    t.pause()
    fake_clock[0] = 10.0
    t.resume()
    fake_clock[0] = 12.0
    # 1.0 s before pause + 2.0 s after resume = 3.0 s = 3000 ms
    assert t.total() == pytest.approx(3000.0)


# ---------------------------------------------------------------------------
# reset()
# ---------------------------------------------------------------------------


def test_reset_clears_all_state(fake_clock):
    """reset() returns the timer to its post-construction idle state."""
    fake_clock[0] = 0.0
    t = Timer()
    fake_clock[0] = 1.0
    t.stop()
    assert t.total_time == pytest.approx(1.0)

    t.reset()
    assert t.total_time == 0.0
    assert t.elapsed_time == 0.0
    assert t.start_time is None
    assert t.paused is False


# ---------------------------------------------------------------------------
# start() guard rails
# ---------------------------------------------------------------------------


def test_start_is_noop_when_already_running(fake_clock):
    """start() must not reset start_time on an already-running timer."""
    fake_clock[0] = 0.0
    t = Timer()  # start_time = 0.0
    fake_clock[0] = 5.0
    t.start()  # should be a no-op
    assert t.start_time == 0.0  # unchanged


def test_start_does_not_resume_a_paused_timer(fake_clock):
    """start() refuses to act on a paused timer (resume() is the right path)."""
    fake_clock[0] = 0.0
    t = Timer()
    fake_clock[0] = 1.0
    t.pause()
    fake_clock[0] = 3.0
    t.start()
    assert t.start_time is None  # paused timer stays idle until resume()


def test_start_after_stop_starts_a_fresh_run(fake_clock):
    """After stop(), start() begins a new run from the current clock."""
    fake_clock[0] = 0.0
    t = Timer()
    fake_clock[0] = 1.0
    t.stop()
    fake_clock[0] = 10.0
    t.start()
    assert t.start_time == 10.0
    fake_clock[0] = 11.0
    # 1.0 s already accumulated plus 1.0 s of new run = 2000 ms
    assert t.total() == pytest.approx(2000.0)
