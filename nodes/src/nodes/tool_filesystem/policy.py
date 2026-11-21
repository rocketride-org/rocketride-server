# =============================================================================
# MIT License
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
The per-call policy of the File System node: its gates, its path whitelist and its sink settings.

Every key either definition of the node declares is a per-call parameter:
the agent tool's allow-flags and path whitelist (services.tool.json) and the
pipeline sink's target directory, signed-URL switch and lifetime and conflict
policy (services.store.json). The instance builds one ``CallPolicy`` from its
settings and enforces it before every tool call and every sink write; the
control holds nothing (the files go through the instance's ``self.files``).

Each value is read with ``get`` and its schema default, since a call's
settings hold only the keys of the definition in use.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from enum import IntEnum
from typing import NamedTuple

from rocketlib import warning


class OnConflict(IntEnum):
    """What to do when the sink's target path is already taken.

    Member names are the services.store.json enum values uppercased, so
    :func:`sink_config` resolves one to the other by name.
    """

    UNIQUE = 0
    OVERWRITE = 1
    SKIP = 2


class CallPolicy(NamedTuple):
    """One call's gates, compiled path whitelist and sink settings."""

    allow_read: bool = True
    allow_write: bool = True
    allow_list: bool = True
    allow_mkdir: bool = True
    allow_stat: bool = True
    allow_delete: bool = False
    path_patterns: tuple[re.Pattern, ...] = ()
    target_dir: str = 'output/'
    emit_url: bool = False
    url_expires_in: int = 3600
    on_conflict: OnConflict = OnConflict.UNIQUE


def build_path_patterns(cfg: Mapping) -> list[re.Pattern]:
    """Compile the repeated ``whitelistPattern`` rows into regexes; an invalid one is skipped with a warning."""
    patterns: list[re.Pattern] = []
    for row in cfg.get('pathWhitelist') or []:
        if not hasattr(row, 'get'):
            continue
        pat_str = str(row.get('whitelistPattern') or '').strip()
        if pat_str:
            try:
                patterns.append(re.compile(pat_str))
            except re.error as e:
                warning(f'tool_filesystem: invalid path whitelist regex {pat_str!r}: {e}')

    return patterns


def sink_config(cfg: Mapping) -> tuple[str, bool, int, OnConflict]:
    """Read the sink lane settings as ``(target_dir, emit_url, url_expires_in, on_conflict)``.

    The schema validates the values (``urlExpiresIn`` within 1..3600, the
    conflict policy one of the enum values); the tool definition declares
    none of them, so each falls back to the sink's schema default.
    """
    target_dir = cfg.get('targetDir', 'output/')
    emit_url = cfg.get('emitUrl', False)
    url_expires_in = cfg.get('urlExpiresIn', 3600)
    on_conflict = OnConflict[cfg.get('onConflict', 'unique').upper()]
    return target_dir, emit_url, url_expires_in, on_conflict


def call_policy(settings: Mapping) -> CallPolicy:
    """
    The policy one call's settings describe.

    Args:
        settings: The call's resolved settings, under whichever definition the node runs.

    Returns:
        The call's gates, whitelist and sink settings.
    """
    target_dir, emit_url, url_expires_in, on_conflict = sink_config(settings)
    return CallPolicy(
        allow_read=settings.get('allowRead', True),
        allow_write=settings.get('allowWrite', True),
        allow_list=settings.get('allowList', True),
        allow_mkdir=settings.get('allowMkdir', True),
        allow_stat=settings.get('allowStat', True),
        allow_delete=settings.get('allowDelete', False),
        path_patterns=tuple(build_path_patterns(settings)),
        target_dir=target_dir,
        emit_url=emit_url,
        url_expires_in=url_expires_in,
        on_conflict=on_conflict,
    )
