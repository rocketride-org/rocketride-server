# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
Subprocess driver for tool_shell.

Runs a command string in the host shell with bounded timeout and output capture.
"""

from __future__ import annotations

import os
import subprocess
import threading


_TRUNCATED_MARKER = '\n...[truncated]'
_READ_CHUNK_SIZE = 4096


def execute_command(
    command: str,
    *,
    cwd: str | None,
    env: dict[str, str],
    timeout: int,
    max_output_bytes: int,
) -> dict:
    """Run *command* in the host shell and capture its result.

    Stdout and stderr are streamed through reader threads and capped at
    ``max_output_bytes`` per stream so a runaway command cannot exhaust
    engine memory. Once a stream's buffer reaches the cap, further chunks
    are drained and discarded so the child can finish writing without
    blocking on a full OS pipe (preserving its natural exit code).
    """
    try:
        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        return {
            'stdout': '',
            'stderr': f'Shell not available: {exc}',
            'exit_code': 127,
            'timed_out': False,
            'truncated': False,
        }

    stdout_buf = bytearray()
    stderr_buf = bytearray()
    capped = {'stdout': False, 'stderr': False}

    def _drain(stream, buf: bytearray, key: str) -> None:
        """Append chunks to *buf* up to the cap; discard anything beyond it."""
        try:
            while True:
                chunk = stream.read(_READ_CHUNK_SIZE)
                if not chunk:
                    return
                remaining = max_output_bytes - len(buf)
                if remaining <= 0:
                    capped[key] = True
                    continue
                if len(chunk) > remaining:
                    buf.extend(chunk[:remaining])
                    capped[key] = True
                    continue
                buf.extend(chunk)
        except (ValueError, OSError):
            return

    t_out = threading.Thread(target=_drain, args=(proc.stdout, stdout_buf, 'stdout'), daemon=True)
    t_err = threading.Thread(target=_drain, args=(proc.stderr, stderr_buf, 'stderr'), daemon=True)
    t_out.start()
    t_err.start()

    timed_out = False
    try:
        exit_code = proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        proc.kill()
        proc.wait()
        exit_code = -1

    t_out.join()
    t_err.join()

    stdout_text = bytes(stdout_buf).decode('utf-8', errors='replace')
    stderr_text = bytes(stderr_buf).decode('utf-8', errors='replace')
    if capped['stdout']:
        stdout_text += _TRUNCATED_MARKER
    if capped['stderr']:
        stderr_text += _TRUNCATED_MARKER

    return {
        'stdout': stdout_text,
        'stderr': stderr_text,
        'exit_code': exit_code,
        'timed_out': timed_out,
        'truncated': capped['stdout'] or capped['stderr'],
    }


def build_environment(
    base_env: dict[str, str] | None,
    config_env: dict[str, str],
    call_env: dict[str, str] | None,
    *,
    allow_external_env: bool,
) -> dict[str, str]:
    """Merge env sources. Config-defined variables always take precedence over
    agent-supplied ones; both layer over the host process env.
    """
    merged: dict[str, str] = dict(base_env if base_env is not None else os.environ)
    if allow_external_env and call_env:
        for k, v in call_env.items():
            if not isinstance(k, str) or not k:
                continue
            merged[k] = '' if v is None else str(v)
    for k, v in config_env.items():
        merged[k] = v
    return merged
