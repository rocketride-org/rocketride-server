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
import subprocess
import sys
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

# Track processed requirements to avoid redundant installs in same session
_processed: set[str] = set()


# ---------------------------------------------------------------------------
# File Locking
# ---------------------------------------------------------------------------


class FileLock:
    """Simple cross-platform file lock using exclusive file access."""

    def __init__(self, lock_path: str, poll_interval: float = 1.0):
        """Initialize the file lock with path and polling interval."""
        self.lock_path = lock_path
        self.poll_interval = poll_interval
        self._file = None

    def __enter__(self):
        """Acquire the file lock, blocking until it is available."""
        os.makedirs(os.path.dirname(self.lock_path), exist_ok=True)

        while True:
            try:
                self._file = open(self.lock_path, 'wb')
                if os.name == 'nt':
                    msvcrt.locking(self._file.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(self._file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except (OSError, BlockingIOError):
                if self._file:
                    self._file.close()
                    self._file = None
                monitorStatus('Waiting for another installation to complete...')
                time.sleep(self.poll_interval)

    def __exit__(self, *args):
        """Release the file lock."""
        if self._file:
            self._file.close()
            self._file = None


# ---------------------------------------------------------------------------
# Environment Bootstrap
# ---------------------------------------------------------------------------


def _get_executable_dir() -> str:
    """Get the directory containing the Python executable."""
    return os.path.dirname(os.path.abspath(sys.executable))


def _get_cache_dir() -> str:
    """Get the cache directory path."""
    return os.path.join(_get_executable_dir(), 'cache')



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

    proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

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

    monitorStatus('Bootstrapping pip...')

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
    return os.path.join(exe_dir, 'Scripts', 'uv.exe') if os.name == 'nt' else \
           os.path.join(exe_dir, 'bin', 'uv')


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

    monitorStatus('Installing wheel...')
    result = _run([sys.executable, '-m', 'pip', 'install', 'wheel', '--quiet', '--disable-pip-version-check'], check=False)

    if result.returncode != 0:
        error(f'Failed to install wheel: {result.stderr}')
        raise RuntimeError('Failed to install wheel')

    debug('wheel installed successfully')


def _ensure_uv():
    """Ensure uv is installed."""
    if _uv_available():
        debug('uv is available')
        return

    monitorStatus('Installing uv...')
    result = _run([sys.executable, '-m', 'pip', 'install', 'uv', '--quiet', '--disable-pip-version-check'], check=False)

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
    result = subprocess.run(cmd, capture_output=True, text=True, check=False)
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
    """Bootstrap the environment: ensure pip, uv, wheel."""
    _ensure_site_packages()  # Must be first!
    _ensure_pip()
    _ensure_wheel()  # Needed for building packages with --no-build-isolation
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
    monitorStatus('Compiling constraints...')

    args = [
        _uv_abs_path(),
        'pip',
        'compile',
        './cache/combined.txt',
        '--output-file',
        './cache/constraints.txt',
        '--python',
        sys.executable,  # Explicitly specify Python version to avoid mismatch
        '--index-strategy',
        'unsafe-best-match',  # Check all indexes for best version
        '--no-build-isolation',  # Don't create temp venvs (engine.exe can't create venvs)
        '--emit-index-url',  # Preserve --extra-index-url etc. so install/dry-run can find packages (e.g. torch+cu128)
    ]
    debug(f'Compile: {args}')
    result = subprocess.run(args, capture_output=True, text=True, check=False, stdin=subprocess.PIPE, encoding='utf-8', errors='replace', cwd=exe_dir)

    if result.returncode != 0:
        error(f'Failed to compile constraints: {result.stderr}')
        raise RuntimeError('Failed to compile constraints')

    debug(f'Constraints compiled: {constraints_path}')


def ensure_constraints() -> str:
    """
    Ensure the constraints file is up to date.

    Returns the path to the constraints file.
    """
    cache_dir = _get_cache_dir()
    os.makedirs(cache_dir, exist_ok=True)

    hash_file = os.path.join(cache_dir, 'requirements.hash')
    combined_path = os.path.join(cache_dir, 'combined.txt')
    constraints_path = os.path.join(cache_dir, 'constraints.txt')

    # Find all requirement files
    req_files = _find_requirement_files()
    if not req_files:
        debug('No requirement files found')
        return constraints_path

    # Compute current hash
    current_hash = _compute_hash(req_files)
    stored_hash = _load_stored_hash(hash_file)

    # Check if rebuild is needed
    if current_hash == stored_hash and os.path.exists(constraints_path):
        debug('Constraints are up to date')
        return constraints_path

    debug('Requirements changed, rebuilding constraints...')
    monitorStatus('Rebuilding constraints...')

    # Combine all requirements
    _combine_requirements(req_files, combined_path)

    # Compile with uv
    _compile_constraints(constraints_path)

    # Save new hash
    _save_hash(hash_file, current_hash)

    return constraints_path


# ---------------------------------------------------------------------------
# Installation
# ---------------------------------------------------------------------------


def _parse_dependency_error(output: str) -> tuple[str | None, str | None]:
    """
    Parse uv/pip dependency resolution errors into user-friendly messages.

    Returns (friendly_message, context) where context is additional raw info.
    Both may be None if parsing completely failed.
    """
    import re

    messages = []

    # --- UV-style errors ---

    # Pattern: "X==version depends on Y"
    # Example: "accelerate==1.12.0 depends on torch==2.8.0+cu126"
    depends_matches = re.findall(r'(\S+)==(\S+)\s+depends on\s+(\S+)', output)

    # Pattern: "there is no version of X"
    no_version_matches = re.findall(r'there is no version of\s+(\S+)', output)

    # Pattern: "X cannot be used"
    cannot_use = re.search(r'we can conclude that\s+(\S+)==(\S+)\s+cannot be used', output)

    # Pattern: "requirements are unsatisfiable"
    unsatisfiable = 'requirements are unsatisfiable' in output.lower()

    # --- Pip-style errors ---

    # Pattern: "No matching distribution found for X"
    no_dist = re.search(r'No matching distribution found for\s+(\S+)', output, re.IGNORECASE)

    # Pattern: "Could not find a version that satisfies the requirement X"
    no_satisfy = re.search(r'Could not find a version that satisfies the requirement\s+(\S+)', output, re.IGNORECASE)

    # Pattern: "X requires Python >=Y"
    python_req = re.search(r'(\S+)\s+requires\s+[Pp]ython\s*([<>=!]+\s*[\d.]+)', output)

    # Pattern: "package X has requirement Y, but you have Z"
    has_req = re.search(r'(\S+)\s+has requirement\s+(\S+),?\s+but you have\s+(\S+)', output, re.IGNORECASE)

    # Pattern: "X is not available for" (platform issues)
    not_available = re.search(r'(\S+)\s+is not available for', output, re.IGNORECASE)

    # Pattern: version conflict "X and Y are incompatible"
    incompatible = re.search(r'(\S+)\s+and\s+(\S+)\s+are incompatible', output, re.IGNORECASE)

    # Pattern: "Conflicting dependencies"
    conflicting = re.search(r'[Cc]onflicting dependencies', output)

    # --- Build the message ---

    # UV: depends + no_version = clear cause
    if depends_matches and no_version_matches:
        for req_pkg, req_ver, dep in depends_matches:
            for missing in no_version_matches:
                if missing in dep or dep in missing:
                    messages.append(f"'{req_pkg}=={req_ver}' requires '{missing}' which is not available")
        if not messages:
            # Fallback: just report what we found
            req_pkg, req_ver, dep = depends_matches[0]
            missing = no_version_matches[0]
            messages.append(f"'{req_pkg}=={req_ver}' requires '{dep}', but '{missing}' is not available")

    # UV: cannot be used
    if cannot_use:
        pkg_name = cannot_use.group(1)
        pkg_version = cannot_use.group(2)
        messages.append(f"'{pkg_name}=={pkg_version}' cannot be used due to dependency conflicts")

    # Pip: no matching distribution
    if no_dist:
        messages.append(f"No matching distribution found for '{no_dist.group(1)}'")

    # Pip: no version satisfies
    if no_satisfy:
        messages.append(f"No version satisfies requirement '{no_satisfy.group(1)}'")

    # Python version requirement
    if python_req:
        messages.append(f"'{python_req.group(1)}' requires Python {python_req.group(2)}")

    # Has requirement conflict
    if has_req:
        messages.append(f"'{has_req.group(1)}' requires '{has_req.group(2)}' but '{has_req.group(3)}' is installed")

    # Platform not available
    if not_available:
        messages.append(f"'{not_available.group(1)}' is not available for this platform")

    # Incompatible packages
    if incompatible:
        messages.append(f"'{incompatible.group(1)}' and '{incompatible.group(2)}' are incompatible")

    # Generic conflicting
    if conflicting and not messages:
        messages.append('Conflicting dependencies detected')

    # Unsatisfiable as last resort
    if unsatisfiable and not messages:
        messages.append('Requirements are unsatisfiable')

    # --- Format output ---

    if not messages:
        return None, None

    # Combine messages
    friendly = '. '.join(messages) + '.'

    # Add actionable advice
    if depends_matches:
        pkg = depends_matches[0][0]
        friendly += f" Consider removing or updating '{pkg}' in requirements.txt."

    # Extract context: first few lines of actual error
    context_lines = []
    for line in output.splitlines():
        line = line.strip()
        if line and not line.startswith('hint:') and len(line) < 200:
            context_lines.append(line)
            if len(context_lines) >= 3:
                break
    context = ' | '.join(context_lines) if context_lines else None

    return friendly, context


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
        '--no-build-isolation',  # Don't create temp venvs (engine.exe can't create venvs)
        '--dry-run',
        '--no-color',
    ]

    # Only add constraints if the file exists and has content
    if os.path.exists(constraints_path) and os.path.getsize(constraints_path) > 0:
        args.extend(['-c', './cache/constraints.txt'])

    debug(f'Dry-run: {args}')
    result = subprocess.run(args, capture_output=True, text=True, check=False, stdin=subprocess.PIPE, cwd=exe_dir)

    # Check if dry-run failed (e.g., dependency resolution error)
    if result.returncode != 0:
        output = (result.stderr + result.stdout).strip()

        # Try to parse a user-friendly error message
        friendly_msg, context = _parse_dependency_error(output)
        if friendly_msg:
            debug(f'Dependency error: {friendly_msg}')
            if context:
                debug(f'  Context: {context}')
            error(f'Dependency error in {requirements_path}: {friendly_msg}')
            raise RuntimeError(f'Dependency error: {friendly_msg}')
        else:
            # Couldn't parse - show raw output
            debug(f'Dry-run failed (rc={result.returncode}): {output[:500]}')
            error(f'Dependency resolution failed for {requirements_path}: {output}')
            raise RuntimeError(f'Dependency resolution failed: {output[:200]}')

    # Parse packages from output - lines starting with "+ "
    packages = []
    for line in (result.stderr + result.stdout).splitlines():
        line = line.strip()
        if line.startswith('+ '):
            # Line format: "+ package==version" or "+ package[extra]==version"
            pkg = line[2:].strip()  # Remove "+ "
            if '==' in pkg:
                pkg = pkg.split('==')[0]
            if '[' in pkg:
                pkg = pkg.split('[')[0]
            packages.append(pkg)

    return packages


def _install_requirements(requirements_path: str, constraints_path: str):
    """Install requirements using uv with constraints. Only installs if needed."""
    import importlib

    debug(f'Installing requirements from: {requirements_path}')

    # Check what needs to be installed (raises on failure)
    packages = _install_dry_run(requirements_path, constraints_path)
    debug(f'Dry-run found {len(packages)} packages to install: {packages}')

    # If dry-run returned empty list, all packages are satisfied
    if len(packages) == 0:
        debug(f'All requirements satisfied: {requirements_path}')
        return

    # Format status message: show up to 5 packages, or 4 + "..." if more than 5
    if len(packages) <= 5:
        pkg_list = ', '.join(packages)
    else:
        pkg_list = ', '.join(packages[:4]) + ', ...'
    monitorStatus(f'Installing {pkg_list}')
    debug(f'sys.executable: {sys.executable}')
    debug(f'cwd: {os.getcwd()}')

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
    if os.path.exists(constraints_path) and os.path.getsize(constraints_path) > 0:
        uv_args.extend(['-c', './cache/constraints.txt'])

    # Run uv and stream output
    debug(f'Install: {uv_args}')
    proc = subprocess.Popen(
        uv_args,
        cwd=exe_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    output_lines = []
    for line in proc.stdout:
        line = line.rstrip()
        output_lines.append(line)
        monitorStatus(line)
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

    cache_dir = _get_cache_dir()
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
    cache_dir = _get_cache_dir()
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
            constraints_path = os.path.join(cache_dir, 'constraints.txt')
            if sys.argv[1] in ('install', 'sync'):
                if os.path.exists(constraints_path) and os.path.getsize(constraints_path) > 0:
                    uv_args.extend(['-c', './cache/constraints.txt'])

            # Run uv
            result = subprocess.run(uv_args, cwd=exe_dir)
            sys.exit(result.returncode)


if __name__ == '__main__':
    main()
