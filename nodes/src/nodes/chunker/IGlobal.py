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
from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config

from .chunker_strategies import ChunkingStrategy, RecursiveCharacterChunker, SentenceChunker, TokenChunker


# Strategy name → class mapping
_STRATEGY_MAP = {
    'recursive': RecursiveCharacterChunker,
    'sentence': SentenceChunker,
    'token': TokenChunker,
}


class IGlobal(IGlobalBase):
    strategy: ChunkingStrategy | None = None

    def validateConfig(self):
        """Validate that tiktoken dependency is available (only needed for token strategy)."""
        try:
            from depends import depends

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)
        except Exception as e:
            warning(str(e))

    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the strategy for that
            pass
        else:
            # Get this node's config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

            # Read strategy parameters from config
            strategy_name = config.get('strategy', 'recursive')
            chunk_size = int(config.get('chunk_size', 1000))
            chunk_overlap = int(config.get('chunk_overlap', 200))
            encoding_name = config.get('encoding_name', 'cl100k_base')

            # Build the appropriate strategy
            if strategy_name == 'token':
                self.strategy = TokenChunker(
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                    encoding_name=encoding_name,
                )
            elif strategy_name == 'sentence':
                self.strategy = SentenceChunker(
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                )
            else:
                # Default to recursive character chunker
                self.strategy = RecursiveCharacterChunker(
                    chunk_size=chunk_size,
                    chunk_overlap=chunk_overlap,
                )

    def endGlobal(self):
        # Release the strategy
        self.strategy = None
