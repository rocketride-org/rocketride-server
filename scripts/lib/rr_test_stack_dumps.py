"""
Test-only hook that makes a task child process write periodic Python stack dumps.

The builder copies this module and a one-line .pth file into the engine's
site-packages for a test run (see stackdumps.js). The module acts only when
ROCKETRIDE_TEST_STACK_DUMPS names a directory and the process is a task child
(``ai/node.py <task-file>``). It then writes ``stacks_<pid>.txt`` there:

- a header with the pid, the start time and the command line;
- every ROCKETRIDE_TEST_STACK_DUMPS_SECS seconds (default 30), the stack of every
  thread except the dumper's own, in the text format of ``faulthandler``
  (``Timeout (h:mm:ss)!``, then ``Thread 0x<16 hex digits> (most recent call
  first):`` and ``  File "<file>", line <n> in <function>`` lines, then a blank
  line). The time in the first line is the time since the hook started.

A daemon thread takes the stacks with ``sys._current_frames()``, so it holds the
GIL while it reads other threads' frames and a dump cannot crash the process.
After each dump the file is flushed and fsynced, so its modification time moves
with every dump. A dumper that cannot get the GIL (another thread is stuck in
native code that holds it) writes nothing, and the file stops being updated.

A child that exits normally removes a file that holds no dump, so what is left
belongs to children that ran long or were killed.
"""

import atexit
import os
import sys
import threading
import time

_DUMP_DIR_VAR = 'ROCKETRIDE_TEST_STACK_DUMPS'
_INTERVAL_VAR = 'ROCKETRIDE_TEST_STACK_DUMPS_SECS'
_DEFAULT_INTERVAL = 30

# Longest wait for the dumper thread to stop on exit, in seconds.
_JOIN_TIMEOUT = 0.5


def _format_elapsed(seconds: float) -> str:
    """
    Format an elapsed time as faulthandler does.

    Args:
        seconds (float): Elapsed time in seconds.

    Returns:
        str: The time as ``h:mm:ss`` with an unpadded hour count.
    """
    total = int(seconds)
    return f'{total // 3600}:{total % 3600 // 60:02d}:{total % 60:02d}'


def _format_stacks(frames: dict, skip_ident: int, elapsed: float) -> str:
    """
    Format the stack of every thread in the faulthandler text format.

    Args:
        frames (dict): Thread ident to its current frame, as ``sys._current_frames()`` returns.
        skip_ident (int): Ident of the thread to leave out (the dumper itself).
        elapsed (float): Seconds since the hook started.

    Returns:
        str: The dump text, ending with a blank line.
    """
    lines = [f'Timeout ({_format_elapsed(elapsed)})!']
    for ident, frame in frames.items():
        if ident == skip_ident:
            continue
        lines.append(f'Thread 0x{ident:016x} (most recent call first):')
        while frame is not None:
            code = frame.f_code
            lines.append(f'  File "{code.co_filename}", line {frame.f_lineno} in {code.co_name}')
            frame = frame.f_back
        lines.append('')
    if len(lines) == 1:
        lines.append('')
    return '\n'.join(lines) + '\n'


class _Dumper:
    """Daemon thread that appends a stack dump to the file every interval."""

    def __init__(self, file, interval: int, started: float) -> None:
        """
        Create the dumper.

        Args:
            file (TextIO): The open dump file.
            interval (int): Seconds between dumps.
            started (float): ``time.monotonic()`` value at hook start.
        """
        self._file = file
        self._interval = interval
        self._started = started
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._closed = False
        self._thread = threading.Thread(target=self._run, name='rr-stack-dumper', daemon=True)

    def start(self) -> None:
        """
        Start the thread.

        Returns:
            None
        """
        self._thread.start()

    def _run(self) -> None:
        """
        Dump every interval until stopped; the n-th dump is due n * interval after the start.

        Returns:
            None
        """
        count = 1
        while not self._stop.wait(max(0.0, self._started + count * self._interval - time.monotonic())):
            try:
                self._dump()
            except Exception:
                # A diagnostic must never stop the task it observes.
                pass
            count = max(count + 1, int((time.monotonic() - self._started) // self._interval) + 1)

    def _dump(self) -> None:
        """
        Write one dump, then flush and fsync the file.

        Returns:
            None
        """
        frames = sys._current_frames()
        try:
            text = _format_stacks(frames, threading.get_ident(), time.monotonic() - self._started)
        finally:
            del frames
        with self._lock:
            if self._closed:
                return
            self._file.write(text)
            self._file.flush()
            os.fsync(self._file.fileno())

    def close(self) -> None:
        """
        Stop the thread, wait briefly for it, and close the file.

        Returns:
            None
        """
        self._stop.set()
        if self._thread.is_alive() and self._thread is not threading.current_thread():
            self._thread.join(_JOIN_TIMEOUT)
        with self._lock:
            self._closed = True
            self._file.close()


def _start() -> None:
    """
    Open the per-pid dump file and start the dumper thread.

    Returns:
        None
    """
    out_dir = os.environ.get(_DUMP_DIR_VAR)
    if not out_dir or not sys.argv or os.path.basename(sys.argv[0]) != 'node.py':
        return

    try:
        interval = int(os.environ.get(_INTERVAL_VAR, '') or _DEFAULT_INTERVAL)
    except ValueError:
        interval = _DEFAULT_INTERVAL
    if interval <= 0:
        interval = _DEFAULT_INTERVAL

    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f'stacks_{os.getpid()}.txt')
    dump_file = open(path, 'w', encoding='utf-8')
    dump_file.write(
        f'pid={os.getpid()} started={time.strftime("%Y-%m-%dT%H:%M:%S%z")} interval={interval}s\nargv={" ".join(sys.argv)}\n'
    )
    dump_file.flush()
    header_size = os.path.getsize(path)

    dumper = _Dumper(dump_file, interval, time.monotonic())
    dumper.start()

    def _finish() -> None:
        """
        Stop the dumper and remove the file when it holds only the header.

        Returns:
            None
        """
        try:
            dumper.close()
            if os.path.getsize(path) == header_size:
                os.remove(path)
        except Exception:
            # A diagnostic must never stop the task it observes.
            pass

    atexit.register(_finish)


try:
    _start()
except Exception:
    # A diagnostic must never stop the task it observes.
    pass
