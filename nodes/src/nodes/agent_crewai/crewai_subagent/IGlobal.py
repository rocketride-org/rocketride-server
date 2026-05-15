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

from rocketlib import IGlobalBase, IJson, OPEN_MODE


class IGlobal(IGlobalBase):
    agent: Any = None
    role: str = 'Specialist'
    task_description: str = ''
    goal: str = ''
    backstory: str = ''
    expected_output: str = ''
    _kickoff_runner: Any = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        # Shared requirements.txt at the parent agent_crewai/ level.
        requirements = os.path.join(
            os.path.dirname(os.path.realpath(__file__)),
            '..',
            'requirements.txt',
        )
        depends(requirements)

        conn_config = IJson.toDict(self.glb.connConfig) if self.glb.connConfig else {}

        self.role = str(conn_config.get('role') or 'Specialist').strip() or 'Specialist'
        self.task_description = str(conn_config.get('task_description') or '').strip()
        self.goal = str(conn_config.get('goal') or '').strip()
        self.backstory = str(conn_config.get('backstory') or '').strip()
        self.expected_output = str(conn_config.get('expected_output') or '').strip()

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
