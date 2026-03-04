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
# The backend (elasticsearch or opensearch) is chosen from node config at
# runtime. Both backends share the same search-option handling and lifecycle.
# ------------------------------------------------------------------------------
from __future__ import annotations

import os
import re
from typing import Any, Dict, Optional

from ai.common.config import Config
from ai.common.transform import IGlobalTransform
from rocketlib import OPEN_MODE, debug, warning

from .constants import (
    BACKEND_ELASTICSEARCH,
    BACKEND_OPENSEARCH,
    DEFAULT_HIGHLIGHT_FRAGMENT_SIZE,
    MODE_INDEX,
    MODE_VSTORE,
)

# Index/collection name: 1–255 chars, lowercase letters, digits, . _ - ; no /
INDEX_NAME_RE = re.compile(r'^[a-z0-9._-]{1,255}$')


def _resolve_provider(connConfig: Dict[str, Any], logical_type: Any) -> str:
    """Resolve backend provider from node config (elasticsearch or opensearch)."""
    provider = (connConfig.get('provider') or '').strip()
    if provider:
        return provider
    if connConfig.get('apikey') is not None or 'elasticsearch' in str(logical_type).lower():
        return BACKEND_ELASTICSEARCH
    return BACKEND_OPENSEARCH


def _normalize_opensearch_host(host: str, use_auth: bool) -> str:
    """Ensure host has scheme; upgrade to https when auth is enabled."""
    host = (host or '').strip()
    if '://' not in host:
        host = f'http://{host}'
    if use_auth and host.startswith('http://'):
        host = 'https://' + host[len('http://') :]
    return host


def _parse_mode_opensearch(mode_raw: str) -> str:
    """Parse OpenSearch mode config into MODE_INDEX or MODE_VSTORE."""
    mode = (str(mode_raw or '').strip()).lower()
    if mode in ("false", "index", ""):
        return MODE_INDEX
    if mode in ("true", "vstore"):
        return MODE_VSTORE
    raise ValueError(f'Invalid mode: {mode_raw}')


def _parse_mode_elasticsearch(mode_raw: Any) -> str:
    """Parse Elasticsearch mode config (bool or string) into MODE_INDEX or MODE_VSTORE."""
    if isinstance(mode_raw, bool):
        return MODE_VSTORE if mode_raw else MODE_INDEX
    mode = str(mode_raw).strip().lower()
    if mode in ("false", "index", ""):
        return MODE_INDEX
    if mode in ("true", "vstore", "vector_database"):
        return MODE_VSTORE
    return MODE_VSTORE


class IGlobal(IGlobalTransform):
    """
    Global state for the index_search node.

    Holds either an Elasticsearch Store or an OpenSearch client, plus shared
    search options (match operator, highlight, etc.). Backend is chosen from
    config at beginGlobal().
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
        """Initialize backend (Elasticsearch or OpenSearch) from node config."""
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return
        self._ensure_dependencies()
        bag = self.IEndpoint.endpoint.bag
        connConfig = self.getConnConfig()
        self.backend = _resolve_provider(connConfig, self.glb.logicalType)
        debug(f'Index search backend: {self.backend}')

        if self.backend == BACKEND_ELASTICSEARCH:
            self._begin_elasticsearch(connConfig, bag)
        elif self.backend == BACKEND_OPENSEARCH:
            self._begin_opensearch(connConfig)
        else:
            raise Exception(f'Unknown index search backend: {self.backend}')

    def _begin_elasticsearch(self, connConfig: Dict[str, Any], bag: Dict[str, Any]) -> None:
        """Initialize Elasticsearch backend and load search options."""
        from .elasticsearch_store import Store

        self.store = None
        self.store = Store(self.glb.logicalType, connConfig, bag)
        self.mode = _parse_mode_elasticsearch(connConfig.get('mode', MODE_VSTORE))
        debug(f'Elasticsearch mode: {self.mode}')

        self.search_enabled = bool(connConfig.get('search', False))
        if self.search_enabled or self.mode == MODE_INDEX:
            self._load_search_flags(connConfig)

        subKey = f'{self.store.host}/{self.store.port}/{self.store.index}'
        super().beginGlobal(subKey)

    def _begin_opensearch(self, connConfig: Dict[str, Any]) -> None:
        """Initialize OpenSearch client and load search options."""
        from .opensearch_client import OpenSearchClient

        host = (connConfig.get('host') or '').strip()
        collection = (connConfig.get('collection') or '').strip()
        vector_dim = int(connConfig.get('dim') or 0)
        score = float(connConfig.get('score') or 0.0)
        auth_cfg = connConfig.get('auth') if isinstance(connConfig.get('auth'), dict) else {}
        username = (auth_cfg.get('username') or connConfig.get('username') or '').strip()
        password = auth_cfg.get('password') or connConfig.get('password') or ''

        use_auth = auth_cfg.get("enabled")
        if use_auth is None:
            use_auth = bool(username or password)

        normalized_host = _normalize_opensearch_host(host, bool(use_auth))
        debug(f'OpenSearch client init host={normalized_host} collection={collection} auth={use_auth}')
        self.client = OpenSearchClient(
            host=normalized_host,
            username=username if use_auth else None,
            password=password if use_auth else None,
            verify_certs=False,
            ssl_show_warn=False,
        )

        self.mode = _parse_mode_opensearch(connConfig.get('mode'))
        self.collection = collection
        self.host = normalized_host
        self.vector_dim = vector_dim
        self.score = score

        self.search_enabled = bool(connConfig.get('search', False))
        if self.search_enabled:
            self._load_search_flags(connConfig)

        subKey = f'{normalized_host}/{collection}'
        debug(f'OpenSearch beginGlobal host={normalized_host} collection={collection}')
        super().beginGlobal(subKey)

    def validateConfig(self) -> None:
        """Validate node config at save-time (fast probe). Backend is auto-detected."""
        self._ensure_dependencies()
        connConfig = self.getConnConfig()
        provider = _resolve_provider(connConfig, self.glb.logicalType)
        if provider == BACKEND_ELASTICSEARCH:
            self._validate_elasticsearch()
        else:
            self._validate_opensearch()

    def _validate_elasticsearch(self) -> None:
        """Validate Elasticsearch config with a quick cluster health check."""
        try:
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            host = (config.get('host') or '').strip()
            port = int(config.get('port', 0))
            apikey = (config.get('apikey') or '').strip()
            index = (config.get('index') or '').strip()
            mode = config.get('mode', 'self-managed')

            if not INDEX_NAME_RE.fullmatch(index):
                warning(
                    'Index name is invalid. Use 1-255 lowercase chars: letters, digits, \'_\', \'-\', \'.\'; no \'/\' or spaces'
                )
                return
            if port == 0:
                warning('Port cannot be 0')
                return

            from elasticsearch import Elasticsearch  # type: ignore

            if host.startswith('http://') or host.startswith('https://'):
                url = f'{host}:{port}'
            else:
                is_local = host == 'localhost' or host.startswith('127.') or mode == 'self-managed'
                scheme = 'http' if is_local else 'https'
                url = f'{scheme}://{host}:{port}'

            client = Elasticsearch([url], api_key=(apikey or None), request_timeout=10)
            try:
                client.cluster.health()
            finally:
                try:
                    client.close()
                except Exception:
                    pass
        except Exception as e:
            warning(_format_error(e))

    def _validate_opensearch(self) -> None:
        """Validate OpenSearch config and optionally ping the host."""
        try:
            connConfig = self.getConnConfig()
            host = (connConfig.get('host') or '').strip()
            collection = (connConfig.get('collection') or '').strip()
            vector_dim = int(connConfig.get('dim') or 0)
            score = connConfig.get('score') or 0.0
            auth_cfg = connConfig.get('auth') if isinstance(connConfig.get('auth'), dict) else {}
            username = (auth_cfg.get('username') or connConfig.get('username') or '').strip()
            password = auth_cfg.get('password') or connConfig.get('password') or ''
            use_auth = auth_cfg.get('enabled')
            if use_auth is None:
                use_auth = bool(username or password)
            use_auth = bool(use_auth)

            if not host:
                warning('Host is required for OpenSearch')
                return
            if collection and not INDEX_NAME_RE.fullmatch(collection):
                warning(
                    'Collection name is invalid. Use 1-255 chars: letters, digits, \'_\', \'-\', \'.\'; no \'/\' or spaces'
                )
                return
            if use_auth:
                if not username:
                    warning('Username is required when basic auth is enabled')
                    return
                if not password:
                    warning('Password is required when basic auth is enabled')
                    return

            normalized_host = _normalize_opensearch_host(host, use_auth)
            from .opensearch_client import OpenSearchClient

            client = OpenSearchClient(
                host=normalized_host,
                username=username if use_auth else None,
                password=password if use_auth else None,
                verify_certs=False,
                ssl_show_warn=False,
            )
            mode = _parse_mode_opensearch(connConfig.get('mode'))

            if mode == MODE_VSTORE:
                if vector_dim <= 0:
                    warning('Embedding dimension is required and must be > 0 for vector store mode')
                    return
                try:
                    s_val = float(score)
                    if s_val < 0 or s_val > 1:
                        warning('Retrieval score must be between 0 and 1')
                        return
                except Exception:
                    warning('Retrieval score must be a number')
                    return
            elif connConfig.get('search'):
                self._load_search_flags(connConfig)

            if not client.ping():
                warning('Unable to reach OpenSearch at provided host')
            else:
                debug(f'Ping succeeded for host={normalized_host} auth={use_auth}')
        except ValueError:
            raise
        except Exception as e:
            warning(_format_error(e))

    def endGlobal(self) -> None:
        """Release store or client and clear references."""
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
        """Load node dependencies once (shared by Elasticsearch and OpenSearch backends)."""
        from depends import depends  # type: ignore

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(requirements)

    def _load_search_flags(self, connConfig: Dict[str, Any]) -> None:
        """Load search options from config (match operator, slop, highlight, fragment size)."""
        from .constants import VALID_MATCH_OPERATORS

        match_operator_raw = (
            (connConfig.get('matchOperator') or connConfig.get('match_operator') or '').strip().lower()
        )
        if match_operator_raw not in (*VALID_MATCH_OPERATORS, ''):
            warning(f"matchOperator must be 'and', 'or', or 'exact'; got: {match_operator_raw}")
            match_operator_raw = ''
        self.search_match_operator = match_operator_raw or 'or'

        try:
            slop_val = connConfig.get('slop')
            self.search_exact_slop = (
                int(slop_val or 0) if self.search_match_operator == 'exact' else 0
            )
        except Exception:
            self.search_exact_slop = 0

        self.search_highlight_enabled = bool(connConfig.get('highlight', False))
        if self.search_highlight_enabled:
            self.search_highlight_fragment_size = int(
                connConfig.get('fragment_size') or DEFAULT_HIGHLIGHT_FRAGMENT_SIZE
            )
        debug(
            f'Search options: enabled={self.search_enabled} matchOperator={self.search_match_operator} '
            f'slop={self.search_exact_slop} highlight={self.search_highlight_enabled} '
            f'fragment_size={self.search_highlight_fragment_size}'
        )


def _format_error(e: Exception) -> str:
    """Concise, provider-first error string with early returns."""
    try:
        import json  # type: ignore
    except Exception:
        return str(e).strip()

    # Handle Elasticsearch exceptions
    error_str = str(e).strip()

    # Try to extract meaningful error messages
    if hasattr(e, 'info'):
        try:
            error_info = e.info if isinstance(e.info, dict) else {}
            error_msg = error_info.get('error', {}).get('reason', error_str)
            return error_msg
        except Exception:
            pass

    return error_str

