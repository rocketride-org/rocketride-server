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
File system tool node — global (shared) state.

Resolves the account's ``client_id`` from the ``ROCKETRIDE_CLIENT_ID`` env var
(injected by the task engine in ``task_engine.py``) and builds a single
``FileStore`` scoped to ``users/<client_id>/files/``. The instance exposes
per-operation allow-flags and a path whitelist that IInstance enforces before
every tool call.

Only the operations already implemented by ``FileStore`` are surfaced:
``read_file``, ``write_file``, ``delete_file``, ``list_directory``,
``create_directory``, ``stat_file``.

Not yet implemented (follow-up — require new primitives on ``FileStore`` and
all ``IStore`` providers first):
  * ``edit_file``  — atomic in-place patch (add edit primitive or compose
                     read+write with concurrency control).
  * ``move_file``  — requires ``FileStore.rename(src, dst)`` plus DAP and
                     client-SDK propagation.
"""

from __future__ import annotations

import os
import re

from ai.account.store import Store
from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning


class IGlobal(IGlobalBase):
    """Global state for tool_filesystem."""

    client_id: str | None = None
    file_store: object | None = None  # ai.account.file_store.FileStore
    allow_read: bool = True
    allow_write: bool = True
    allow_list: bool = True
    allow_mkdir: bool = True
    allow_stat: bool = True
    allow_delete: bool = False
    path_patterns: list[re.Pattern] | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        self.allow_read = bool(cfg.get('allowRead', True))
        self.allow_write = bool(cfg.get('allowWrite', True))
        self.allow_list = bool(cfg.get('allowList', True))
        self.allow_mkdir = bool(cfg.get('allowMkdir', True))
        self.allow_stat = bool(cfg.get('allowStat', True))
        self.allow_delete = bool(cfg.get('allowDelete', False))
        self.path_patterns = self._build_path_patterns(cfg)

        client_id = os.environ.get('ROCKETRIDE_CLIENT_ID', '').strip()
        if not client_id:
            warning('tool_filesystem: ROCKETRIDE_CLIENT_ID env var is missing; tool methods will be disabled. This usually means the node is running outside the task engine.')
            self.client_id = None
            self.file_store = None
            return

        try:
            store = Store.create()
            self.file_store = store.get_file_store(client_id)
            self.client_id = client_id
        except Exception as e:
            warning(f'tool_filesystem: failed to initialise FileStore: {e}')
            self.client_id = None
            self.file_store = None

    @staticmethod
    def _build_path_patterns(cfg: dict) -> list[re.Pattern]:
        """Parse the repeated ``whitelistPattern`` rows into compiled regexes."""
        raw = cfg.get('pathWhitelist') or []
        if not isinstance(raw, list):
            import json

            try:
                raw = json.loads(str(raw))
                if not isinstance(raw, list):
                    raise ValueError(f'pathWhitelist must be a JSON array, got {type(raw).__name__}')
            except (json.JSONDecodeError, TypeError, ValueError) as e:
                raise ValueError(f'pathWhitelist is malformed and cannot be parsed: {e}') from e

        patterns: list[re.Pattern] = []
        for row in raw:
            if not hasattr(row, 'get'):
                continue
            pat_str = str(row.get('whitelistPattern') or '').strip()
            if pat_str:
                try:
                    patterns.append(re.compile(pat_str))
                except re.error as e:
                    warning(f'tool_filesystem: invalid path whitelist regex {pat_str!r}: {e}')

        return patterns

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            self._build_path_patterns(cfg)
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.client_id = None
        self.file_store = None
        self.path_patterns = []
