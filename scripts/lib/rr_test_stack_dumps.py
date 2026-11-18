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

followed by a blank line. With ``_WMI_SKIP`` false the wrapper returns the original result
or re-raises the original exception unchanged. With ``_WMI_SKIP`` true (the default) it never
calls ``_wmi``: it appends the block below and raises ``OSError``, which ``platform`` treats
as "WMI unavailable" and answers from ``sys.getwindowsversion()``, the ``ver`` command
(run once in a child process) and the environment::

    === wmi query seconds=<s, 3 decimals> skipped query=<first 200 chars>

Nothing the wrapper logs can raise.

The hook also journals every take of ``install.lock``. Once ``depends`` (the engine's
``depends.py``) is imported, ``FileLock.__enter__``, ``FileLock.__exit__`` and
``_verdict_cached`` are wrapped; if ``depends`` is not imported yet when the hook starts, a
``sys.meta_path`` finder wraps it right after its first import, before any lock is taken.
When the lock is released, the process appends one line (``req`` is the ``requirements``
argument of the calling ``depends()`` frame, ``-`` when there is none; the epochs are wall
clock, ``waited`` and ``held`` are monotonic seconds)::

    === lock take req=<abs path or -> wait_start=<epoch> acquired=<epoch> released=<epoch> waited=<s> held=<s> cache=hit|miss|none installed=yes|no|unknown

followed by a blank line. ``cache`` is the result of ``_verdict_cached`` during the hold
(``hit`` if any call returned true, ``miss`` if all returned false, ``none`` if it was not
called). ``installed`` compares ``_installed_fingerprint()`` at acquire and at release
(``unknown`` when it cannot be computed). Each periodic dump also appends one line for every
take of this process that is waiting for or holding the lock::

    === lock state waiting_since=<epoch> req=<abs path or ->
    === lock state holding_since=<epoch> req=<abs path or ->

followed by a blank line. The wrappers pass return values and exceptions through unchanged
and swallow every error of their own.

A child that exits normally removes a file that holds no dump, so what is left
belongs to children that ran long or were killed.
"""

import atexit
import functools
import importlib.abc
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

# True: the wrapped ``_wmi.exec_query`` never calls the original and raises ``OSError``
# after logging a ``skipped`` block. False: it calls the original and logs the outcome.
_WMI_SKIP = True

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
        self._journal = None
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

    def _lock_state_block(self) -> str:
        """
        Describe the lock takes of this process that are waiting or holding, read at dump time.

        Returns:
            str: The ``=== lock state`` lines, or ``''`` when there are none or no journal is set.
        """
        try:
            return self._journal.state_text() if self._journal is not None else ''
        except Exception:
            return ''

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
            text += self._lock_state_block()
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
    the attribute here covers its first query. With ``_WMI_SKIP`` false the wrapper returns
    the original result or re-raises the original exception unchanged. With ``_WMI_SKIP``
    true it never calls the original: it logs a ``skipped`` block and raises ``OSError``.
    A failure to log is swallowed in both modes.

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
        Skip the query (``_WMI_SKIP`` true) or call the original, time it and log the outcome.

        Args:
            *args: Positional arguments, passed on unchanged.
            **kwargs: Keyword arguments, passed on unchanged.

        Returns:
            str: The original result; never returns when ``_WMI_SKIP`` is true.

        Raises:
            OSError: When ``_WMI_SKIP`` is true.
        """
        begin = time.monotonic()
        if _WMI_SKIP:
            _log_wmi(dumper, begin, args, kwargs, 'skipped')
            raise OSError('WMI query skipped by the test hook')
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


def _clean_field(value) -> str:
    """
    Make a value safe for a one-line field.

    Args:
        value (object): The value to print.

    Returns:
        str: The text with line breaks replaced by spaces.
    """
    return str(value).replace('\r', ' ').replace('\n', ' ')


def _caller_requirements(frame) -> str:
    """
    Read the ``requirements`` local of the frame that entered a lock.

    Args:
        frame (frame | None): The frame that runs the ``with FileLock(...)`` statement.

    Returns:
        str: The path, or ``-`` when the frame has no non-empty ``requirements`` local.
    """
    try:
        value = frame.f_locals.get('requirements') if frame is not None else None
        return _clean_field(value) if value else '-'
    except Exception:
        return '-'


class _LockJournal:
    """Wraps ``FileLock`` and ``_verdict_cached`` of ``depends`` and journals every take of the lock."""

    def __init__(self, dumper: '_Dumper') -> None:
        """
        Create the journal.

        Args:
            dumper (_Dumper): The dumper whose file receives the lines.
        """
        self._dumper = dumper
        self._local = threading.local()
        self._guard = threading.Lock()
        self._active = {}

    def _takes(self) -> list:
        """
        Return the calling thread's stack of takes that hold the lock.

        Returns:
            list[dict]: The takes, innermost last.
        """
        takes = getattr(self._local, 'takes', None)
        if takes is None:
            takes = self._local.takes = []
        return takes

    @staticmethod
    def _fingerprint(module):
        """
        Read the installed-set digest of ``depends``.

        Args:
            module (types.ModuleType): The ``depends`` module.

        Returns:
            str | None: The digest, or None when it cannot be computed.
        """
        try:
            return module._installed_fingerprint()
        except Exception:
            return None

    def state_text(self) -> str:
        """
        Describe every take of this process that is waiting for or holding the lock.

        Returns:
            str: One ``=== lock state`` line plus a blank line per take, or ``''``.
        """
        with self._guard:
            takes = list(self._active.values())
        lines = []
        for take in takes:
            since = take.get('acquired') or take['wait_start']
            kind = 'holding_since' if take.get('acquired') else 'waiting_since'
            lines.append(f'=== lock state {kind}={since:.3f} req={take["req"]}\n\n')
        return ''.join(lines)

    def _log_take(self, take: dict, released: float, held: float, installed: str) -> None:
        """
        Append the ``=== lock take`` line; never raises.

        Args:
            take (dict): The take's record.
            released (float): Wall-clock release time.
            held (float): Monotonic seconds between acquire and release.
            installed (str): ``yes``, ``no`` or ``unknown``.

        Returns:
            None
        """
        try:
            self._dumper._append(
                f'=== lock take req={take["req"]} wait_start={take["wait_start"]:.3f} '
                f'acquired={take["acquired"]:.3f} released={released:.3f} '
                f'waited={take["waited"]:.3f} held={held:.3f} cache={take["cache"]} installed={installed}\n\n'
            )
        except Exception:
            # A diagnostic must never stop the process it observes.
            pass

    def patch(self, module) -> bool:
        """
        Wrap ``FileLock.__enter__``, ``FileLock.__exit__`` and ``_verdict_cached`` of a ``depends`` module.

        Args:
            module (types.ModuleType): The ``depends`` module.

        Returns:
            bool: True when the wrappers were installed, False when the module lacks
                ``FileLock`` or ``_verdict_cached``, or is already wrapped.
        """
        lock_class = getattr(module, 'FileLock', None)
        verdict = getattr(module, '_verdict_cached', None)
        if lock_class is None or verdict is None or getattr(lock_class, '_rr_lock_journal', False):
            return False
        original_enter = lock_class.__enter__
        original_exit = lock_class.__exit__
        journal = self

        @functools.wraps(original_enter)
        def __enter__(self):
            """
            Time the wait, call the original and record the acquire.

            Returns:
                object: What the original returns.
            """
            take = None
            try:
                take = {
                    'req': _caller_requirements(sys._getframe(1)),
                    'wait_start': time.time(),
                    'wait_mono': time.monotonic(),
                    'cache': 'none',
                }
                with journal._guard:
                    journal._active[id(take)] = take
            except Exception:
                take = None
            try:
                result = original_enter(self)
            except BaseException:
                if take is not None:
                    with journal._guard:
                        journal._active.pop(id(take), None)
                raise
            try:
                if take is not None:
                    take['acquired'] = time.time()
                    take['acquired_mono'] = time.monotonic()
                    take['waited'] = take['acquired_mono'] - take['wait_mono']
                    take['fingerprint'] = journal._fingerprint(module)
                    self._rr_take = take
                    journal._takes().append(take)
            except Exception:
                pass
            return result

        @functools.wraps(original_exit)
        def __exit__(self, *args):
            """
            Record the release, call the original and append the take line.

            Args:
                *args: Exception information, passed on unchanged.

            Returns:
                object: What the original returns.
            """
            take = None
            released = held = 0.0
            installed = 'unknown'
            try:
                take = getattr(self, '_rr_take', None)
                if take is not None:
                    self._rr_take = None
                    released = time.time()
                    held = time.monotonic() - take['acquired_mono']
                    before, after = take.get('fingerprint'), journal._fingerprint(module)
                    if before is not None and after is not None:
                        installed = 'no' if before == after else 'yes'
                    takes = journal._takes()
                    if take in takes:
                        takes.remove(take)
                    with journal._guard:
                        journal._active.pop(id(take), None)
            except Exception:
                pass
            try:
                return original_exit(self, *args)
            finally:
                if take is not None:
                    journal._log_take(take, released, held, installed)

        @functools.wraps(verdict)
        def _verdict_cached(*args, **kwargs):
            """
            Call the original and note its answer on the take the calling thread holds.

            Args:
                *args: Positional arguments, passed on unchanged.
                **kwargs: Keyword arguments, passed on unchanged.

            Returns:
                bool: What the original returns.
            """
            result = verdict(*args, **kwargs)
            try:
                takes = journal._takes()
                if takes and takes[-1]['cache'] != 'hit':
                    takes[-1]['cache'] = 'hit' if result else 'miss'
            except Exception:
                pass
            return result

        lock_class.__enter__ = __enter__
        lock_class.__exit__ = __exit__
        lock_class._rr_lock_journal = True
        module._verdict_cached = _verdict_cached
        return True


class _DependsFinder(importlib.abc.MetaPathFinder):
    """Meta-path finder that wraps ``depends`` right after its first import."""

    def __init__(self, journal: '_LockJournal') -> None:
        """
        Create the finder.

        Args:
            journal (_LockJournal): The journal that patches the module.
        """
        self._journal = journal

    def find_spec(self, fullname, path=None, target=None):
        """
        Find the spec of ``depends`` with the other finders and wrap its loader's ``exec_module``.

        Args:
            fullname (str): The module name.
            path (list[str] | None): The package path.
            target (types.ModuleType | None): The module being reloaded.

        Returns:
            importlib.machinery.ModuleSpec | None: The spec, or None to let the other finders answer.
        """
        if fullname != 'depends':
            return None
        try:
            spec = None
            for finder in list(sys.meta_path):
                find = getattr(finder, 'find_spec', None)
                if finder is self or find is None:
                    continue
                spec = find(fullname, path, target)
                if spec is not None:
                    break
            loader = getattr(spec, 'loader', None)
            original = getattr(loader, 'exec_module', None)
            if original is None:
                return spec
            journal = self._journal

            def exec_module(module):
                """
                Run the original ``exec_module``, then wrap the module; the wrapping never raises.

                Args:
                    module (types.ModuleType): The module that was just created.

                Returns:
                    None
                """
                original(module)
                try:
                    journal.patch(module)
                except Exception:
                    pass

            loader.exec_module = exec_module
            return spec
        except Exception:
            return None


def _watch_depends(dumper: '_Dumper') -> None:
    """
    Journal the lock takes of ``depends``, now when it is imported, else right after its import.

    Args:
        dumper (_Dumper): The dumper that receives the lines and the periodic ``lock state`` lines.

    Returns:
        None
    """
    journal = _LockJournal(dumper)
    dumper._journal = journal
    module = sys.modules.get('depends')
    if module is not None and journal.patch(module):
        return
    sys.meta_path.insert(0, _DependsFinder(journal))


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

    try:
        _watch_depends(dumper)
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
