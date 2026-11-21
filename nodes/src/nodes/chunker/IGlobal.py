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
"""
Global handler for the Text Chunker node.

The strategy, the sizes and the token encoding are per-call parameters the
instance reads from its settings and builds its own (cheap) strategy from.
The control keeps only the tokenizers a call has asked for, keyed by encoding
name: loading a tiktoken encoding reads its BPE ranks, so calls that share an
encoding share it. The schema offers four encodings, which bounds the cache.
"""

import os
import threading

from rocketlib import IGlobalBase


class IGlobal(IGlobalBase):
    """IGlobal for the Text Chunker node: the tokenizer cache, keyed by encoding name."""

    def beginGlobal(self):
        """Create the empty tokenizer cache and its lock."""
        self._lock = threading.Lock()
        self._encoders = {}

    def encoder_for(self, encoding_name: str):
        """
        The tiktoken encoding of one name, loaded on first use.

        Args:
            encoding_name: The call's tiktoken encoding name (one of the schema's options).

        Returns:
            The ``tiktoken.Encoding``.
        """
        with self._lock:
            encoder = self._encoders.get(encoding_name)
            if encoder is None:
                # The tokenizer is a run-path dependency: install it where it is first used
                from depends import depends  # type: ignore

                depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

                import tiktoken

                encoder = tiktoken.get_encoding(encoding_name)
                self._encoders[encoding_name] = encoder
            return encoder

    def endGlobal(self):
        """Release the cached tokenizers."""
        self._encoders = None
        self._lock = None
