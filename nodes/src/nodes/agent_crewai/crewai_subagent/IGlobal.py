# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
CrewAI Subagent — global state for the managed sub-agent CrewAI node.

Loads connConfig fields, ensures the process-wide CrewAI kickoff runner is
running, and instantiates the `CrewSubagent` driver held on `self.agent`.

The Subagent has no `process` field — it never builds its own Crew (the
Manager that delegates to it builds the hierarchical Crew).
"""

from __future__ import annotations

import os
from typing import Any

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    agent: Any = None
    role: str = 'Specialist'
    task_description: str = ''
    goal: str = ''
    backstory: str = ''
    expected_output: str = ''
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

        # The resolved config: defaults applied, every field flat
        config = self.config

        self.role = config.role.strip() or 'Specialist'
        self.task_description = config.task_description.strip()
        self.goal = config.goal.strip()
        self.backstory = config.backstory.strip()
        self.expected_output = config.expected_output.strip()

        from ..crewai_runner import get_shared_runner

        self._kickoff_runner = get_shared_runner()

        from .subagent import CrewSubagent

        self.agent = CrewSubagent(
            self,
            role=self.role,
            task_description=self.task_description,
            goal=self.goal,
            backstory=self.backstory,
            expected_output=self.expected_output,
        )

    def endGlobal(self) -> None:
        self.agent = None
        self.role = 'Specialist'
        self.task_description = ''
        self.goal = ''
        self.backstory = ''
        self.expected_output = ''
        self._kickoff_runner = None
