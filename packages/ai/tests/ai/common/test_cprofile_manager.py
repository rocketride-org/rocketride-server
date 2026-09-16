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

"""Unit tests for CProfileManager.register_current_thread().

DETERMINISM: no yappi session involving a "cold" thread (one whose Python
thread state is created after start()) runs inside the pytest process.
yappi's late-thread pickup is nondeterministic when another Python thread
runs concurrently — measured: a lone busy thread never picks a cold thread
up, but a second concurrently-running hooked thread picks it up completely.
pytest always has extra threads (xdist I/O, timeout watchdog, ...), so a
cold-thread session here would flip between 0 and N between runs.

Every cold-thread scenario therefore runs in a subprocess this test owns,
which asserts it is the only Python thread before starting a session. The
lock-ownership invariant (register + both stop paths mutate yappi only
while _lock is held) is checked structurally, in-process, with no threads.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import pytest
import yappi

from ai.common.cprofile_manager import _COLUMNS, CProfileManager, profiler

# Rows are fixed-width, so the numeric columns start right after the name one.
# Taken from the module rather than hardcoded: the width is a tuning knob.
_NAME_WIDTH = _COLUMNS[0][1]

# Source tree root (.../packages/ai/src), derived from THIS test file so a
# subprocess imports the code under test rather than the dist copy that sits
# next to the engine binary.  __file__ = .../packages/ai/tests/ai/common/<this>
_SRC_ROOT = str(Path(__file__).resolve().parents[3] / 'src')

_CHILD_TIMEOUT = 60.0

# Windows STATUS_ACCESS_VIOLATION, as a raw process exit code
_ACCESS_VIOLATION = 0xC0000005


@pytest.fixture(autouse=True)
def _reset_profiler():
    """Reset process-global profiler / yappi / sys.setprofile after each test.

    yappi, sys.setprofile and the ``profiler`` singleton are process-global; a
    leaked session would run every later test in this worker ~12x slower under
    an active profiler.
    """
    try:
        yield
    finally:
        try:
            if yappi.is_running():
                yappi.stop()
            yappi.clear_stats()
        except Exception:
            pass
        sys.setprofile(None)
        profiler._active = False
        profiler._owner_id = None
        profiler._session_name = None
        profiler._start_time = None
        profiler._last_report = None
        profiler._last_stats_data = None
        profiler._last_thread_data = None


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------


def _run_child(script: str, *args: str, timeout: float = _CHILD_TIMEOUT) -> subprocess.CompletedProcess:
    """Run ``script`` under the current interpreter with ``args``."""
    try:
        return subprocess.run(
            [sys.executable, '-c', script, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:  # pragma: no cover - failure path
        pytest.fail(f'child timed out after {timeout}s\nstdout={exc.stdout!r}\nstderr={exc.stderr!r}')


def _child_json(cp: subprocess.CompletedProcess) -> dict:
    """Parse the last non-empty stdout line of a child as JSON."""
    lines = [ln for ln in cp.stdout.splitlines() if ln.strip()]
    assert lines, f'child produced no JSON result\nrc={cp.returncode}\nstdout={cp.stdout!r}\nstderr={cp.stderr!r}'
    result = json.loads(lines[-1])
    assert result.get('error') != 'not_alone', (
        f'child was not the only Python thread (frames={result.get("frames")}); determinism precondition broken'
    )
    # The engine binary ships its own copy of the package next to it; without
    # this the child could silently profile dist code instead of the source
    src = result.get('src')
    assert src is None or src.startswith(_SRC_ROOT), (
        f'child imported the wrong copy of cprofile_manager: {src!r} is not under {_SRC_ROOT!r}'
    )
    return result


# Cold worker calls a marker N times; a control run leaves it unregistered, a
# treatment run registers it first.  Config comes via argv so the script body
# has no literal-brace escaping.
_CAPTURE_CHILD = r"""
import json, sys, _thread, threading
sys.path.insert(0, sys.argv[1])
import yappi
from ai.common import cprofile_manager as cm
from ai.common.cprofile_manager import profiler as p

mode, N = sys.argv[2], int(sys.argv[3])
if len(sys._current_frames()) != 1:
    print(json.dumps({'error': 'not_alone', 'frames': len(sys._current_frames())}))
    sys.exit(3)

def marker():
    return 1

done = threading.Event()
box = {}

def worker():
    if mode == 'treatment':
        box['registered'] = p.register_current_thread()
    for _ in range(N):
        marker()
    done.set()

p.start('child', session=mode)
_thread.start_new_thread(worker, ())
if not done.wait(30):
    print(json.dumps({'error': 'worker_timeout'}))
    sys.exit(4)
p.stop('child')

data = p._last_stats_data or []
ncall = sum(e['ncall'] for e in data if e['key'][2] == 'marker')
print(json.dumps({'ncall': ncall, 'entries': len(data),
                  'registered': box.get('registered'), 'src': cm.__file__}))
"""


# NOTE: there is deliberately no sys.getprofile() probe of the registered
# thread.  On its first event yappi transplants a C-level callback into the
# thread state, after which sys.getprofile() reports None *while actively
# profiled* — so it cannot distinguish hooked from unhooked.  Capture itself
# (control vs treatment) is the observable that matters, and the stop-path
# unhook is covered structurally by test_yappi_mutations_happen_under_lock.


# Reproduces the crash the lock exists to prevent: install the bootstrap on a
# fresh thread AFTER stats have been cleared -> the next event dereferences
# freed yappi state.  Self-contained (no manager) so it documents the raw
# hazard.  Run on win32 only — see the skipif below for why, it is a choice
# rather than a platform limit.
_CRASH_CHILD = r"""
import sys, threading, yappi

def noop():
    pass

yappi.start()
yappi.stop()
yappi.clear_stats()
print('armed', flush=True)

def worker():
    sys.setprofile(yappi._profile_thread_callback)
    for _ in range(20000):
        noop()

t = threading.Thread(target=worker)
t.start()
t.join()
print('survived')
"""


# Three threads, each calling its own marker, two of them also a shared one:
# the main thread, a threading.Thread, and a cold engine-style worker that
# names itself and then registers — the order setupDebug()/setupProfiler() use.
_THREADS_CHILD = r"""
import json, sys, _thread, threading
sys.path.insert(0, sys.argv[1])
from ai.common import cprofile_manager as cm
from ai.common.cprofile_manager import profiler as p

if len(sys._current_frames()) != 1:
    print(json.dumps({'error': 'not_alone', 'frames': len(sys._current_frames())}))
    sys.exit(3)

MARKERS = ('main_marker', 'thread_marker', 'engine_marker', 'shared_marker')

def main_marker():
    return 1

def thread_marker():
    return 1

def engine_marker():
    return 1

def shared_marker():
    return 1

def plain_worker():
    for _ in range(20):
        thread_marker()
    for _ in range(3):
        shared_marker()

done = threading.Event()

def engine_worker():
    threading.current_thread().name = 'engine-worker-7'
    p.register_current_thread()
    for _ in range(30):
        engine_marker()
    for _ in range(4):
        shared_marker()
    done.set()

threading.current_thread().name = 'main-thread'
p.start('child', session='threads')
for _ in range(10):
    main_marker()
t = threading.Thread(target=plain_worker, name='plain-worker')
t.start()
t.join()
_thread.start_new_thread(engine_worker, ())
if not done.wait(30):
    print(json.dumps({'error': 'worker_timeout'}))
    sys.exit(4)
p.stop('child')

def tree_names(node, out):
    out.add(node['name'])
    for child in node['children']:
        tree_names(child, out)
    return out

def marker_counts(entries):
    return {m: sum(e['ncall'] for e in entries if e['key'][2] == m) for m in MARKERS}

per_thread = {}
for t in p._last_thread_data:
    tree = p.report_tree(max_depth=500, min_pct=0, thread=t['id'])['tree']
    per_thread[t['name']] = {
        'id': t['id'],
        'counts': marker_counts(t['stats']),
        'tree_markers': sorted(tree_names(tree, set()) & set(MARKERS)),
        'functions': len(t['stats']),
        'calls': sum(e['ncall'] for e in t['stats']),
    }
print(json.dumps({'threads': p.threads()['threads'], 'per_thread': per_thread,
                  'flat': marker_counts(p._last_stats_data), 'src': cm.__file__}))
"""


# ---------------------------------------------------------------------------
# In-process tests (no cold thread involved)
# ---------------------------------------------------------------------------


def test_register_no_session_is_noop():
    """No active session: returns False and installs no profile hook."""
    assert not yappi.is_running()
    before = sys.getprofile()
    assert profiler.register_current_thread() is False
    assert sys.getprofile() is before


def test_yappi_internal_symbols_present():
    """Pin the private yappi symbols the fix depends on, so a vendored bump
    fails loudly here rather than silently breaking registration.
    """
    assert hasattr(yappi, '_profile_thread_callback')
    assert hasattr(yappi, 'is_running')


def test_yappi_mutations_happen_under_lock(monkeypatch):
    """Register + both stop paths must touch yappi only while _lock is held.

    Structural check (better than a timed race): record ``_lock._is_owned()``
    at every point that installs the profile hook or clears stats, drive a
    stop()-ended and a release()-ended session, and assert the lock was always
    owned by the calling thread.  Since _lock serializes, that is exactly the
    atomicity guarantee — a concurrent stop cannot interleave with an install.
    """
    seen: list[tuple[str, bool]] = []
    real_setprofile = sys.setprofile
    real_clear = yappi.clear_stats
    this_thread = threading.get_ident()

    def rec_setprofile(fn):
        # threading.py calls sys.setprofile in every Thread bootstrap, so record
        # only this thread — another thread starting here is not our install
        if threading.get_ident() == this_thread:
            seen.append(('setprofile', profiler._lock._is_owned()))
        real_setprofile(fn)

    def rec_clear():
        seen.append(('clear_stats', profiler._lock._is_owned()))
        real_clear()

    monkeypatch.setattr(sys, 'setprofile', rec_setprofile)
    monkeypatch.setattr(yappi, 'clear_stats', rec_clear)

    profiler.start('owner')
    assert profiler.register_current_thread() is True
    profiler.stop('owner')  # stop path: clears stats

    profiler.start('owner2')
    profiler.release('owner2')  # release path: clears stats

    assert seen, 'no yappi state mutation was observed'
    assert any(op == 'setprofile' for op, _ in seen), 'register never installed the hook'
    unlocked = [op for op, owned in seen if not owned]
    assert not unlocked, f'yappi state mutated without holding _lock: {unlocked}'


# ---------------------------------------------------------------------------
# Subprocess tests (cold thread, owned quiet child)
# ---------------------------------------------------------------------------


def test_cold_thread_control_is_invisible():
    """A cold worker that never registers is invisible to yappi (the bug).

    Permanent characterization, true before and after the fix — and the proof
    that this harness still discriminates: if it ever reports 500, yappi or the
    environment changed and a green treatment means nothing.  Do not "fix" it.
    """
    result = _child_json(_run_child(_CAPTURE_CHILD, _SRC_ROOT, 'control', '500'))
    # Without this, a session that silently failed to start also reports 0
    assert result['entries'] > 0, f'profiler captured nothing at all, so 0 proves nothing: {result}'
    assert result['ncall'] == 0, result


def test_cold_thread_treatment_is_captured():
    """A cold worker that registers first is fully captured (the fix)."""
    result = _child_json(_run_child(_CAPTURE_CHILD, _SRC_ROOT, 'treatment', '500'))
    assert result['registered'] is True
    assert result['ncall'] == 500, result


@pytest.mark.skipif(
    sys.platform != 'win32',
    # It reproduces on Linux too — measured SIGSEGV on Ubuntu 22.04 (3.10) and
    # 26.04 (3.14). Kept win32-only anyway: whether a use-after-free faults at
    # all is an allocator and layout accident, so gating three CI distros on it
    # buys a demonstration at the price of a flake, and each Linux run would
    # leave a core dump behind where only *.mdmp is cleaned up.
    reason='win32 only by choice: the lock guarantee itself is covered '
    'cross-platform by test_yappi_mutations_happen_under_lock',
)
def test_unlocked_install_after_clear_crashes():
    """The shape the lock prevents: installing the bootstrap after stats were
    cleared crashes the process.  Documents WHY the lock is mandatory.
    """
    temp = Path(tempfile.gettempdir())
    before = set(temp.glob('*.mdmp'))
    cp = _run_child(_CRASH_CHILD)
    # the engine drops a minidump per crash; remove any this child created
    for dump in set(temp.glob('*.mdmp')) - before:
        try:
            dump.unlink()
        except OSError:
            pass

    out = cp.stdout + cp.stderr
    assert 'armed' in cp.stdout, f'child died before reaching the hazard: rc={cp.returncode}\n{out}'
    assert 'survived' not in cp.stdout, (
        'the use-after-free no longer reproduces; re-check that the lock is still needed'
    )
    # Assert the access violation itself, not merely a non-zero exit: the engine
    # binary's SEH handler reports 0xc0000005 as exit code 1, which any ordinary
    # child-side error (ImportError, AttributeError) also produces
    assert cp.returncode & 0xFFFFFFFF == _ACCESS_VIOLATION or '0xc0000005' in out.lower(), (
        f'child failed without an access violation: rc={cp.returncode}\n{out}'
    )


# ---------------------------------------------------------------------------
# Text report, built lazily by report()
# ---------------------------------------------------------------------------
#
# These start sessions in-process, but only ever call the marker on the test's
# own (already hooked) thread, so the determinism rule above does not apply.
#
# Assertions are on substance — header fields, section order, sort order,
# call counts — never on exact text.  The format deliberately changed when the
# build moved out of stop(), and nothing parses it (ReportText.tsx renders it
# verbatim in a <pre>), so pinning bytes would only create churn.


# Name kept short and distinctive so it survives the name column trim
def report_marker():
    """Marker whose call count must show up in the report."""
    return 1


def _section_rows(report_text: str, title: str) -> list[str]:
    """Return the data rows of one report section (title, rule, header skipped)."""
    lines = report_text.splitlines()
    start = lines.index(f'{title}:') + 3
    rows = []
    for line in lines[start:]:
        if not line.strip():
            break
        rows.append(line)
    return rows


def _columns(row: str) -> list[str]:
    """Split a data row's numeric columns: [ncall, tsub, ttot, tavg]."""
    return row[_NAME_WIDTH:].split()


def _run_session(owner: str, session: str, calls: int = 50) -> None:
    """Profile ``calls`` marker invocations on this (hooked) thread."""
    profiler.start(owner, session=session)
    for _ in range(calls):
        report_marker()
    assert profiler.stop(owner)['status'] == 'completed'


def test_report_before_any_session_is_fallback():
    """No session has ever completed: the original placeholder is preserved."""
    assert profiler.report()['report'] == 'No profiling data available. Run a session first.'
    assert profiler.status()['has_report'] is False


def test_report_header_and_sections():
    """Header carries the session's own metadata; both sections are present."""
    _run_session('owner-1', 'session-1')

    assert profiler.status()['has_report'] is True
    text = profiler.report()['report']
    lines = text.splitlines()

    assert lines[0] == 'Session: session-1'
    assert lines[1] == 'Owner: owner-1'
    assert lines[2].startswith('Duration: ') and lines[2].endswith('s')
    # start() defaults to wall, and yappi's own default is not wall — so the
    # clock the numbers came from has to be stated, not assumed
    assert lines[3] == 'Clock: wall'
    assert 'FUNCTIONS BY CUMULATIVE TIME:' in text
    assert 'TOP 30 BY TOTAL TIME:' in text


def test_report_counts_every_call():
    """The marker appears with the exact number of calls made."""
    _run_session('owner-1', 'session-1', calls=50)

    rows = _section_rows(profiler.report()['report'], 'FUNCTIONS BY CUMULATIVE TIME')
    marked = [r for r in rows if 'report_marker' in r]
    assert len(marked) == 1, f'expected exactly one marker row, got {marked}'
    assert _columns(marked[0])[0] == '50'


def test_builtin_rows_keep_yappis_dotted_name():
    """Builtins read 'builtins.sum', not 'builtins:0 sum'.

    yappi names them with a dot and no line number (yappi.py:167), and the
    manager profiles with builtins=True, so these rows are common. The captured
    dicts must therefore carry the builtin flag — the key tuple alone cannot
    reconstruct the name.
    """
    profiler.start('owner-1', session='session-1')
    for _ in range(50):
        sum(range(10))
    profiler.stop('owner-1')

    rows = _section_rows(profiler.report()['report'], 'FUNCTIONS BY CUMULATIVE TIME')
    assert any(r.startswith('builtins.sum') for r in rows), rows[:5]
    assert not any(r.startswith('builtins:0 ') for r in rows), rows[:5]


def test_report_sections_are_sorted_descending():
    """Captured data arrives unordered, so each section must sort explicitly."""
    _run_session('owner-1', 'session-1')
    text = profiler.report()['report']

    # [ncall, tsub, ttot, tavg] — cumulative section sorts on ttot
    cumulative = [float(_columns(r)[2]) for r in _section_rows(text, 'FUNCTIONS BY CUMULATIVE TIME')]
    assert cumulative == sorted(cumulative, reverse=True), cumulative

    # ... and the top section on tsub
    total = [float(_columns(r)[1]) for r in _section_rows(text, 'TOP 30 BY TOTAL TIME')]
    assert total == sorted(total, reverse=True), total
    assert len(total) <= 30


def test_top_section_is_capped_at_30():
    """The top section stays capped however many functions were profiled."""
    profiler.start('owner-1', session='session-1')
    # Enough distinct code objects to exceed the cap
    for i in range(40):
        exec(compile(f'def _f{i}():\n    return {i}\n_f{i}()', '<generated>', 'exec'), {})
    profiler.stop('owner-1')

    text = profiler.report()['report']
    assert len(_section_rows(text, 'FUNCTIONS BY CUMULATIVE TIME')) > 30
    assert len(_section_rows(text, 'TOP 30 BY TOTAL TIME')) == 30


def test_report_is_cached_and_follows_the_latest_session():
    """Second call returns the cached text; a new session replaces it."""
    _run_session('owner-1', 'session-1')
    first = profiler.report()['report']
    assert profiler._last_report is not None, 'report was not cached'
    assert profiler.report()['report'] == first

    _run_session('owner-2', 'session-2')
    assert profiler._last_report is None, 'stop() must invalidate the cached text'
    second = profiler.report()['report']
    assert 'Session: session-2' in second
    assert 'Owner: owner-2' in second


def test_concurrent_reports_agree():
    """Two threads building at once may both build; both must agree."""
    _run_session('owner-1', 'session-1')

    results: list[str] = []
    barrier = threading.Barrier(2)

    def grab():
        barrier.wait()
        results.append(profiler.report()['report'])

    threads = [threading.Thread(target=grab) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
        assert not t.is_alive(), 'report() deadlocked'

    assert len(results) == 2
    assert results[0] == results[1]


def test_report_straddling_a_new_session_is_not_cached(monkeypatch):
    """A build that straddles a later stop() returns its text but must not cache it.

    Without the _session_seq check, this report — built from session-1 data —
    would land in the cache slot now owned by session-2, and every later
    report() would return the wrong session's text forever.
    """
    _run_session('owner-1', 'session-1')

    real_build = CProfileManager._build_text_report_from_data
    straddled = []

    def build_then_land_a_new_session(stats_data, session_name, owner_id, runtime, clock_type=None):
        text = real_build(stats_data, session_name, owner_id, runtime, clock_type)
        # Only once, and only for the call under test
        if not straddled:
            straddled.append(session_name)
            _run_session('owner-2', 'session-2')
        return text

    monkeypatch.setattr(
        CProfileManager,
        '_build_text_report_from_data',
        staticmethod(build_then_land_a_new_session),
    )

    text = profiler.report()['report']

    assert straddled == ['session-1'], 'the straddle never happened; test proves nothing'
    # Correct answer for the session that was current when the call arrived
    assert 'Session: session-1' in text
    # ... but session-2 owns the cache slot now, so nothing was stored
    assert profiler._last_report is None, 'stale text was cached over a newer session'


def test_empty_stats_data_builds_a_valid_report():
    """A session with nothing profiled formats rather than raising."""
    text = CProfileManager._build_text_report_from_data([], 'empty', 'owner-1', 0.0, 'wall')

    assert text.splitlines()[0] == 'Session: empty'
    assert 'FUNCTIONS BY CUMULATIVE TIME:' in text
    assert 'TOP 30 BY TOTAL TIME:' in text
    assert _section_rows(text, 'FUNCTIONS BY CUMULATIVE TIME') == []


# ---------------------------------------------------------------------------
# Thread breakdown — threads() and report_tree(thread=...)
# ---------------------------------------------------------------------------


@pytest.fixture(scope='module')
def threads_child() -> dict:
    """One run of the three-thread child, shared by the tests that read it.

    An owned child: the cold worker makes it a cold-thread session.
    """
    return _child_json(_run_child(_THREADS_CHILD, _SRC_ROOT))


def test_thread_breakdown_keeps_each_threads_calls_apart(threads_child):
    """Each thread's stats and tree hold its own calls, under its own name."""
    result = threads_child
    per_thread = result['per_thread']

    # Named from Thread.name; yappi's default would call two of these 'Thread'
    # and '_DummyThread', and the dict above would collapse them
    assert set(per_thread) == {'main-thread', 'plain-worker', 'engine-worker-7'}, per_thread

    # Exact counts per thread: the shared function is split, not duplicated
    no_calls = dict.fromkeys(('main_marker', 'thread_marker', 'engine_marker', 'shared_marker'), 0)
    assert per_thread['main-thread']['counts'] == {**no_calls, 'main_marker': 10}
    assert per_thread['plain-worker']['counts'] == {**no_calls, 'thread_marker': 20, 'shared_marker': 3}
    assert per_thread['engine-worker-7']['counts'] == {**no_calls, 'engine_marker': 30, 'shared_marker': 4}
    assert result['flat']['shared_marker'] == 7

    # Thread 0 is real, and the exact counts above then prove it was not handed
    # every thread's functions — what get_func_stats(ctx_id=0) does
    assert [name for name, t in per_thread.items() if t['id'] == 0], per_thread

    # Each tree is built from that thread's stats alone
    assert per_thread['main-thread']['tree_markers'] == ['main_marker']
    assert per_thread['plain-worker']['tree_markers'] == ['shared_marker', 'thread_marker']
    assert per_thread['engine-worker-7']['tree_markers'] == ['engine_marker', 'shared_marker']


def test_threads_listing_matches_the_captured_data(threads_child):
    """threads() summarises exactly what was captured, busiest first."""
    per_thread = threads_child['per_thread']
    listed = threads_child['threads']

    assert {t['name'] for t in listed} == set(per_thread)
    for thread in listed:
        captured = per_thread[thread['name']]
        assert thread['id'] == captured['id']
        assert thread['functions'] == captured['functions']
        assert thread['calls'] == captured['calls']
        # Names are not unique in general; the tid is what tells threads apart
        assert isinstance(thread['tid'], int) and thread['tid'] > 0, thread

    ttots = [t['ttot'] for t in listed]
    assert ttots == sorted(ttots, reverse=True), listed


def test_threads_before_any_session_is_empty():
    """No session has completed: an empty list and the usual placeholder."""
    result = profiler.threads()

    assert result['threads'] == []
    assert result['error'] == 'No profiling data available. Run a session first.'


def test_report_tree_of_one_thread():
    """The id threads() lists selects that thread's tree; None keeps them all.

    In-process, so other pytest threads may be in the session too — the test
    only relies on the thread it ran report_marker on.
    """
    _run_session('owner-1', 'session-1', calls=50)

    # Our thread, found by its system thread id rather than by name
    listed = profiler.threads()['threads']
    ours = [t for t in listed if t['tid'] == threading.get_ident()]
    assert len(ours) == 1, listed

    tree = profiler.report_tree(min_pct=0, thread=ours[0]['id'])
    assert 'error' not in tree, tree
    assert tree['total_calls'] == ours[0]['calls']

    merged = profiler.report_tree(min_pct=0)
    assert merged['total_calls'] == sum(t['calls'] for t in listed)

    # A DAP client may send the id as a string
    assert profiler.report_tree(min_pct=0, thread=str(ours[0]['id'])) == tree


@pytest.mark.parametrize('thread', ['abc', True, 1.5j, [0]])
def test_report_tree_rejects_an_invalid_thread(thread):
    """A bad id is reported, never silently widened to all threads."""
    _run_session('owner-1', 'session-1')

    result = profiler.report_tree(thread=thread)

    assert result['tree'] is None
    assert result['error'].startswith('Invalid thread id'), result


def test_report_tree_reports_an_unknown_thread():
    """A well-formed id that is not in the session is an error, not all threads."""
    _run_session('owner-1', 'session-1')
    missing = max(t['id'] for t in profiler.threads()['threads']) + 1000

    result = profiler.report_tree(thread=missing)

    assert result['tree'] is None
    assert result['error'] == f'Thread {missing} not found in the last session'


def test_report_tree_without_data_ignores_the_thread():
    """No session yet: the placeholder wins over the thread lookup."""
    result = profiler.report_tree(thread=0)

    assert result['tree'] is None
    assert result['error'] == 'No profiling data available. Run a session first.'


def test_captures_share_one_string_per_path():
    """The flat and per-thread copies of a function hold one path string.

    _relativize_path is cached, so a path is computed once under _lock and the
    copies do not each keep their own string.
    """
    _run_session('owner-1', 'session-1')

    flat = [e['key'][0] for e in profiler._last_stats_data if e['key'][2] == 'report_marker']
    per_thread = [e['key'][0] for t in profiler._last_thread_data for e in t['stats'] if e['key'][2] == 'report_marker']
    assert len(flat) == 1 and len(per_thread) == 1, (flat, per_thread)
    assert flat[0] is per_thread[0]


def test_thread_capture_happens_under_lock_before_clear(monkeypatch):
    """Per-thread capture reads yappi under _lock and before clear_stats().

    After clear_stats() the per-thread data is gone, and outside the lock a
    concurrent start() could clear it — either way the capture comes back empty.
    """
    profiler.start('owner')

    # Recorded only from here, so start()'s own clear_stats() is not counted
    seen: list[tuple[str, bool]] = []
    real_thread_stats = yappi.get_thread_stats
    real_func_stats = yappi.get_func_stats
    real_clear = yappi.clear_stats

    def rec_thread_stats():
        seen.append(('thread_stats', profiler._lock._is_owned()))
        return real_thread_stats()

    def rec_func_stats(*args, **kwargs):
        # The per-thread reads are the ones filtered by context
        if 'ctx_id' in (kwargs.get('filter') or {}):
            seen.append(('func_stats_ctx', profiler._lock._is_owned()))
        return real_func_stats(*args, **kwargs)

    def rec_clear():
        seen.append(('clear_stats', profiler._lock._is_owned()))
        real_clear()

    monkeypatch.setattr(yappi, 'get_thread_stats', rec_thread_stats)
    monkeypatch.setattr(yappi, 'get_func_stats', rec_func_stats)
    monkeypatch.setattr(yappi, 'clear_stats', rec_clear)

    for _ in range(10):
        report_marker()
    profiler.stop('owner')

    ops = [op for op, _ in seen]
    assert 'func_stats_ctx' in ops, f'no per-thread capture was observed: {ops}'
    # Cleared exactly once, and only after every read
    assert ops.count('clear_stats') == 1 and ops[-1] == 'clear_stats', f'stats cleared mid-capture: {ops}'
    unlocked = [op for op, owned in seen if not owned]
    assert not unlocked, f'yappi read without holding _lock: {unlocked}'
    # ... and the capture did find this thread
    assert profiler._last_thread_data, 'nothing was captured per thread'


# ---------------------------------------------------------------------------
# Call-tree pruning, on hand-built stats
# ---------------------------------------------------------------------------
#
# The shapes below are the ones a real parse pipeline produced (see the
# session numbers in each docstring).  They are built by hand rather than
# profiled: which frames are still running at stop() is exactly what a live
# session cannot pin down.


def _stats(calls: dict[str, dict[str, float]], ttot: dict[str, float] | None = None, tsub=None) -> list[dict]:
    """Stats entries for a call graph given as {caller: {callee: edge ttot}}."""
    names = set(calls) | {callee for callees in calls.values() for callee in callees}
    ttot = ttot or {}
    tsub = tsub or {}
    return [
        {
            'key': ('./ai/fake.py', 1, name),
            'ncall': 1,
            'ttot': ttot.get(name, 0.0),
            'tsub': tsub.get(name, 0.0),
            'builtin': False,
            'children': [
                {'key': ('./ai/fake.py', 1, callee), 'ncall': 1, 'ttot': edge, 'tsub': 0.0}
                for callee, edge in calls.get(name, {}).items()
            ],
        }
        for name in sorted(names)
    ]


def _paths(node: dict, prefix: tuple = ()) -> list[tuple]:
    """Every root-to-node path of a built tree, by function name."""
    path = prefix + (node['name'],)
    return [path] + [p for child in node['children'] for p in _paths(child, path)]


def test_tree_keeps_work_under_frames_still_running_at_stop():
    """A thread started mid-session: its entry frames never returned, so read 0.

    Measured: asyncio_2 lost close_sync (5.3 s) because Thread.run, at depth 2
    with 0 s, fell under the threshold and took its whole subtree with it.
    """
    data = _stats(
        {
            '_bootstrap': {'_bootstrap_inner': 0.0},
            '_bootstrap_inner': {'run': 0.0},
            'run': {'_worker': 0.0},
            '_worker': {'_WorkItem.run': 5.4},
            '_WorkItem.run': {'close_sync': 5.3},
        }
    )

    tree = CProfileManager._build_tree(data, max_depth=50, min_pct=0.1, total_time=10.0)['tree']

    expected = ('<root>', '_bootstrap', '_bootstrap_inner', 'run', '_worker', '_WorkItem.run', 'close_sync')
    assert expected in _paths(tree), _paths(tree)


def test_tree_keeps_a_coroutine_under_a_short_loop_step():
    """A coroutine is booked its whole lifetime, the loop step resuming it is not.

    Measured: on_receive (48.7 s) sat under Context.run (0.53 s), which the
    threshold dropped.  Here the step is below the threshold on its own.
    """
    data = _stats(
        {
            '_run_once': {'Handle._run': 0.01},
            'Handle._run': {'Context.run': 0.01},
            'Context.run': {'on_receive': 48.7},
        },
        ttot={'_run_once': 27.5},
    )

    tree = CProfileManager._build_tree(data, max_depth=50, min_pct=0.1, total_time=27.5)['tree']

    assert ('<root>', '_run_once', 'Handle._run', 'Context.run', 'on_receive') in _paths(tree), _paths(tree)


def test_tree_still_prunes_what_leads_nowhere():
    """Light nodes survive only when real work hangs below them."""
    data = _stats(
        {
            'main': {'busy': 5.0, 'idle': 0.0001},
            'idle': {'idler': 0.0001},
            'idler': {'idlest': 0.00005},
        },
    )

    paths = _paths(CProfileManager._build_tree(data, max_depth=50, min_pct=0.1, total_time=10.0)['tree'])

    assert ('<root>', 'main', 'busy') in paths
    # Depth 1 is never pruned; below it, nothing here reaches 0.01 s
    assert ('<root>', 'main', 'idle') in paths
    assert not [p for p in paths if 'idler' in p], paths


def test_tree_weighs_through_cycles():
    """Weights propagate around a cycle and the propagation terminates."""
    data = _stats(
        {
            'entry': {'a': 0.0},
            'a': {'b': 0.0},
            'b': {'a': 0.0, 'heavy': 3.0},
        },
    )

    paths = _paths(CProfileManager._build_tree(data, max_depth=50, min_pct=0.1, total_time=10.0)['tree'])

    assert ('<root>', 'entry', 'a', 'b', 'heavy') in paths, paths


def test_tree_total_defaults_to_self_time():
    """Without a thread total, self times are summed — ttot would count nesting again.

    main 10 s > work 9 s > sleep 8 s ran for 10 s; the ttot sum says 27.
    """
    data = _stats(
        {'main': {'work': 9.0}, 'work': {'sleep': 8.0}},
        ttot={'main': 10.0, 'work': 9.0, 'sleep': 8.0},
        tsub={'main': 1.0, 'work': 1.0, 'sleep': 8.0},
    )

    result = CProfileManager._build_tree(data, max_depth=50, min_pct=0.1)

    assert result['total_time'] == 10.0
    assert result['tree']['cumtime'] == 10.0


def test_report_tree_total_is_thread_time():
    """The tree's total is how long the threads ran: one, or all summed."""
    one = _stats({'main': {'work': 1.0}}, tsub={'main': 0.5, 'work': 1.0})
    two = _stats({'loop': {'step': 2.0}}, tsub={'loop': 7.0, 'step': 2.0})
    profiler._last_stats_data = one + two
    profiler._last_thread_data = [
        {'id': 0, 'name': 'first', 'tid': 1, 'ttot': 5.0, 'sched_count': 1, 'stats': one},
        {'id': 1, 'name': 'second', 'tid': 2, 'ttot': 3.0, 'sched_count': 1, 'stats': two},
    ]

    assert profiler.report_tree()['total_time'] == 8.0
    assert profiler.report_tree(thread=0)['total_time'] == 5.0
    assert profiler.report_tree(thread=1)['total_time'] == 3.0
