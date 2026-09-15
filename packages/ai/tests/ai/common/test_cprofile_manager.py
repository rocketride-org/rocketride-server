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

from ai.common.cprofile_manager import profiler

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
# hazard.  Windows-only: deterministic use-after-free there.
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
    reason='use-after-free is deterministic only on win32; the lock guarantee '
    'itself is covered cross-platform by test_yappi_mutations_happen_under_lock',
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
