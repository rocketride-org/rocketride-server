# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
from rocketlib import IGlobalBase, warning
from ai.common.config import Config
from ai.common.chat import ChatBase


class IGlobal(IGlobalBase):
    chat: ChatBase | None = None

    def validateConfig(self):
        """Save-time validation for Anthropic.

        - Parameterless; UI handles required fields
        - Only explicit check: token limit must be > 0
        - Prefer provider-driven exceptions for concise messages
        - Fallback sanitizes JSON/plain text to a short warning.
        """
        # Load dependencies first (once per call is fine; small file)
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        try:
            # Direct Anthropic client and structured exceptions (SDK-dependent)
            from anthropic import Anthropic

            try:
                from anthropic import (
                    APIStatusError,
                    APIConnectionError,
                    APITimeoutError,
                    RateLimitError,
                    AuthenticationError,
                    BadRequestError,
                    PermissionDeniedError,
                    NotFoundError,
                    InternalServerError,
                    APIError,
                )
            except Exception:  # SDK variations across versions
                APIStatusError = Exception  # type: ignore
                APIConnectionError = Exception  # type: ignore
                APITimeoutError = Exception  # type: ignore
                RateLimitError = Exception  # type: ignore
                AuthenticationError = Exception  # type: ignore
                BadRequestError = Exception  # type: ignore
                PermissionDeniedError = Exception  # type: ignore
                NotFoundError = Exception  # type: ignore
                InternalServerError = Exception  # type: ignore
                APIError = Exception  # type: ignore

            # Read config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model')

            # Lower-bound token check (custom models)
            modelTotalTokens = config.get('modelTotalTokens')
            if modelTotalTokens is not None and modelTotalTokens <= 0:
                warning('Token limit must be greater than 0')
                return

            # Minimal probe
            try:
                client = Anthropic(api_key=apikey)
                client.messages.create(model=model, max_tokens=1, messages=[{'role': 'user', 'content': 'Hi'}])
            except APIStatusError as e:  # HTTP error with structured payload
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                message = str(e).strip()
                # Prefer structured JSON body
                try:
                    data = e.response.json()
                    if isinstance(data, dict):
                        err = data.get('error')
                        etype = err.get('type') if isinstance(err, dict) else None
                        emsg = (err.get('message') if isinstance(err, dict) else None) or data.get('message')
                        message = self._format_error(status, etype, emsg, message)
                except Exception:
                    message = self._format_error(status, None, None, message)
                warning(message)
                return
            except (APIConnectionError, APITimeoutError, RateLimitError, AuthenticationError, BadRequestError, PermissionDeniedError, NotFoundError, InternalServerError, APIError) as e:
                message = self._format_error(None, None, None, str(e))
                warning(message)
                return
            except Exception as e:
                # Fallback: try response.json() → embedded dict → raw
                status = getattr(e, 'status_code', None) or getattr(e, 'status', None)
                raw = str(e).strip()
                message = raw

                # 1) response.json()
                try:
                    data = e.response.json()
                    if isinstance(data, dict):
                        err = data.get('error')
                        etype = err.get('type') if isinstance(err, dict) else None
                        emsg = (err.get('message') if isinstance(err, dict) else None) or data.get('message')
                        message = self._format_error(status, etype, emsg, message)
                except Exception:
                    pass

                # 2) Embedded dict-like payload in exception string
                if message == raw:
                    try:
                        m = re.search(r'\{.*\}', raw, re.DOTALL)
                        blob = m.group(0) if m else None
                        if blob:
                            payload = None
                            try:
                                payload = json.loads(blob)
                            except Exception:
                                try:
                                    payload = ast.literal_eval(blob)
                                except Exception:
                                    payload = None
                            if isinstance(payload, dict):
                                emsg = None
                                etype = None
                                if isinstance(payload.get('error'), dict):
                                    etype = payload['error'].get('type')
                                    emsg = payload['error'].get('message')
                                if not emsg:
                                    emsg = payload.get('message')
                                message = self._format_error(status, etype, emsg, message)
                    except Exception:
                        pass

                message = self._format_error(status, None, None, message)
                warning(message)
                return

        except Exception as e:
            # Dependency/setup issues
            msg = self._format_error(None, None, None, str(e))
            warning(msg)
            return

    def beginGlobal(self):
        """Initialize the global filter state by loading dependencies and creating a Chat instance.

        Sets up the node configuration and establishes connection to Anthropic API.
        """
        from depends import depends  # type: ignore

        # Load the requirements
        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .anthropic import Chat

        # Get our bag
        bag = self.IEndpoint.endpoint.bag

        # Get this nodes config
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Get a chat to interface
        self._chat = Chat(self.glb.logicalType, config, bag)

    def endGlobal(self):
        """Clean up global filter state by clearing the chat instance.

        Called when the filter is being destroyed or reset.
        """
        self.chat = None

    def _format_error(self, status, etype, emsg, fallback: str) -> str:
        """
        Build a concise, consistent error string.

        - If structured fields are present, formats as: "Error <status>: <type> - <message>"
        - Otherwise returns the sanitized fallback text.
        - Always collapses whitespace for readability.

        Args:
            status: Optional HTTP status code
            etype: Optional provider error type string
            emsg: Optional provider human-readable message
            fallback: Raw message to use when structured fields are not available

        Returns:
            A single-line, human-readable error string.
        """
        parts: list[str] = []
        if status:
            parts.append(f'Error {status}:')
        if etype:
            parts.append(etype)
        if emsg:
            if etype:
                parts.append('-')
            parts.append(str(emsg))
        message = ' '.join(parts) if parts else fallback
        return re.sub(r'\s+', ' ', message).strip()
