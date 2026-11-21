# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
CrewAI Subagent — global state for the managed sub-agent CrewAI node.

Ensures the process-wide CrewAI kickoff runner is running and instantiates
the `CrewSubagent` driver held on `self.agent`. The persona and task are
per-call parameters the driver reads from the described instance's
settings; nothing of the node's configuration is kept here.

The Subagent has no `process` field — it never builds its own Crew (the
Manager that delegates to it builds the hierarchical Crew).
"""

from __future__ import annotations

import os
from typing import Any

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    agent: Any = None
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

        from ..crewai_runner import get_shared_runner

        self._kickoff_runner = get_shared_runner()

        from .subagent import CrewSubagent

        self.agent = CrewSubagent(self)

    def endGlobal(self) -> None:
        self.agent = None
        self._kickoff_runner = None
