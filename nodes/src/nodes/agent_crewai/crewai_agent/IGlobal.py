# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
CrewAI Agent — global state for the standalone single-agent CrewAI node.

Ensures the process-wide CrewAI kickoff runner is running and instantiates
the `CrewAgent` driver held on `self.agent`. The persona and task (role,
goal, backstory, task description, expected output) are per-call parameters
the driver reads from the invoking instance's settings; nothing of the
node's configuration is kept here.
"""

from __future__ import annotations

import os
from typing import Any

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    process: Any = None
    agent: Any = None
    # Reference to the process-wide CrewKickoffRunner.  All three CrewAI
    # sub-packages share the same singleton via the parent package's
    # `crewai_runner` module — see `nodes/src/nodes/agent_crewai/crewai_runner.py`.
    _kickoff_runner: Any = None

    def beginGlobal(self) -> None:
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

        # Resolve the process-wide kickoff runner.  First call lazily starts
        # the daemon thread and installs the persistent event listener; later
        # calls (from this or any other CrewAI sub-package's beginGlobal) just
        # return the cached instance.
        from ..crewai_runner import get_shared_runner

        self._kickoff_runner = get_shared_runner()

        from .agent import CrewAgent

        self.agent = CrewAgent(self, process=self.process)

    def endGlobal(self) -> None:
        self.agent = None
        self.process = None
        # Clear our local reference only.  The underlying CrewRunner is a
        # process-wide singleton (other CrewAI nodes may still need it) and
        # its daemon thread dies with the Python interpreter automatically.
        self._kickoff_runner = None
