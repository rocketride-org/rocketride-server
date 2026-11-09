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
xai save-time validation.

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


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the provider probe."""

    def validateConfig(self, syntaxOnly: bool = False):
        """Save-time validation for xAI using a minimal probe.

        - No string matching or hardcoded texts
        - Keep only the lower-bound token check (> 0)
        - Prefer provider/HTTP JSON bodies; trim embedded dict strings as fallback.
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
            # xAI client
            from langchain_xai import ChatXAI

            # Provider HTTP exceptions (used by langchain_xai under the hood)
            try:
                import httpx  # type: ignore
            except Exception:  # pragma: no cover
                httpx = None  # type: ignore

            apikey = config.get('apikey')

            # Do not send a ${...} the engine left unfilled to the provider as the key:
            # its reply would say the key is wrong, not which variable is missing.
            if warn_if_credential_unresolved(self.glb.logicalType, 'apikey', apikey):
                return

            model = config.get('customModel') if config.model == 'custom' else config.model
            modelTotalTokens = config.get('modelTotalTokens')

            # Minimal explicit check: custom model must have positive token limit
            if model and modelTotalTokens is not None and modelTotalTokens <= 0:
                warning('Token limit must be greater than 0')
                return

            # Minimal probe; UI handles required fields
            try:
                client = ChatXAI(model=model, api_key=apikey, temperature=0)
                client.invoke(self.VALIDATION_PROMPT)
            except Exception as e:
                # SDK-first: HTTP status errors carry response and status code
                if httpx is not None and isinstance(e, getattr(httpx, 'HTTPStatusError', ())):
                    try:
                        status_code = e.response.status_code  # type: ignore[attr-defined]
                    except Exception:
                        status_code = None
                    raw = str(e)
                    # Reuse shared helpers (no duplication): extract → format
                    status_str, emsg, code = self._extract_status_message_code(raw)
                    # Prefer concrete HTTP status when available; otherwise use parsed code
                    warning(self._format_error(status_code if status_code is not None else code, status_str, emsg, raw))
                    return

                # Network/connection issues: still try to parse structured fields
                if httpx is not None and isinstance(e, getattr(httpx, 'RequestError', ())):
                    raw = str(e)
                    status, emsg, code = self._extract_status_message_code(raw)
                    warning(self._format_error(code, None, emsg, raw))
                    return

                # Generic fallback: extract structured fields from raw string if possible
                raw = str(e)
                status, emsg, code = self._extract_status_message_code(raw)
                warning(self._format_error(code if code is not None else status, None, emsg, raw))
                return
        except Exception:
            import sys

            exc = sys.exc_info()[1]
            warning(str(exc))

    def _format_error(self, status_or_code, etype_or_status, emsg, fallback: str) -> str:
        """Compose a user-facing error string.

        - Prefix with numeric status/code if available: "Error <code>:".
        - Include type/status and message when present.
        - If nothing structured is available, return the fallback unchanged.
        - Normalize whitespace; do not truncate.
        """
        parts: list[str] = []
        if status_or_code is not None:
            parts.append(f'Error {status_or_code}:')
        if etype_or_status:
            parts.append(str(etype_or_status))
        if emsg:
            if etype_or_status:
                parts.append('-')
            parts.append(str(emsg))
        message = ' '.join(parts) if parts else fallback
        return re.sub(r'\s+', ' ', message).strip()

    def _extract_status_message_code(self, raw: str):
        """Extract status/message/code from common xAI error strings.

        Strategy:
        1) Parse embedded dict at the end (json → ast) and read message/code/type.
        2) Light regex for "Error code: NNN" and for 'message': '...'.
        Returns (status, message, code); values may be None.
        """
        status = None
        emsg = None
        code = None
        # Embedded dict payload
        idx = raw.rfind('{')
        if idx != -1:
            # Provider often appends a structured JSON/dict block at the end
            js = raw[idx:]
            data = None
            try:
                data = json.loads(js)
            except Exception:
                try:
                    data = ast.literal_eval(js)
                except Exception:
                    data = None
            if isinstance(data, dict):
                err = data.get('error')
                if isinstance(err, dict):
                    emsg = err.get('message') or data.get('message') or data.get('error')
                    status = err.get('type') or data.get('status') or data.get('type')
                    code = err.get('code') or data.get('code')
                elif isinstance(err, str):
                    emsg = err
                    status = data.get('status') or data.get('type')
                    code = data.get('code')
                else:
                    emsg = data.get('message') or data.get('error')
                    status = data.get('status') or data.get('type')
                    code = data.get('code')
        # Regex fallbacks
        if code is None:
            # Match: "Error code: 401" (case-insensitive), capture the number
            m_code = re.search(r'Error code:\s*(\d+)', raw, re.IGNORECASE)
            if m_code:
                code = int(m_code.group(1)) if m_code.group(1).isdigit() else m_code.group(1)
        if emsg is None:
            # Quote-agnostic 'message' capture: works for single or double quotes
            m_msg = re.search(r"[\"']message[\"']\s*:\s*[\"']([^\"']+)[\"']", raw)
            if m_msg:
                emsg = m_msg.group(1)
        return status, emsg, code
