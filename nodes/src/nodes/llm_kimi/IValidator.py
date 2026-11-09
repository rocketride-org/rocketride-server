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
kimi save-time validation.

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


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the provider probe."""

    def validateConfig(self, syntaxOnly: bool = False):
        """Validate only cloud Kimi (Moonshot) models (API-based) at save time.

        Local/self-hosted OpenAI-compatible endpoints are not validated here per
        product decision.
        """
        # Load dependencies first
        # The schema check: a config that does not fit raises ConfigError here,
        # before any probe. syntaxOnly asks for that check alone.
        config = self.config
        if syntaxOnly:
            return

        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        try:
            # Import OpenAI SDK (Kimi/Moonshot is OpenAI-compatible)
            from openai import OpenAI

            # Prefer provider-driven exception types over string parsing
            from openai import APIStatusError, OpenAIError, AuthenticationError, RateLimitError, APIConnectionError

            apikey = config.get('apikey')

            # Do not send a ${...} the engine left unfilled to the provider as the key:
            # its reply would say the key is wrong, not which variable is missing.
            if warn_if_credential_unresolved(self.glb.logicalType, 'apikey', apikey):
                return

            model = config.get('customModel') if config.model == 'custom' else config.model
            serverbase = config['serverbase']

            # Only validate cloud Moonshot endpoints; skip self-hosted/offline ones.
            if 'api.moonshot' not in serverbase:
                return

            # Minimal probe; UI handles missing key prompts
            try:
                # Create client and make a 1-token probe
                client = OpenAI(api_key=apikey, base_url=serverbase)
                client.chat.completions.create(
                    model=model, messages=[{'role': 'user', 'content': VALIDATION_PROMPT}], max_tokens=1
                )
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
