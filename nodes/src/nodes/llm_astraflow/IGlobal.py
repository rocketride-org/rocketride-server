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
import re
from typing import Optional
from rocketlib import IGlobalBase, warning
from ai.common.config import Config
from ai.common.chat import ChatBase


class IGlobal(IGlobalBase):
    """Global handler for the Astraflow LLM node."""

    _chat: Optional[ChatBase] = None

    _VALIDATION_PROMPT = 'Hi'
    _ASTRAFLOW_BASE_URL = 'https://api-us-ca.umodelverse.ai/v1'
    _ASTRAFLOW_CN_BASE_URL = 'https://api.modelverse.cn/v1'
    # Substrings that indicate a vision/multimodal model (case-insensitive).
    # Used to warn the user when a custom model name looks like a vision model.
    _VISION_HINTS = ('vl', 'vision', 'visual', 'multimodal')

    def validateConfig(self):
        """Validate Astraflow models at save time.

        For named profiles the model ID is pre-verified. For the custom
        profile the user-entered model name is checked: vision/multimodal
        model names trigger a warning and skip the API probe; all other
        non-empty names are probed with a 1-token request to confirm both
        the API key and model existence.
        """
        from depends import depends  # type: ignore

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        try:
            from openai import OpenAI
            from openai import APIStatusError, OpenAIError, AuthenticationError, RateLimitError, APIConnectionError

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')
            serverbase = config.get('serverbase') or self._ASTRAFLOW_BASE_URL

            # Nothing to validate if model or API key is not set yet.
            if not model or not apikey:
                return

            # Vision heuristic: warn and skip probe if model looks like a vision model
            model_lower = model.lower()
            if any(hint in model_lower for hint in self._VISION_HINTS):
                warning(
                    'This model appears to be a vision/multimodal model. For image input, use a vision node instead.'
                )
                return

            # Probe with a 1-token request to validate key + model existence
            try:
                client = OpenAI(api_key=apikey, base_url=serverbase)
                client.chat.completions.create(
                    model=model,
                    messages=[{'role': 'user', 'content': self._VALIDATION_PROMPT}],
                    max_tokens=1,
                )
            except RateLimitError:
                return
            except APIStatusError as e:
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                if status == 429:
                    return
                try:
                    resp = getattr(e, 'response', None)
                    data = resp.json() if resp is not None else None
                    if isinstance(data, dict):
                        api_err = data.get('error')
                        if isinstance(api_err, dict):
                            etype = api_err.get('type')
                            emsg = api_err.get('message') or data.get('message')
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
            except (AuthenticationError, APIConnectionError, OpenAIError) as e:
                message = self._format_error(None, None, None, str(e))
                warning(message)
                return

        except Exception as e:
            warning(str(e))

    def beginGlobal(self):
        """Initialize the Astraflow chat client."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .astraflow import Chat

        bag = self.IEndpoint.endpoint.bag
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        if not config.get('apikey'):
            raise ValueError('Astraflow API key is required.')
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        """Release the chat client."""
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
        if parts and not etype and not emsg and fallback:
            parts.append(fallback)
        message = ' '.join(parts) if parts else fallback
        return re.sub(r'\s+', ' ', message).strip()
