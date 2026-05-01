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


_TRUNCATED_MARKER = '\n...[truncated]'


def execute_command(
    command: str,
    *,
    cwd: str | None,
    env: dict[str, str],
    timeout: int,
    max_output_bytes: int,
) -> dict:
    """Run *command* in the host shell and capture its result.

    Returns a dict with ``stdout``, ``stderr``, ``exit_code``, ``timed_out``,
    and ``truncated`` keys. Output is decoded as UTF-8 (errors replaced) and
    capped at ``max_output_bytes`` bytes for each stream.
    """
    timed_out = False
    try:
        completed = subprocess.run(
            command,
            shell=True,
            cwd=cwd,
            env=env,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        stdout_bytes = completed.stdout or b''
        stderr_bytes = completed.stderr or b''
        exit_code = completed.returncode
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        stdout_bytes = exc.stdout or b''
        stderr_bytes = exc.stderr or b''
        exit_code = -1
    except FileNotFoundError as exc:
        return {
            'stdout': '',
            'stderr': f'Shell not available: {exc}',
            'exit_code': 127,
            'timed_out': False,
            'truncated': False,
        }

    stdout, stdout_truncated = _decode_and_cap(stdout_bytes, max_output_bytes)
    stderr, stderr_truncated = _decode_and_cap(stderr_bytes, max_output_bytes)

    return {
        'stdout': stdout,
        'stderr': stderr,
        'exit_code': exit_code,
        'timed_out': timed_out,
        'truncated': stdout_truncated or stderr_truncated,
    }


def _decode_and_cap(data: bytes, max_bytes: int) -> tuple[str, bool]:
    if not data:
        return '', False
    truncated = len(data) > max_bytes
    if truncated:
        data = data[:max_bytes]
    text = data.decode('utf-8', errors='replace')
    if truncated:
        text += _TRUNCATED_MARKER
    return text, truncated


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
