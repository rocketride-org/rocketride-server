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

Resolves the account identity and the storage anchor from the TASK FILE the
engine published (``rocketlib.getTask()``: the ``identity`` and ``storage``
blocks, see task_engine._build_task) and builds a single ``FileStore``
rooted at that anchor — the owning user's tree
(``users/<userId>/files/``) for development runs, a task-specific team
subtree (``teams/<teamId>/files/tasks/<projectId>/``) for deployed runs —
so node-level paths are identical in both modes. The instance exposes
per-operation allow-flags and a path whitelist that IInstance enforces before
every tool call.

Surfaces ``read_file``, ``write_file``, ``delete_file``, ``list_directory``,
``create_directory``, and ``stat_file`` as ``@tool_function`` methods on
``IInstance``.
"""

from __future__ import annotations

import re
from enum import IntEnum

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning


class IGlobal(IGlobalBase):
    """Global state for tool_filesystem."""

    class OnConflict(IntEnum):
        """What to do when the sink's target path is already taken.

        Member names are the services.store.json enum values uppercased, which is what lets
        :meth:`_sink_config` resolve one to the other by name. Resolved once at config time,
        so each write compares ints.
        """

        UNIQUE = 0
        OVERWRITE = 1
        SKIP = 2

    client_id: str | None = None
    file_store: object | None = None  # ai.account.file_store.FileStore
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
        (
            self.target_dir,
            self.emit_url,
            self.url_expires_in,
            self.on_conflict,
        ) = self._sink_config(cfg)

        try:
            # Engine identity: this node runs INSIDE the engine subprocess
            # with no account session, and its paths come from LLM tool
            # calls — so it gets the most restricted context: plain paths
            # only, every @/Team, @/Org and @/User path and reserved subtree
            # (.logs, .deployments) rejected by the store. It must never
            # hold an internal identity (that would let a pipeline address
            # any team's storage unchecked). Identity and the storage anchor
            # (the owner's tree for dev runs, a task-specific team subtree
            # for deploy runs) come from the task file the engine published
            # via rocketlib.getTask() — never the environment — and the
            # store resolves them itself, so this node needs no plumbing.
            from ai.account.store import Store

            self.file_store = Store.engine_file_store()
            self.client_id = getattr(self.file_store, '_client_id', None)
        except Exception as e:
            warning(f'tool_filesystem: failed to initialise FileStore: {e}')
            self.client_id = None
            self.file_store = None

        if self.file_store is None:
            warning(
                'tool_filesystem: no running task with an identity (rocketlib.getTask); tool methods will be disabled. This usually means the node is running outside the task engine.'
            )

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

    @staticmethod
    def _sink_config(cfg: dict) -> tuple[str, bool, int, OnConflict]:
        """Parse the sink lane config into ``(target_dir, emit_url, url_expires_in, on_conflict)``.

        ``url_expires_in`` is clamped to the FileStore range of 1..3600 seconds;
        non-positive or missing values fall back to the 3600-second default.
        ``on_conflict`` falls back to :attr:`OnConflict.UNIQUE` on anything that does not name
        a member, so a mistyped config degrades to the non-destructive outcome rather than
        failing the pipeline.
        """
        target_dir = str(cfg.get('targetDir', 'output/'))
        emit_url = bool(cfg.get('emitUrl', False))
        try:
            raw_expires = int(cfg.get('urlExpiresIn', 3600) or 3600)
        except (TypeError, ValueError):
            raw_expires = 3600
        url_expires_in = min(raw_expires, 3600) if raw_expires > 0 else 3600
        try:
            on_conflict = IGlobal.OnConflict[str(cfg.get('onConflict', '')).strip().upper()]
        except KeyError:
            on_conflict = IGlobal.OnConflict.UNIQUE
        return target_dir, emit_url, url_expires_in, on_conflict

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
        self.target_dir = 'output/'
        self.emit_url = False
        self.url_expires_in = 3600
        self.on_conflict = IGlobal.OnConflict.UNIQUE
