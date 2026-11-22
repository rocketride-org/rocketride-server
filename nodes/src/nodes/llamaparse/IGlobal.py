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
Global handler for the LlamaParse node.

The parse configuration (simple or advanced, the parse mode, the vision
model, the prompt fragment, the spreadsheet switch, the raw advanced block)
is each call's. ``LlamaParse`` binds those values at construction, so the
control keeps a small bounded cache of clients keyed by the call's settings,
built on first use; the API key and the parse lock are the control's.
"""

import os
import threading
from collections import OrderedDict
from typing import TYPE_CHECKING, Any, Mapping

from rocketlib import IGlobalBase, debug, warning

if TYPE_CHECKING:
    from .parser import Parser

# ==== Constants ==================================================================

#: The most parse configurations one control keeps a client for; the least recently used goes first.
MAX_PARSERS = 4


class IGlobal(IGlobalBase):
    """Global state: the API key, the parse lock and the LlamaParse clients the calls have asked for."""

    # Private variables for internal use
    _parserLock: threading.Lock

    def beginGlobal(self):
        """Install the dependencies and keep the account key; the clients are built per configuration."""
        debug('LlamaParse Global: Starting global initialization')
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

        # The resolved config: the API key is required by the schema
        self._api_key = self.config.api_key

        # Parsing is serialised on the parse lock; the cache has its own
        self._parserLock = threading.Lock()
        self._cacheLock = threading.Lock()
        self._parsers = OrderedDict()

        # Provenance advisory (issue #1406): this node emits flattened Markdown and
        # does not preserve cell-level provenance. Warn once at init so pipeline
        # authors building audit-grade extraction see it in the run logs. The
        # structure-preserving alternative is the datalab_parse node (#1425).
        warning(
            'LlamaParse Global: this node flattens documents to Markdown and does not preserve '
            'cell-level provenance (page boundaries, bbox coordinates, or the table-HTML cell grid). '
            'It is not suitable for audit-grade or provenance-bearing extraction. For structure-preserving '
            'parsing (HTML + tables with page/coordinates), use the datalab_parse node.'
        )

    def parser_for(self, settings: Mapping[str, Any]) -> 'Parser':
        """
        The parser for one call's parse configuration, its LlamaParse client built on first use.

        Args:
            settings: The call's resolved settings (the mode selector decides which leaves are present).

        Returns:
            The cached or newly built ``Parser``.

        Raises:
            RuntimeError: The call's advanced block is not a JSON object, or the client cannot be built.
        """
        from llama_parse import LlamaParse

        from .parser import Parser, llama_parse_args

        key = tuple(sorted((name, repr(value)) for name, value in settings.items() if name != 'api_key'))
        with self._cacheLock:
            parser = self._parsers.get(key)
            if parser is not None:
                self._parsers.move_to_end(key)
                return parser

            parser_args = llama_parse_args(settings, self._api_key)
            debug(f'LlamaParse Global: Creating LlamaParse instance with args: {list(parser_args)}')
            try:
                llama_parse = LlamaParse(**parser_args)
            except Exception as e:
                raise RuntimeError(f'LlamaParse Global: Error creating LlamaParse instance: {e}') from e

            # The parser holds this control's LlamaParse client: nothing is shared
            # through the endpoint bag, which every control of the engine sees
            parser = Parser(settings.node.provider, settings, llama_parse)
            self._parsers[key] = parser
            while len(self._parsers) > MAX_PARSERS:
                self._parsers.popitem(last=False)
            return parser

    def endGlobal(self):
        """Drop every client and the account key."""
        debug('LlamaParse Global: Starting global cleanup')
        self._parsers = None
        self._api_key = ''
