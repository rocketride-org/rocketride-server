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
from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config
from ai.common.chat import ChatBase
from typing import Optional


PERPLEXITY_BASE_URL = 'https://api.perplexity.ai'
VALIDATION_PROMPT = 'Hi'


class IGlobal(IGlobalBase):
    """Global interface for Perplexity AI node."""

    chat: Optional[ChatBase] = None

    def validateConfig(self):
        """
        Validate Perplexity configuration at save-time with a minimal probe.

        Use provider-driven (OpenAI-compatible) exceptions; provide one concise fallback.
        """
        try:
            # Load dependencies
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            from openai import OpenAI

            # Exception classes (best-effort import across versions)
            try:
                from openai import (
                    APIStatusError,
                    AuthenticationError,
                    RateLimitError,
                    APIConnectionError,
                    OpenAIError,
                )
            except Exception:
                APIStatusError = AuthenticationError = RateLimitError = APIConnectionError = OpenAIError = Exception  # type: ignore

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')

            # Simple API validation
            try:
                client = OpenAI(api_key=apikey, base_url=PERPLEXITY_BASE_URL, timeout=15.0)
                # Minimal 1-token probe
                client.chat.completions.create(
                    model=model,
                    messages=[{'role': 'user', 'content': VALIDATION_PROMPT}],
                    max_tokens=10,
                )
            except APIStatusError as e:
                # HTTP error with status and possible JSON/HTML body
                status = getattr(e, 'status_code', None)
                raw = str(e).strip()
                etype = None
                emsg = None
                resp = getattr(e, 'response', None)
                if resp is not None:
                    # Prefer structured JSON if available
                    try:
                        data = resp.json()
                        if isinstance(data, dict):
                            err = data.get('error') or {}
                            etype = err.get('type') or data.get('type')
                            emsg = err.get('message') or data.get('message')
                    except Exception:
                        # Brief HTML extraction for Perplexity 401 page
                        text = getattr(resp, 'text', None)
                        if isinstance(text, str) and text:
                            emsg = self._extract_html_message(text)
                message = self._format_error(status, etype, emsg, raw)
                warning(message)
                return

            except (AuthenticationError, RateLimitError, APIConnectionError, OpenAIError) as e:
                message = self._format_error(None, None, None, str(e))
                warning(message)
                return

            except Exception as e:
                # One concise fallback for any non-SDK or unexpected format
                message = self._format_error(None, None, None, str(e))
                warning(message)
                return

        except Exception as e:
            # Outer setup exceptions: concise message only
            message = self._format_error(None, None, None, str(e))
            warning(message)
            return

    def beginGlobal(self):
        """Initialize the global chat instance."""
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            from .perplexity import Chat

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get this nodes config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Get a chat to interface
            self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        """Clean up the global chat instance."""
        self._chat = None

    def _format_error(self, status, etype, emsg, fallback: str) -> str:
        """
        Build a concise, consistent error string.

        - If structured fields are present, formats as: "Error <status>: <type> - <message>".
        - Otherwise returns sanitized fallback text; avoids duplicate status prefixing.
        - Always collapses whitespace for readability.
        """
        base = fallback or ''
        base = re.sub(r'\s+', ' ', base).strip()
        # Avoid duplication like "Error 401: 401 ..." or "Error 401: Error 401: ..."
        if status is not None:
            base = re.sub(rf'^\s*(?:error\s*)?{status}\s*[:\-]?\s*', '', base, flags=re.IGNORECASE).strip()
            if emsg:
                emsg = re.sub(rf'^\s*(?:error\s*)?{status}\s*[:\-]?\s*', '', str(emsg), flags=re.IGNORECASE).strip()
        parts: list[str] = []
        if status is not None:
            parts.append(f'Error {status}:')
        if etype:
            parts.append(str(etype))
        if emsg:
            if etype:
                parts.append('-')
            parts.append(str(emsg))
        # If we have no structured message, include the fallback text
        if (not emsg) and base:
            if etype:
                parts.append('-')
            parts.append(base)
        return ' '.join(p for p in parts if p).strip() or base

    def _extract_html_message(self, text: str) -> str:
        """Extract a concise message from simple HTML error pages (title/h1).

        This is used for Perplexity 401 HTML responses. Falls back to
        stripping tags if title/h1 are not present.
        """
        title = re.search(r'<title>\s*(.*?)\s*</title>', text, re.IGNORECASE | re.DOTALL)
        h1 = re.search(r'<h1[^>]*>\s*(.*?)\s*</h1>', text, re.IGNORECASE | re.DOTALL)
        parts = []
        if title:
            parts.append(title.group(1).strip())
        if h1:
            text_h1 = h1.group(1).strip()
            if not parts or text_h1 != parts[0]:
                parts.append(text_h1)
        return ' - '.join(parts) if parts else re.sub(r'<[^>]+>', ' ', text).strip()
