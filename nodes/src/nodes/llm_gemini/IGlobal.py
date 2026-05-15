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
import json
import ast
from typing import Optional
from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config
from ai.common.chat import ChatBase


class IGlobal(IGlobalBase):
    """Global interface for Gemini LLM node."""

    chat: Optional[ChatBase] = None

    VALIDATION_PROMPT = 'Hi'

    def validateConfig(self):
        """
        Validate Gemini configuration at save-time using a minimal API probe.

        Provider-driven exceptions first; simple fallback. Full messages, no truncation.
        """
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        try:
            from google import genai

            try:
                from google.api_core.exceptions import (
                    GoogleAPICallError,
                    ClientError,
                    BadRequest,
                    Unauthorized,
                    Forbidden,
                    NotFound,
                    TooManyRequests,
                    ServiceUnavailable,
                    InternalServerError,
                    DeadlineExceeded,
                    InvalidArgument,
                )
            except Exception:
                GoogleAPICallError = Exception  # type: ignore
                ClientError = BadRequest = Unauthorized = Forbidden = NotFound = TooManyRequests = (
                    ServiceUnavailable
                ) = InternalServerError = DeadlineExceeded = InvalidArgument = Exception  # type: ignore
            try:
                from google.auth.exceptions import GoogleAuthError, RefreshError
            except Exception:
                GoogleAuthError = RefreshError = Exception  # type: ignore

            # Read config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')

            # Minimal probe; UI prompts for missing keys
            try:
                client = genai.Client(api_key=apikey)
                client.models.generate_content(model=model, contents=self.VALIDATION_PROMPT)
            except (
                BadRequest,
                Unauthorized,
                Forbidden,
                NotFound,
                TooManyRequests,
                ServiceUnavailable,
                InternalServerError,
                DeadlineExceeded,
                InvalidArgument,
                ClientError,
                GoogleAPICallError,
            ) as e:
                try:
                    prov_code = e.code  # type: ignore[attr-defined]
                except Exception:
                    prov_code = None
                raw = str(e)

                # Attempt to parse JSON payload from the exception string (provider includes a JSON blob)
                status = None
                emsg = None
                code = None
                try:
                    status, emsg, code = self._extract_status_message_code(raw, prov_code)
                    # Some Gemini models complain about "response modalities" when probed with text.
                    # That is not a config/auth error, so we skip emitting a warning here.
                    if (
                        isinstance(status, str)
                        and status.upper() == 'INVALID_ARGUMENT'
                        and isinstance(emsg, str)
                        and 'response modalities' in emsg.lower()
                    ):
                        return
                except Exception:
                    pass

                # If structured parse failed, attempt a light regex extraction
                if emsg is None:
                    m_msg = re.search(r"[\"']message[\"']\s*:\s*[\"']([^\"']+)[\"']", raw)
                    if m_msg:
                        emsg = m_msg.group(1)
                if status is None:
                    m_stat = re.search(r'\b(\d{3})\s+([A-Z_]+)\b', raw)
                    if m_stat:
                        # Prefer numeric code from this match if provider code missing
                        if code is None:
                            try:
                                code = int(m_stat.group(1))
                            except Exception:
                                code = m_stat.group(1)
                        status = m_stat.group(2)

                # Normalize enum-like codes
                display_code = code
                if hasattr(display_code, 'value'):
                    display_code = display_code.value
                elif hasattr(display_code, 'name'):
                    display_code = display_code.name

                message = self._format_error(display_code, status, emsg, raw)
                warning(message)
                return
            except (GoogleAuthError, RefreshError) as e:
                warning(str(e))
                return
            except Exception as e:
                # Fallback path: still try to extract structured fields from raw string
                raw = str(e)
                status, emsg, code = self._extract_status_message_code(raw, None)
                display_code = code
                if hasattr(display_code, 'value'):
                    display_code = display_code.value
                elif hasattr(display_code, 'name'):
                    display_code = display_code.name
                message = self._format_error(display_code, status, emsg, raw)
                warning(message)
                return

        except Exception:
            warning('Gemini validation setup error. Please check your configuration.')

    def beginGlobal(self):
        """Initialize the global chat instance."""
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            from depends import depends  # type: ignore

            # Load the requirements
            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            from .gemini import Chat

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get this nodes config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Get a chat to interface
            self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        """Clean up the global chat instance."""
        self._chat = None

    def _format_error(self, status_or_code, etype_or_status, emsg, fallback: str) -> str:
        """Compose a user-facing error string for Gemini.

        - Prefix with numeric code if available: "Error <code>:".
        - Include status/type (e.g., INVALID_ARGUMENT) and message when present.
        - If nothing structured is available, return the fallback string unchanged.
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

    def _extract_status_message_code(self, raw: str, prov_code):
        """Extract status, message, and code from a Gemini exception string.

        Order of parsing:
        1) Structured JSON/dict appended by the SDK (most reliable).
        2) Light regex for header ("<code> <STATUS>.") and `'message': '...'` fields.

        Returns (status, message, code). Any may be None if unavailable.
        """
        status = None
        emsg = None
        code = None
        idx = raw.rfind('{')
        if idx != -1:
            js = raw[idx:].strip()
            data = None
            try:
                data = json.loads(js)
            except Exception:
                try:
                    data = ast.literal_eval(js)
                except Exception:
                    data = None
            if isinstance(data, dict):
                err = data.get('error') or {}
                status = err.get('status') or data.get('status')
                emsg = err.get('message') or data.get('message')
                code = err.get('code') or data.get('code') or prov_code

        if emsg is None:
            m_msg = re.search(r"[\"']message[\"']\s*:\s*[\"']([^\"']+)[\"']", raw)
            if m_msg:
                emsg = m_msg.group(1)
        if status is None or code is None:
            m_hdr = re.search(r'\b(\d{3})\s+([A-Z_]+)\b', raw)
            if m_hdr:
                if code is None:
                    try:
                        code = int(m_hdr.group(1))
                    except Exception:
                        code = m_hdr.group(1)
                if status is None:
                    status = m_hdr.group(2)
        return status, emsg, code
