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

"""Global singleton for the Deep Agent node — owns dependency bootstrap and driver lifecycle."""

from __future__ import annotations

import os
from typing import Any

from rocketlib import IGlobalBase, OPEN_MODE


class IGlobal(IGlobalBase):
    """
    Node-global state holder for the Deep Agent node.

    Created once per node configuration and shared across all ``IInstance`` objects.
    Responsible for installing Python dependencies on first open and constructing the
    ``DeepAgentDriver`` singleton used by every pipeline invocation.

    Attributes:
        agent: The active ``DeepAgentDriver`` instance, or ``None`` when the node is
            opened in ``CONFIG`` mode or after ``endGlobal`` has been called.
    """

    agent: Any = None

    def beginGlobal(self) -> None:
        """
        Initialise the node: install dependencies and create the driver.

        Skipped entirely when the endpoint is opened in ``CONFIG`` mode (no runtime
        execution is expected).  Otherwise, resolves ``requirements.txt`` via
        ``depends`` and instantiates ``DeepAgentDriver``.

        Returns:
            None
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends

        # Shared requirements.txt lives at the parent agent_deepagent/ level.
        requirements = os.path.join(
            os.path.dirname(os.path.realpath(__file__)),
            '..',
            'requirements.txt',
        )
        depends(requirements)

        from ..deepagent import DeepAgentDriver

        self.agent = DeepAgentDriver(self)

    def endGlobal(self) -> None:
        """
        Tear down the node: release the driver instance.

        Sets ``agent`` to ``None`` so the ``DeepAgentDriver`` and any resources it
        holds can be garbage-collected.

        Returns:
            None
        """
        self.agent = None
