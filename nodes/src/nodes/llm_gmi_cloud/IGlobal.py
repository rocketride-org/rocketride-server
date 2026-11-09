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


import os
from typing import Optional
from rocketlib import IGlobalBase
from ai.common.chat import ChatBase

from .IValidator import validate_serverbase


class IGlobal(IGlobalBase):
    """Global handler for the GMI Cloud LLM node."""

    _chat: Optional[ChatBase] = None

    def beginGlobal(self):
        """Initialize the GMI Cloud chat client."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .gmi_cloud import Chat

        bag = self.IEndpoint.endpoint.bag
        config = self.config
        # The schema pins the shared endpoint per model and requires one for the
        # deploy-on-demand models; only the host rule is checked here.
        err = validate_serverbase(config.serverbase)
        if err:
            raise ValueError(err)
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        """Release the chat client."""
        self._chat = None
