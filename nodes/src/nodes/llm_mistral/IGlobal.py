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
from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config
from ai.common.chat import ChatBase
from typing import Optional


VALIDATION_PROMPT = 'Hi'


class IGlobal(IGlobalBase):
    """Global handler for the Mistral AI node."""

    chat: Optional[ChatBase] = None

    def validateConfig(self):
        """Validate Mistral configuration at save-time with a minimal probe.

        Prefer provider-driven exceptions; concise formatting; no string matching.
        """
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        try:
            # Import Mistral SDK after dependencies are loaded
            from mistralai.client import Mistral

            try:
                from mistralai.exceptions import MistralException  # type: ignore
            except Exception:
                MistralException = Exception  # type: ignore

            # Read config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')
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

    def beginGlobal(self):
        """Initialize the global instance for the Mistral AI node."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            return
        else:
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Import the Mistral chat implementation
            from .mistral import Chat

            # Get our bag for sharing data across pipeline components
            bag = self.IEndpoint.endpoint.bag

            # Get this node's configuration from the service definition
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Initialize the Mistral chat interface with configuration
            self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        """Clean up the global instance when the node shuts down."""
        self._chat = None

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
