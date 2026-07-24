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
import re
from typing import Any, Dict

from ai.common.store import StoreGlobalBase
from rocketlib import warning


class IGlobal(StoreGlobalBase):
    serverName: str = 'atlas'

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the driver's Store, resolved lazily via the package hook so config mode never loads the driver."""
        from . import getStore

        Store = getStore()
        return Store(logical_type, conn_config, bag)

    def _sub_key(self) -> str:
        """Return the transform sub-key: host/database/collection."""
        return f'{self.store.host}/{self.store.database}/{self.store.collection}'

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """
        Validate MongoDB config at save-time with lightweight format checks.

        Performs format validation only (no network call): API key present,
        host matches the Atlas ``mongodb+srv`` URI shape, and database/collection
        names respect MongoDB naming restrictions.
        """
        try:
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
            mongodb_uri_pattern = r'^mongodb\+srv://[^:]+:[^@]+@[a-zA-Z0-9\-]+\.[a-zA-Z0-9]+\.mongodb\.net/\?.*'
            if not re.match(mongodb_uri_pattern, host):
                warning(
                    'Host must be a valid MongoDB SRV URI '
                    "(e.g., 'mongodb+srv://user:pass@cluster.abc12.mongodb.net/?retryWrites=true')"
                )
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
