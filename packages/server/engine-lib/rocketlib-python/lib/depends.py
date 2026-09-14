# =============================================================================
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
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Dependency management for RocketRide Engine.

Two modes of operation:
  - Library mode: import and call depends(requirements_file)
  - Main mode: engine depends.py [uv pip arguments]
"""

from __future__ import annotations

import hashlib
import os
import platform
import re
import subprocess
import sys
import threading
import time
from glob import glob
from typing import Optional

# Conditional imports for cross-platform file locking (both are built-in)
if os.name == 'nt':
    import msvcrt
else:
    import fcntl

# engLib is built into engine.exe, always available
from engLib import debug, monitorStatus, error

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

REQUIREMENTS_GLOBS = [
    'requirement*.txt',
    'nodes/**/requirement*.txt',
    'ai/**/requirement*.txt',
]

# Override files: unlike constraints, uv overrides REPLACE what packages
# declare. Discovered like requirement files; see packages/ai/src/ai/overrides.txt
# for the policy comment. Named 'overrides.txt' so REQUIREMENTS_GLOBS
# ('requirement*.txt') never sweeps them into the combined requirements.
OVERRIDES_GLOBS = [
    'overrides.txt',
    'nodes/**/overrides.txt',
    'ai/**/overrides.txt',
]

# Bootstrap tools install outside any constraint, so pin them or they float to 'latest' and a
# later install downgrades them. Lockstep with packages/server/scripts/tasks.js.
_BOOTSTRAP_TOOL_VERSIONS: dict[str, str] = {
    'wheel': '0.47.0',
    'setuptools': '82.0.1',
    'uv': '0.11.25',
}


def _tool_spec(name: str) -> str:
    """Pinned pip spec for a bootstrap tool; bare name if unpinned."""
    version = _BOOTSTRAP_TOOL_VERSIONS.get(name)
    return f'{name}=={version}' if version else name


# Track processed requirements to avoid redundant installs in same session
_processed: set[str] = set()


# ---------------------------------------------------------------------------
# File Locking
# ---------------------------------------------------------------------------


# Path to the progress sidecar file, set when the lock is acquired.
# The lock holder writes status updates here so waiting processes can
# display what is happening instead of a generic "Waiting..." message.
_progress_path: Optional[str] = None

# Track packages currently being downloaded so we can show a combined
# status like "Downloading torch (2.7GiB), transformers (11.4MiB)"
# instead of only the last line uv emitted.
# Each entry is (name, display) where display includes the size suffix.
_downloading: list[tuple[str, str]] = []

# Last message written to the sidecar, used by the heartbeat thread
# to refresh the timestamp so waiting processes see it ticking.
_last_sidecar_message: Optional[str] = None

# Fixed start time written to the sidecar so waiters can compute
# total elapsed time since the install began (not since last write).
_sidecar_start_time: float = 0.0

# Heartbeat thread that re-emits monitorStatus every 5 seconds to
# keep the task startup timeout alive during long silent operations.
_heartbeat_thread: Optional[threading.Thread] = None
_heartbeat_stop: Optional[threading.Event] = None


def _write_sidecar(message: str):
    """Write a progress update to the sidecar file (if lock is held)."""
    global _last_sidecar_message
    _last_sidecar_message = message
    if _progress_path:
        try:
            with open(_progress_path, 'w', encoding='utf-8') as f:
                f.write(f'{_sidecar_start_time}\n{message}\n')
        except OSError:
            pass


def _start_heartbeat():
    """Start the background heartbeat thread."""
    global _heartbeat_thread, _heartbeat_stop, _sidecar_start_time
    _sidecar_start_time = time.time()
    _heartbeat_stop = threading.Event()

    def _heartbeat_loop(stop_event: threading.Event):
        """Re-emit monitorStatus every 5 seconds to reset the task startup timeout."""
        while not stop_event.wait(5.0):
            if _last_sidecar_message:
                monitorStatus(_last_sidecar_message)

    _heartbeat_thread = threading.Thread(target=_heartbeat_loop, args=(_heartbeat_stop,), daemon=True)
    _heartbeat_thread.start()


def _stop_heartbeat():
    """Stop the background heartbeat thread."""
    global _heartbeat_thread, _heartbeat_stop
    if _heartbeat_stop:
        _heartbeat_stop.set()
    if _heartbeat_thread:
        _heartbeat_thread.join(timeout=2.0)
    _heartbeat_thread = None
    _heartbeat_stop = None


def updateProgress(message: str):
    """
    Send a status update to the engine monitor and write the progress sidecar.

    Tracks uv "Downloading <pkg>" / "Downloaded <pkg>" lines to build a
    combined status of all in-flight downloads, e.g. "Downloading torch,
    transformers".  Non-download lines are passed through as-is.
    """
    debug(f'  [uv] {message}')
    stripped = message.strip()

    # uv emits "Downloading <name> (<size>)" when a download starts
    if stripped.startswith('Downloading '):
        display = stripped[len('Downloading ') :]
        # Extract bare name for matching, e.g. "stripe (1.4MiB)" -> "stripe"
        name = display[: display.index(' (')] if ' (' in display else display
        if name and not any(n == name for n, _ in _downloading):
            _downloading.append((name, display))
        # Emit combined status with sizes, e.g. "Downloading torch (2.7GiB), stripe (1.4MiB)"
        combined = f'Downloading {", ".join(d for _, d in _downloading)}'
        monitorStatus(combined)
        _write_sidecar(combined)
        return

    # uv emits "Downloaded <name>" when a download finishes
    if stripped.startswith('Downloaded '):
        name = stripped[len('Downloaded ') :]
        if ' (' in name:
            name = name[: name.index(' (')]
        _downloading[:] = [(n, d) for n, d in _downloading if n != name]
        # If other downloads are still in flight, show them
        if _downloading:
            combined = f'Downloading {", ".join(d for _, d in _downloading)}'
            monitorStatus(combined)
            _write_sidecar(combined)
        else:
            monitorStatus(message)
            _write_sidecar(message)
        return

    # Any non-download line clears the tracking (new phase)
    _downloading.clear()
    monitorStatus(message)
    _write_sidecar(message)


def _read_progress(path: str) -> str:
    """Read the progress sidecar written by the lock holder."""
    try:
        with open(path, 'r', encoding='utf-8') as f:
            lines = f.read().strip().splitlines()
        if len(lines) < 2:
            return ''
        # Line 0 = unix timestamp, line 1 = status message
        started = float(lines[0])
        elapsed = int(time.time() - started)
        return f'{lines[1]} ({elapsed}s)'
    except (OSError, ValueError):
        return ''


class FileLock:
    """
    Simple cross-platform file lock using exclusive file access.

    While the lock is held, callers use ``updateProgress()`` instead of
    ``monitorStatus()`` so that a sidecar file is kept up to date for
    waiting processes to read.
    """

    def __init__(self, lock_path: str, poll_interval: float = 1.0):
        """Initialize the file lock with path and polling interval."""
        self.lock_path = lock_path
        self.poll_interval = poll_interval
        self._file = None
        self._sidecar_path = lock_path.replace('.lock', '.progress')

    def __enter__(self):
        """Acquire the file lock, blocking until it is available."""
        global _progress_path, _sidecar_start_time, _last_sidecar_message
        os.makedirs(os.path.dirname(self.lock_path), exist_ok=True)

        while True:
            try:
                self._file = open(self.lock_path, 'wb')
                if os.name == 'nt':
                    msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(self._file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                # Lock acquired — initialize sidecar state and enable writes
                _progress_path = self._sidecar_path
                _sidecar_start_time = time.time()
                _last_sidecar_message = None
                return self
            except (OSError, BlockingIOError):
                if self._file:
                    self._file.close()
                    self._file = None
                # Read what the lock holder is doing and include it in our status
                detail = _read_progress(self._sidecar_path)
                if detail:
                    monitorStatus(f'Waiting — {detail}')
                else:
                    monitorStatus('Waiting for another installation to complete...')
                time.sleep(self.poll_interval)

    def __exit__(self, *args):
        """Release the file lock and clean up progress sidecar."""
        global _progress_path
        _progress_path = None
        try:
            os.remove(self._sidecar_path)
        except OSError:
            pass
        if self._file:
            self._file.close()
            self._file = None


# ---------------------------------------------------------------------------
# Environment Bootstrap
# ---------------------------------------------------------------------------


def _get_executable_dir() -> str:
    """Get the directory containing the Python executable."""
    return os.path.dirname(os.path.abspath(sys.executable))


def engine_cache_dir(create: bool = False) -> str:
    """Return (and create if needed) the engine cache directory (``<executable dir>/cache``).

    Single source of truth for the cache location.

    Args:
        create: Create directory if indicated.

    Returns:
        Absolute path to the engine cache directory.
    """
    path = os.path.join(_get_executable_dir(), 'cache')
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def model_cache_dir(name: str, create: bool = True) -> str:
    """Return (and create if required) a per-model cache directory under the engine cache.

    Args:
        name: Subdirectory name for this model's weights/assets.
        create: Create directory if indicated

    Returns:
        Absolute path to the created ``<engine cache>/models/<name>`` directory.
    """
    path = os.path.join(engine_cache_dir(), 'models', name)
    if create:
        os.makedirs(path, exist_ok=True)
    return path


def _get_combined_path() -> str:
    """Path to the concatenated requirements file (the constraints-compile input)."""
    return os.path.join(engine_cache_dir(), 'combined.txt')


def _get_constraints_path() -> str:
    """Path to the compiled constraints file applied (``-c``) to every install."""
    return os.path.join(engine_cache_dir(), 'constraints.txt')


def _constraints_args(constraints_path: str, exe_dir: str) -> list[str]:
    """Return uv ``-c`` args if the constraints file exists and is non-empty, else ``[]``.

    Relative to exe_dir (the subprocess cwd) — uv splits the value on whitespace.
    """
    if os.path.exists(constraints_path) and os.path.getsize(constraints_path) > 0:
        return ['-c', os.path.relpath(constraints_path, exe_dir)]
    return []


def _get_overrides_path() -> str:
    """Path of the combined overrides file in the engine cache."""
    return os.path.join(engine_cache_dir(), 'overrides-combined.txt')


def _override_args(exe_dir: str) -> list[str]:
    """Return uv ``--override`` args if the combined overrides file is non-empty, else ``[]``.

    Relative to exe_dir (the subprocess cwd) — uv splits the value on whitespace.
    """
    overrides_path = _get_overrides_path()
    if os.path.exists(overrides_path) and os.path.getsize(overrides_path) > 0:
        return ['--override', os.path.relpath(overrides_path, exe_dir)]
    return []


def _run(args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    """
    Run a subprocess command, keeping stdin open until process exits.

    Uses Popen with threads to read stdout/stderr while keeping stdin
    open until the process naturally terminates.

    When spawning engine.exe subprocesses, adds --monitor=App to prevent
    stdin monitor from interfering with the parent process.
    """
    import threading

    # If running engine.exe as subprocess, add --monitor=App
    if args and args[0] == sys.executable:
        args = [args[0], '--monitor=App'] + args[1:]

    debug(f'Running: {" ".join(args)}')

    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        errors='replace',
    )

    # Read stdout/stderr in background threads to avoid blocking
    stdout_data = []
    stderr_data = []

    def read_stdout():
        stdout_data.append(proc.stdout.read())

    def read_stderr():
        stderr_data.append(proc.stderr.read())

    stdout_thread = threading.Thread(target=read_stdout)
    stderr_thread = threading.Thread(target=read_stderr)
    stdout_thread.start()
    stderr_thread.start()

    # Wait for process to exit (stdin stays open)
    proc.wait()

    # Now close stdin (process already exited)
    proc.stdin.close()

    # Wait for output threads to finish
    stdout_thread.join()
    stderr_thread.join()

    stdout = stdout_data[0] if stdout_data else ''
    stderr = stderr_data[0] if stderr_data else ''

    result = subprocess.CompletedProcess(args, proc.returncode, stdout, stderr)

    if check and proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, args, stdout, stderr)

    return result


def _pip_available():
    """Check if pip module is available."""
    try:
        import importlib.util

        return importlib.util.find_spec('pip') is not None
    except Exception:
        return False


def _ensure_pip():
    """Ensure pip is available using ensurepip."""
    if _pip_available():
        debug('pip is available')
        return

    updateProgress('Bootstrapping pip...')

    # Use _run which keeps stdin open until process exits
    try:
        result = _run([sys.executable, '-m', 'ensurepip', '--upgrade'], check=False)

        if result.returncode != 0:
            # Check if pip is available anyway (might have succeeded before error)
            if _pip_available():
                return
            raise RuntimeError(f'Failed to bootstrap pip: {result.stderr}')
    except Exception:
        # Check if pip got installed despite exception
        if _pip_available():
            return
        raise


def _uv_abs_path() -> str:
    """Get the absolute path to the uv executable based on platform."""
    exe_dir = _get_executable_dir()
    return os.path.join(exe_dir, 'Scripts', 'uv.exe') if os.name == 'nt' else os.path.join(exe_dir, 'bin', 'uv')


def _uv_available() -> bool:
    """Check if uv executable exists."""
    return os.path.isfile(_uv_abs_path())


def _wheel_available() -> bool:
    """Check if wheel module is available."""
    try:
        import importlib.util

        return importlib.util.find_spec('wheel') is not None
    except Exception:
        return False


def _ensure_wheel():
    """Ensure wheel is installed (needed for building packages with --no-build-isolation)."""
    if _wheel_available():
        debug('wheel is available')
        return

    updateProgress('Installing wheel...')
    result = _run(
        [sys.executable, '-m', 'pip', 'install', _tool_spec('wheel'), '--quiet', '--disable-pip-version-check'],
        check=False,
    )

    if result.returncode != 0:
        error(f'Failed to install wheel: {result.stderr}')
        raise RuntimeError('Failed to install wheel')

    debug('wheel installed successfully')


def _setuptools_available() -> bool:
    """Check if setuptools module is available."""
    try:
        import importlib.util

        return importlib.util.find_spec('setuptools') is not None
    except Exception:
        return False


def _ensure_setuptools():
    """Ensure setuptools is installed in the parent env.

    Required because we compile/install with --no-build-isolation, which means uv
    builds source-only wheels (e.g. docopt 0.6.2, transitively pulled by kokoro →
    misaki → num2words) against the parent env. Several legacy sdists declare
    setup.py-style builds without listing setuptools in build-system.requires,
    so uv can't auto-bootstrap them. Mirroring _ensure_wheel so the parent env
    has the standard PEP 517 backend available at compile/install time.
    """
    if _setuptools_available():
        debug('setuptools is available')
        return

    updateProgress('Installing setuptools...')
    result = _run(
        [sys.executable, '-m', 'pip', 'install', _tool_spec('setuptools'), '--quiet', '--disable-pip-version-check'],
        check=False,
    )

    if result.returncode != 0:
        error(f'Failed to install setuptools: {result.stderr}')
        raise RuntimeError('Failed to install setuptools')

    # Verify installation
    if not _setuptools_available():
        raise RuntimeError('setuptools installed but not found')

    debug('setuptools installed successfully')


def _ensure_uv():
    """Ensure uv is installed."""
    if _uv_available():
        debug('uv is available')
        return

    updateProgress('Installing uv...')
    result = _run(
        [sys.executable, '-m', 'pip', 'install', _tool_spec('uv'), '--quiet', '--disable-pip-version-check'],
        check=False,
    )

    if result.returncode != 0:
        error(f'Failed to install uv: {result.stderr}')
        raise RuntimeError('Failed to install uv')

    # Verify installation
    if not _uv_available():
        raise RuntimeError('uv installed but not found')


def pip(*args) -> bool:
    """
    Run pip command in a platform-independent way.

    This is a simple wrapper around 'python -m pip' for use by modules
    that need to manage packages (e.g., ai.common.opencv for cleanup).

    Usage:
        from depends import pip
        pip('uninstall', '-y', 'opencv-python')
        pip('install', 'some-package>=1.0')

    Args:
        *args: Arguments to pass to pip

    Returns:
        True if command succeeded, False otherwise
    """
    cmd = [sys.executable, '-m', 'pip'] + list(args)
    result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', check=False)
    return result.returncode == 0


def _apply_pywin32_hack():
    """
    Apply pywin32 path hack on Windows if needed.

    pywin32 uses a .pth file to add paths to sys.path at Python startup.
    If pywin32 is installed during a running session, those paths won't
    be available until the next Python restart. This hack adds them manually.
    """
    if platform.system() != 'Windows':
        return

    # Check if pywin32 is installed
    try:
        import importlib.metadata

        importlib.metadata.version('pywin32')
    except Exception:
        return  # Not installed, nothing to do

    # Check if pywintypes is already importable (hack not needed)
    try:
        import pywintypes

        _ = pywintypes
        return
    except ImportError:
        pass

    debug('Applying pywin32 path hack...')
    site_path = _get_site_packages()
    pywin32_paths = ['win32', 'win32/lib', 'Pythonwin']

    for subpath in pywin32_paths:
        full_path = os.path.abspath(os.path.join(site_path, subpath))
        if full_path not in sys.path and os.path.exists(full_path):
            sys.path.append(full_path)
            debug(f'  Added: {full_path}')


def _get_site_packages() -> str:
    """Get the site-packages directory path (platform-specific)."""
    exe_dir = _get_executable_dir()
    if os.name == 'nt':
        return os.path.join(exe_dir, 'lib', 'site-packages')
    else:
        # Unix: lib/python3.X/site-packages
        version = f'python{sys.version_info.major}.{sys.version_info.minor}'
        return os.path.join(exe_dir, 'lib', version, 'site-packages')


def _ensure_site_packages():
    """Ensure site-packages directory exists and is in sys.path."""
    site_packages = _get_site_packages()

    # Create if doesn't exist
    if not os.path.exists(site_packages):
        os.makedirs(site_packages, exist_ok=True)
        debug(f'Created site-packages: {site_packages}')

    # Ensure it's in sys.path
    if site_packages not in sys.path:
        sys.path.append(site_packages)
        debug(f'Added site-packages to sys.path: {site_packages}')


def bootstrap():
    """Bootstrap the environment: ensure pip, uv, wheel, setuptools."""
    _ensure_site_packages()  # Must be first!
    _ensure_pip()
    _ensure_wheel()  # Needed for building packages with --no-build-isolation
    _ensure_setuptools()  # Same reason — required by sdists with legacy setup.py builds
    _ensure_uv()


# ---------------------------------------------------------------------------
# Constraints Management
# ---------------------------------------------------------------------------


def _find_requirement_files() -> list[str]:
    """Find all requirement files matching the glob patterns."""
    executable_dir = _get_executable_dir()
    found = []

    for pattern in REQUIREMENTS_GLOBS:
        full_pattern = os.path.join(executable_dir, pattern)
        matches = glob(full_pattern, recursive=True)
        for path in matches:
            abs_path = os.path.abspath(path)
            if os.path.isfile(abs_path) and abs_path not in found:
                found.append(abs_path)

    return found


def _find_override_files() -> list[str]:
    """Find all override files matching OVERRIDES_GLOBS."""
    executable_dir = _get_executable_dir()
    found = []
    for pattern in OVERRIDES_GLOBS:
        full_pattern = os.path.join(executable_dir, pattern)
        for path in glob(full_pattern, recursive=True):
            abs_path = os.path.abspath(path)
            if os.path.isfile(abs_path) and abs_path not in found:
                found.append(abs_path)
    return found


def _compute_hash(file_paths: list[str]) -> str:
    """Compute a fast hash from file metadata (mtime + size)."""
    hasher = hashlib.md5()
    for path in sorted(file_paths):
        stat = os.stat(path)
        entry = f'{path}:{stat.st_size}:{stat.st_mtime_ns}\n'
        hasher.update(entry.encode())
    return hasher.hexdigest()


def _load_stored_hash(hash_file: str) -> Optional[str]:
    """Load the stored hash from file."""
    try:
        with open(hash_file, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        return None


def _save_hash(hash_file: str, hash_value: str):
    """Save the hash to file."""
    with open(hash_file, 'w') as f:
        f.write(hash_value)


def _combine_requirements(file_paths: list[str], output_path: str):
    """Concatenate all requirement files into one."""
    with open(output_path, 'w', encoding='utf-8') as out:
        for path in file_paths:
            out.write(f'# Source: {path}\n')
            with open(path, 'r', encoding='utf-8') as inp:
                out.write(inp.read())
            out.write('\n')


def _compile_constraints(constraints_path: str):
    """Use uv pip compile to generate constraints file."""
    if not _uv_available():
        raise RuntimeError('uv executable not found')

    exe_dir = _get_executable_dir()
    updateProgress('Compiling constraints...')

    args = [
        _uv_abs_path(),
        'pip',
        'compile',
        _get_combined_path(),
        '--output-file',
        _get_constraints_path(),
        '--python',
        sys.executable,  # Explicitly specify Python version to avoid mismatch
        '--index-strategy',
        'unsafe-best-match',  # Check all indexes for best version
        '--no-build-isolation',  # Don't create temp venvs (engine.exe can't create venvs)
        '--emit-index-url',  # Preserve --extra-index-url etc. so install/dry-run can find packages (e.g. torch+cu128)
    ]
    args.extend(_override_args(exe_dir))
    debug(f'Compile: {args}')
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        check=False,
        stdin=subprocess.PIPE,
        encoding='utf-8',
        errors='replace',
        cwd=exe_dir,
    )

    if result.returncode != 0:
        error(f'Failed to compile constraints: {result.stderr}')
        raise RuntimeError('Failed to compile constraints')

    debug(f'Constraints compiled: {constraints_path}')


def ensure_constraints() -> str:
    """
    Ensure the constraints file is up to date.

    Returns the path to the constraints file.
    """
    cache_dir = engine_cache_dir()
    os.makedirs(cache_dir, exist_ok=True)

    hash_file = os.path.join(cache_dir, 'requirements.hash')
    combined_path = _get_combined_path()
    constraints_path = _get_constraints_path()

    # Find all requirement files
    req_files = _find_requirement_files()
    override_files = _find_override_files()
    if not req_files:
        debug('No requirement files found')
        return constraints_path

    # Compute current hash
    current_hash = _compute_hash(req_files + override_files)
    stored_hash = _load_stored_hash(hash_file)

    # Check if rebuild is needed. The derived overrides cache is part of the
    # predicate: install-time _override_args() reads that file, so a missing
    # one (partially cleared cache) while override files exist — or a stale
    # non-empty one after overrides were removed — must trigger a rebuild,
    # not be silently reused.
    overrides_path = _get_overrides_path()
    overrides_cache_nonempty = os.path.exists(overrides_path) and os.path.getsize(overrides_path) > 0
    if (
        current_hash == stored_hash
        and os.path.exists(constraints_path)
        and bool(override_files) == overrides_cache_nonempty
    ):
        debug('Constraints are up to date')
        return constraints_path

    debug('Requirements changed, rebuilding constraints...')
    updateProgress('Rebuilding constraints...')

    # Combine all requirements
    _combine_requirements(req_files, combined_path)

    # Combine all overrides (empty file list yields a zero-byte file, treated as absent)
    _combine_requirements(override_files, _get_overrides_path())

    # Compile with uv
    _compile_constraints(constraints_path)

    # Save new hash
    _save_hash(hash_file, current_hash)

    return constraints_path


# ---------------------------------------------------------------------------
# Installation
# ---------------------------------------------------------------------------


def _excludes_content() -> str:
    """Content of uv's resolution-excludes file for this platform.

    Excludes `uv` (bootstrapped by depends.py; pip-installing it crashes on Windows)
    and, on non-Darwin, plain `onnxruntime` (it clobbers onnxruntime-gpu in the same
    folder; the gpu build provides `import onnxruntime`).
    """
    excludes = 'uv\n'
    if platform.system() != 'Darwin':
        excludes += 'onnxruntime\n'
    return excludes


def _write_excludes_file() -> str:
    """Write uv's resolution-excludes file (rewritten each call) and return its path."""
    excludes_path = os.path.join(engine_cache_dir(), 'excludes.txt')
    with open(excludes_path, 'w', encoding='utf-8') as f:
        f.write(_excludes_content())
    return excludes_path


# ---------------------------------------------------------------------------
# Satisfied-verdict cache
# ---------------------------------------------------------------------------
#
# ``_processed`` spans one process, so every cold engine re-ran the 20-40s uv
# resolve only to conclude that nothing was missing (#2089). Persist that
# verdict instead, keyed by everything a resolve consults.
#
# Two consequences worth knowing. The fingerprint is the whole installed set,
# so installing anything invalidates every file's verdict: on a host where
# nodes install lazily, each install costs one extra resolve per requirements
# file before things settle again. And the key cannot see the resolve's own
# arguments, so _VERDICT_SCHEMA below is bumped whenever those change.
#
# The check and the write both run under the engine-global ``install.lock``
# via depends(), which is what makes the non-atomic _save_hash write safe.
# Per-node locks (#2089 ask 2) would remove that guarantee.

# Bump when the resolve's inputs or semantics change (uv arguments, what the
# key covers), so verdicts recorded under the old behaviour are not reused.
_VERDICT_SCHEMA = '1'


def _verdict_path(requirements_path: str) -> str:
    """Path of the cached verdict for a requirements file."""
    digest = hashlib.md5(os.path.abspath(requirements_path).encode('utf-8')).hexdigest()
    return os.path.join(engine_cache_dir(), 'satisfied', f'{digest}.hash')


def _file_digest(path: str) -> str:
    """Content digest of a file, or empty string when it does not exist."""
    try:
        with open(path, 'rb') as f:
            return hashlib.md5(f.read()).hexdigest()
    except OSError:
        return ''


# A requirements line that pulls in another file: ``-r``/``--requirement`` and
# ``-c``/``--constraint``, with the path after whitespace or ``=``.
_INCLUDE_DIRECTIVE = re.compile(r'^\s*(?:-r|--requirement|-c|--constraint)(?:\s+|=)(?:"([^"]+)"|\'([^\']+)\'|(\S+))')


def _requirements_closure(requirements_path: str) -> list[str]:
    """``requirements_path`` plus every file it pulls in through ``-r`` / ``-c``, recursively.

    Included paths resolve relative to the including file, as pip and uv resolve
    them. Each file is visited once, so an include cycle terminates.
    """
    closure: list[str] = []
    pending = [os.path.abspath(requirements_path)]
    while pending:
        path = pending.pop(0)
        if path in closure:
            continue
        closure.append(path)
        try:
            # errors='replace' because this decode only feeds directive
            # scanning: the digest is taken from the bytes in _file_digest, so a
            # non-UTF-8 requirements file must not fail the node it belongs to.
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                # A trailing backslash continues the line, as in pip and uv.
                lines = f.read().replace('\\\n', '').splitlines()
        except OSError:
            continue
        for line in lines:
            match = _INCLUDE_DIRECTIVE.match(line)
            if match:
                target = match.group(1) or match.group(2) or match.group(3)
                pending.append(os.path.normpath(os.path.join(os.path.dirname(path), target)))
    return closure


def _installed_fingerprint() -> Optional[str]:
    """Digest of the *.dist-info / *.egg-info names in site-packages, or ``None``.

    The names carry versions, so an install, upgrade or uninstall changes it.

    ``None`` when the directory cannot be listed. Hashing an empty list instead
    would return the same digest every time, so the key would stop noticing
    installs and every verdict would stay satisfied for ever — a silent stale
    hit. Refusing the key resolves every time instead, which is the safe
    direction. ``bootstrap()`` creates this directory before any key is
    computed, so on the real path it always exists.
    """
    try:
        entries = [e for e in os.listdir(_get_site_packages()) if e.endswith(('.dist-info', '.egg-info'))]
    except OSError:
        return None
    return hashlib.md5('\n'.join(sorted(entries)).encode('utf-8')).hexdigest()


def _verdict_key(requirements_path: str, constraints_path: str) -> Optional[str]:
    """Key under which a "satisfied" verdict for ``requirements_path`` is valid.

    Everything that can change what a resolve concludes is part of it,
    including every file the requirements file includes through ``-r`` / ``-c``.

    Returns ``None`` when the key cannot be computed honestly — a directive
    names something that is not a readable file, or site-packages cannot be
    listed. In
    both cases something the resolve depends on is invisible here, so the key
    would be stable over changing inputs. Refusing it degrades to resolving
    every time, which is the safe direction — a stable key over an unseen
    input keeps reporting "satisfied" after that input gains a dependency.
    """
    closure = _requirements_closure(requirements_path)
    if not all(os.path.isfile(path) for path in closure):
        return None

    installed = _installed_fingerprint()
    if installed is None:
        return None

    parts = [_VERDICT_SCHEMA, sys.executable, sys.version]
    parts.extend(_file_digest(path) for path in closure)
    parts.extend(
        [
            _file_digest(constraints_path),
            _file_digest(_get_overrides_path()),
            _excludes_content(),
            installed,
        ]
    )
    # NUL-separated: none of the parts can contain it, so field boundaries
    # stay unambiguous even though two of them are multi-line text.
    return hashlib.md5('\0'.join(parts).encode('utf-8')).hexdigest()


def _verdict_cached(requirements_path: str, constraints_path: str) -> bool:
    """True when a previous resolve recorded this requirements file as satisfied under the current key.

    An unreadable cache, or a key the closure refuses to produce, is a miss —
    never an error. The cache is an optimisation: anything it cannot answer
    must fall back to resolving, not fail the node that asked.
    """
    try:
        stored = _load_stored_hash(_verdict_path(requirements_path))
        if stored is None:
            return False
        key = _verdict_key(requirements_path, constraints_path)
        return key is not None and stored == key
    except Exception as e:  # noqa: BLE001 - a cache read must never fail an install
        debug(f'  Could not read the satisfied verdict ({e}); resolving instead')
        return False


def _save_verdict(requirements_path: str, constraints_path: str):
    """Record that ``requirements_path`` is satisfied under the current key.

    Best effort, like the progress sidecar: the verdict only saves the next
    process a resolve, so a cache that cannot be written must not fail an
    install that succeeded.
    """
    try:
        key = _verdict_key(requirements_path, constraints_path)
        if key is None:
            debug(f'  Not recording a verdict: an include of {requirements_path} does not resolve')
            return
        verdict_file = _verdict_path(requirements_path)
        os.makedirs(os.path.dirname(verdict_file), exist_ok=True)
        _save_hash(verdict_file, key)
    except Exception as e:  # noqa: BLE001 - a cache write must never fail an install
        debug(f'  Could not record the satisfied verdict ({e}); the next process will resolve again')


def _install_dry_run(requirements_path: str, constraints_path: str) -> list[str]:
    """
    Run uv pip install --dry-run and return list of packages that would be installed.

    Returns empty list if all requirements are already satisfied.
    Raises RuntimeError if dependency resolution fails.
    """
    if not _uv_available():
        raise RuntimeError('uv executable not found')

    exe_dir = _get_executable_dir()
    args = [
        _uv_abs_path(),
        'pip',
        'install',
        '--python',
        sys.executable,
        '-r',
        requirements_path,
        '--index-strategy',
        'unsafe-best-match',
        '--no-build-isolation',
        '--dry-run',
        '--no-color',
    ]

    # uv splits --excludes on whitespace, so an absolute path with a space (macOS
    # "Application Support") breaks resolution; pass it relative to the cwd (exe_dir).
    # See #1256.
    args.extend(['--excludes', os.path.relpath(_write_excludes_file(), exe_dir)])

    args.extend(_constraints_args(constraints_path, exe_dir))
    args.extend(_override_args(exe_dir))

    debug(f'Dry-run: {args}')
    result = subprocess.run(
        args,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        check=False,
        stdin=subprocess.PIPE,
        cwd=exe_dir,
    )

    if result.returncode != 0:
        output = (result.stderr + result.stdout).strip()
        debug(f'Dry-run failed (rc={result.returncode}): {output[:500]}')
        error(f'Dependency resolution failed for {requirements_path}: {output}')
        raise RuntimeError(f'Dependency resolution failed: {output[:200]}')

    # Parse packages from output — lines starting with "+ "
    packages = []
    for line in (result.stderr + result.stdout).splitlines():
        line = line.strip()
        if line.startswith('+ '):
            # Line format: "+ package==version" or "+ package[extra]==version"
            pkg = line[2:].strip()
            if '==' in pkg:
                pkg = pkg.split('==')[0]
            if '[' in pkg:
                pkg = pkg.split('[')[0]
            packages.append(pkg)

    return packages


def _install_requirements(requirements_path: str, constraints_path: str):
    """
    Install requirements using uv with constraints.

    Runs a dry-run first to check if anything needs installing. If all
    requirements are satisfied, skips the install entirely. Otherwise,
    streams download and install progress through updateProgress().
    """
    debug(f'Installing requirements from: {requirements_path}')

    # Skip empty requirements files (comments/blanks only) to avoid uv warnings
    with open(requirements_path, 'r', encoding='utf-8') as f:
        has_deps = any(line.strip() and not line.strip().startswith('#') for line in f)
    if not has_deps:
        debug(f'  Empty requirements file, skipping: {requirements_path}')
        return

    # A previous process already resolved this file against this environment
    # and found it satisfied: nothing to install, and nothing to resolve.
    if _verdict_cached(requirements_path, constraints_path):
        debug(f'  Satisfied verdict cached, skipping resolve: {requirements_path}')
        return

    # Start heartbeat early — the dry-run can block on uv's internal lock
    # for minutes, and we need monitorStatus events to keep the task startup
    # timeout alive during that time.
    _start_heartbeat()
    try:
        return _install_requirements_inner(requirements_path, constraints_path)
    finally:
        _stop_heartbeat()


def _install_requirements_inner(requirements_path: str, constraints_path: str):
    """Inner install logic, runs under the heartbeat thread."""
    import importlib

    # Check what needs to be installed (raises on failure)
    packages = _install_dry_run(requirements_path, constraints_path)
    debug(f'Dry-run found {len(packages)} packages to install: {packages}')

    # If dry-run returned empty list, all packages are satisfied
    if len(packages) == 0:
        debug(f'All requirements satisfied: {requirements_path}')
        _save_verdict(requirements_path, constraints_path)
        return

    # Format status message: show up to 5 packages, or 4 + "..." if more than 5
    if len(packages) <= 5:
        pkg_list = ', '.join(packages)
    else:
        pkg_list = ', '.join(packages[:4]) + ', ...'
    updateProgress(f'Installing {pkg_list}')

    # Build uv command
    exe_dir = _get_executable_dir()
    uv_args = [
        _uv_abs_path(),
        'pip',
        'install',
        '-r',
        requirements_path,
        '--python',
        sys.executable,
        '--index-strategy',
        'unsafe-best-match',
        '--no-build-isolation',  # Don't create temp venvs (engine.exe can't create venvs)
    ]

    # Relative to cwd (exe_dir) — see the --excludes note in _install_dry_run (#1256).
    uv_args.extend(['--excludes', os.path.relpath(_write_excludes_file(), exe_dir)])

    uv_args.extend(_constraints_args(constraints_path, exe_dir))
    uv_args.extend(_override_args(exe_dir))

    # Run uv and stream output (heartbeat is already running from the caller)
    debug(f'Install: {uv_args}')
    proc = subprocess.Popen(
        uv_args,
        cwd=exe_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding='utf-8',
        errors='replace',
        bufsize=1,
    )
    output_lines = []
    for line in proc.stdout:
        line = line.rstrip()
        output_lines.append(line)
        updateProgress(line)
    proc.wait()

    if proc.returncode != 0:
        output_text = '\n'.join(output_lines)
        error(f'Installation failed: {output_text}')
        # Include last few lines of output in the error for debugging
        last_lines = output_lines[-10:] if len(output_lines) > 10 else output_lines
        error_detail = '\n'.join(last_lines)
        raise RuntimeError(f'Failed to install {requirements_path}\n{error_detail}')

    # Invalidate import caches so Python can find newly installed packages
    importlib.invalidate_caches()

    # Clear path importer cache for site-packages to force re-scan
    sys.path_importer_cache.pop(_get_site_packages(), None)

    # The install changed the installed set: record the verdict against it.
    _save_verdict(requirements_path, constraints_path)

    debug(f'Installed: {requirements_path}')


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def depends(requirements: Optional[str] = None):
    """
    Install dependencies from a requirements file.

    This is the main entry point for library mode. It:
    1. Bootstraps the environment (pip, uv, platform hacks)
    2. Ensures constraints are up to date
    3. Installs the specified requirements with constraints

    Args:
        requirements: Path to a requirements.txt file. If None, only
                      ensures the environment and constraints are ready.
    """
    debug(f'depends({requirements})')

    # Normalize path
    if requirements:
        requirements = os.path.abspath(requirements)
        debug(f'  Path: {requirements}')
        if not os.path.exists(requirements):
            debug('  File not found, skipping')
            return
        if requirements in _processed:
            debug('  Already processed, skipping')
            return

    cache_dir = engine_cache_dir()
    lock_path = os.path.join(cache_dir, 'install.lock')

    with FileLock(lock_path):
        debug(f'  Lock acquired: {lock_path}')

        # Phase 1: Bootstrap
        bootstrap()

        # Phase 2: Ensure constraints
        constraints_path = ensure_constraints()

        # Phase 3: Install if requirements provided
        if requirements:
            _install_requirements(requirements, constraints_path)
            _processed.add(requirements)
            debug(f'  Completed: {os.path.basename(requirements)}')

        # Phase 4: Apply platform-specific hacks (after packages may have been installed)
        _apply_pywin32_hack()


def load_depends(current_file: str, requirements_file: str = 'requirements.txt') -> None:
    """Install a requirements file located alongside the calling module.

    Saves callers the os.path boilerplate of resolving a requirements file next
    to their own module. Equivalent to ``depends(<dir of current_file>/<requirements_file>)``.

    Args:
        current_file: The caller's ``__file__``.
        requirements_file: Requirements filename in that module's directory (default 'requirements.txt').

    Returns:
        None.
    """
    requirements = os.path.join(os.path.dirname(os.path.realpath(current_file)), requirements_file)
    depends(requirements)


# ---------------------------------------------------------------------------
# Main Mode
# ---------------------------------------------------------------------------


def main():
    """
    Run the main command-line entry point.

    Usage: engine depends.py [uv pip arguments]

    After bootstrapping and ensuring constraints, passes all arguments
    through to 'uv pip'. Falls back to standard pip if uv can't build
    source distributions due to virtualenv creation issues.
    """
    cache_dir = engine_cache_dir()
    lock_path = os.path.join(cache_dir, 'install.lock')

    with FileLock(lock_path):
        # Bootstrap environment
        bootstrap()

        # Ensure constraints are ready
        ensure_constraints()

        # Pass through to uv pip
        if len(sys.argv) > 1:
            if not _uv_available():
                sys.exit(1)

            exe_dir = _get_executable_dir()

            # Build uv args
            uv_args = [_uv_abs_path(), 'pip'] + sys.argv[1:] + ['--python', sys.executable]

            # --index-strategy is only valid for install, compile, sync commands
            is_install_cmd = sys.argv[1] in ('install', 'compile', 'sync')
            if is_install_cmd:
                uv_args += ['--index-strategy', 'unsafe-best-match']

            # For install/sync commands, add constraints file if available
            if sys.argv[1] in ('install', 'sync'):
                uv_args.extend(_constraints_args(_get_constraints_path(), exe_dir))

            # Run uv
            result = subprocess.run(uv_args, cwd=exe_dir)
            sys.exit(result.returncode)


if __name__ == '__main__':
    main()
