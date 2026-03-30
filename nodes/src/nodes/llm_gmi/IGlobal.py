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

"""
Global (connection-level) state for the GMI Cloud LLM node.

GMI Cloud provides GPU inference with an OpenAI-compatible API.
"""

import os
import re
from typing import Optional

from rocketlib import IGlobalBase, warning
from ai.common.config import Config
from ai.common.chat import ChatBase


GMI_CLOUD_BASE_URL = 'https://api.gmi-serving.com/v1'
VALIDATION_PROMPT = 'Hi'


class IGlobal(IGlobalBase):
    """Global handler for the GMI Cloud LLM node."""

    _chat: Optional[ChatBase] = None

    def validateConfig(self):
        """Validate the GMI Cloud API configuration at save time."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        try:
            from openai import (
                OpenAI,
                APIStatusError,
                OpenAIError,
                AuthenticationError,
                RateLimitError,
                APIConnectionError,
            )

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')
            serverbase = config.get('serverbase', GMI_CLOUD_BASE_URL)

            if not apikey:
                warning('GMI Cloud API key is required')
                return

            try:
                client = OpenAI(api_key=apikey, base_url=serverbase)
                client.chat.completions.create(
                    model=model,
                    messages=[{'role': 'user', 'content': VALIDATION_PROMPT}],
                    max_tokens=1,
                )
            except APIStatusError as e:
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                try:
                    resp = getattr(e, 'response', None)
                    data = resp.json() if resp is not None else None
                    if isinstance(data, dict):
                        err = data.get('error')
                        if isinstance(err, dict):
                            etype = err.get('type')
                            emsg = err.get('message') or data.get('message')
                        else:
                            etype = None
                            emsg = data.get('message')
                        message = self._format_error(status, etype, emsg, str(e))
                    else:
                        message = self._format_error(status, None, None, str(e))
                except Exception:
                    message = self._format_error(status, None, None, str(e))
                warning(message)
                return
            except (AuthenticationError, RateLimitError, APIConnectionError, OpenAIError) as e:
                message = self._format_error(None, None, None, str(e))
                warning(message)
                return

        except Exception as e:
            warning(str(e))

    def beginGlobal(self):
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .gmi_client import Chat

        bag = self.IEndpoint.endpoint.bag
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        self._chat = None

    def _format_error(self, status, etype, emsg, fallback: str) -> str:
        """Compose a user-facing error string."""
        parts: list[str] = []
        if status is not None:
            parts.append(f'Error {status}:')
        if etype:
            parts.append(str(etype))
        if emsg:
            if etype:
                parts.append('-')
            parts.append(str(emsg))
        message = ' '.join(parts) if parts else fallback
        return re.sub(r'\s+', ' ', message).strip()
