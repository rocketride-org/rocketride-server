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
from rocketlib import IGlobalBase, warning
from ai.common.config import Config
from ai.common.chat import ChatBase


class IGlobal(IGlobalBase):
    """Global handler for the Nebius Token Factory LLM node."""

    _chat: Optional[ChatBase] = None

    _VALIDATION_PROMPT = 'Hi'
    _BASE_URL = 'https://api.tokenfactory.nebius.com/v1/'

    def _resolve_apikey(self, config) -> str:
        return str(config.get('apikey') or os.environ.get('NEBIUS_API_KEY', '')).strip()

    def validateConfig(self):
        """Probe the model with a 1-token request to validate key + model at save time."""
        from depends import depends  # type: ignore

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
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
            apikey = self._resolve_apikey(config)
            model = config.get('model')
            if not model or not apikey:
                return
            try:
                client = OpenAI(api_key=apikey, base_url=self._BASE_URL)
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
                warning(f'Nebius validation error {status}: {e}')
                return
            except (AuthenticationError, APIConnectionError, OpenAIError) as e:
                warning(str(e))
                return
        except Exception as e:
            warning(str(e))

    def beginGlobal(self):
        """Initialize the Nebius chat client."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .nebius import Chat

        bag = self.IEndpoint.endpoint.bag
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        if not self._resolve_apikey(config):
            raise ValueError('Nebius API key is required.')
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        self._chat = None
