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
# Unified IGlobal for Elasticsearch and OpenSearch index search nodes.
#
# The backend (elasticsearch or opensearch) is the registration the node runs
# under: both share the same search-option handling and lifecycle.
# ------------------------------------------------------------------------------
from __future__ import annotations

import os
from typing import Mapping

from rocketlib import IGlobalBase, debug

from ai.common.config import check_credential_resolved

from .backend import normalize_opensearch_host, resolve_backend
from .constants import BACKEND_ELASTICSEARCH, BACKEND_OPENSEARCH, DEFAULT_HIGHLIGHT_FRAGMENT_SIZE, MODE_VSTORE


class IGlobal(IGlobalBase):
    """
    Global state for the index_search node.

    Holds either an Elasticsearch Store or an OpenSearch client, plus shared
    search options (match operator, highlight, etc.). The backend follows the
    registration the node runs under.
    """

    backend: str = ''
    store = None  # Set when backend == BACKEND_ELASTICSEARCH
    client = None  # Set when backend == BACKEND_OPENSEARCH

    search_enabled: bool = False
    search_match_operator: str = 'or'
    search_exact_slop: int = 0
    search_highlight_enabled: bool = False
    search_highlight_fragment_size: int = DEFAULT_HIGHLIGHT_FRAGMENT_SIZE

    mode: str = MODE_VSTORE  # MODE_INDEX or MODE_VSTORE

    collection: str = ''
    host: str = ''
    vector_dim: int = 0
    score: float = 0.0

    def beginGlobal(self) -> None:
        """Initialize the backend (Elasticsearch or OpenSearch) from the resolved config."""
        self._ensure_dependencies()
        bag = self.IEndpoint.endpoint.bag
        # The resolved config: defaults applied, the active branch flattened
        config = self.config
        self.backend = resolve_backend(self.glb.logicalType)
        debug(f'Index search backend: {self.backend}')

        if self.backend == BACKEND_ELASTICSEARCH:
            self._begin_elasticsearch(config, bag)
        else:
            self._begin_opensearch(config)

    def _begin_elasticsearch(self, config: Mapping, bag: dict) -> None:
        """Open the Elasticsearch store and load the search options."""
        from .elasticsearch_store import Store

        self.store = None
        self.store = Store(self.glb.logicalType, config, bag)
        self.mode = config['mode']
        debug(f'Elasticsearch mode: {self.mode}')
        self._load_search_flags(config)

    def _begin_opensearch(self, config: Mapping) -> None:
        """Open the OpenSearch client and load the search options."""
        from .opensearch_client import OpenSearchClient

        use_auth = config['auth'] == 'basic'
        username = (config['username'] or '').strip() if use_auth else None
        password = config['password'] if use_auth else None
        if use_auth:
            # An unfilled password names the missing variable instead of reaching the server.
            check_credential_resolved(self.glb.logicalType, 'password', password)

        self.host = normalize_opensearch_host(config['host'], use_auth)
        self.collection = (config['collection'] or '').strip()
        self.mode = config['mode']
        # The vector-store branch carries the dimension and the score
        self.vector_dim = int(config['dim']) if 'dim' in config else 0
        self.score = float(config['score']) if 'score' in config else 0.0
        debug(f'OpenSearch client init host={self.host} collection={self.collection} auth={use_auth}')
        self.client = OpenSearchClient(
            host=self.host,
            username=username,
            password=password,
            verify_certs=False,
            ssl_show_warn=False,
        )
        self._load_search_flags(config)
        debug(f'OpenSearch beginGlobal host={self.host} collection={self.collection}')

    def endGlobal(self) -> None:
        """Release the store or client and clear the references."""
        if self.backend == BACKEND_ELASTICSEARCH:
            self.store = None
        elif self.backend == BACKEND_OPENSEARCH:
            if self.client is not None:
                try:
                    self.client.close()
                except Exception:
                    pass
            self.client = None
            debug('OpenSearch endGlobal cleaning up client')

    def _ensure_dependencies(self) -> None:
        """Load the node dependencies once (shared by the Elasticsearch and OpenSearch backends)."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

    def _load_search_flags(self, config: Mapping) -> None:
        """Read the text-search options: match operator, slop, highlight, fragment size.

        They apply only while the customize switch (``search``) is on; off, the
        class defaults stand. The schema validated the values (the operator is
        an enum, slop and the fragment size are bounded integers), so they are
        read as they are.
        """
        self.search_enabled = bool(config['search'])
        if not self.search_enabled:
            return
        self.search_match_operator = config['matchOperator']
        self.search_exact_slop = int(config['slop']) if self.search_match_operator == 'exact' else 0
        self.search_highlight_enabled = bool(config['highlight'])
        self.search_highlight_fragment_size = int(config['fragment_size'])
        debug(
            f'Search options: enabled={self.search_enabled} matchOperator={self.search_match_operator} '
            f'slop={self.search_exact_slop} highlight={self.search_highlight_enabled} '
            f'fragment_size={self.search_highlight_fragment_size}'
        )
