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

from ai.common.chat import ChatBase
from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning


DEFAULT_QIANFAN_BASE_URL = 'https://qianfan.baidubce.com/v2'
VALIDATION_PROMPT = 'Hi'
VALIDATION_MAX_TOKENS = 8


class IGlobal(IGlobalBase):
    """Global handler for the Baidu Qianfan LLM node."""

    chat: Optional[ChatBase] = None

    def _ensure_dependencies(self):
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

    def validateConfig(self):
        """
        Validate the configured Qianfan OpenAI-compatible endpoint at save time.
        """
        try:
            self._ensure_dependencies()

            from openai import (
                APIConnectionError,
                APIStatusError,
                AuthenticationError,
                OpenAI,
                OpenAIError,
                RateLimitError,
            )

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')
            serverbase = (config.get('serverbase') or DEFAULT_QIANFAN_BASE_URL).rstrip('/')
            modelTotalTokens = config.get('modelTotalTokens')

            if not isinstance(apikey, str) or not apikey.strip():
                warning('Baidu Qianfan API key is required.')
                return

            if not isinstance(model, str) or not model.strip():
                warning('Baidu Qianfan model name must not be empty.')
                return

            if modelTotalTokens is not None:
                try:
                    model_total_tokens = int(modelTotalTokens)
                except (TypeError, ValueError):
                    warning('Token limit must be greater than 0')
                    return
                if model_total_tokens <= 0:
                    warning('Token limit must be greater than 0')
                    return

            try:
                client = OpenAI(api_key=apikey.strip(), base_url=serverbase)
                client.chat.completions.create(
                    model=model.strip(),
                    messages=[{'role': 'user', 'content': VALIDATION_PROMPT}],
                    max_tokens=VALIDATION_MAX_TOKENS,
                )
            except AuthenticationError:
                warning('Baidu Qianfan API key is invalid or unauthorized.')
                return
            except RateLimitError:
                warning('Baidu Qianfan rate limit exceeded while validating the configuration.')
                return
            except APIStatusError as e:
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                try:
                    resp = getattr(e, 'response', None)
                    data = resp.json() if resp is not None else None
                    if isinstance(data, dict):
                        err = data.get('error')
                        if isinstance(err, dict):
                            etype = err.get('type') or err.get('code')
                            emsg = err.get('message') or data.get('message')
                        else:
                            etype = data.get('code')
                            emsg = data.get('message')
                        message = self._format_error(status, etype, emsg, str(e))
                    else:
                        message = self._format_error(status, None, None, str(e))
                except Exception:
                    message = self._format_error(status, None, None, str(e))
                warning(message)
                return
            except APIConnectionError:
                warning('Could not connect to Baidu Qianfan. Check the configured base URL and network access.')
                return
            except OpenAIError as e:
                warning(self._format_error(None, None, None, str(e)))
                return

        except Exception as e:
            warning(str(e))
            return

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        self._ensure_dependencies()

        from .qianfan_client import Chat

        bag = self.IEndpoint.endpoint.bag
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        self._chat = None

    def _format_error(self, status, etype, emsg, fallback: str) -> str:
        parts: list[str] = []
        if status is not None:
            parts.append(f'Error {status}:')
        if etype:
            parts.append(str(etype))
        if emsg:
            if etype:
                parts.append('-')
            parts.append(str(emsg))
        if etype or emsg:
            message = ' '.join(parts)
        elif status is not None and fallback:
            message = f'{" ".join(parts)} {fallback}'
        else:
            message = fallback
        message = re.sub(r'\s+', ' ', message).strip()
        if len(message) > 500:
            message = message[:500].rstrip() + '\u2026'
        return message
