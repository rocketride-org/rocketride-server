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

from .chunker_strategies import ChunkingStrategy, SentenceChunker, TokenChunker


class IGlobal(IGlobalBase):
    strategy: ChunkingStrategy | None = None

    def beginGlobal(self):
        """Build the configured chunking strategy from the resolved config.

        The resolver has applied the selected strategy's defaults and bounded
        the sizes; the one cross-field rule (overlap below size) is checked here.

        Raises:
            ValueError: The overlap is not smaller than the chunk size.
        """
        config = self.config
        chunk_size = config.chunk_size
        chunk_overlap = config.chunk_overlap

        if chunk_overlap >= chunk_size:
            raise ValueError(f'chunk_overlap ({chunk_overlap}) must be less than chunk_size ({chunk_size})')

        if config.strategy == 'token':
            # The tokenizer is a run-path dependency: install it where it is used
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            self.strategy = TokenChunker(
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
                encoding_name=config.encoding_name,
            )
        else:
            self.strategy = SentenceChunker(
                chunk_size=chunk_size,
                chunk_overlap=chunk_overlap,
            )

    def endGlobal(self):
        """Release the configured chunking strategy."""
        # Release the strategy
        self.strategy = None
