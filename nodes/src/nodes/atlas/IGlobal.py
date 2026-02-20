# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
from rocketlib import OPEN_MODE
from ai.common.transform import IGlobalTransform
from rocketlib import warning
from ai.common.config import Config


class IGlobal(IGlobalTransform):
    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            # Validate configuration only during config mode
            self.validateConfig()
            pass
        else:
            # Declare store
            from . import getStore

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            connConfig = self.getConnConfig()

            # Get the configuration
            Store = getStore()
            self.store = Store(self.glb.logicalType, connConfig, bag)

            # Get the info about our store
            database = self.store.database
            collection = self.store.collection
            host = self.store.host

            # Format it into a subKey
            subKey = f'{host}/{database}/{collection}'

            # Call the base
            super().beginGlobal(subKey)
            return

    def validateConfig(self):
        """
        Validate MongoDB config at save-time with optional connection testing.

        Performs lightweight format validation by default.
        No syntaxOnly arg per engine expectations.
        """
        try:
            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            host = config.get('host')
            api_key = config.get('apikey')
            database = config.get('database')
            collection = config.get('collection')

            # API Key validation - lightweight check
            if not api_key or not api_key.strip():
                warning('API key is required and cannot be empty')
                return

            # Host validation - format check only (no network call)
            if not host or not host.strip():
                warning('Host is required and cannot be empty')
                return

            host = host.strip()

            # Basic MongoDB URI format validation using regex
            import re

            mongodb_uri_pattern = r'^mongodb\+srv://[^:]+:[^@]+@[a-zA-Z0-9\-]+\.[a-zA-Z0-9]+\.mongodb\.net/\?.*'
            if not re.match(mongodb_uri_pattern, host):
                warning("Host must be a valid MongoDB URI (e.g., 'mongodb+srv://cluster.example.mongodb.net')")
                return

            # Database name validation - format check only
            if not database or not database.strip():
                warning('Database name is required and cannot be empty')
                return

            database = database.strip()

            # MongoDB database name restrictions - no network calls
            invalid_chars = ['/', '\\', ' ', '"', '$', '*', '<', '>', ':', '|', '?']
            if any(char in database for char in invalid_chars):
                warning(f'Database name contains invalid characters. Avoid: {", ".join(invalid_chars)}')
                return

            if len(database) > 64:
                warning('Database name must be 64 characters or less')
                return

            # Collection name validation - format check only
            if not collection or not collection.strip():
                warning('Collection name is required and cannot be empty')
                return

            collection = collection.strip()

            # MongoDB collection name restrictions - no network calls
            if collection.startswith('system.'):
                warning("Collection name cannot start with 'system.' (reserved prefix)")
                return

            if '$' in collection:
                warning("Collection name cannot contain '$' character")
                return

            if len(collection) > 120:
                warning('Collection name must be 120 characters or less')
                return

        except Exception as e:
            msg = str(e)
            warning(msg)

    def endGlobal(self):
        # Release the database connection
        self.store = None
