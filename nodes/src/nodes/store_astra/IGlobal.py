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
from typing import Any, Dict

from ai.common.store import StoreGlobalBase


class IGlobal(StoreGlobalBase):
    serverName: str = 'astra'

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so config mode never loads the driver."""
        from .astra_db import Store

        return Store(logical_type, conn_config, bag)

    def _sub_key(self) -> str:
        """Return the transform sub-key: endpoint-or-host/collection."""
        store = self.store
        collection = getattr(store, 'collection_name', getattr(store, 'collection', ''))

        # Prefer cloud endpoint if present; otherwise fall back to host[:port]; otherwise logical type
        if getattr(store, 'api_endpoint', ''):
            identifier = store.api_endpoint.rstrip('/')
        elif getattr(store, 'host', ''):
            port = getattr(store, 'port', None)
            identifier = f'{store.host}:{port}' if port else store.host
        else:
            identifier = self.glb.logicalType

        return f'{identifier}/{collection}'

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Astra validates the collection name inside Store.__init__; no save-time probe here."""
        return
