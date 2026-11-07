"""
Test-only hook that makes a task child process write periodic Python stack dumps.

The builder copies this module and a one-line .pth file into the engine's
site-packages for a test run (see stackdumps.js). The module acts only when
ROCKETRIDE_TEST_STACK_DUMPS names a directory and the process is a task child
(``ai/node.py <task-file>``). It then writes ``stacks_<pid>.txt`` there:

- a header with the pid, the start time and the command line;
- every ROCKETRIDE_TEST_STACK_DUMPS_SECS seconds (default 30), the stack of every
  thread. The n-th dump is written n * SECS seconds after the start time.

A child that exits normally removes a file that holds no dump, so what is left
belongs to children that ran long or were killed.
"""

import atexit
import faulthandler
import os
import sys
import time

_DUMP_DIR_VAR = 'ROCKETRIDE_TEST_STACK_DUMPS'
_INTERVAL_VAR = 'ROCKETRIDE_TEST_STACK_DUMPS_SECS'
_DEFAULT_INTERVAL = 30

# Held so the file stays open for faulthandler until the process ends.
_dump_file = None


def _start() -> None:
    """Open the per-pid dump file and arm the repeating stack dump."""
    global _dump_file

    out_dir = os.environ.get(_DUMP_DIR_VAR)
    if not out_dir or not sys.argv or os.path.basename(sys.argv[0]) != 'node.py':
        return

    try:
        interval = int(os.environ.get(_INTERVAL_VAR, '') or _DEFAULT_INTERVAL)
    except ValueError:
        interval = _DEFAULT_INTERVAL

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f'stacks_{os.getpid()}.txt')
    _dump_file = open(path, 'w', encoding='utf-8')
    _dump_file.write(
        f'pid={os.getpid()} started={time.strftime("%Y-%m-%dT%H:%M:%S%z")} interval={interval}s\nargv={" ".join(sys.argv)}\n'
    )
    _dump_file.flush()
    header_size = os.path.getsize(path)

    faulthandler.dump_traceback_later(interval, repeat=True, file=_dump_file)

    def _finish() -> None:
        faulthandler.cancel_dump_traceback_later()
        _dump_file.close()
        if os.path.getsize(path) == header_size:
            os.remove(path)

    atexit.register(_finish)


try:
    _start()
except Exception:
    # A diagnostic must never stop the task it observes.
    pass
