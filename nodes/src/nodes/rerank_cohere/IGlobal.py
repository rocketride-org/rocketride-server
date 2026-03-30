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
import re


class IGlobal(IGlobalBase):
    _reranker = None

    def validateConfig(self):
        """
        Validate the configuration for the Cohere Rerank node.
        """
        try:
            # Load dependencies
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            from cohere import ClientV2 as CohereClient
            from cohere.errors import UnauthorizedError, BadRequestError

            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            apikey = config.get('apikey')
            model = config.get('model', 'rerank-v3.5')

            if not apikey:
                warning('Cohere API key is required')
                return

            # Validate the API key with a minimal rerank call
            try:
                client = CohereClient(api_key=apikey)
                client.rerank(
                    model=model,
                    query='test',
                    documents=['test document'],
                    top_n=1,
                )
            except UnauthorizedError as e:
                message = re.sub(r'\s+', ' ', str(e)).strip()
                if len(message) > 500:
                    message = message[:500].rstrip() + '...'
                warning(message)
                return
            except BadRequestError as e:
                message = re.sub(r'\s+', ' ', str(e)).strip()
                if len(message) > 500:
                    message = message[:500].rstrip() + '...'
                warning(message)
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
            # Ensure cohere dependency is installed before importing rerank_client
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Import the rerank client
            from .rerank_client import RerankClient

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            self._reranker = RerankClient(self.glb.logicalType, config, bag)

    def endGlobal(self):
        self._reranker = None
