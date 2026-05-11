"""
Unit tests for ai.modules.profiler.profile.WebServerProfiler.

WebServerProfiler wraps cProfile to give a lifecycle (start / stop /
status / get_full_report) usable from HTTP endpoints. The class is pure
state on top of the standard library — no FastAPI involved here. Tests
exercise:

- ``start_profiling`` — happy path, double-start rejection, custom session name.
- ``stop_profiling`` — produces a report dict and clears state, plus the
  "stop with no session" guard.
- ``get_status`` — returns the right shape in both active and inactive states.
- ``get_full_report`` — returns either the cached report or the
  "no data" sentinel.
- ``is_profiling`` — boolean accessor.
- History trimming — only the last 10 profiles are kept.
"""

from __future__ import annotations

from ai.modules.profiler.profile import WebServerProfiler


def _do_some_work() -> int:
    """Light work for the profiler to record. Keeps tests fast (<1ms)."""
    total = 0
    for i in range(50):
        total += i * i
    return total


# ---------------------------------------------------------------------------
# is_profiling
# ---------------------------------------------------------------------------


def test_is_profiling_false_on_fresh_instance():
    """A freshly constructed profiler is not profiling anything."""
    p = WebServerProfiler()
    assert p.is_profiling() is False


def test_is_profiling_true_after_start():
    """is_profiling flips to True between start_profiling and stop_profiling."""
    p = WebServerProfiler()
    p.start_profiling()
    try:
        assert p.is_profiling() is True
    finally:
        p.stop_profiling()
    assert p.is_profiling() is False


# ---------------------------------------------------------------------------
# start_profiling
# ---------------------------------------------------------------------------


def test_start_profiling_default_session_name():
    """Without an explicit name, the session id is derived from the wall clock."""
    p = WebServerProfiler()
    info = p.start_profiling()
    try:
        assert info['status'] == 'started'
        assert info['session'].startswith('session_')
    finally:
        p.stop_profiling()


def test_start_profiling_with_custom_session_name():
    """An explicit session_name overrides the auto-generated id."""
    p = WebServerProfiler()
    info = p.start_profiling('manual-run')
    try:
        assert info['session'] == 'manual-run'
        assert info['status'] == 'started'
        assert 'manual-run' in info['message']
        assert info['start_time'] > 0
    finally:
        p.stop_profiling()


def test_start_profiling_twice_returns_error_status():
    """Starting a second session while one is active returns an error envelope."""
    p = WebServerProfiler()
    p.start_profiling('first')
    try:
        second = p.start_profiling('second')
        assert second['status'] == 'error'
        assert 'already active' in second['error']
        assert second['current_session'] == 'first'
    finally:
        p.stop_profiling()


# ---------------------------------------------------------------------------
# stop_profiling
# ---------------------------------------------------------------------------


def test_stop_without_start_returns_error():
    """stop_profiling on an idle profiler returns an error envelope."""
    p = WebServerProfiler()
    info = p.stop_profiling()
    assert info['status'] == 'error'
    assert 'No active' in info['error']


def test_stop_returns_full_report_record_and_clears_state():
    """A complete start/stop cycle returns a profile record and resets state."""
    p = WebServerProfiler()
    p.start_profiling('cycle')
    _do_some_work()
    info = p.stop_profiling()

    # Shape of the returned dict
    assert info['status'] == 'completed'
    assert info['session'] == 'cycle'
    assert info['runtime'] >= 0
    assert isinstance(info['top_functions'], list)
    assert 'profile_record' in info

    record = info['profile_record']
    assert record['session'] == 'cycle'
    assert 'summary' in record
    assert record['timestamp'] > 0

    # State has been reset.
    assert p.is_profiling() is False
    assert p.session_name is None
    assert p.start_time is None
    assert p.profiler is None

    # The history is now exactly one entry.
    assert len(p.profiles_history) == 1
    assert p.profiles_history[0] is record


def test_stop_caches_full_report_text():
    """After stop, current_profile_data is a non-empty multi-line string."""
    p = WebServerProfiler()
    p.start_profiling('cache-check')
    _do_some_work()
    p.stop_profiling()
    assert p.current_profile_data is not None
    assert 'RocketRide Profile Report' in p.current_profile_data
    assert 'cache-check' in p.current_profile_data


# ---------------------------------------------------------------------------
# get_status
# ---------------------------------------------------------------------------


def test_get_status_inactive_when_no_session():
    """get_status returns 'inactive' shape when no session has been started."""
    p = WebServerProfiler()
    info = p.get_status()
    assert info['status'] == 'inactive'
    assert info['history_count'] == 0
    assert info['last_profiles'] == []


def test_get_status_active_while_session_running():
    """get_status returns 'active' shape while a session is in progress."""
    p = WebServerProfiler()
    p.start_profiling('live')
    try:
        info = p.get_status()
        assert info['status'] == 'active'
        assert info['session'] == 'live'
        assert info['runtime'] >= 0
        assert 'live' in info['message']
    finally:
        p.stop_profiling()


def test_get_status_history_includes_recent_sessions():
    """After stopping a session, the inactive status payload includes it."""
    p = WebServerProfiler()
    p.start_profiling('s1')
    p.stop_profiling()
    info = p.get_status()
    assert info['status'] == 'inactive'
    assert info['history_count'] == 1
    assert info['last_profiles'][0]['session'] == 's1'


# ---------------------------------------------------------------------------
# get_full_report
# ---------------------------------------------------------------------------


def test_get_full_report_returns_sentinel_before_any_session():
    """Calling get_full_report before any session yields the 'no data' string."""
    p = WebServerProfiler()
    assert 'No profiling data' in p.get_full_report()


def test_get_full_report_returns_cached_text_after_stop():
    """After stop, get_full_report returns the cached multi-line report."""
    p = WebServerProfiler()
    p.start_profiling('cached')
    p.stop_profiling()
    out = p.get_full_report()
    assert 'RocketRide Profile Report' in out
    assert 'cached' in out


# ---------------------------------------------------------------------------
# History trimming
# ---------------------------------------------------------------------------


def test_history_keeps_only_last_ten_entries():
    """profiles_history is trimmed to the 10 most-recent sessions."""
    p = WebServerProfiler()
    for i in range(15):
        p.start_profiling(f'session-{i}')
        p.stop_profiling()

    assert len(p.profiles_history) == 10
    # The earliest session that survived is session-5 (15 - 10 = 5).
    assert p.profiles_history[0]['session'] == 'session-5'
    assert p.profiles_history[-1]['session'] == 'session-14'
