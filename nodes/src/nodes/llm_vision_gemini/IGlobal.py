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


class IGlobal(IGlobalBase):
    """Global interface for Gemini Vision node."""

    _chat: Optional[ChatBase] = None

    VALIDATION_PROMPT = 'Hi'

    def beginGlobal(self):
        """Initialize the global chat instance."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .gemini_vision import Chat

        bag = self.IEndpoint.endpoint.bag
        config = self.config
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        """Clean up the global chat instance."""
        self._chat = None
