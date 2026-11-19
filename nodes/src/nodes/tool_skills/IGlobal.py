# =============================================================================
# RocketRide Engine
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
Skills tool node - global (shared) state.

Builds the skill catalog once per pipeline start: the skills entered in the
config panel, then the skills in the configured folder of the task's file
store (the same store the File System node uses). A skill that cannot be
used is reported with ``warning()`` and skipped; the others still load.
"""

from __future__ import annotations

import asyncio
import json

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .skill_catalog import SkillCatalog, load_folder, skills_from_config


class IGlobal(IGlobalBase):
    """Global state for tool_skills."""

    catalog: SkillCatalog | None = None
    file_store: object | None = None  # ai.account.file_store.FileStore, set when a folder is configured

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        catalog = SkillCatalog()
        problems: list[str] = []

        skills, row_problems = skills_from_config(_parse_rows(cfg.get('skills')))
        problems.extend(row_problems)
        for skill in skills:
            problem = catalog.add(skill)
            if problem:
                problems.append(problem)

        folder = str(cfg.get('folder') or '').strip()
        if folder:
            folder_skills, folder_problems = self._load_folder(folder)
            problems.extend(folder_problems)
            for skill in folder_skills:
                problem = catalog.add(skill)
                if problem:
                    problems.append(problem)

        for problem in problems:
            warning(f'tool_skills: {problem}')
        if not len(catalog):
            warning(
                'tool_skills: no skills loaded, so the agent is offered no skill tools. Add a skill or set a skills folder.'
            )

        self.catalog = catalog

    def _load_folder(self, folder: str) -> tuple[list, list[str]]:
        """Read the folder's skills from the task's file store."""
        try:
            # Same engine identity as tool_filesystem: plain paths inside the
            # task's storage anchor only (see that node's IGlobal).
            from ai.account.store import Store

            self.file_store = Store.engine_file_store()
        except Exception as e:
            self.file_store = None
            return [], [f'the skills folder {folder!r} was not read: the file store failed to open: {e}']
        if self.file_store is None:
            return [], [f'the skills folder {folder!r} was not read: no running task with an identity to read files as']
        try:
            return run_async(load_folder, self.file_store, folder)
        except Exception as e:
            return [], [f'the skills folder {folder!r} could not be read: {e}']

    def endGlobal(self) -> None:
        self.catalog = None
        self.file_store = None


def _parse_rows(raw) -> list:
    """Read the skill rows, which may arrive as a list or as its JSON text."""
    if raw is None:
        return []
    if isinstance(raw, list):
        return raw
    try:
        parsed = json.loads(str(raw))
    except (json.JSONDecodeError, TypeError, ValueError):
        warning('tool_skills: the skills list is malformed and was ignored')
        return []
    return parsed if isinstance(parsed, list) else []


def run_async(async_fn, *args, **kwargs):
    """Run an async file store call from the engine's synchronous node methods.

    The engine calls ``beginGlobal`` and ``@tool_function`` methods on threads
    with no running event loop (see ``tool_filesystem``'s ``_run_async``).
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        raise RuntimeError('tool_skills: run_async must not be called from a thread with a running event loop')
    return asyncio.run(async_fn(*args, **kwargs))
