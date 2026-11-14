"""
Test-only hook that makes a task child or a pytest process write periodic Python stack dumps.

The builder copies this module and a one-line .pth file into the engine's
site-packages for a test run (see stackdumps.js). The module acts only when
ROCKETRIDE_TEST_STACK_DUMPS names a directory and the process is one of:

- ``task``: a task child (``ai/node.py <task-file>``);
- ``pytest-main``: ``engine -m pytest ...`` (the pytest process, or the xdist controller);
- ``pytest-worker``: a pytest-xdist worker, which execnet starts as
  ``engine -u -c "import sys;exec(eval(sys.stdin.readline()))"``.

Any other interpreter (``engine -c ...`` CLIs, helper scripts) does nothing. It then
writes ``stacks_<pid>.txt`` there:

- a header with the pid, the start time, the dump interval and the process ``kind``
  on the first line, then the command line;
- every ROCKETRIDE_TEST_STACK_DUMPS_SECS seconds (default 30), the stack of every
  thread except the dumper's own, in the text format of ``faulthandler``
  (``Timeout (h:mm:ss)!``, then ``Thread 0x<16 hex digits> (most recent call
  first):`` and ``  File "<file>", line <n> in <function>`` lines, then a blank
  line). The main thread's heading carries a ``[main]`` label after the thread id.
  The time in the first line is the time since the hook started.
  For a pytest process each dump ends with an ``info:`` line that gives the xdist
  worker id (``worker=gw0``, known only after startup) and the running test
  (``current_test=...``, from ``PYTEST_CURRENT_TEST``), read at dump time.

A daemon thread takes the stacks with ``sys._current_frames()``, so it holds the
GIL while it reads other threads' frames and a dump cannot crash the process.
After each dump the file is flushed and fsynced, so its modification time moves
with every dump. A dumper that cannot get the GIL (another thread is stuck in
native code that holds it) writes nothing, and the file stops being updated.

When the main thread has sat in ``FileLock.__enter__`` (``depends.py``) for
``_PROBE_AFTER`` seconds, the dumper runs a one-shot lock probe in that process
and appends a block that starts with ``=== lock probe``. The probe repeats the
waiter's own steps on ``install.lock`` (open the file for writing, then take a
non-blocking lock on its first byte) and records which step failed and with what
error, plus the state of the lock file and its ``.progress`` sidecar. It tells a
lock held by another process (the lock step fails) from a lock nobody holds
(the open step fails, or the lock is free).

After each dump the dumper looks for a thread whose innermost frames are one or more
``threading.py`` ``wait`` frames called directly from a ``threading.py`` ``start``
frame, which is how a thread looks while ``Thread.start()`` waits for the new OS thread
to run its first Python line. A dump can catch a healthy ``start`` for an instant, so
the dumper waits ``_START_RECHECK_S`` seconds without the GIL (and without delaying
close), samples again, and appends a block for every thread whose very same ``start``
frame object is still on its stack::

    === thread start stuck thread=0x<16 hex digits> seconds=2

followed by a blank line. A given stuck ``start`` frame is reported once; a later
``start`` call that gets stuck is reported again.

On Windows the hook also wraps ``_wmi.exec_query``, which ``platform`` calls on its first
``platform.*`` call. Each call appends one block, written under the same lock and
fsynced because the process may hang right after::

    === wmi query seconds=<s, 3 decimals> ok chars=<length of the returned text> query=<first 200 chars>
    === wmi query seconds=<s> error=<exception class> winerror=<code or -> query=<first 200 chars>

followed by a blank line. The wrapper returns the original result or re-raises the
original exception unchanged, and nothing it logs can raise.

A child that exits normally removes a file that holds no dump, so what is left
belongs to children that ran long or were killed.
"""

import atexit
import functools
import os
import sys
import threading
import time

_DUMP_DIR_VAR = 'ROCKETRIDE_TEST_STACK_DUMPS'
_INTERVAL_VAR = 'ROCKETRIDE_TEST_STACK_DUMPS_SECS'
_DEFAULT_INTERVAL = 30

# Longest wait for the dumper thread to stop on exit, in seconds.
_JOIN_TIMEOUT = 0.5

# Seconds the main thread must have been inside FileLock.__enter__ before the lock probe runs.
_PROBE_AFTER = 180

# Seconds the dumper waits before it checks that a thread is still inside the same Thread.start() call.
_START_RECHECK_S = 2

# Longest sidecar text kept in the probe block, in characters.
_SIDECAR_MAX = 300

# Longest ``current_test`` text kept in the info line, in characters.
_TEST_MAX = 300

# Longest WMI query text kept in the ``=== wmi query`` line, in characters.
_WMI_QUERY_MAX = 200

# Interpreter options that take the next argument as their value.
_VALUE_OPTIONS = ('-W', '-X')

# Text of the execnet bootstrap command that pytest-xdist workers run.
_EXECNET_BOOTSTRAP = 'exec(eval(sys.stdin.readline()))'


def _detect_kind(argv: list, orig_argv: list) -> str:
    """
    Classify the current interpreter from its command line.

    ``sys.argv`` alone cannot tell ``-m pytest`` apart from any other ``-m`` run (it holds
    only ``['-m', ...]`` while the .pth runs), so the interpreter's own command line,
    ``sys.orig_argv``, is read; ``argv`` is used for the task check only.

    Args:
        argv (list[str]): ``sys.argv``.
        orig_argv (list[str]): ``sys.orig_argv``, the interpreter path followed by its arguments.

    Returns:
        str: ``task``, ``pytest-main``, ``pytest-worker``, or ``''`` for any other process.
    """
    if argv and os.path.basename(argv[0]) == 'node.py':
        return 'task'
    args = list(orig_argv[1:])
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == '-m':
            module = args[index + 1] if index + 1 < len(args) else ''
            return 'pytest-main' if module.split('.')[0] in ('pytest', '_pytest') else ''
        if arg == '-c':
            code = args[index + 1] if index + 1 < len(args) else ''
            return 'pytest-worker' if _EXECNET_BOOTSTRAP in code else ''
        if not arg.startswith('-'):
            return 'pytest-main' if os.path.basename(arg).lower() in ('pytest', 'pytest.exe', 'py.test') else ''
        index += 2 if arg in _VALUE_OPTIONS else 1
    return ''


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


def _format_stacks(frames: dict, skip_ident: int, elapsed: float, main_ident: int | None = None) -> str:
    """
    Format the stack of every thread in the faulthandler text format.

    Args:
        frames (dict): Thread ident to its current frame, as ``sys._current_frames()`` returns.
        skip_ident (int): Ident of the thread to leave out (the dumper itself).
        elapsed (float): Seconds since the hook started.
        main_ident (int | None): Ident of the main thread; its heading gets a ``[main]`` label.

    Returns:
        str: The dump text, ending with a blank line.
    """
    lines = [f'Timeout ({_format_elapsed(elapsed)})!']
    for ident, frame in frames.items():
        if ident == skip_ident:
            continue
        label = ' [main]' if ident == main_ident else ''
        lines.append(f'Thread 0x{ident:016x}{label} (most recent call first):')
        while frame is not None:
            code = frame.f_code
            lines.append(f'  File "{code.co_filename}", line {frame.f_lineno} in {code.co_name}')
            frame = frame.f_back
        lines.append('')
    if len(lines) == 1:
        lines.append('')
    return '\n'.join(lines) + '\n'


def _find_lock_wait(frame):
    """
    Find the ``FileLock.__enter__`` frame of ``depends.py`` in a thread's stack.

    Args:
        frame (frame | None): The innermost frame of the thread.

    Returns:
        frame | None: The matching frame, or None when the thread is not inside it.
    """
    while frame is not None:
        code = frame.f_code
        if code.co_name == '__enter__' and os.path.basename(code.co_filename) == 'depends.py':
            if hasattr(frame.f_locals.get('self'), 'lock_path'):
                return frame
        frame = frame.f_back
    return None


def _describe_error(step: str, exc: BaseException) -> list:
    """
    Describe the exception of a failed probe step as ``key=value`` lines.

    Args:
        step (str): The step that failed, ``open`` or ``lock``.
        exc (BaseException): The exception it raised.

    Returns:
        list[str]: The lines.
    """
    return [
        f'failed_step={step}',
        f'error_class={type(exc).__name__}',
        f'errno={getattr(exc, "errno", None)}',
        f'winerror={getattr(exc, "winerror", None)}',
        f'strerror={getattr(exc, "strerror", None)}',
    ]


def _describe_path(label: str, path: str) -> list:
    """
    Describe whether a file exists, and its size and modification time.

    Args:
        label (str): Prefix for the keys.
        path (str): The file to look at.

    Returns:
        list[str]: The ``key=value`` lines.
    """
    try:
        info = os.stat(path)
    except OSError as exc:
        return [f'{label}_exists=False', f'{label}_stat_error={type(exc).__name__} errno={exc.errno}']
    mtime = time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(info.st_mtime))
    return [f'{label}_exists=True', f'{label}_size={info.st_size}', f'{label}_mtime={mtime}']


def _run_lock_probe(lock_path: str, sidecar_path: str) -> str:
    """
    Repeat the lock waiter's steps once and describe the outcome.

    The probe opens ``lock_path`` for writing and takes a non-blocking lock on its
    first byte, as ``FileLock.__enter__`` does. A lock it takes is released at once.
    The file is always closed and no exception leaves the function.

    Args:
        lock_path (str): The lock file the main thread waits for.
        sidecar_path (str): The ``.progress`` sidecar of that lock.

    Returns:
        str: The block text, starting with ``=== lock probe`` and ending with a blank line.
    """
    lines = ['=== lock probe', f'lock_path={lock_path}', f'platform={sys.platform}']
    try:
        handle = None
        try:
            try:
                handle = open(lock_path, 'wb')
            except Exception as exc:
                lines += ['result=error'] + _describe_error('open', exc)
            else:
                try:
                    if os.name == 'nt':
                        import msvcrt

                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl

                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        fcntl.flock(handle, fcntl.LOCK_UN)
                    lines.append('result=lock_free')
                except Exception as exc:
                    lines += ['result=error'] + _describe_error('lock', exc)
        finally:
            if handle is not None:
                handle.close()
    except Exception as exc:
        lines.append(f'probe_error={type(exc).__name__}: {exc}')
    lines += _describe_path('lock_file', lock_path)
    lines += _describe_path('sidecar', sidecar_path)
    try:
        with open(sidecar_path, 'r', encoding='utf-8', errors='replace') as sidecar:
            text = ''.join(sidecar.readlines()[:2])[:_SIDECAR_MAX]
        lines.append(f'sidecar_content={text!r}')
    except Exception as exc:
        lines.append(f'sidecar_content_error={type(exc).__name__}')
    return '\n'.join(lines) + '\n\n'


def _frame_is(frame, name: str, filename: str = 'threading.py') -> bool:
    """
    Tell whether a frame runs the function ``name`` of the file ``filename``.

    Args:
        frame (frame): The frame to test.
        name (str): The expected function name.
        filename (str): The expected file basename.

    Returns:
        bool: True when both match.
    """
    code = frame.f_code
    return code.co_name == name and os.path.basename(code.co_filename) == filename


def _find_start_wait(frame):
    """
    Find the ``Thread.start`` frame a thread is waiting in.

    The thread's innermost frames must be one or more ``wait`` frames of ``threading.py``,
    followed directly by a ``start`` frame of ``threading.py``.

    Args:
        frame (frame | None): The innermost frame of the thread.

    Returns:
        frame | None: The ``start`` frame, or None when the thread is not waiting in it.
    """
    waits = 0
    while frame is not None and _frame_is(frame, 'wait'):
        waits += 1
        frame = frame.f_back
    if waits and frame is not None and _frame_is(frame, 'start'):
        return frame
    return None


def _on_stack(frame, target) -> bool:
    """
    Tell whether a frame object is on a stack.

    Args:
        frame (frame | None): The innermost frame of the stack.
        target (frame): The frame object to look for, compared by identity.

    Returns:
        bool: True when ``target`` is ``frame`` or one of its callers.
    """
    while frame is not None:
        if frame is target:
            return True
        frame = frame.f_back
    return False


class _Dumper:
    """Daemon thread that appends a stack dump to the file every interval."""

    def __init__(self, file, interval: int, started: float, kind: str = 'task') -> None:
        """
        Create the dumper.

        Args:
            file (TextIO): The open dump file.
            interval (int): Seconds between dumps.
            started (float): ``time.monotonic()`` value at hook start.
            kind (str): Process kind, see ``_detect_kind``; a pytest kind adds an info line to each dump.
        """
        self._file = file
        self._kind = kind
        self._interval = interval
        self._started = started
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self._closed = False
        self._wait_since = None
        self._probed = False
        self._recheck = _START_RECHECK_S
        self._reported = {}
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
                # A diagnostic must never stop the process it observes.
                pass
            count = max(count + 1, int((time.monotonic() - self._started) // self._interval) + 1)

    def _probe_block(self, main_frame) -> str:
        """
        Return the lock probe block when it is due, else an empty string.

        The probe is due once per process, when the main thread has been inside
        ``FileLock.__enter__`` in every dump for ``_PROBE_AFTER`` seconds.

        Args:
            main_frame (frame | None): The innermost frame of the main thread.

        Returns:
            str: The block text, or ``''``.
        """
        if self._probed:
            return ''
        try:
            wait_frame = _find_lock_wait(main_frame)
            if wait_frame is None:
                self._wait_since = None
                return ''
            now = time.monotonic()
            if self._wait_since is None:
                self._wait_since = now
            if now - self._wait_since < _PROBE_AFTER:
                return ''
            self._probed = True
            lock_obj = wait_frame.f_locals.get('self')
            lock_path = str(lock_obj.lock_path)
            sidecar_path = getattr(lock_obj, '_sidecar_path', None) or lock_path.replace('.lock', '.progress')
            return _run_lock_probe(lock_path, sidecar_path)
        except Exception as exc:
            self._probed = True
            return f'=== lock probe\nprobe_error={type(exc).__name__}: {exc}\n\n'

    def _info_line(self) -> str:
        """
        Describe the pytest worker id and the running test, read at dump time.

        Both are set by pytest after the hook started, so they cannot go in the header.

        Returns:
            str: The ``info:`` line with a trailing blank line, or ``''`` for a task child.
        """
        if not self._kind.startswith('pytest'):
            return ''
        worker = os.environ.get('PYTEST_XDIST_WORKER', '-')
        test = os.environ.get('PYTEST_CURRENT_TEST', '-')[:_TEST_MAX]
        return f'info: worker={worker} current_test={test}\n\n'

    def _dump(self) -> None:
        """
        Write one dump, then flush and fsync the file.

        Returns:
            None
        """
        frames = sys._current_frames()
        starts = {}
        try:
            starts = self._start_waits(frames)
            main_ident = threading.main_thread().ident
            text = _format_stacks(frames, threading.get_ident(), time.monotonic() - self._started, main_ident)
            text += self._info_line()
            text += self._probe_block(frames.get(threading.main_thread().ident))
        finally:
            del frames
        self._append(text)
        if starts:
            self._report_stuck_starts(starts)

    def _append(self, text: str) -> None:
        """
        Append text to the dump file under the file lock, then flush and fsync it.

        Args:
            text (str): The text to write.

        Returns:
            None
        """
        with self._lock:
            if self._closed:
                return
            self._file.write(text)
            self._file.flush()
            os.fsync(self._file.fileno())

    def _start_waits(self, frames: dict) -> dict:
        """
        Pick the threads that wait in ``Thread.start()`` and are not reported yet.

        Reported entries whose thread has left that ``start`` frame are forgotten.

        Args:
            frames (dict): Thread ident to its current frame, as ``sys._current_frames()`` returns.

        Returns:
            dict[int, frame]: Thread ident to its ``start`` frame.
        """
        own = threading.get_ident()
        found = {}
        for ident, frame in frames.items():
            if ident != own:
                start = _find_start_wait(frame)
                if start is not None:
                    found[ident] = start
        self._reported = {ident: start for ident, start in self._reported.items() if found.get(ident) is start}
        return {ident: start for ident, start in found.items() if self._reported.get(ident) is not start}

    def _report_stuck_starts(self, starts: dict) -> None:
        """
        Append a marker for every thread still inside the same ``Thread.start()`` call.

        Waits ``self._recheck`` seconds without the GIL, samples the threads again and
        compares the ``start`` frame objects by identity. Nothing is written when the
        dumper is stopped during the wait.

        Args:
            starts (dict[int, frame]): Thread ident to its ``start`` frame from the first sample.

        Returns:
            None
        """
        try:
            if self._stop.wait(self._recheck):
                return
            frames = sys._current_frames()
            try:
                stuck = {ident: start for ident, start in starts.items() if _on_stack(frames.get(ident), start)}
            finally:
                del frames
            if not stuck:
                return
            self._reported.update(stuck)
            self._append(
                ''.join(
                    f'=== thread start stuck thread=0x{ident:016x} seconds={self._recheck:g}\n\n' for ident in stuck
                )
            )
        finally:
            starts.clear()

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


def _wrap_wmi(dumper: '_Dumper') -> bool:
    """
    Wrap ``_wmi.exec_query`` so every call appends one ``=== wmi query`` line to the dump file.

    ``platform`` looks ``_wmi.exec_query`` up on the module at call time, so replacing
    the attribute here covers its first query. The wrapper returns the original result
    or re-raises the original exception unchanged; a failure to log is swallowed.

    Args:
        dumper (_Dumper): The dumper whose file lock and file receive the line.

    Returns:
        bool: True when the wrapper was installed, False when ``_wmi`` is missing,
            has no ``exec_query`` or is already wrapped.
    """
    try:
        import _wmi
    except Exception:
        return False
    original = getattr(_wmi, 'exec_query', None)
    if original is None or getattr(original, '_rr_wmi_wrapped', False):
        return False

    @functools.wraps(original)
    def exec_query(*args, **kwargs):
        """
        Call the original ``exec_query``, time it and log the outcome.

        Args:
            *args: Positional arguments, passed on unchanged.
            **kwargs: Keyword arguments, passed on unchanged.

        Returns:
            str: The original result.
        """
        begin = time.monotonic()
        try:
            result = original(*args, **kwargs)
        except BaseException as exc:
            winerror = getattr(exc, 'winerror', None)
            _log_wmi(
                dumper,
                begin,
                args,
                kwargs,
                f'error={type(exc).__name__} winerror={"-" if winerror is None else winerror}',
            )
            raise
        _log_wmi(dumper, begin, args, kwargs, f'ok chars={len(result) if isinstance(result, str) else "-"}')
        return result

    exec_query._rr_wmi_wrapped = True
    _wmi.exec_query = exec_query
    return True


def _log_wmi(dumper: '_Dumper', begin: float, args: tuple, kwargs: dict, outcome: str) -> None:
    """
    Append one ``=== wmi query`` line; never raises.

    Args:
        dumper (_Dumper): The dumper that owns the file.
        begin (float): ``time.monotonic()`` value before the call.
        args (tuple): Positional arguments of the call; the first one is the query text.
        kwargs (dict): Keyword arguments of the call; ``query`` is used when ``args`` is empty.
        outcome (str): The text after the seconds field.

    Returns:
        None
    """
    try:
        seconds = time.monotonic() - begin
        query = args[0] if args else kwargs.get('query', '')
        query = str(query)[:_WMI_QUERY_MAX].replace('\r', ' ').replace('\n', ' ')
        dumper._append(f'=== wmi query seconds={seconds:.3f} {outcome} query={query}\n\n')
    except Exception:
        # A diagnostic must never stop the process it observes.
        pass


def _start() -> None:
    """
    Open the per-pid dump file and start the dumper thread.

    Does nothing unless the dump directory is set and ``_detect_kind`` names a kind.

    Returns:
        None
    """
    out_dir = os.environ.get(_DUMP_DIR_VAR)
    if not out_dir:
        return
    kind = _detect_kind(list(sys.argv or []), list(getattr(sys, 'orig_argv', None) or []))
    if not kind:
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
        f'pid={os.getpid()} started={time.strftime("%Y-%m-%dT%H:%M:%S%z")} interval={interval}s kind={kind}\nargv={" ".join(getattr(sys, "orig_argv", None) or sys.argv)}\n'
    )
    dump_file.flush()
    header_size = os.path.getsize(path)

    dumper = _Dumper(dump_file, interval, time.monotonic(), kind)
    dumper.start()
    if os.name == 'nt':
        try:
            _wrap_wmi(dumper)
        except Exception:
            # A diagnostic must never stop the process it observes.
            pass

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
            # A diagnostic must never stop the process it observes.
            pass

    atexit.register(_finish)


try:
    _start()
except Exception:
    # A diagnostic must never stop the process it observes.
    pass
