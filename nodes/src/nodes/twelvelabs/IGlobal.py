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

from typing import List
from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config


class IGlobal(IGlobalBase):
    """
    Global configuration for the TwelveLabs node.

    Loads the API key and instructions from configuration once,
    making them available to all instances.
    """

    api_key: str = ''
    instructions: List[str]

    def __init__(self) -> None:
        """
        Initialize the global configuration for the TwelveLabs node.
        """
        super().__init__()
        self.instructions = []

    def beginGlobal(self) -> None:
        """
        Load the API key and instructions from configuration once,
        making them available to all instances.
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        # install requirements
        import os
        from depends import depends  # type: ignore

        # Load the requirements
        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        config = Config.getNodeConfig(
            self.glb.logicalType,
            self.glb.connConfig,
        )

        self.api_key = config.get('apikey') or ''
        instructions = config.get('instructions') or []
        self.instructions = [str(instruction) for instruction in instructions]

    def endGlobal(self) -> None:
        """
        Clear the global configuration.
        """
        self.api_key = ''
        self.instructions = []
