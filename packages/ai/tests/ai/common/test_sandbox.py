"""
Unit tests for ai.common.sandbox.execute_sandboxed.

execute_sandboxed compiles agent code through RestrictedPython, executes it
inside a guarded namespace (limited builtins, allowlist-only ``__import__``,
PrintCollector for stdout, watchdog thread for timeout), and returns a
dict with stdout / stderr / exit_code / timed_out / optional result.

RestrictedPython is bundled with the engine via ai/common/requirements.txt,
so the real library is exercised here — no mocking needed for the happy
paths. Tests are written so they finish well before the default 20-second
timeout.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path

import pytest

from ai.common import sandbox
from ai.common.sandbox import execute_sandboxed


# ---------------------------------------------------------------------------
# Happy path — code execution + result capture
# ---------------------------------------------------------------------------


def test_simple_code_runs_and_collects_stdout():
    """A plain ``print`` call is captured into ``stdout`` and exit_code is 0."""
    result = execute_sandboxed('print("hello world")')
    assert result['exit_code'] == 0
    assert result['timed_out'] is False
    assert 'hello world' in result['stdout']
    assert result['stderr'] == ''


def test_result_variable_is_returned_for_primitive_values():
    """A ``result`` variable in the script is round-tripped in the return dict."""
    result = execute_sandboxed('result = 1 + 2')
    assert result['exit_code'] == 0
    assert result['result'] == 3


@pytest.mark.parametrize(
    'code, expected',
    [
        ('result = 42', 42),
        ('result = 3.14', 3.14),
        ('result = "hello"', 'hello'),
        ('result = True', True),
        ('result = [1, 2, 3]', [1, 2, 3]),
        ('result = {"a": 1, "b": 2}', {'a': 1, 'b': 2}),
        ('result = None', None),  # None is allowed but the dict will omit the key
    ],
)
def test_result_captures_primitive_types(code, expected):
    """All JSON-serialisable primitives in ``result`` are returned as-is."""
    out = execute_sandboxed(code)
    if expected is None:
        assert 'result' not in out  # None result is dropped by the source
    else:
        assert out['result'] == expected


def test_complex_object_falls_back_to_repr():
    """Non-primitive ``result`` values are stringified via ``repr``.

    Sets are not in the primitive allowlist for the ``result`` field
    (``str | int | float | bool | list | dict | None``), so they take the
    ``repr(...)`` fallback path.
    """
    out = execute_sandboxed('result = frozenset([1, 2, 3])')
    assert out['exit_code'] == 0
    assert isinstance(out['result'], str)
    assert 'frozenset' in out['result']


# ---------------------------------------------------------------------------
# Compilation errors
# ---------------------------------------------------------------------------


def test_syntax_error_is_returned_in_stderr():
    """A SyntaxError during compile yields exit_code=1 and the message in stderr."""
    out = execute_sandboxed('def : pass')  # invalid syntax
    assert out['exit_code'] == 1
    assert out['timed_out'] is False
    assert 'invalid' in out['stderr'].lower() or 'syntax' in out['stderr'].lower()


def test_restricted_python_policy_violation_is_blocked():
    """RestrictedPython rejects dunder name access at compile time."""
    out = execute_sandboxed('result = (1).__class__')
    # Compilation either returns None (policy violation) or raises a
    # SyntaxError-shaped message; either way the function exits non-zero.
    assert out['exit_code'] == 1
    assert out['timed_out'] is False
    assert out['stderr']  # non-empty


# ---------------------------------------------------------------------------
# Import allowlist
# ---------------------------------------------------------------------------


def test_allowed_default_module_can_be_imported():
    """``math`` is in the default allowlist; ``math.sqrt`` works inside the sandbox."""
    out = execute_sandboxed('import math\nresult = math.sqrt(16)')
    assert out['exit_code'] == 0
    assert out['result'] == 4.0


def test_disallowed_import_raises_import_error():
    """``os`` is not in the default allowlist; the import is rejected."""
    out = execute_sandboxed('import os\nresult = os.getcwd()')
    assert out['exit_code'] == 1
    assert 'not allowed' in out['stderr']


def test_custom_allowed_modules_extend_the_allowlist():
    """A caller-supplied ``allowed_modules`` set is merged with the defaults.

    Uses ``os``, which is **not** in the default allowlist, so the test
    actually exercises the merge path: the import fails without
    ``allowed_modules`` and succeeds once ``os`` is added.
    """
    # Without the extension, importing ``os`` is blocked.
    blocked = execute_sandboxed('import os\nresult = os.name')
    assert blocked['exit_code'] == 1
    assert 'not allowed' in blocked['stderr']

    # With ``os`` explicitly added, the import succeeds and runs.
    import os as _os

    allowed = execute_sandboxed('import os\nresult = os.name', allowed_modules={'os'})
    assert allowed['exit_code'] == 0
    assert allowed['result'] == _os.name


def test_submodule_top_level_check():
    """The allowlist is enforced on the top-level package, not the dotted submodule."""
    # ``json.decoder`` should be importable because ``json`` is allowed at the top.
    out = execute_sandboxed('import json.decoder\nresult = 1')
    assert out['exit_code'] == 0


# ---------------------------------------------------------------------------
# SystemExit handling
# ---------------------------------------------------------------------------


def test_sys_exit_with_int_code_is_captured():
    """Raise SystemExit(2) becomes exit_code=2 without stderr."""
    out = execute_sandboxed('raise SystemExit(2)')
    assert out['exit_code'] == 2
    assert out['timed_out'] is False
    assert out['stderr'] == ''


def test_sys_exit_with_no_arg_is_treated_as_zero():
    """Raise SystemExit() (no arg) sets exit_code=0."""
    out = execute_sandboxed('raise SystemExit()')
    assert out['exit_code'] == 0


def test_sys_exit_with_message_string_is_captured_in_stderr():
    """Raise SystemExit('msg') captures 'SystemExit: msg' in stderr and exit_code=1."""
    out = execute_sandboxed('raise SystemExit("explicit error")')
    assert out['exit_code'] == 1
    assert 'SystemExit' in out['stderr']
    assert 'explicit error' in out['stderr']


# ---------------------------------------------------------------------------
# Exception handling
# ---------------------------------------------------------------------------


def test_runtime_exception_lands_in_stderr_with_exit_one():
    """An unhandled exception during execution sets exit_code=1 and fills stderr."""
    out = execute_sandboxed('result = 1 / 0')
    assert out['exit_code'] == 1
    assert out['timed_out'] is False
    assert 'ZeroDivisionError' in out['stderr']


# ---------------------------------------------------------------------------
# Timeout
# ---------------------------------------------------------------------------


def test_timeout_exits_with_minus_one_and_timed_out_flag():
    """A long-running script (much longer than the configured timeout) is killed."""
    # 1-second budget; the loop spins for far longer than that.
    out = execute_sandboxed(
        """
total = 0
for i in range(100_000_000):
    total += i
result = total
""",
        timeout=1,
    )
    assert out['timed_out'] is True
    assert out['exit_code'] == -1
    assert '1s' in out['stderr']


#: A script that never finishes on its own.
RUNAWAY = 'x = 0\nwhile True:\n    x += 1'


def _live_children() -> list:
    """Child processes of this test process, if psutil is available."""
    psutil = pytest.importorskip('psutil', reason='process accounting needs psutil')
    return psutil.Process(os.getpid()).children(recursive=True)


def _wait_for_children_to_settle(before: int) -> None:
    """Give the killed child a moment to be reaped, then require it is gone."""
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline and len(_live_children()) > before:
        time.sleep(0.05)
    assert len(_live_children()) == before, 'timed-out script is still running'


def test_timeout_leaves_no_surviving_child():
    """The deadline kills the script rather than merely giving up on it.

    ``Thread.join(timeout)`` used to return while the script kept running for
    the life of the engine. The work happens in a child process now, so the
    kill is the kernel's and needs no cooperation from the script.
    """
    before = len(_live_children())

    out = execute_sandboxed(RUNAWAY, timeout=1)

    assert out['timed_out'] is True
    _wait_for_children_to_settle(before)


def test_repeated_timeouts_do_not_accumulate_processes():
    """Three runaway scripts in a row leave nothing behind.

    The pre-fix failure mode was cumulative: every timed-out call added another
    thread that ran until the engine died.
    """
    before = len(_live_children())

    for _ in range(3):
        assert execute_sandboxed(RUNAWAY, timeout=1)['timed_out'] is True

    _wait_for_children_to_settle(before)


def test_timeout_stops_a_script_that_swallows_every_exception():
    """A bare ``except`` cannot outlive the deadline.

    In-process interruption depended on the script not catching what was thrown
    at it. Killing the process does not negotiate.
    """
    out = execute_sandboxed(
        """
x = 0
while True:
    try:
        x += 1
    except BaseException:
        pass
""",
        timeout=1,
    )

    assert out['timed_out'] is True
    assert out['exit_code'] == -1


def test_timeout_does_not_deadlock_under_a_trace_function():
    """A tracer in this process must not turn a timeout into a hang.

    Regression test for the CI failure that replaced the in-process design.
    Injecting an asynchronous exception landed it inside ``coverage``'s tracer
    while it held a global lock; the worker died without releasing it and every
    thread then blocked on the next traced line. Nothing in this process is
    interrupted now, so a tracer is irrelevant — this pins that.
    """

    def _tracer(frame, event, arg):
        return _tracer

    threading.settrace(_tracer)
    sys.settrace(_tracer)
    try:
        out = execute_sandboxed(RUNAWAY, timeout=1)
    finally:
        sys.settrace(None)
        threading.settrace(None)

    assert out['timed_out'] is True
    assert out['exit_code'] == -1


def test_stdout_is_empty_on_the_timeout_path():
    """A killed child cannot report what it printed — documented, not accidental."""
    out = execute_sandboxed(
        """
print('before the loop')
x = 0
while True:
    x += 1
""",
        timeout=1,
    )

    assert out['timed_out'] is True
    assert out['stdout'] == ''


# ---------------------------------------------------------------------------
# Child-process failures
# ---------------------------------------------------------------------------


def test_unstartable_sandbox_is_reported_not_raised(monkeypatch):
    """A sandbox that cannot start is an error result, not an exception."""
    monkeypatch.setattr(sandbox.sys, 'executable', '/nonexistent/interpreter')

    out = execute_sandboxed('result = 1')

    assert out['exit_code'] == 1
    assert out['timed_out'] is False
    assert 'could not start' in out['stderr']


def test_worker_exiting_without_a_result_is_reported(monkeypatch):
    """A child that dies without answering surfaces its exit code and stderr."""
    monkeypatch.setattr(sandbox, '_WORKER_PATH', str(Path(__file__).with_name('no_such_worker.py')))

    out = execute_sandboxed('result = 1')

    assert out['exit_code'] == 1
    assert out['timed_out'] is False
    assert 'without a result' in out['stderr']


def test_stray_stdout_from_the_script_does_not_corrupt_the_response():
    """The response travels on stdout, so the script must not be able to write there.

    ``sys.stdout`` is swapped for a buffer inside the child and folded into the
    reported stdout; without that, one stray write would make the response
    unparseable and turn a working script into a sandbox error.
    """
    out = execute_sandboxed(
        """
import sys
sys.stdout.write('raw write')
result = 'ok'
""",
        allowed_modules={'sys'},
    )

    assert out['exit_code'] == 0
    assert out['result'] == 'ok'
    assert 'raw write' in out['stdout']


def test_non_object_worker_response_is_reported_not_raised(monkeypatch):
    """Valid JSON of the wrong shape is an error result, not a TypeError.

    The response is parsed and then subscripted; a bare list or string would
    have raised out of a function whose whole contract is to return a result
    dict.
    """

    class _Completed:
        stdout = '[1, 2, 3]'
        stderr = ''
        returncode = 0

    monkeypatch.setattr(sandbox.subprocess, 'run', lambda *a, **k: _Completed())

    out = execute_sandboxed('result = 1')

    assert out['exit_code'] == 1
    assert out['timed_out'] is False
    assert 'without a result' in out['stderr']


@pytest.mark.parametrize(
    'code, expected',
    [
        ("d = {'a': 1, 'b': 2}\nout = []\nfor k, v in d.items():\n    out.append(k)\nresult = out", ['a', 'b']),
        ("result = [i for i, ch in enumerate(['x', 'y'])]", [0, 1]),
        ('result = [a for a, b in zip([1, 2], [3, 4])]', [1, 2]),
        ('result = [x for (a, b), x in [((1, 2), 3)]]', [3]),
    ],
)
def test_tuple_unpacking_in_for_loops_is_allowed(code, expected):
    """Iterating pairs is everyday agent code and must not be refused.

    Pins the ``_iter_unpack_sequence_`` binding: these are exactly the shapes
    that break if the sequence guard is wired where the iterator guard belongs.
    """
    out = execute_sandboxed(code)

    assert out['exit_code'] == 0, out['stderr']
    assert out['result'] == expected


def test_result_survives_the_round_trip():
    """A structured ``result`` reaches the caller through the JSON channel."""
    out = execute_sandboxed("result = {'a': [1, 2], 'b': 'x'}")

    assert out['exit_code'] == 0
    assert out['result'] == {'a': [1, 2], 'b': 'x'}
