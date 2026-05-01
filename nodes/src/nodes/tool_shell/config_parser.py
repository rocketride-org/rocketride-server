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
Pure-Python config parsing helpers for tool_shell.

Kept free of rocketlib/runtime imports so the helpers can be unit-tested
in isolation.
"""

from __future__ import annotations

import json
import re
from typing import Callable


DEFAULT_TIMEOUT = 30
MAX_TIMEOUT = 1800
DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024


def parse_working_dir(cfg: dict) -> str | None:
    raw = cfg.get('workingDir')
    if raw is None:
        return None
    val = str(raw).strip()
    return val or None


def parse_timeout(cfg: dict) -> int:
    raw = cfg.get('timeout')
    if raw is None:
        return DEFAULT_TIMEOUT
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT
    return max(1, min(value, MAX_TIMEOUT))


def parse_max_output(cfg: dict) -> int:
    raw = cfg.get('maxOutputBytes')
    if raw is None:
        return DEFAULT_MAX_OUTPUT_BYTES
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return DEFAULT_MAX_OUTPUT_BYTES
    return max(1024, value)


def parse_env_vars(cfg: dict) -> dict[str, str]:
    raw = _coerce_list(cfg.get('envVars'))
    env: dict[str, str] = {}
    for row in raw:
        if not hasattr(row, 'get'):
            continue
        name = str(row.get('envName') or '').strip()
        if not name:
            continue
        env[name] = str(row.get('envValue') or '')
    return env


def parse_command_patterns(
    cfg: dict,
    *,
    on_invalid: Callable[[str], None] | None = None,
) -> list[re.Pattern]:
    """Compile the command allowlist regexes.

    *on_invalid* is invoked with a human-readable message for each pattern
    that fails to compile. It defaults to a no-op so the helper stays a
    pure function for tests.
    """
    raw = _coerce_list(cfg.get('commandAllowlist'))
    patterns: list[re.Pattern] = []
    for row in raw:
        if not hasattr(row, 'get'):
            continue
        pat_str = str(row.get('commandPattern') or '').strip()
        if not pat_str:
            continue
        try:
            patterns.append(re.compile(pat_str))
        except re.error as e:
            if on_invalid is not None:
                on_invalid(f'Invalid command allowlist regex {pat_str!r}: {e}')
    return patterns


def _coerce_list(raw: object) -> list:
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    try:
        parsed = json.loads(str(raw))
    except (json.JSONDecodeError, TypeError, ValueError):
        return []
    return parsed if isinstance(parsed, list) else []
