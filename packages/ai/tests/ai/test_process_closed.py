# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The engine closes its own process as it starts (Linux).

Other processes of the same user read a process's ``/proc/<pid>/environ`` and
memory, and attach a debugger, only while its dumpable flag is 1. The engine
and the tasks of every caller can run as one user, so the engine clears the
flag itself, natively, before any Python runs. ``RR_ENABLE_DEBUGGER_CONNECTION``
set to 1, true, yes or on (in any case) keeps the flag as the kernel gave it.

The tests start a fresh engine: the flag is set once per process.
"""

import os
import select
import subprocess
import sys

import pytest

pytestmark = pytest.mark.skipif(not sys.platform.startswith('linux'), reason='the dumpable flag is Linux only')

# prctl(PR_GET_DUMPABLE)
_PRINT_FLAG = 'import ctypes; print(ctypes.CDLL(None).prctl(3, 0, 0, 0, 0))'

# Seconds a fresh engine may take to start and answer; a stalled one fails the test, not hangs it
_START_TIMEOUT = 60

# CAP_SYS_PTRACE, which reads the /proc entries of a closed process all the same
_CAP_SYS_PTRACE = 19


def _flag_of_a_new_engine(**env: str) -> int:
    """Start the engine this test runs under and return its dumpable flag."""
    environ = {k: v for k, v in os.environ.items() if k != 'RR_ENABLE_DEBUGGER_CONNECTION'}
    environ.update(env)
    out = subprocess.run(
        [sys.executable, '-c', _PRINT_FLAG],
        env=environ,
        capture_output=True,
        text=True,
        check=True,
        timeout=_START_TIMEOUT,
    )
    return int(out.stdout.strip().splitlines()[-1])


def _reads_any_process() -> bool:
    """Whether this process holds CAP_SYS_PTRACE (root does), for which no process is closed."""
    with open('/proc/self/status', encoding='utf-8') as f:
        for line in f:
            if line.startswith('CapEff:'):
                return bool(int(line.split()[1], 16) & (1 << _CAP_SYS_PTRACE))
    return False


def test_the_engine_closes_itself_as_it_starts():
    """A fresh engine runs with its dumpable flag at 0."""
    assert _flag_of_a_new_engine() == 0


@pytest.mark.parametrize('value', ['1', 'true', 'TRUE', 'Yes', 'on', ' on '])
def test_the_opt_out_keeps_a_debuggers_way_in(value):
    """The engine binary under test is readable, so the kernel started it with 1, and it stays."""
    assert _flag_of_a_new_engine(RR_ENABLE_DEBUGGER_CONNECTION=value) == 1


@pytest.mark.parametrize('value', ['', '0', 'false', 'no', 'off', '2', 'tru'])
def test_any_other_value_leaves_the_engine_closed(value):
    """A value that is not a yes, a typo included, must not open the process."""
    assert _flag_of_a_new_engine(RR_ENABLE_DEBUGGER_CONNECTION=value) == 0


def test_a_closed_engine_hides_its_environment_from_its_users_processes():
    """What the flag is for: /proc/<pid>/environ of a running engine is not readable by this process."""
    if _reads_any_process():
        pytest.skip('this process holds CAP_SYS_PTRACE, which reads a closed process anyway')
    environ = {k: v for k, v in os.environ.items() if k != 'RR_ENABLE_DEBUGGER_CONNECTION'}
    engine = subprocess.Popen(
        [sys.executable, '-c', 'import sys; print("up", flush=True); sys.stdin.read()'],
        env=environ,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        ready, _, _ = select.select([engine.stdout], [], [], _START_TIMEOUT)
        assert ready, f'the engine did not start within {_START_TIMEOUT} s'
        assert engine.stdout.readline().strip().endswith('up')
        with pytest.raises(PermissionError):
            open(f'/proc/{engine.pid}/environ', 'rb').read()
    finally:
        engine.stdin.close()
        try:
            engine.wait(timeout=30)
        except subprocess.TimeoutExpired:
            engine.kill()
            engine.wait()
