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
openai api save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a short probe request
against the provider with the configured model and key. The provider SDK is
imported inside the probe so this module stays import-light.
"""

import os
import re

from rocketlib import IValidatorBase, debug, warning
from ai.common.config import warn_if_credential_unresolved


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the provider probe."""

    def validateConfig(self, syntaxOnly: bool = False):
        """
        Validate the configuration for OpenAI-compatible API LLM node.
        """
        # The schema check: a config that does not fit raises ConfigError here,
        # before any probe. syntaxOnly asks for that check alone.
        config = self.config
        if syntaxOnly:
            return

        try:
            # Load dependencies
            from depends import depends

            requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
            depends(requirements)

            from openai import (
                OpenAI,
                APIStatusError,
                OpenAIError,
                AuthenticationError,
                RateLimitError,
                APIConnectionError,
            )

            apikey = config.get('apikey')
            model = config.get('customModel') if config.model == 'custom' else config.model
            base_url = config.get('base_url') or None
            modelTotalTokens = config.get('modelTotalTokens')

            # Only validate tokens > 0 if provided
            if modelTotalTokens is not None and modelTotalTokens <= 0:
                warning('Token limit must be greater than 0')
                return

            # Do not send a ${...} the engine left unfilled to the provider as the key:
            # its reply would say the key is wrong, not which variable is missing.
            if warn_if_credential_unresolved(self.glb.logicalType, 'apikey', apikey):
                return

            # Simple API validation using provider-driven exceptions
            try:
                kwargs = {'api_key': apikey, 'timeout': 10.0}
                if base_url:
                    kwargs['base_url'] = base_url

                client = OpenAI(**kwargs)
                client.chat.completions.create(model=model, messages=[{'role': 'user', 'content': 'Hi'}], max_tokens=1)
            except APIStatusError as e:
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
                except Exception as exc:
                    debug(f'JSON parse failed while formatting API error: {exc}')
                message = re.sub(r'\s+', ' ', message).strip()
                if len(message) > 500:
                    message = message[:500].rstrip() + '…'
                warning(message)
                return
            except (AuthenticationError, RateLimitError, APIConnectionError, OpenAIError) as e:
                message = re.sub(r'\s+', ' ', str(e)).strip()
                if len(message) > 500:
                    message = message[:500].rstrip() + '…'
                warning(message)
                return

        except Exception as e:
            warning(str(e))
            return
