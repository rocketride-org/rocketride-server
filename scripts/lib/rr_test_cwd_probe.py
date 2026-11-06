"""
Test-only pytest plugin that detects a closed current-directory handle (issue #3046).

On Windows every process keeps an open handle to its current directory; the loader
stores it in the PEB (``ProcessParameters->CurrentDirectory.Handle``). When some code
closes that handle by mistake, opening a file by a relative path fails with
``OSError: [Errno 9] Bad file descriptor`` while absolute paths still work.

The builder copies this module and a ``pytest11`` entry point into the engine's
site-packages for a test run (see cwdprobe.js), so pytest loads it in every pytest
process, xdist workers included. It acts only when ROCKETRIDE_TEST_CWD_PROBE names a
directory and the platform is Windows. It then:

- reads the cwd handle from the PEB and asks ``GetFinalPathNameByHandleW`` for its path;
  the handle is dead when that call fails or the path is not the process's cwd (a closed
  handle value can be reused by another object);
- checks before and after every test phase (setup, call, teardown) and once a second
  from a background thread, which also covers closes between tests;
- on a dead handle writes ``cwd_probe_<utc>_<pid>_<n>.txt`` into that directory: time,
  pid, argv, the current test and phase, the recent phases, the process handle count,
  the loaded DLLs and the stack of every thread;
- re-arms: the process leaves the cwd and enters it again, which opens a fresh handle
  (see WindowsBackend.reopen_cwd_handle), then keeps watching and counts the occurrences.
  The old handle value gets closed once more, so an object that reused it loses its
  handle; the process is already broken at that point.

``armed_<pid>.txt`` is written at start and rewritten at the end with the check and
occurrence counts, so an artifact without reports still shows that the probe ran.
Nothing is ever written into the cwd.
"""

import collections
import ctypes
import datetime
import faulthandler
import ntpath
import os
import sys
import tempfile
import threading
import time

import pytest

_DIR_VAR = 'ROCKETRIDE_TEST_CWD_PROBE'
_INTERVAL_SECS = 1.0
_MAX_REPORTS = 10
# A re-armed handle can die again at once (its value may still be in use elsewhere); closes this
# close together count as one report.
_MIN_REPORT_GAP_SECS = 5.0
_HISTORY_LEN = 30

_probe = None


def _utc_now() -> str:
    """
    Return the current UTC time as an ISO-8601 string with milliseconds.

    Returns:
        str: For example ``2026-11-06T12:00:00.123Z``.
    """
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


def _norm(path: str) -> str:
    """
    Normalise a Windows path for comparison: no ``\\\\?\\`` prefix, no trailing slash, folded case.

    Parameters:
        path (str): A path as returned by GetFinalPathNameByHandleW or os.getcwd.

    Returns:
        str: The comparable form.
    """
    if path.startswith('\\\\?\\UNC\\'):
        path = '\\\\' + path[8:]
    elif path.startswith('\\\\?\\'):
        path = path[4:]
    return ntpath.normcase(ntpath.normpath(path))


def _same_dir(final_path: str, cwd: str) -> bool:
    """
    Tell whether the path a handle resolves to is the process's cwd.

    The final path has links and junctions resolved while ``os.getcwd`` may not, so a
    textual mismatch falls back to comparing the two directories on disk.

    Parameters:
        final_path (str): Path from GetFinalPathNameByHandleW.
        cwd (str): The current directory from ``os.getcwd``.

    Returns:
        bool: True when both name the same directory.
    """
    if _norm(final_path) == _norm(cwd):
        return True
    try:
        return os.path.samefile(final_path, cwd)
    except (OSError, ValueError):
        return False


class WindowsBackend:
    """The Windows calls the probe needs, kept apart so tests can replace them."""

    def __init__(self) -> None:
        """Bind the kernel32 and ntdll functions with explicit argument types."""
        from ctypes import wintypes

        self._k32 = ctypes.WinDLL('kernel32', use_last_error=True)
        k32 = self._k32
        k32.GetCurrentProcess.restype = ctypes.c_void_p
        k32.GetFinalPathNameByHandleW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, wintypes.DWORD, wintypes.DWORD]
        k32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
        k32.GetProcessHandleCount.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
        k32.GetProcessHandleCount.restype = wintypes.BOOL
        k32.K32EnumProcessModules.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_void_p),
            wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        k32.K32EnumProcessModules.restype = wintypes.BOOL
        k32.CreateEventW.argtypes = [ctypes.c_void_p, wintypes.BOOL, wintypes.BOOL, ctypes.c_wchar_p]
        k32.CreateEventW.restype = ctypes.c_void_p
        k32.CloseHandle.argtypes = [ctypes.c_void_p]
        k32.GetHandleInformation.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD)]
        k32.GetHandleInformation.restype = wintypes.BOOL
        k32.GetModuleFileNameW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, wintypes.DWORD]
        k32.GetModuleFileNameW.restype = wintypes.DWORD

        ntdll = ctypes.WinDLL('ntdll')
        ntdll.NtQueryInformationProcess.argtypes = [
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.c_void_p,
            ctypes.c_ulong,
            ctypes.POINTER(ctypes.c_ulong),
        ]
        ntdll.NtQueryInformationProcess.restype = ctypes.c_long
        self._ntdll = ntdll
        self._ptr = ctypes.sizeof(ctypes.c_void_p)

    def _handle_slot(self) -> int:
        """
        Return the address of ``CurrentDirectory.Handle`` in this process's PEB.

        The PEB holds ``ProcessParameters`` after four pointer-sized fields. In
        RTL_USER_PROCESS_PARAMETERS the 16 bytes of lengths and flags are followed by
        five pointer-sized fields (console handle and flags, three standard handles)
        and the cwd UNICODE_STRING, which is two pointers wide; the handle comes next.

        Returns:
            int: The address of the handle slot.

        Raises:
            OSError: When NtQueryInformationProcess fails.
        """
        ptr = self._ptr
        info = (ctypes.c_void_p * 6)()
        status = self._ntdll.NtQueryInformationProcess(
            self._k32.GetCurrentProcess(), 0, ctypes.byref(info), ctypes.sizeof(info), None
        )
        if status != 0:
            raise OSError(f'NtQueryInformationProcess failed: 0x{status & 0xFFFFFFFF:08x}')
        params = ctypes.c_void_p.from_address(info[1] + 4 * ptr).value
        return params + 16 + 7 * ptr

    def cwd_handle(self) -> int:
        """
        Read the cwd handle from the PEB.

        Returns:
            int: The handle value, 0 when the slot is empty.
        """
        return ctypes.c_void_p.from_address(self._handle_slot()).value or 0

    def reopen_cwd_handle(self, cwd: str) -> int:
        """
        Make the process open its current directory again and return the new handle.

        ``os.chdir`` to the directory the process is already in does nothing, so the
        process leaves it and enters it again. Every ``chdir`` opens the new handle
        first and then closes the old handle value. A closed value is the first one to
        be reused, so the new handle could get the old value and be closed at once. A
        placeholder event takes that value first, and the ``chdir`` closes the event.

        Parameters:
            cwd (str): The current directory.

        Returns:
            int: The new handle value.

        Raises:
            OSError: When the process cannot change directory.
        """
        from ctypes import wintypes

        dead = self.cwd_handle()
        placeholder = self._k32.CreateEventW(None, True, False, None)
        try:
            parent = os.path.dirname(cwd)
            os.chdir(parent if parent != cwd else tempfile.gettempdir())
            os.chdir(cwd)
        finally:
            flags = wintypes.DWORD()
            # Still open means the chdir did not close it: it did not hold the old value.
            if placeholder and placeholder != dead and self._k32.GetHandleInformation(placeholder, ctypes.byref(flags)):
                self._k32.CloseHandle(placeholder)
        return self.cwd_handle()

    def final_path(self, handle: int) -> tuple:
        """
        Resolve a handle to its path.

        Parameters:
            handle (int): The handle value to query.

        Returns:
            tuple: ``(path, None)`` on success, ``(None, 'winerror N')`` on failure.
        """
        size = 1024
        for _ in range(2):
            buf = ctypes.create_unicode_buffer(size)
            n = self._k32.GetFinalPathNameByHandleW(handle, buf, size, 0)
            if n == 0:
                return None, f'winerror {ctypes.get_last_error()}'
            if n < size:
                return buf.value, None
            size = n + 1
        return None, 'path too long'

    def handle_count(self) -> int:
        """
        Count the handles the process holds.

        Returns:
            int: The count, -1 when the call fails.
        """
        from ctypes import wintypes

        count = wintypes.DWORD()
        if self._k32.GetProcessHandleCount(self._k32.GetCurrentProcess(), ctypes.byref(count)):
            return count.value
        return -1

    def modules(self) -> list:
        """
        List the DLLs and the executable loaded in the process.

        Returns:
            list: Full paths, in load order.
        """
        from ctypes import wintypes

        mods = (ctypes.c_void_p * 4096)()
        needed = wintypes.DWORD()
        proc = self._k32.GetCurrentProcess()
        if not self._k32.K32EnumProcessModules(proc, mods, ctypes.sizeof(mods), ctypes.byref(needed)):
            return []
        out = []
        for i in range(min(needed.value // self._ptr, len(mods))):
            buf = ctypes.create_unicode_buffer(1024)
            if self._k32.GetModuleFileNameW(mods[i], buf, 1024):
                out.append(buf.value)
        return out


class CwdProbe:
    """Watches the cwd handle of this process and writes a report when it dies."""

    def __init__(self, out_dir: str, backend, interval: float = _INTERVAL_SECS) -> None:
        """
        Create the probe; call start() to arm it.

        Parameters:
            out_dir (str): Directory for the report files.
            backend: Object with cwd_handle, reopen_cwd_handle, final_path, handle_count, modules.
            interval (float): Seconds between background checks.
        """
        self.out_dir = out_dir
        self.backend = backend
        self.interval = interval
        self.checks = 0
        self.occurrences = 0
        self.nodeid = ''
        self.phase = ''
        self.history = collections.deque(maxlen=_HISTORY_LEN)
        self.last_ok = ''
        self.reports = []
        self._initial_handle = 0
        self._last_report_at = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    def start(self) -> None:
        """Write the armed file and start the background thread."""
        os.makedirs(self.out_dir, exist_ok=True)
        self._initial_handle = self.backend.cwd_handle()
        self._write_armed('started')
        self.last_ok = _utc_now()
        self._thread = threading.Thread(target=self._loop, name='rr-cwd-probe', daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop the thread and rewrite the armed file with the final counts."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(2)
        self._write_armed('finished')

    def enter(self, nodeid: str, phase: str) -> None:
        """
        Record the test phase that is about to run.

        Parameters:
            nodeid (str): The pytest node id.
            phase (str): ``setup``, ``call`` or ``teardown``.
        """
        self.nodeid = nodeid
        self.phase = phase
        self.history.append((_utc_now(), nodeid, phase))

    def check(self, where: str) -> bool:
        """
        Check the cwd handle once; on a dead handle write a report and re-arm.

        Parameters:
            where (str): What triggered the check, for example ``thread`` or ``before call``.

        Returns:
            bool: True when the handle was dead.
        """
        with self._lock:
            self.checks += 1
            try:
                handle = self.backend.cwd_handle()
                cwd = os.getcwd()
                path, error = self.backend.final_path(handle) if handle else (None, 'handle is 0')
                if path is not None and _same_dir(path, cwd):
                    self.last_ok = _utc_now()
                    return False
                reason = (
                    f'GetFinalPathNameByHandleW failed ({error})'
                    if path is None
                    else f'handle resolves to {path!r}, cwd is {cwd!r}'
                )
                self.occurrences += 1
                now = time.monotonic()
                quiet = self._last_report_at is not None and now - self._last_report_at < _MIN_REPORT_GAP_SECS
                if len(self.reports) < _MAX_REPORTS and not quiet:
                    self._last_report_at = now
                    self._report(where, handle, cwd, reason)
                self._rearm(cwd)
                return True
            except Exception as err:
                # A diagnostic must never fail the test it observes.
                self._note(f'probe error in {where}: {err!r}')
                return False

    def _loop(self) -> None:
        """Check every interval until stopped."""
        while not self._stop.wait(self.interval):
            self.check('thread')

    def _rearm(self, cwd: str) -> None:
        """
        Give the process a fresh cwd handle.

        Parameters:
            cwd (str): The directory to enter again.
        """
        try:
            self._note(f're-armed: new handle 0x{self.backend.reopen_cwd_handle(cwd):x}')
        except Exception as err:
            self._note(f're-arm failed: {err!r}')

    def _note(self, line: str) -> None:
        """
        Append a line to the newest report, or to the armed file when there is none.

        Parameters:
            line (str): The text to append.
        """
        target = self.reports[-1] if self.reports else os.path.join(self.out_dir, f'armed_{os.getpid()}.txt')
        try:
            with open(target, 'a', encoding='utf-8') as f:
                f.write(f'{_utc_now()} {line}\n')
        except OSError:
            pass

    def _write_armed(self, state: str) -> None:
        """
        Write the per-process marker file.

        Parameters:
            state (str): ``started`` or ``finished``.
        """
        try:
            handle = self.backend.cwd_handle()
            path, error = self.backend.final_path(handle) if handle else (None, 'handle is 0')
            with open(os.path.join(self.out_dir, f'armed_{os.getpid()}.txt'), 'w', encoding='utf-8') as f:
                f.write(
                    f'state={state} utc={_utc_now()} pid={os.getpid()}\n'
                    f'argv={" ".join(sys.argv)}\ncwd={os.getcwd()}\n'
                    f'initial_handle=0x{self._initial_handle:x} handle=0x{handle:x} path={path} error={error}\n'
                    f'checks={self.checks} occurrences={self.occurrences}\n'
                )
        except Exception:
            pass

    def _report(self, where: str, handle: int, cwd: str, reason: str) -> None:
        """
        Write one report file.

        Parameters:
            where (str): What triggered the check.
            handle (int): The dead handle value.
            cwd (str): The process's current directory.
            reason (str): Why the handle counts as dead.
        """
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')
        path = os.path.join(self.out_dir, f'cwd_probe_{stamp}_{os.getpid()}_{self.occurrences}.txt')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(
                f'cwd handle is dead (occurrence {self.occurrences})\n'
                f'utc={_utc_now()} pid={os.getpid()}\nargv={" ".join(sys.argv)}\n'
                f'detected_by={where}\n'
                f'test={self.nodeid or "(none yet)"} phase={self.phase or "(none)"}\n'
                f'handle=0x{handle:x} initial_handle=0x{self._initial_handle:x}\ncwd={cwd}\n'
                f'reason={reason}\nlast_ok_utc={self.last_ok}\n'
                f'process_handle_count={self.backend.handle_count()}\n'
                f'\n--- recent test phases (oldest first) ---\n'
            )
            for when, nodeid, phase in self.history:
                f.write(f'{when} {phase:<8} {nodeid}\n')
            f.write('\n--- thread stacks ---\n')
            f.flush()
            faulthandler.dump_traceback(file=f, all_threads=True)
            mods = self.backend.modules()
            f.write(f'\n--- loaded modules ({len(mods)}) ---\n')
            f.writelines(f'{m}\n' for m in mods)
        self.reports.append(path)


def enabled() -> bool:
    """
    Tell whether the probe should run in this process.

    Returns:
        bool: True on Windows when ROCKETRIDE_TEST_CWD_PROBE names a directory.
    """
    return os.name == 'nt' and bool(os.environ.get(_DIR_VAR))


def pytest_configure(config) -> None:
    """Arm the probe in this pytest process (controller and xdist workers alike)."""
    global _probe
    if _probe is not None or not enabled():
        return
    try:
        probe = CwdProbe(os.path.abspath(os.environ[_DIR_VAR]), WindowsBackend())
        probe.start()
        _probe = probe
    except Exception:
        # A diagnostic must never stop the run it observes.
        _probe = None


def pytest_unconfigure(config) -> None:
    """Stop the probe and write its final counts."""
    global _probe
    if _probe is not None:
        _probe.stop()
        _probe = None


def _phase_wrapper(item, phase: str):
    """
    Run one test phase between two checks.

    Parameters:
        item: The pytest item.
        phase (str): ``setup``, ``call`` or ``teardown``.

    Yields:
        None: Control to pytest while the phase runs.
    """
    if _probe is None:
        yield
        return
    _probe.enter(item.nodeid, phase)
    _probe.check(f'before {phase}')
    yield
    _probe.check(f'after {phase}')


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_setup(item):
    """Check around the setup phase."""
    yield from _phase_wrapper(item, 'setup')


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item):
    """Check around the call phase."""
    yield from _phase_wrapper(item, 'call')


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(item):
    """Check around the teardown phase."""
    yield from _phase_wrapper(item, 'teardown')


def pytest_terminal_summary(terminalreporter) -> None:
    """Print how often the cwd handle died and where the reports are."""
    if _probe is not None and _probe.occurrences:
        terminalreporter.write_line(f'cwd probe: handle died {_probe.occurrences} time(s); reports: {_probe.reports}')
