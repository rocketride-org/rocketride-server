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
Vertex binding for the ChatLLM.
"""

from base64 import b64decode
import json
from enum import Enum
from typing import Any, Dict
import re

from ai.common.chat import ChatBase
from ai.common.config import Config
from langchain_google_vertexai import ChatVertexAI

from google.oauth2.service_account import Credentials as ServiceCredentials
from google.auth.transport.requests import Request as AuthRequest
from nodes.google.client.external_refresh_credentials import ExternalRefreshCredentials
from datetime import datetime


class AuthType(Enum):
    NONE = 0
    SERVICE = 1
    USER = 2


class Chat(ChatBase):
    """
    Create an vertex chat bot.
    """

    """
    Privates
    """
    _llm: ChatVertexAI

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any], parameters: Dict[str, Any] = None):
        """
        Initialize the Vertex AI chat wrapper and configure authentication, project/location, and the underlying ChatVertexAI model.
        
        Sets up credentials based on parameters['authType'] (supports NONE, SERVICE, USER), initializes self._llm as a ChatVertexAI instance (including model, temperature, credentials, project, location, and max_output_tokens), and stores this Chat instance into bag['chat'].
        
        Parameters:
            provider: Identifier of the provider node.
            connConfig: Node connection configuration dictionary (used to read project and location).
            bag: Mutable container shared across the node where this Chat instance will be saved under the 'chat' key.
            parameters: Optional runtime parameters that may include authentication payloads and related settings (e.g., 'authType', 'serviceKey', 'adminEmail', 'userToken').
        
        Raises:
            Exception: If an unknown authentication type is specified in parameters['authType'].
        """
        # Init the base
        super().__init__(provider, connConfig, bag)

        # Get the nodes configuration
        config = Config.getNodeConfig(provider, connConfig)

        # Get auth type
        auth_type = AuthType[parameters.get('authType').upper()]
        credentials = None

        if auth_type == AuthType.SERVICE:
            admin_email = parameters.get('adminEmail')
            service_key_formdata = parameters.get('serviceKey')
            service_key = self.read_key(service_key_formdata)

            # Create credentals for GCP service account
            service_credentals = ServiceCredentials.from_service_account_info(json.loads(service_key))

            # Impersonate GCP service as G Suite admin user
            credentials = service_credentals.with_subject(admin_email)

        elif auth_type == AuthType.USER:
            user_token_formdata = parameters.get('userToken')
            user_token = self.read_key(user_token_formdata)

            # Create the client and connect to authenticate google account with specified scopes
            if user_token:
                credentials_dict = json.loads(user_token)
                token = credentials_dict.get('access_token')
                expiry_ts = credentials_dict.get('expiry_date')
                expiry_dt = datetime.fromtimestamp(expiry_ts / 1000) if expiry_ts else None
                credentials = ExternalRefreshCredentials(token=token, refresh_token=credentials_dict.get('refresh_token'), expiry=expiry_dt, scopes=credentials_dict.get('scopes'), oauth_server_url=credentials_dict.get('oauth_server_url'))

            if not credentials or not credentials.valid or (credentials.expiry and credentials.expiry < datetime.now()):
                if credentials and (credentials.expiry and credentials.expiry < datetime.now()) and credentials.refresh_token:
                    # Refresh user credentals
                    credentials.refresh(AuthRequest())
        else:
            raise Exception(f'Unknown authentication type: {auth_type}')

        # Get the project name, don't save it
        project = config.get('project', None)

        # Get the location, don't save it
        location = config.get('location', 'us-central1')

        # Pass-through canonical model IDs from configuration
        vertex_model_name = self._model

        # Initialize LLM using unified ChatVertexAI for all models
        self._llm = ChatVertexAI(model=vertex_model_name, temperature=0, credentials=credentials, project=project, location=location, max_output_tokens=self._modelOutputTokens)

        # Save our chat class into the bag
        bag['chat'] = self

    @staticmethod
    def read_key(key_formdata: str) -> str:
        # Parse the contents of a file uploaded using a web form
        if key_formdata:
            # In some cases the web form sends content in the following base64 format
            if key_match := re.match(r'data:(.+?);name=(.+?);base64,(.+)', key_formdata):
                mime_type, _, key_base64 = key_match.groups()
                if mime_type != 'application/json':
                    raise Exception('Invalid Secret: The uploaded file is not a valid JSON secret file.')
                return b64decode(key_base64)
            # In other cases as raw text context
            else:
                return key_formdata
        else:
            return None
