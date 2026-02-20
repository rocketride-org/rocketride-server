# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
import re
from typing import Optional
from rocketlib import IGlobalBase, warning
from ai.common.config import Config
from ai.common.chat import ChatBase


VALIDATION_PROMPT = 'Hi'
DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'


class IGlobal(IGlobalBase):
    """Global handler for the DeepSeek LLM node."""

    chat: Optional[ChatBase] = None

    def validateConfig(self):
        """Validate only cloud DeepSeek models (API-based) at save time.

        Local/localhost models are not validated here per product decision.
        """
        # Load dependencies first
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        try:
            # Import OpenAI SDK (DeepSeek is OpenAI-compatible)
            from openai import OpenAI

            # Prefer provider-driven exception types over string parsing
            from openai import APIStatusError, OpenAIError, AuthenticationError, RateLimitError, APIConnectionError

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')

            # Cloud models we validate: deepseek-reasoner, deepseek-chat
            if model not in ['deepseek-reasoner', 'deepseek-chat']:
                # Skip localhost/offline validation per decision
                return

            # Minimal probe; UI handles missing key prompts
            try:
                # Create client and make a 1-token probe
                client = OpenAI(api_key=apikey, base_url=DEEPSEEK_BASE_URL)
                client.chat.completions.create(model=model, messages=[{'role': 'user', 'content': VALIDATION_PROMPT}], max_tokens=1)
            except APIStatusError as e:
                # HTTP error with structured body; pull code/type/message
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
                # Other OpenAI exceptions; format consistently
                message = self._format_error(None, None, None, str(e))
                warning(message)
                return

        except Exception as e:
            # Generic fallback - do not alter provider message
            warning(str(e))

    def beginGlobal(self):
        from depends import depends  # type: ignore

        # Load the requirements
        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .deepseek import Chat

        # Get our bag
        bag = self.IEndpoint.endpoint.bag

        # Get this nodes config
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Get a chat to interface
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        self.chat = None

    def _format_error(self, status, etype, emsg, fallback: str) -> str:
        """Compose a user-facing error string.

        - If a numeric HTTP status/code is available, prefix it as "Error <status>:".
        - Then include provider error type and message when present.
        - If no structured fields are available, return the fallback message as-is.
        - Whitespace is normalized to a single line; content is not truncated.
        """
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
