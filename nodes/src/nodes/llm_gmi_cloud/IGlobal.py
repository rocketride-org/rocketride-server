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
from urllib.parse import urlparse
from typing import Optional
from rocketlib import IGlobalBase, warning
from ai.common.config import Config
from ai.common.chat import ChatBase


class IGlobal(IGlobalBase):
    """Global handler for the GMI Cloud LLM node."""

    _chat: Optional[ChatBase] = None

    _VALIDATION_PROMPT = 'Hi'
    _GMI_CLOUD_BASE_URL = 'https://api.gmi-serving.com/v1'
    _ALLOWED_DOMAIN = 'gmi-serving.com'
    # Substrings that indicate a vision/multimodal model (case-insensitive).
    # Used to warn the user when a custom model name looks like a vision model.
    _VISION_HINTS = ('vl', 'vision', 'visual', 'multimodal')

    def _validate_serverbase(self, url: str) -> Optional[str]:
        """Return an error message if url is not a valid GMI Cloud endpoint, else None.

        Enforces HTTPS and restricts the hostname to *.gmi-serving.com to
        prevent SSRF via user-supplied endpoint URLs.
        """
        parsed = urlparse(url)
        if parsed.scheme != 'https':
            return 'Endpoint URL must use HTTPS.'
        host = parsed.hostname or ''
        if host != self._ALLOWED_DOMAIN and not host.endswith('.' + self._ALLOWED_DOMAIN):
            return f'Endpoint URL must be a {self._ALLOWED_DOMAIN} address.'
        return None

    def validateConfig(self):
        """Validate GMI Cloud models at save time.

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
            serverbase = config.get('serverbase') or self._GMI_CLOUD_BASE_URL

            # Nothing to validate if model or API key is not set yet.
            if not model or not apikey:
                return

            # Deploy-on-demand profiles (Llama, Qwen) require the user to supply
            # their deployment endpoint URL. Skip the probe if it has not been set yet.
            if not config.get('serverbase'):
                return

            err = self._validate_serverbase(serverbase)
            if err:
                warning(err)
                return

            # Vision heuristic: warn and skip probe if model looks like a vision model
            model_lower = model.lower()
            if any(hint in model_lower for hint in self._VISION_HINTS):
                warning(
                    'This model appears to be a vision/multimodal model. For image input, use a vision node instead.'
                )
                # Skip the probe — vision models may reject text-only requests,
                # which would produce a misleading error on top of this warning.
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
                # 429 during validation means the API key is accepted — the probe
                # just hit the rate limit. Treat as valid; no warning needed.
                return
            except APIStatusError as e:
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                # 429 via APIStatusError: same as RateLimitError — key is valid.
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
        """Initialize the GMI Cloud chat client."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .gmi_cloud import Chat

        bag = self.IEndpoint.endpoint.bag
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        if not config.get('apikey'):
            raise ValueError('GMI Cloud API key is required.')
        serverbase = config.get('serverbase') or self._GMI_CLOUD_BASE_URL
        err = self._validate_serverbase(serverbase)
        if err:
            raise ValueError(err)
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        """Release the chat client."""
        self._chat = None

    def _format_error(self, status, etype, emsg, fallback: str) -> str:
        """Compose a user-facing error string.

        If a numeric HTTP status is available, prefix it as 'Error <status>:'.
        Then include provider error type and message when present.
        If no structured fields are available, return the fallback message as-is.
        Whitespace is normalized to a single line.
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
        # If we only have a status code with no detail, append the raw fallback
        # so the user sees the full provider message rather than "Error 404:" alone.
        if parts and not etype and not emsg and fallback:
            parts.append(fallback)
        message = ' '.join(parts) if parts else fallback
        return re.sub(r'\s+', ' ', message).strip()
