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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------

import os
import re

from .pinecone import Store

from rocketlib import OPEN_MODE, warning
from ai.common.transform import IGlobalTransform
from ai.common.config import Config

HTTP_BODY_MARKER = 'http response body:'


class IGlobal(IGlobalTransform):
    # Class attributes - properly defined for IDE support
    store: 'Store | None' = None

    def beginGlobal(self):
        """
        Initialize Pinecone store connection and set up global resources.

        Creates store instance and configures subkey for the base transform.
        """
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition - even though
            from .pinecone import Store

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            connConfig = self.getConnConfig()

            # Get the configuration
            self.store = Store(self.glb.logicalType, connConfig, bag)

            # Get the info about our store
            collection = self.store.collection
            host = self.store.host
            port = self.store.port

            # Format it into a subKey
            subKey = f'{host}/{port}/{collection}'

            # Call the base
            super().beginGlobal(subKey)
            return

    def validateConfig(self):
        """
        Validate the configuration for Pinecone vector store.

        Comprehensive validation: API key, collection name, index existence, compatibility.
        """
        try:
            # Load dependencies first
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Import pinecone after dependencies are loaded
            # Use HTTP client for validation to surface structured ApiException with status/body
            from pinecone import Pinecone

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            collection = config.get('collection')
            mode = config.get('mode')  # pod-based or serverless-dense

            # Step 1: Collection Name Validation (per Pinecone docs)
            # Gather all violations and report them together to the user
            violations: list[str] = []

            # Normalize and guard
            if not collection:
                violations.append('is missing')
            else:
                # Check collection name format (lowercase, alphanumeric, hyphens only)
                if not re.match(r'^[a-z0-9-]+$', collection):
                    violations.append('must use only lowercase letters, numbers, and hyphens')

                # Check for leading/trailing hyphens
                if collection.startswith('-') or collection.endswith('-'):
                    violations.append('cannot start or end with a hyphen')

                # Check for consecutive hyphens
                if '--' in collection:
                    violations.append("cannot contain consecutive hyphens ('--')")

                # Check collection name length (Pinecone limit)
                if len(collection) > 45:
                    violations.append('is too long (max 45 characters)')

            if violations:
                name = collection or '<empty>'
                warning(f"Collection name '{name}' is invalid: " + '; '.join(violations))
                return

            # Step 2: API Authentication and Collection Check
            # Initialize client and list indexes
            client = Pinecone(api_key=apikey)
            index_list = client.list_indexes()

            # Check if collection exists and validate mode compatibility
            existing_collection = next((index for index in index_list if index.get('name') == collection), None)
            if existing_collection:
                is_serverless = 'serverless' in existing_collection.get('spec', {})
                if mode == 'serverless-dense' and not is_serverless:
                    warning(
                        f"Collection '{collection}' exists and is pod-based but you selected serverless mode. Please select 'Pinecone Pod-Based Index' to use this collection"
                    )
                    return
                if mode == 'pod-based' and is_serverless:
                    warning(
                        f"Collection '{collection}' exists and is serverless but you selected pod-based mode. Please select 'Pinecone Serverless Dense Index' to use this collection"
                    )
                    return

        except Exception as e:
            # Prefer SDK/HTTP structured attributes if available
            try:
                from pinecone.core.client.exceptions import ApiException as _ApiException  # type: ignore

                if isinstance(e, _ApiException):
                    status = getattr(e, 'status', None)
                    body = getattr(e, 'body', '') or getattr(e, 'reason', '') or str(e)
                    body = body.strip()
                    message = f'Error {status}: {body}' if status else body
                    warning(message)
                    return
            except Exception:
                pass

            status = getattr(e, 'status', None)
            body_attr = getattr(e, 'body', None) or getattr(e, 'reason', None)
            if status is not None or body_attr:
                body = (body_attr or str(e)).strip()
                message = f'Error {status}: {body}' if status else body
                warning(message)
                return

            # Fallback: extract after HTTP_BODY_MARKER
            error_str = str(e)
            lower = error_str.lower()
            idx = lower.find(HTTP_BODY_MARKER)
            if idx != -1:
                body = error_str[idx + len(HTTP_BODY_MARKER) :].strip()
                warning(body)
            else:
                warning(error_str.strip())
            return

    def endGlobal(self):
        """
        Clean up global resources and release Pinecone store connection.
        """
        # Release the index and embeddings
        self.store = None
