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
openai save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a short probe request
against the provider with the configured model and key. The provider SDK is
imported inside the probe so this module stays import-light.
"""

import os
import re

from rocketlib import IValidatorBase, warning
from ai.common.config import warn_if_credential_unresolved


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the provider probe."""

    def validateConfig(self, syntaxOnly: bool = False):
        """
        Validate the configuration for OpenAI LLM node.
        """
        # The schema check: a config that does not fit raises ConfigError here,
        # before any probe. syntaxOnly asks for that check alone.
        config = self.config
        if syntaxOnly:
            return

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

            apikey = config.get('apikey')
            model = config.get('customModel') if config.model == 'custom' else config.model
            modelTotalTokens = config.get('modelTotalTokens')

            # Only validate tokens > 0 if provided
            if modelTotalTokens is not None:
                if modelTotalTokens <= 0:
                    warning('Token limit must be greater than 0')
                    return

            # Do not send a ${...} the engine left unfilled to the provider as the key:
            # its reply would say the key is wrong, not which variable is missing.
            if warn_if_credential_unresolved(self.glb.logicalType, 'apikey', apikey):
                return

            # Simple API validation using provider-driven exceptions
            try:
                client = OpenAI(api_key=apikey)

                # Newer models use max_completion_tokens instead of max_tokens
                newer_models = ['gpt-5', 'gpt-5.1', 'gpt-5-mini', 'gpt-5-nano']
                uses_max_completion_tokens = any(model.startswith(m) for m in newer_models)

                # Make sure model is using the correct parameters
                if uses_max_completion_tokens:
                    client.chat.completions.create(
                        model=model, messages=[{'role': 'user', 'content': 'Hi'}], max_completion_tokens=10
                    )
                else:
                    client.chat.completions.create(
                        model=model, messages=[{'role': 'user', 'content': 'Hi'}], max_tokens=1
                    )
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
