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

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config
from ai.common.chat import ChatBase
import os
import re

DASHSCOPE_REGIONS = {
    'us': 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    'intl': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    'cn': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
}


class IGlobal(IGlobalBase):
    chat: ChatBase | None = None

    def _format_error(self, message: str) -> str:
        """
        Format an error message for user-facing display.
        """
        message = re.sub(r'\s+', ' ', message).strip()
        if len(message) > 500:
            message = message[:500].rstrip() + '\u2026'
        return message

    def validateConfig(self):
        """
        Validate the configuration for Qwen LLM node.
        """
        try:
            # Load dependencies
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Prefer provider-driven exceptions vs string parsing
            from openai import (
                OpenAI,
                APIStatusError,
                OpenAIError,
                AuthenticationError,
                RateLimitError,
                APIConnectionError,
            )

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')
            modelTotalTokens = config.get('modelTotalTokens')

            # Validate API key format
            if not apikey or not apikey.startswith('sk-'):
                warning('Invalid DashScope API key. Key must start with "sk-".')
                return

            # Only validate tokens > 0 if provided
            if modelTotalTokens is not None:
                if modelTotalTokens <= 0:
                    warning('Token limit must be greater than 0')
                    return

            # Resolve regional endpoint
            region = config.get('region', 'us')
            base_url = DASHSCOPE_REGIONS.get(region, DASHSCOPE_REGIONS['us'])

            # Simple API validation using provider-driven exceptions
            try:
                client = OpenAI(api_key=apikey, base_url=base_url)
                client.chat.completions.create(model=model, messages=[{'role': 'user', 'content': 'Hi'}], max_tokens=1)
            except APIStatusError as e:
                # HTTP error with structured body; pull status/type/message
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                message = str(e)
                try:
                    resp = getattr(e, 'response', None)
                    data = resp.json() if resp is not None else None
                    if isinstance(data, dict):
                        err = data.get('error')
                        etype = err.get('type') if isinstance(err, dict) else None
                        emsg = (err.get('message') if isinstance(err, dict) else None) or data.get('message')
                        parts = []
                        if status:
                            parts.append(f'Error {status}:')
                        if etype:
                            parts.append(etype)
                        if emsg:
                            if etype:
                                parts.append('-')
                            parts.append(emsg)
                        if parts:
                            message = ' '.join(parts)
                except Exception:
                    pass
                warning(self._format_error(message))
                return
            except (AuthenticationError, RateLimitError, APIConnectionError, OpenAIError) as e:
                warning(self._format_error(str(e)))
                return

        except Exception as e:
            warning(str(e))
            return

    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition
            from .qwen_client import Chat

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        self._chat = None
