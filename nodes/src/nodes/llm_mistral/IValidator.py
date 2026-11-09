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
mistral save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a short probe request
against the provider with the configured model and key. The provider SDK is
imported inside the probe so this module stays import-light.
"""

import os
import re
import json
import ast

from rocketlib import IValidatorBase, warning
from ai.common.config import warn_if_credential_unresolved

VALIDATION_PROMPT = 'Hi'


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the provider probe."""

    def validateConfig(self, syntaxOnly: bool = False):
        """Validate Mistral configuration at save-time with a minimal probe.

        Prefer provider-driven exceptions; concise formatting; no string matching.
        """
        # The schema check: a config that does not fit raises ConfigError here,
        # before any probe. syntaxOnly asks for that check alone.
        config = self.config
        if syntaxOnly:
            return

        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        try:
            # Import Mistral SDK after dependencies are loaded
            try:
                from mistralai.client import Mistral  # 2.x layout
            except ImportError:
                from mistralai import Mistral  # 1.x layout

            try:
                from mistralai.exceptions import MistralException  # type: ignore  # contract-check: ignore  optional, falls back to built-in Exception
            except Exception:
                MistralException = Exception  # type: ignore

            apikey = config.get('apikey')

            # Do not send a ${...} the engine left unfilled to the provider as the key:
            # its reply would say the key is wrong, not which variable is missing.
            if warn_if_credential_unresolved(self.glb.logicalType, 'apikey', apikey):
                return

            model = config.get('customModel') or config.model
            modelTotalTokens = config.get('modelTotalTokens')

            # Minimal explicit check for custom models
            if model and modelTotalTokens is not None and modelTotalTokens <= 0:
                warning('Token limit must be greater than 0')
                return

            # Minimal probe (UI handles required fields)
            try:
                client = Mistral(api_key=apikey)
                client.chat.complete(
                    model=model,
                    messages=[{'role': 'user', 'content': VALIDATION_PROMPT}],
                    max_tokens=1,
                )
            except MistralException as e:  # Provider exceptions
                status = getattr(e, 'status_code', None)
                raw = str(e).strip()

                body_text = self._extract_body_text(e) or raw

                etype = None
                emsg = None
                code = None
                # Try JSON or embedded dict once
                try:
                    parsed = None
                    try:
                        parsed = json.loads(body_text)
                    except Exception:
                        m = re.search(r'\{.*\}', body_text, re.DOTALL)
                        if m:
                            js = m.group(0)
                            try:
                                parsed = json.loads(js)
                            except Exception:
                                try:
                                    parsed = ast.literal_eval(js)
                                except Exception:
                                    parsed = None
                    if isinstance(parsed, dict):
                        err = parsed.get('error') or {}
                        etype = err.get('type') or parsed.get('type')
                        emsg = err.get('message') or parsed.get('message') or parsed.get('detail')
                        code = err.get('code') or parsed.get('code')
                except Exception:
                    pass

                message = self._format_error(code if code is not None else status, etype, emsg, raw)
                warning(message)
                return
            except Exception as e:
                # Generic fallback
                # Do not alter or truncate provider message; surface as-is
                raw = str(e)
                warning(raw)
                return

        except Exception:
            warning('Mistral validation setup error. Please check your configuration.')

    def _format_error(self, status_or_code, etype, emsg, fallback: str) -> str:
        parts: list[str] = []
        if status_or_code is not None:
            parts.append(f'Error {status_or_code}:')
        if etype:
            parts.append(str(etype))
        if emsg:
            if etype:
                parts.append('-')
            parts.append(str(emsg))
        message = ' '.join(parts) if parts else fallback
        return re.sub(r'\s+', ' ', message).strip()

    def _extract_body_text(self, e) -> str:
        val = getattr(e, 'body', None)
        if isinstance(val, bytes):
            try:
                s = val.decode('utf-8', errors='ignore')
                if s.strip():
                    return s
            except Exception:
                pass
        if isinstance(val, str) and val.strip():
            return val
        resp = getattr(e, 'response', None)
        text = getattr(resp, 'text', None)
        if isinstance(text, str) and text.strip():
            return text
        return ''
