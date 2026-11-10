# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
CrewAI Manager — global state for the hierarchical multi-agent CrewAI node.

Loads the manager-only connConfig fields (`goal`, `backstory`, `planning`), ensures the
process-wide CrewAI kickoff runner is running, and instantiates the
`CrewManager` driver held on `self.agent`.

The Manager has no `role`, `task_description`, or `expected_output` fields —
those belong to the per-sub-agent `Agent + Task` pairs that the Manager
builds inside `_run` from each sub-agent's `describe` response.
"""

from __future__ import annotations

import os
from typing import Any

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    agent: Any = None
    goal: str = ''
    backstory: str = ''
    planning: bool = False
    _kickoff_runner: Any = None

    def beginGlobal(self) -> None:
        from depends import depends

        # Shared requirements.txt at the parent agent_crewai/ level.
        requirements = os.path.join(
            os.path.dirname(os.path.realpath(__file__)),
            '..',
            'requirements.txt',
        )
        depends(requirements)

        # The resolved config: defaults applied, every field flat and typed
        config = self.config

        self.goal = config.goal.strip()
        self.backstory = config.backstory.strip()
        self.planning = config.planning

        from ..crewai_runner import get_shared_runner

        self._kickoff_runner = get_shared_runner()

        from .manager import CrewManager

        self.agent = CrewManager(self)

    def endGlobal(self) -> None:
        self.agent = None
        self.goal = ''
        self.backstory = ''
        self.planning = False
        self._kickoff_runner = None
