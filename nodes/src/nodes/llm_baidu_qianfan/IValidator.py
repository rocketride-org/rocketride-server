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
baidu qianfan save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a short probe request
against the provider with the configured model and key. The provider SDK is
imported inside the probe so this module stays import-light.
"""

import os
import re

from rocketlib import IValidatorBase, warning
from ai.common.config import warn_if_credential_unresolved

VALIDATION_PROMPT = 'Hi'
VALIDATION_MAX_TOKENS = 8


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the provider probe."""

    def validateConfig(self, syntaxOnly: bool = False):
        """
        Validate the configured Qianfan OpenAI-compatible endpoint at save time.
        """
        # The schema check: a config that does not fit raises ConfigError here,
        # before any probe. syntaxOnly asks for that check alone.
        config = self.config
        if syntaxOnly:
            return

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

            apikey = config.get('apikey')

            # Do not send a ${...} the engine left unfilled to the provider as the key:
            # its reply would say the key is wrong, not which variable is missing.
            if warn_if_credential_unresolved(self.glb.logicalType, 'apikey', apikey):
                return

            model = config.get('customModel') if config.model == 'custom' else config.model
            serverbase = config['serverbase'].rstrip('/')
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

    def _ensure_dependencies(self):
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

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
