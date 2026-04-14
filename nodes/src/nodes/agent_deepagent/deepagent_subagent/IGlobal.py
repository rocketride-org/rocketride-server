# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
DeepAgent Subagent — global state for the managed sub-agent node.

Installs the shared dependencies (from the parent agent_deepagent/
requirements.txt) and instantiates the ``DeepAgentSubagentDriver`` held on
``self.agent``. All user-configured fields (``description``, ``system_prompt``,
``instructions``) are loaded by ``AgentBase.__init__`` and the driver's own
``__init__``, so no extra wiring is needed here.
"""

from __future__ import annotations

import os
from typing import Any

from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    agent: Any = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        # Shared requirements.txt at the parent agent_deepagent/ level.
        requirements = os.path.join(
            os.path.dirname(os.path.realpath(__file__)),
            '..',
            'requirements.txt',
        )
        depends(requirements)

        from .subagent import DeepAgentSubagentDriver

        self.agent = DeepAgentSubagentDriver(self)

    def endGlobal(self) -> None:
        self.agent = None
