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

import pytest

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
