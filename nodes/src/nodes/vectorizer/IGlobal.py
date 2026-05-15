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

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.store import DocumentStoreBase, getStore
from ai.common.embedding import EmbeddingBase, getEmbedding
from ai.common.preprocessor import PreProcessorBase, getPreprocessor
from ai.common.config import Config


class IGlobal(IGlobalBase):
    preprocessor: PreProcessorBase | None = None
    embedding: EmbeddingBase | None = None
    store: DocumentStoreBase | None = None

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            pass
        else:
            import os
            from depends import depends  # type: ignore

            # Load the requirements
            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)
            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # If we are running a transform, we need the preprocessor
            # and the embedding
            config = self.glb.connConfig

            # If we are using an embedding
            if 'preprocessor' in config:
                providerPreprocessor, configPreprocessor = Config.getMultiProviderConfig(
                    'preprocessor', self.glb.connConfig
                )
                self.preprocessor = getPreprocessor(providerPreprocessor, configPreprocessor, bag)

            # If we are using an embedding
            if 'embedding' in config:
                providerEmbedding, configEmbedding = Config.getMultiProviderConfig('embedding', self.glb.connConfig)
                self.embedding = getEmbedding(providerEmbedding, configEmbedding, bag)

            # If we are using a store
            if 'store' in config:
                providerStore, configStore = Config.getMultiProviderConfig('store', self.glb.connConfig)
                self.store = getStore(providerStore, configStore, bag)

            # TODO: Add support for remote here
            return

    def endGlobal(self):
        self.preprocessor = None
        self.embedding = None
        self.store = None
