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

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    _reranker = None

    def _ensure_dependencies(self):
        """Install the real SDK unless the test runner has injected mocks."""
        if os.environ.get('ROCKETRIDE_MOCK'):
            return

        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

    def beginGlobal(self):
        """Create the rerank client from the resolved config (model, top_n, min_score, apikey).

        The schema pins the model of the named entries, requires a name for
        the custom one and requires the key, so the client gets a usable config.
        """
        self._ensure_dependencies()

        # Import the rerank client
        from .rerank_client import RerankClient

        bag = self.IEndpoint.endpoint.bag
        self._reranker = RerankClient(self.glb.logicalType, self.config, bag)

    def endGlobal(self):
        self._reranker = None
