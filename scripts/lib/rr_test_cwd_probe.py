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

- picks a stable regular file of the cwd with an absolute ``os.listdir`` (an absolute
  path does not use the cwd handle): the oldest one that is not newer than the probe's
  start. It reads the file's identity (volume serial and file index, from
  ``GetFileInformationByHandle``) through a handle opened by its relative name, which goes
  through the cwd handle, and through one opened by its absolute path. Both opens ask only
  for FILE_READ_ATTRIBUTES and share read, write and delete, so they conflict with no other
  opener, and both handles are closed at once. The handle is dead when the relative open
  fails with winerror 6 (ERROR_INVALID_HANDLE), when it yields another identity (the handle
  value now belongs to another directory), or when it reports file or path not found while
  the absolute open succeeds. A relative ``os.stat`` is no test: it resolves the full path
  and works with a closed handle. The file is picked again when ``os.getcwd()`` changes or
  the file disappears;
- checks before and after every test phase (setup, call, teardown) and once a second
  from a background thread, which also covers closes between tests;
- on a dead handle writes one ``cwd_probe_<utc>_<pid>.txt`` into that directory: time,
  pid, argv, the current test and phase, the recent phases, the process handle count,
  the loaded DLLs and the stack of every thread. Then it stops checking in this process.

After the start the probe never queries or changes the handle: a closed handle value can
be reused by any object, and asking a reused pipe or file handle for its path can block.
The PEB handle and its path are read once at start for the report header.

``armed_<pid>.txt`` is written at start and rewritten at the end with the number of
checks, so an artifact without reports still shows that the probe ran.
Nothing is ever written into the cwd.
"""

import collections
import ctypes
import datetime
import faulthandler
import os
import stat
import sys
import threading
import time

import pytest

_DIR_VAR = 'ROCKETRIDE_TEST_CWD_PROBE'
_INTERVAL_SECS = 1.0
_HISTORY_LEN = 30
_probe = None


def _utc_now() -> str:
    """
    Return the current UTC time as an ISO-8601 string with milliseconds.

    Returns:
        str: For example ``2026-11-06T12:00:00.123Z``.
    """
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z'


# Win32 error codes
_ERROR_FILE_NOT_FOUND = 2
_ERROR_PATH_NOT_FOUND = 3
_ERROR_INVALID_HANDLE = 6


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
        k32.CreateFileW.argtypes = [
            ctypes.c_wchar_p,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.c_void_p,
            wintypes.DWORD,
            wintypes.DWORD,
            ctypes.c_void_p,
        ]
        k32.CreateFileW.restype = ctypes.c_void_p
        k32.CloseHandle.argtypes = [ctypes.c_void_p]
        k32.CloseHandle.restype = wintypes.BOOL

        class ByHandleFileInformation(ctypes.Structure):
            """BY_HANDLE_FILE_INFORMATION, as filled by GetFileInformationByHandle."""

            _fields_ = [
                ('attributes', wintypes.DWORD),
                ('created', wintypes.FILETIME),
                ('accessed', wintypes.FILETIME),
                ('written', wintypes.FILETIME),
                ('volume_serial', wintypes.DWORD),
                ('size_high', wintypes.DWORD),
                ('size_low', wintypes.DWORD),
                ('links', wintypes.DWORD),
                ('index_high', wintypes.DWORD),
                ('index_low', wintypes.DWORD),
            ]

        self._info_type = ByHandleFileInformation
        k32.GetFileInformationByHandle.argtypes = [ctypes.c_void_p, ctypes.POINTER(ByHandleFileInformation)]
        k32.GetFileInformationByHandle.restype = wintypes.BOOL
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

    def cwd_handle(self) -> int:
        """
        Read the cwd handle from the PEB.

        The PEB holds ``ProcessParameters`` after four pointer-sized fields. In
        RTL_USER_PROCESS_PARAMETERS the 16 bytes of lengths and flags are followed by
        five pointer-sized fields (console handle and flags, three standard handles)
        and the cwd UNICODE_STRING, which is two pointers wide; the handle comes next.

        Returns:
            int: The handle value, 0 when the slot is empty.

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
        return ctypes.c_void_p.from_address(params + 16 + 7 * ptr).value or 0

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

    def file_identity(self, path: str) -> tuple:
        """
        Read the identity of a file through a fresh handle that conflicts with no other opener.

        A relative path is resolved through the process's cwd handle.

        Parameters:
            path (str): Relative or absolute path of a file.

        Returns:
            tuple: ``((volume serial, index high, index low), None)`` on success,
                ``(None, win32 error code)`` on failure.
        """
        # FILE_READ_ATTRIBUTES; share read, write and delete; OPEN_EXISTING; FILE_FLAG_BACKUP_SEMANTICS.
        handle = self._k32.CreateFileW(path, 0x80, 7, None, 3, 0x02000000, None)
        if handle is None or handle == ctypes.c_void_p(-1).value:
            return None, ctypes.get_last_error()
        try:
            info = self._info_type()
            if not self._k32.GetFileInformationByHandle(handle, ctypes.byref(info)):
                return None, ctypes.get_last_error()
            return (info.volume_serial, info.index_high, info.index_low), None
        finally:
            self._k32.CloseHandle(handle)

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
    """Watches the cwd handle of this process and writes one report when it dies."""

    def __init__(self, out_dir: str, backend, interval: float = _INTERVAL_SECS) -> None:
        """
        Create the probe; call start() to arm it.

        Parameters:
            out_dir (str): Directory for the report files.
            backend: Object with cwd_handle, final_path, file_identity, handle_count and modules.
            interval (float): Seconds between background checks.
        """
        self.out_dir = out_dir
        self.backend = backend
        self.interval = interval
        self.checks = 0
        self.dead = False
        self.report_path = None
        self.nodeid = ''
        self.phase = ''
        self.history = collections.deque(maxlen=_HISTORY_LEN)
        self.last_ok = ''
        self._start_info = ''
        self._cwd = None
        self._entry = None
        self._started = time.time()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    def start(self) -> None:
        """Read the start state, write the armed file and start the background thread."""
        os.makedirs(self.out_dir, exist_ok=True)
        try:
            handle = self.backend.cwd_handle()
            path, error = self.backend.final_path(handle) if handle else (None, 'handle is 0')
            self._start_info = f'handle=0x{handle:x} path={path} error={error}'
        except Exception as err:
            self._start_info = f'handle unreadable: {err!r}'
        self._started = time.time()
        self.last_ok = _utc_now()
        self._write_armed('started')
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
        Check the cwd handle once; on a dead handle write the report and stop checking.

        Parameters:
            where (str): What triggered the check, for example ``thread`` or ``before call``.

        Returns:
            bool: True when the handle was found dead by this call.
        """
        with self._lock:
            if self.dead:
                return False
            self.checks += 1
            try:
                reason = self._probe_once()
                if reason is None:
                    self.last_ok = _utc_now()
                    return False
                self.dead = True
                self._stop.set()
                self._report(where, reason)
                return True
            except Exception as err:
                # A diagnostic must never fail the test it observes.
                self._note(f'probe error in {where}: {err!r}')
                return False

    def _pick_entry(self, cwd: str) -> None:
        """
        Choose the oldest regular file of the cwd that is not newer than the probe, by absolute paths only.

        Parameters:
            cwd (str): The current directory.
        """
        self._cwd, self._entry = cwd, None
        oldest = None
        for name in os.listdir(cwd):
            try:
                st = os.stat(os.path.join(cwd, name))
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode) and st.st_mtime <= self._started and (oldest is None or st.st_mtime < oldest):
                self._entry, oldest = name, st.st_mtime

    def _probe_once(self):
        """
        Compare the identity of one cwd file read by its relative and by its absolute name.

        Returns:
            str | None: Why the handle counts as dead, or None when it works or cannot be judged.
        """
        cwd = os.getcwd()
        if cwd != self._cwd or self._entry is None:
            self._pick_entry(cwd)
            if self._entry is None:
                return None
        name = self._entry
        absolute = os.path.join(cwd, name)
        abs_id, _ = self.backend.file_identity(absolute)
        if abs_id is None:
            # The file is gone or locked against attribute reads: pick again next time.
            self._entry = None
            return None
        rel_id, rel_err = self.backend.file_identity(name)
        if rel_id is None:
            if rel_err == _ERROR_INVALID_HANDLE:
                return f'relative open of {name!r} failed with winerror 6 (invalid handle)'
            if rel_err in (_ERROR_FILE_NOT_FOUND, _ERROR_PATH_NOT_FOUND):
                return f'relative open of {name!r} gave winerror {rel_err}, the absolute open succeeds'
            return None
        if rel_id != abs_id:
            return f'relative open of {name!r} names another file than {absolute!r}: {rel_id} vs {abs_id}'
        return None

    def _loop(self) -> None:
        """Check every interval until stopped."""
        while not self._stop.wait(self.interval):
            self.check('thread')

    def _note(self, line: str) -> None:
        """
        Append a line to the report, or to the armed file when there is none.

        Parameters:
            line (str): The text to append.
        """
        target = self.report_path or os.path.join(self.out_dir, f'armed_{os.getpid()}.txt')
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
            with open(os.path.join(self.out_dir, f'armed_{os.getpid()}.txt'), 'w', encoding='utf-8') as f:
                f.write(
                    f'state={state} utc={_utc_now()} pid={os.getpid()}\n'
                    f'argv={" ".join(sys.argv)}\nstart: {self._start_info}\n'
                    f'checks={self.checks} dead={self.dead}\n'
                )
        except Exception:
            pass

    def _report(self, where: str, reason: str) -> None:
        """
        Write the report file.

        Parameters:
            where (str): What triggered the check.
            reason (str): Why the handle counts as dead.
        """
        stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')
        path = os.path.join(self.out_dir, f'cwd_probe_{stamp}_{os.getpid()}.txt')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(
                f'cwd handle is dead\n'
                f'utc={_utc_now()} pid={os.getpid()}\nargv={" ".join(sys.argv)}\n'
                f'detected_by={where}\n'
                f'test={self.nodeid or "(none yet)"} phase={self.phase or "(none)"}\n'
                f'cwd={self._cwd}\nstart: {self._start_info}\n'
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
        self.report_path = path


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
    """Print where the report is when the cwd handle died."""
    if _probe is not None and _probe.dead:
        terminalreporter.write_line(f'cwd probe: handle died; report: {_probe.report_path}')
