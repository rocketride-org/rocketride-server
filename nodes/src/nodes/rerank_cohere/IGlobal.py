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
from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config
import os


class IGlobal(IGlobalBase):
    _reranker = None

    def _ensure_dependencies(self):
        """Install the real SDK unless the test runner has injected mocks."""
        if os.environ.get('ROCKETRIDE_MOCK'):
            return

        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

    def validateConfig(self):
        """
        Validate the configuration for the Cohere Rerank node.

        Only checks presence and format of required fields.  Does NOT make
        a live API call — a Cohere outage or rate-limit at config time would
        otherwise surface a misleading error to the user.
        """
        try:
            self._ensure_dependencies()

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model', 'rerank-english-v3.0')

            if not isinstance(apikey, str) or not apikey.strip():
                warning('Cohere API key is required')
                return

            if not isinstance(model, str) or not model.strip():
                warning('Cohere model name must not be empty')
                return

        except Exception as e:
            warning(str(e))
            return

    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            self._ensure_dependencies()

            # Import the rerank client
            from .rerank_client import RerankClient

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            try:
                self._reranker = RerankClient(self.glb.logicalType, config, bag)
            except ValueError as e:
                warning(f'Cohere Rerank configuration error for {self.glb.logicalType}: {e}')
                self._reranker = None

    def endGlobal(self):
        self._reranker = None
