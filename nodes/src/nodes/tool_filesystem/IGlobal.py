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
File system tool node - global (per control) state.

Holds the control's configuration only: the per-operation allow-flags and the
compiled path whitelist IInstance enforces before every tool call, and the
sink settings. The files themselves are never opened here: every operation
goes through the instance's ``self.files`` (plan 5.7), the store the SERVER
roots at the calling binding's owner tree - the owning user's tree
(``users/<userId>/files/``) for development runs, a task-specific team
subtree (``teams/<teamId>/files/tasks/<projectId>/``) for deployed runs - so
node-level paths are identical in both modes and no identity is read here.

One IGlobal serves two definitions: the agent tool (services.tool.json, the
allow flags) and the pipeline sink (services.store.json, the target directory
and conflict policy). Each is read with ``get`` and its schema default, since
the resolved view holds only the keys of the definition in use.

Surfaces ``read_file``, ``write_file``, ``delete_file``, ``list_directory``,
``create_directory``, and ``stat_file`` as ``@tool_function`` methods on
``IInstance``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from enum import IntEnum

from rocketlib import IGlobalBase, warning


class OnConflict(IntEnum):
    """What to do when the sink's target path is already taken.

    Member names are the services.store.json enum values uppercased, so
    :meth:`IGlobal._sink_config` resolves one to the other by name.
    """

    UNIQUE = 0
    OVERWRITE = 1
    SKIP = 2


class IGlobal(IGlobalBase):
    """Global state for tool_filesystem."""

    allow_read: bool = True
    allow_write: bool = True
    allow_list: bool = True
    allow_mkdir: bool = True
    allow_stat: bool = True
    allow_delete: bool = False
    path_patterns: list[re.Pattern] | None = None
    target_dir: str = 'output/'
    emit_url: bool = False
    url_expires_in: int = 3600
    on_conflict: OnConflict = OnConflict.UNIQUE

    def beginGlobal(self) -> None:
        # The resolved config of whichever definition this node runs under
        cfg = self.config

        self.allow_read = cfg.get('allowRead', True)
        self.allow_write = cfg.get('allowWrite', True)
        self.allow_list = cfg.get('allowList', True)
        self.allow_mkdir = cfg.get('allowMkdir', True)
        self.allow_stat = cfg.get('allowStat', True)
        self.allow_delete = cfg.get('allowDelete', False)
        self.path_patterns = self._build_path_patterns(cfg)
        (
            self.target_dir,
            self.emit_url,
            self.url_expires_in,
            self.on_conflict,
        ) = self._sink_config(cfg)

    @staticmethod
    def _build_path_patterns(cfg: Mapping) -> list[re.Pattern]:
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

    @staticmethod
    def _sink_config(cfg: Mapping) -> tuple[str, bool, int, OnConflict]:
        """Read the sink lane config as ``(target_dir, emit_url, url_expires_in, on_conflict)``.

        The schema validates the values (``urlExpiresIn`` within 1..3600, the
        conflict policy one of the enum values); the tool definition declares
        none of them, so each falls back to the sink's schema default.
        """
        target_dir = cfg.get('targetDir', 'output/')
        emit_url = cfg.get('emitUrl', False)
        url_expires_in = cfg.get('urlExpiresIn', 3600)
        on_conflict = OnConflict[cfg.get('onConflict', 'unique').upper()]
        return target_dir, emit_url, url_expires_in, on_conflict

    def endGlobal(self) -> None:
        self.path_patterns = []
        self.target_dir = 'output/'
        self.emit_url = False
        self.url_expires_in = 3600
        self.on_conflict = OnConflict.UNIQUE
