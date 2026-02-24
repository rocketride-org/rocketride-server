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

# ------------------------------------------------------------------------------
# This class controls the data shared between all threads for the task
# ------------------------------------------------------------------------------
from rocketlib import OPEN_MODE
from ai.common.transform import IGlobalTransform


class IGlobal(IGlobalTransform):
    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition - even though
            from .astra_db import Store

            # Declare store
            self.store: Store | None = None

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            connConfig = self.getConnConfig()

            # Get the configuration
            self.store = Store(self.glb.logicalType, connConfig, bag)
            collection = getattr(self.store, 'collection_name', getattr(self.store, 'collection', ''))

            # Prefer cloud endpoint if present; otherwise fall back to host[:port]; otherwise logical type
            if hasattr(self.store, 'api_endpoint') and self.store.api_endpoint:
                identifier = self.store.api_endpoint.rstrip('/')
            elif hasattr(self.store, 'host') and getattr(self.store, 'host', ''):
                port = getattr(self.store, 'port', None)
                identifier = f'{self.store.host}:{port}' if port else self.store.host
            else:
                identifier = self.glb.logicalType

            subKey = f'{identifier}/{collection}'

            # Call the base
            super().beginGlobal(subKey)
            return

    def endGlobal(self):
        # Release the index and embeddings
        self.store = None
