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


class IGlobal(IGlobalTransform):
    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition - even though
            from .chroma import Store

            # Declare store
            self.store: Store | None = None

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            connConfig = self.getConnConfig()

            # Create the loader
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

    def endGlobal(self):
        # Release the index and embeddings
        self.store = None
