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
from typing import Any, Optional
from rocketlib import IGlobalBase

from .OpenAIEmbeddingWrapper import OpenAIEmbeddingWrapper


# ----------------------------------
# Define the IGlobal C++ will call
# ----------------------------------
class IGlobal(IGlobalBase):
    embedding: Optional[Any] = None

    # ----------------------------------
    # Common methods
    # ----------------------------------
    def beginGlobal(self):
        """Build the OpenAI embedding client from the resolved config.

        The API key is a required leaf, so it is set by the time this runs; the
        key arrives through the node config (a ${ROCKETRIDE_EMBEDDING_OPENAI_APIKEY}
        reference resolved per control). The model is each call's: the wrapper
        keeps one embedder per model a call asks for.
        """
        bag = self.IEndpoint.endpoint.bag
        self.embedding = OpenAIEmbeddingWrapper(self.config.node.provider, self.config, bag)

    def endGlobal(self):
        # Destroy the embedding module
        self.embedding = None
