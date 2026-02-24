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
import json
from rocketlib import IGlobalBase, warning, debug
from ai.common.config import Config
from ai.common.chat import ChatBase


class IGlobal(IGlobalBase):
    chat: ChatBase | None = None

    def validateConfig(self):
        """
        Save-time validation for Vertex LLM.

        - Loads deps
        - Builds Vertex client with current auth (User/Service)
        - Runs a tiny probe with retries disabled to keep validation quick
        - Surfaces provider errors clearly; no truncation
        """
        try:
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Build a lightweight client directly, using credentials from UI parameters
            from langchain_google_vertexai import ChatVertexAI
            from google.oauth2.service_account import Credentials as ServiceCredentials
            from google.oauth2.credentials import Credentials as UserCredentials

            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            parameters = self.glb.connConfig.get('parameters', {})

            # Model id: pass through exactly as provided (services.json now canonical)
            model_cfg = (config.get('model') or '').strip()

            # Minimal custom tokens lower bound (UI shows field only for custom)
            custom_total_tokens = config.get('modelTotalTokens')
            try:
                if custom_total_tokens is not None and int(custom_total_tokens) <= 0:
                    warning('Total tokens must be greater than 0 for custom models.')
                    return
            except Exception:
                pass

            project = config.get('project', None)
            location = config.get('location')

            # Credentials from UI
            auth_type = str(parameters.get('authType', '')).upper()
            credentials = None
            if auth_type == 'SERVICE':
                service_key_formdata = parameters.get('serviceKey')
                key_text = self._read_key(service_key_formdata)
                if key_text:
                    svc_info = json.loads(key_text)
                    # Fast local sanity: mismatch between UI project and service.json project_id
                    ui_project = config.get('project')
                    svc_project = svc_info.get('project_id')
                    if ui_project and svc_project and ui_project != svc_project:
                        warning(f"Project mismatch: UI '{ui_project}' vs service.json '{svc_project}'.")
                        return
                    credentials = ServiceCredentials.from_service_account_info(svc_info)
                    admin_email = parameters.get('adminEmail')
                    if admin_email:
                        credentials = credentials.with_subject(admin_email)

            elif auth_type == 'USER':
                # Read token payload from UI (supports base64 data-url or raw JSON)
                user_token_formdata = parameters.get('userToken')
                user_token_text = self._read_key(user_token_formdata)
                try:
                    cred_dict = json.loads(user_token_text) if user_token_text else {}
                except Exception:
                    cred_dict = {}
                token = cred_dict.get('access_token') or cred_dict.get('token')
                if token:
                    # Use a simple, non-refreshing bearer credential for validation speed
                    credentials = UserCredentials(token=token)

            llm = ChatVertexAI(model=model_cfg, temperature=0, max_output_tokens=1, project=project, location=location, credentials=credentials, max_retries=0)

            # Perform a minimal probe
            try:
                llm.invoke('Hi')
                return
            except Exception as e:
                try:
                    # Print full provider error for debug purposes (requested in PR)
                    debug(str(e).strip())
                except Exception:
                    pass
                warning(self._format_exception_message(e, location_hint=location))
                return

        except Exception as e:
            warning(str(e))
            return

    def beginGlobal(self):
        from depends import depends  # type: ignore

        # Load the requirements
        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .vertex import Chat

        # Get our bag
        bag = self.IEndpoint.endpoint.bag

        # Get this nodes config
        config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Get a chat to interface
        self._chat = Chat(self.glb.logicalType, config, bag, self.glb.connConfig.get('parameters', {}))

    def endGlobal(self):
        self.chat = None

    def _read_key(self, key_formdata: str) -> str | None:
        """
        Minimal helper to read secrets uploaded via UI.

        Supports base64 data-URL (application/json) or raw text.
        """
        try:
            if not key_formdata:
                return None
            import re
            from base64 import b64decode

            m = re.match(r'data:(.+?);name=(.+?);base64,(.+)', key_formdata)
            if m:
                mime_type, _, key_base64 = m.groups()
                if mime_type != 'application/json':
                    return None
                return b64decode(key_base64)
            return key_formdata
        except Exception:
            return None

    def _format_exception_message(self, err: Exception, location_hint: str | None = None) -> str:
        """
        Extract a concise gRPC provider message: "<code>: <message>".

        Uses err.code() and err.details() if available; otherwise falls back to str(err).
        """
        import re

        try:
            from http import HTTPStatus  # local import to avoid hard dependency at load time
        except Exception:
            HTTPStatus = None  # type: ignore

        str_err = str(err).strip()

        # Prefer numeric status from err.code() when available
        status: int | None = None
        code_attr = getattr(err, 'code', None)
        try:
            code_val = code_attr() if callable(code_attr) else code_attr
        except Exception:
            code_val = None
        if isinstance(code_val, int):
            status = code_val
        else:
            value = getattr(code_val, 'value', None)
            if isinstance(value, int):
                status = value

        # Extract a quoted message from details() when present
        message: str | None = None
        details_attr = getattr(err, 'details', None)
        try:
            details_val = details_attr() if callable(details_attr) else details_attr
        except Exception:
            details_val = None
        if details_val:
            m = re.search(r'message:\s*"([^"]+)"', str(details_val))
            if m:
                message = m.group(1)

        # Prefer an embedded "status: NNN" in str(err) (e.g., wrong location shows 404 even if code()==501)
        m = re.search(r'status:\s*(\d{3})', str_err)
        if m:
            embedded = int(m.group(1))
            if status is None or status != embedded:
                status = embedded

        # If we have only a status and no provider message, add standard phrase when available
        if message is None and isinstance(status, int) and HTTPStatus:
            try:
                message = HTTPStatus(status).phrase  # e.g., 404 -> 'Not Found'
            except Exception:
                pass

        # Append configured location hint for 404 when helpful and available (UI field, not provider parse)
        if isinstance(status, int) and status == 404 and location_hint:
            lower_msg = (message or '').lower()
            if 'location:' not in lower_msg and location_hint.lower() not in lower_msg:
                message = (message or 'Not Found') + f' (location: {location_hint})'

        if status is not None and message:
            return f'{status}: {message}'
        if message:
            return message
        return str_err or 'An unknown error occurred while contacting Vertex AI.'
