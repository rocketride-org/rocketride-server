# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
CrewAI Agent — global state for the standalone single-agent CrewAI node.

Loads connConfig fields, ensures the process-wide CrewAI kickoff runner is
running, and instantiates the `CrewAgent` driver held on `self.agent`.
"""

from __future__ import annotations

import os
from typing import Any

from rocketlib import IGlobalBase, IJson, OPEN_MODE


class IGlobal(IGlobalBase):
    process: Any = None
    agent: Any = None
    role: str = 'Assistant'
    task_description: str = ''
    goal: str = ''
    backstory: str = ''
    expected_output: str = ''
    # Reference to the process-wide CrewKickoffRunner.  All three CrewAI
    # sub-packages share the same singleton via the parent package's
    # `crewai_runner` module — see `nodes/src/nodes/agent_crewai/crewai_runner.py`.
    _kickoff_runner: Any = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        # The shared requirements.txt lives at the parent agent_crewai/ level
        # so all three sub-packages install crewai exactly once.
        requirements = os.path.join(
            os.path.dirname(os.path.realpath(__file__)),
            '..',
            'requirements.txt',
        )
        depends(requirements)

        from crewai import Process

        self.process = Process.sequential

        conn_config = IJson.toDict(self.glb.connConfig) if self.glb.connConfig else {}

        self.role = str(conn_config.get('role') or 'Assistant').strip() or 'Assistant'
        self.task_description = str(conn_config.get('task_description') or '').strip()
        self.goal = str(conn_config.get('goal') or '').strip()
        self.backstory = str(conn_config.get('backstory') or '').strip()
        self.expected_output = str(conn_config.get('expected_output') or '').strip()

        # Resolve the process-wide kickoff runner.  First call lazily starts
        # the daemon thread and installs the persistent event listener; later
        # calls (from this or any other CrewAI sub-package's beginGlobal) just
        # return the cached instance.
        from ..crewai_runner import get_shared_runner

        self._kickoff_runner = get_shared_runner()

        from .agent import CrewAgent

        self.agent = CrewAgent(
            self,
            process=self.process,
            role=self.role,
            task_description=self.task_description,
            goal=self.goal,
            backstory=self.backstory,
            expected_output=self.expected_output,
        )

    def endGlobal(self) -> None:
        self.agent = None
        self.process = None
        self.role = 'Assistant'
        self.task_description = ''
        self.goal = ''
        self.backstory = ''
        self.expected_output = ''
        # Clear our local reference only.  The underlying CrewRunner is a
        # process-wide singleton (other CrewAI nodes may still need it) and
        # its daemon thread dies with the Python interpreter automatically.
        self._kickoff_runner = None
