"""
Runtime process spawn and teardown.

Manages the runtime subprocess lifecycle: start, health-check, stop.
"""

import asyncio
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Callable

import aiohttp

from ..exceptions import RuntimeManagementError
from .paths import logs_dir


async def spawn_runtime(
    binary_path: Path,
    port: int,
    instance_id: str,
) -> int:
    """Start the runtime binary as a fully detached subprocess.

    Redirects stdout/stderr to log files under ~/.rocketride/logs/{id}/.
    Returns the process pid.

    Uses subprocess.Popen (not asyncio) so the child process is fully
    independent of the parent — it survives after the CLI exits.
    """
    log_dir = logs_dir(instance_id)
    log_dir.mkdir(parents=True, exist_ok=True)

    stdout_log = log_dir / 'stdout.log'
    stderr_log = log_dir / 'stderr.log'

    stdout_fh = open(stdout_log, 'w')
    stderr_fh = open(stderr_log, 'w')

    # The runtime binary is a Python interpreter — it needs the eaas.py
    # entrypoint script as its first argument.
    script = str(binary_path.parent / 'ai' / 'eaas.py')

    # Force unbuffered stdout/stderr so log lines are written to disk
    # immediately — without this, Python block-buffers when output is
    # redirected to a file and wait_ready() would tail an empty file.
    env = {**os.environ, 'PYTHONUNBUFFERED': '1'}

    try:
        if sys.platform == 'win32':
            # CREATE_NO_WINDOW (0x08000000) — no console window at all
            # CREATE_NEW_PROCESS_GROUP (0x200) — don't inherit Ctrl+C
            process = subprocess.Popen(
                [str(binary_path), script, '--port', str(port)],
                stdout=stdout_fh,
                stderr=stderr_fh,
                env=env,
                cwd=str(binary_path.parent),
                creationflags=0x08000000 | 0x00000200,
            )
        else:
            process = subprocess.Popen(
                [str(binary_path), script, '--port', str(port)],
                stdout=stdout_fh,
                stderr=stderr_fh,
                env=env,
                cwd=str(binary_path.parent),
                start_new_session=True,
            )
    except Exception as e:
        stdout_fh.close()
        stderr_fh.close()
        raise RuntimeManagementError(f'Failed to start runtime: {e}') from e

    # The child process has inherited the file handles — close the
    # parent's copies so they don't hold locks after Popen returns.
    stdout_fh.close()
    stderr_fh.close()

    return process.pid


async def stop_runtime(pid: int, timeout: float = 10.0) -> None:
    """Stop a runtime process by pid.

    Sends SIGTERM (Unix) or TerminateProcess (Windows), waits up to
    timeout seconds, then escalates to SIGKILL if still running.
    """
    import os
    import signal

    if sys.platform == 'win32':
        import ctypes

        kernel32 = ctypes.windll.kernel32
        PROCESS_TERMINATE = 0x0001
        SYNCHRONIZE = 0x00100000

        # Kill the entire process tree so child processes don't hold file locks
        try:
            subprocess.run(
                ['taskkill', '/F', '/T', '/PID', str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=timeout,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
            # Fallback: kill just the parent process
            handle = kernel32.OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, False, pid)
            if handle:
                kernel32.TerminateProcess(handle, 1)
                kernel32.WaitForSingleObject(handle, int(timeout * 1000))
                kernel32.CloseHandle(handle)

        # Wait for the process to fully exit so file handles are released
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if handle:
            kernel32.WaitForSingleObject(handle, int(timeout * 1000))
            kernel32.CloseHandle(handle)
        # Brief extra grace period for child processes in the tree
        await asyncio.sleep(0.5)
        return

    # Unix: SIGTERM then SIGKILL
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return  # Already gone

    # Wait for process to exit
    for _ in range(int(timeout * 10)):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return  # Exited
        await asyncio.sleep(0.1)

    # Still alive — escalate
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


async def wait_healthy(
    port: int,
    pid: int = 0,
    timeout: float = 600.0,
    log_file: Path | None = None,
    on_status: Callable[[float], None] | None = None,
) -> None:
    """Poll the runtime's HTTP endpoint until it responds.

    If *pid* is provided, checks that the process is still alive each
    iteration — exits immediately if the runtime crashes.

    If *log_file* is provided, tails it to stdout while waiting so the
    user can see runtime startup output in real time.

    If *on_status* is provided, it is called each poll iteration with
    the elapsed seconds so the caller can display a progress indicator.

    Raises RuntimeManagementError if the runtime doesn't become healthy within timeout.
    """
    from .state import _is_pid_alive

    url = f'http://127.0.0.1:{port}'
    loop = asyncio.get_event_loop()
    start_time = loop.time()
    deadline = start_time + timeout
    file_pos = 0

    def _flush_log():
        nonlocal file_pos
        if log_file and log_file.exists():
            try:
                with open(log_file, 'r') as f:
                    f.seek(file_pos)
                    new = f.read()
                    if new:
                        sys.stdout.write(new)
                        sys.stdout.flush()
                        file_pos += len(new)
            except OSError:
                pass

    while loop.time() < deadline:
        if not on_status:
            _flush_log()

        elapsed = loop.time() - start_time
        if on_status:
            on_status(elapsed)

        # Check if the process has crashed
        if pid and not _is_pid_alive(pid):
            if not on_status:
                _flush_log()
            raise RuntimeManagementError(f'Runtime process (PID {pid}) exited before becoming healthy')

        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(url, timeout=aiohttp.ClientTimeout(total=2)) as resp:
                    if resp.status == 200:
                        if not on_status:
                            _flush_log()
                        return
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            pass
        await asyncio.sleep(0.5)

    raise RuntimeManagementError(f'Runtime on port {port} did not become healthy within {timeout}s')


_READY_PATTERN = re.compile(r'Uvicorn running on https?://[\w.]+:(\d+)')


async def wait_ready(
    pid: int,
    log_file: Path,
    timeout: float = 600.0,
    on_output: Callable[[str], None] | None = None,
) -> None:
    """Wait for the runtime to emit the Uvicorn ready line in its log file.

    Tails *log_file* in a tight loop (50ms between reads). Each new line
    is forwarded to *on_output* (if provided) and checked against
    ``_READY_PATTERN``.  Returns as soon as the pattern matches.

    Raises RuntimeManagementError if the process exits or the timeout is
    exceeded before the ready pattern appears.
    """
    from .state import _is_pid_alive

    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    file_pos = 0
    buf = ''

    while loop.time() < deadline:
        # Check if the process has crashed
        if not _is_pid_alive(pid):
            raise RuntimeManagementError(f'Runtime process (PID {pid}) exited before becoming ready')

        # Read any new content from the log file
        if log_file.exists():
            try:
                with open(log_file, 'r') as f:
                    f.seek(file_pos)
                    new = f.read()
                    if new:
                        file_pos += len(new)
                        buf += new

                        # Process complete lines
                        while '\n' in buf:
                            line, buf = buf.split('\n', 1)
                            if on_output:
                                on_output(line)
                            if _READY_PATTERN.search(line):
                                return
            except OSError:
                pass

        await asyncio.sleep(0.05)

    raise RuntimeManagementError(f'Runtime (PID {pid}) did not become ready within {timeout}s')
