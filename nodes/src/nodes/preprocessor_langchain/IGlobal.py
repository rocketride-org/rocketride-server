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

"""
Global handler for the LangChain text splitter node.

The splitter class, its options and the chunk size are per-call parameters.
Most splitters are cheap to build, but the spaCy splitter loads a language
pipeline and the NLTK one checks its tokenizer data, so the control keeps a
small bounded cache of built splitters keyed by the call's settings: calls
that split the same way share one, and a new combination builds its own.
"""

import threading
from collections import OrderedDict
from typing import Any, Mapping

from rocketlib import IGlobalBase

# ==== Constants ==================================================================

#: The most splitters one control keeps; the least recently used is dropped first.
MAX_SPLITTERS = 8


class IGlobal(IGlobalBase):
    """IGlobal for the LangChain splitter node: the splitters calls have asked for, keyed by their settings."""

    def beginGlobal(self):
        """Create the empty splitter cache and its lock."""
        self._lock = threading.Lock()
        self._splitters = OrderedDict()

    def preprocessor_for(self, settings: Mapping[str, Any]):
        """
        The splitter for one call's settings, built on first use.

        Args:
            settings: The call's resolved settings (splitter, mode, sizes, the splitter's options).

        Returns:
            The cached or newly built ``PreProcessor``.
        """
        # Imported here: the module installs langchain when it loads
        from .langchain import PreProcessor

        key = tuple(sorted((name, repr(value)) for name, value in settings.items()))
        with self._lock:
            preprocessor = self._splitters.get(key)
            if preprocessor is not None:
                self._splitters.move_to_end(key)
                return preprocessor

            # Build the new one, then drop the least recently used past the bound
            preprocessor = PreProcessor(settings.node.provider, settings)
            self._splitters[key] = preprocessor
            while len(self._splitters) > MAX_SPLITTERS:
                self._splitters.popitem(last=False)
            return preprocessor

    def endGlobal(self):
        """Drop every cached splitter and the lock."""
        self._splitters = None
        self._lock = None
