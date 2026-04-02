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
from rocketlib import IGlobalBase, warning
from ai.common.config import Config
from ai.common.chat import ChatBase


class IGlobal(IGlobalBase):
    chat: ChatBase | None = None

    def validateConfig(self):
        """Validate Amazon Bedrock config at save-time using a minimal API probe.

        - No syntaxOnly arg per engine expectations
        - Avoid hardcoded warnings; sanitize and surface provider errors clearly.
        """
        # Load dependencies first
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        try:
            # Import after dependencies are loaded
            from langchain_aws import ChatBedrock

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            accessKey = config.get('accessKey')
            secretKey = config.get('secretKey')
            region = config.get('region')
            model = config.get('model')
            modelTotalTokens = config.get('modelTotalTokens')

            # Lower-bound token check (UI shows tokens only for custom models)
            if modelTotalTokens is not None and modelTotalTokens <= 0:
                warning('Token limit must be greater than 0 for custom models')
                return

            # Model identifier sanity: must be provider-prefixed ID or ARN
            # Examples: "anthropic.claude-3-7-sonnet-20250219-v1:0" or "arn:aws:bedrock:..."
            if model:
                has_region_prefix = bool(re.match(r'^(us\.|eu\.|apac\.)', model))
                has_provider_prefix = bool(re.match(r'^[a-z0-9]+\.', model))
                is_arn = model.startswith('arn:')
                if not (is_arn or has_provider_prefix or has_region_prefix):
                    warning("Enter a full Bedrock model identifier (e.g., 'anthropic.claude-3-7-sonnet-20250219-v1:0') or an ARN")
                    return

            # Test AWS credentials and model availability using a minimal call
            try:
                # Add region prefix when not already present or ARN
                test_model = model or ''
                if test_model and not test_model.startswith('arn:') and not re.match(r'^(us\.|eu\.|apac\.)', test_model):
                    model_prefix = 'us.'
                    if region and region[:2] == 'eu':
                        model_prefix = 'eu.'
                    elif region and region[:2] == 'ap':
                        model_prefix = 'apac.'
                    test_model = model_prefix + test_model

                # Test with minimal API call (limit output to minimal to avoid spend)
                llm = ChatBedrock(model=test_model, aws_access_key_id=accessKey, aws_secret_access_key=secretKey, region=region, temperature=0)

                # Try a minimal test call
                _ = llm.invoke('Hi')

            except Exception as e:
                # Prefer AWS/botocore structured exceptions first
                try:
                    from botocore.exceptions import (
                        ClientError,
                        BotoCoreError,
                        NoCredentialsError,
                        PartialCredentialsError,
                        EndpointConnectionError,
                        ReadTimeoutError,
                        ConnectTimeoutError,
                        SSLError,
                        ParamValidationError,
                    )
                except Exception:
                    ClientError = BotoCoreError = NoCredentialsError = PartialCredentialsError = EndpointConnectionError = ReadTimeoutError = ConnectTimeoutError = SSLError = ParamValidationError = type('E', (), {})  # type: ignore

                # Re-raise into typed branches if matches
                if isinstance(e, ClientError):
                    resp = getattr(e, 'response', {}) or {}
                    meta = resp.get('ResponseMetadata', {}) if isinstance(resp, dict) else {}
                    status = meta.get('HTTPStatusCode')
                    err = resp.get('Error', {}) if isinstance(resp, dict) else {}
                    code = err.get('Code') if isinstance(err, dict) else None
                    emsg = err.get('Message') if isinstance(err, dict) else None
                    message = self._format_error(status, code, emsg, str(e))
                    # Bedrock surfaces a ValidationException when region is incorrect. Incorrect keys will surface different exceptions.
                    if status == 400 and str(code) == 'ValidationException':
                        message = f'{message}.. Verify the AWS region matches your account'
                    warning(message)
                    return
                if isinstance(e, (ParamValidationError, NoCredentialsError, PartialCredentialsError, EndpointConnectionError, ReadTimeoutError, ConnectTimeoutError, SSLError, BotoCoreError)):
                    message = self._format_error(None, None, None, str(e))
                    warning(message)
                    return

                # Fallback: generic sanitization for unexpected error shapes
                raw = str(e)
                message = raw.strip()

                # Try to extract provider message from JSON if present
                try:
                    json_str = None
                    m = re.search(r'\{.*\}', message, re.DOTALL)
                    if m:
                        json_str = m.group(0)
                    elif message.startswith('{') and message.endswith('}'):
                        json_str = message

                    if json_str:
                        # Make it JSON-friendly if single quoted
                        if "'" in json_str and '"' not in json_str:
                            json_str = json_str.replace("'", '"')
                        data = json.loads(json_str)
                        if isinstance(data, dict):
                            extracted = None
                            # Common keys
                            for key in ['message', 'Message', 'errorMessage', 'detail']:
                                if key in data and isinstance(data[key], str):
                                    extracted = data[key]
                                    break
                            if not extracted and isinstance(data.get('error'), dict):
                                err = data['error']
                                for key in ['message', 'Message', 'detail']:
                                    if key in err and isinstance(err[key], str):
                                        extracted = err[key]
                                        break
                            if extracted:
                                message = extracted
                except Exception:
                    pass

                # AWS style: "An error occurred (Type) when calling the InvokeModel operation: msg"
                m = re.search(r'\(([^)]+)\).*?:\s*(.*)$', raw, re.IGNORECASE | re.DOTALL)
                if m:
                    err_type = m.group(1).strip()
                    err_msg = re.sub(r'\s+', ' ', m.group(2)).strip()
                    if err_msg:
                        message = f'{err_type} - {err_msg}'

                message = self._format_error(None, None, None, message)
                warning(message)

        except Exception as e:
            msg = str(e)
            # Pydantic/validation-style noise reduction
            m = re.search(r'Error raised by service:\s*(.*)$', msg, re.DOTALL)
            if m:
                msg = m.group(1)
            msg = self._format_error(None, None, None, msg)
            warning(msg)

    def beginGlobal(self):
        """Initialize global filter state by loading deps and creating a Chat instance.

        Sets up configuration and Bedrock client used by the pipeline.
        """
        from depends import depends  # type: ignore

        # Load the requirements
        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        from .bedrock import Chat

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
        self._chat = None

    def _format_error(self, status, etype, emsg, fallback: str) -> str:
        """
        Build a concise, consistent error string.

        - If structured fields are present, formats as: "Error <status>: <type> - <message>"
        - Otherwise returns the sanitized fallback text.
        - Always collapses whitespace for readability.

        Args:
            status: Optional HTTP status code
            etype: Optional provider error type or code
            emsg: Optional provider human-readable message
            fallback: Raw message to use when structured fields are not available

        Returns:
            A single-line, human-readable error string.
        """
        parts: list[str] = []
        if status:
            parts.append(f'Error {status}:')
        if etype:
            parts.append(str(etype))
        if emsg:
            if etype:
                parts.append('-')
            parts.append(str(emsg))
        message = ' '.join(parts) if parts else fallback
        return re.sub(r'\s+', ' ', message).strip()
