# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
# Unified IGlobal for Elasticsearch and OpenSearch index search connectors.
#
# The backend ('elasticsearch' or 'opensearch') is determined from the
# connector configuration at runtime. Both share the same search flag
# handling and lifecycle pattern.
# ------------------------------------------------------------------------------
from __future__ import annotations

import os
import re
from typing import Optional, Dict, Any

from ai.common.config import Config
from ai.common.transform import IGlobalTransform
from rocketlib import OPEN_MODE, debug, warning


# Module-level regex for index name (1-255 of a-z 0-9 . _ - ; no '/')
INDEX_NAME_RE = re.compile(r'^[a-z0-9._-]{1,255}$')


class IGlobal(IGlobalTransform):
    # Which backend we are using: 'elasticsearch' or 'opensearch'
    backend: str = ''

    # Elasticsearch store (only set when backend == 'elasticsearch')
    store = None

    # OpenSearch client (only set when backend == 'opensearch')
    client = None

    # Shared search configuration flags
    search_enabled: bool = False
    search_match_operator: str = 'or'
    search_exact_slop: int = 0
    search_highlight_enabled: bool = False
    search_highlight_fragment_size: int = 250

    # Mode: 'index' for text-only search, 'vstore' for vector search
    mode: str = 'vstore'

    # OpenSearch-specific fields
    collection: str = ''
    host: str = ''
    vector_dim: int = 0
    score: float = 0.0

    def beginGlobal(self):
        # Are we in config mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        # Get our bag
        bag = self.IEndpoint.endpoint.bag

        # Get the passed configuration
        connConfig = self.getConnConfig()

        # Determine backend from config provider key or protocol
        provider = connConfig.get('provider', '')
        if not provider:
            # Fallback: detect from config keys
            if connConfig.get('apikey') is not None or 'elasticsearch' in str(self.glb.logicalType).lower():
                provider = 'elasticsearch'
            else:
                provider = 'opensearch'

        self.backend = provider
        debug(f'Index search backend: {self.backend}')

        if self.backend == 'elasticsearch':
            self._begin_elasticsearch(connConfig, bag)
        elif self.backend == 'opensearch':
            self._begin_opensearch(connConfig)
        else:
            raise Exception(f'Unknown index search backend: {self.backend}')

    def _begin_elasticsearch(self, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        """Initialize Elasticsearch backend."""
        from .elasticsearch_store import Store

        # Declare store
        self.store = None

        # Get the configuration
        self.store = Store(self.glb.logicalType, connConfig, bag)

        # Get the info about our store
        index = self.store.index
        host = self.store.host
        port = self.store.port

        # Load mode setting (index vs vstore)
        mode_raw = connConfig.get('mode', 'vstore')
        if isinstance(mode_raw, bool):
            # Boolean mode: false=index, true=vstore
            self.mode = 'vstore' if mode_raw else 'index'
        else:
            mode_str = str(mode_raw).strip().lower()
            if mode_str in ('false', 'index', ''):
                self.mode = 'index'
            elif mode_str in ('true', 'vstore', 'vector_database'):
                self.mode = 'vstore'
            else:
                self.mode = 'vstore'

        debug(f'Elasticsearch mode: {self.mode}')

        # Load search configuration flags (for index mode)
        self.search_enabled = bool(connConfig.get('search', False))
        if self.search_enabled or self.mode == 'index':
            self._load_search_flags(connConfig)

        # Format it into a subKey
        subKey = f'{host}/{port}/{index}'

        # Call the base
        super().beginGlobal(subKey)

    def _begin_opensearch(self, connConfig: Dict[str, Any]):
        """Initialize OpenSearch backend."""
        from .opensearch_client import OpenSearchClient

        host = (connConfig.get('host', '') or '').strip()
        collection = (connConfig.get('collection', '') or '').strip()
        mode = str(connConfig.get('mode')).strip()
        vector_dim = int(connConfig.get('dim') or 0)
        score = float(connConfig.get('score') or 0.0)
        auth_cfg = connConfig.get('auth', {}) if isinstance(connConfig.get('auth', {}), dict) else {}

        # Prefer nested auth.*; fall back to top-level username/password
        username = (auth_cfg.get('username') or connConfig.get('username') or '').strip()
        password = auth_cfg.get('password') or connConfig.get('password') or ''

        # Enable auth if explicitly set in nested config, otherwise infer from presence of creds
        use_auth = auth_cfg.get('enabled')
        if use_auth is None:
            use_auth = bool(username or password)

        # Normalize host to include scheme; if auth is enabled and host lacks https, upgrade to https
        if '://' not in host:
            normalized_host = f'http://{host}'
        else:
            normalized_host = host
        if use_auth and normalized_host.startswith('http://'):
            normalized_host = 'https://' + normalized_host[len('http://'):]
            debug(f'Auth enabled; upgrading host to HTTPS -> {normalized_host}')

        # Initialize OpenSearch client
        debug(f'OpenSearch client init host={normalized_host} collection={collection} auth={use_auth}')

        self.client = OpenSearchClient(
            host=normalized_host,
            username=username if use_auth else None,
            password=password if use_auth else None,
            verify_certs=False,
            ssl_show_warn=False,
        )

        mode_lower = mode.lower() if mode else ''
        if mode_lower in ('false', 'index', ''):
            mode = 'index'
        elif mode_lower in ('true', 'vstore'):
            mode = 'vstore'
        else:
            raise Exception(f'Invalid mode: {mode}')

        self.collection = collection
        self.host = normalized_host
        self.mode = mode
        self.vector_dim = vector_dim
        self.score = score

        self.search_enabled = connConfig.get('search')
        if self.search_enabled:
            self._load_search_flags(connConfig)

        # Sub-key for caching/shared resource
        subKey = f'{normalized_host}/{collection}'
        debug(f'OpenSearch beginGlobal host={normalized_host} collection={collection}')
        super().beginGlobal(subKey)

    def validateConfig(self):
        """
        Validate config at save-time with a fast probe.

        Auto-detects backend from configuration and validates accordingly.
        """
        connConfig = self.getConnConfig()
        provider = connConfig.get('provider', '')

        if not provider:
            if connConfig.get('apikey') is not None or 'elasticsearch' in str(self.glb.logicalType).lower():
                provider = 'elasticsearch'
            else:
                provider = 'opensearch'

        if provider == 'elasticsearch':
            self._validate_elasticsearch()
        else:
            self._validate_opensearch()

    def _validate_elasticsearch(self):
        """Validate Elasticsearch config at save-time with a fast SDK probe."""
        try:
            config = Config.getConnectorConfig(self.glb.logicalType, self.glb.connConfig)
            host = (config.get('host', '')).strip()
            port = config.get('port')
            apikey = (config.get('apikey', '')).strip()
            index = (config.get('index', '')).strip()
            mode = config.get('mode', 'self-managed')

            # Validate index name format (no existence lookup)
            if not INDEX_NAME_RE.fullmatch(index or ''):
                warning("Index name is invalid. Use 1-255 lowercase chars: letters, digits, '_', '-', '.'; no '/' or spaces")
                return

            # Block port 0 explicitly; other values rely on OS/SDK errors
            port_int = int(port)
            if port_int == 0:
                warning('Port cannot be 0')
                return

            # Ensure dependencies are available before importing SDK
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Import Elasticsearch client after depends
            from elasticsearch import Elasticsearch  # type: ignore

            # Build URL directly from user inputs; support hosts that already include scheme
            lower_host = host.lower()
            if lower_host.startswith('http://') or lower_host.startswith('https://'):
                url = f'{host}:{port_int}'
            else:
                # Prefer http for localhost/127.*, otherwise use https for cloud/443
                is_local = host == 'localhost' or host.startswith('127.') or mode == 'self-managed'
                scheme = 'http' if is_local else 'https'
                url = f'{scheme}://{host}:{port_int}'

            # Create client - validation-timeout is 10s
            client = Elasticsearch([url], api_key=(apikey or None), request_timeout=10)

            # Minimal probe: cluster health (read-only, quick)
            try:
                client.cluster.health()
            finally:
                try:
                    client.close()
                except Exception:
                    pass

        except Exception as e:
            warning(_format_error(e))

    def _validate_opensearch(self):
        """Validate OpenSearch config at save-time with a fast SDK ping."""
        try:
            self._ensure_dependencies()

            connConfig = self.getConnConfig()
            host = (connConfig.get('host', '') or '').strip()
            collection = (connConfig.get('collection', '') or '').strip()
            mode = str(connConfig.get('mode')).strip()
            vector_dim = int(connConfig.get('dim') or 0)
            score = connConfig.get('score') or 0.0
            auth_cfg = connConfig.get('auth', {}) if isinstance(connConfig.get('auth', {}), dict) else {}

            # Prefer nested auth.*; fall back to top-level username/password
            username = (auth_cfg.get('username') or connConfig.get('username') or '').strip()
            password = auth_cfg.get('password') or connConfig.get('password') or ''

            # Enable auth if explicitly set in nested config, otherwise infer from presence of creds
            use_auth = auth_cfg.get('enabled')
            if use_auth is None:
                use_auth = bool(username or password)
            use_auth = bool(use_auth)

            if not host:
                warning('Host is required for OpenSearch')
                debug('Validation failed: missing host')
                return

            # Validate collection name format (local check only)
            if collection and not INDEX_NAME_RE.fullmatch(collection):
                warning("Collection name is invalid. Use 1-255 chars: letters, digits, '_', '-', '.'; no '/' or spaces")
                debug(f'Validation failed: invalid collection name "{collection}"')
                return

            if use_auth:
                if not username:
                    warning('Username is required when basic auth is enabled')
                    debug('Validation failed: missing username with auth enabled')
                    return
                if not password:
                    warning('Password is required when basic auth is enabled')
                    debug('Validation failed: missing password with auth enabled')
                    return

            if '://' not in host:
                normalized_host = f'http://{host}'
            else:
                normalized_host = host
            if use_auth and normalized_host.startswith('http://'):
                normalized_host = 'https://' + normalized_host[len('http://'):]
                debug(f'Auth enabled; upgrading host to HTTPS (validate) -> {normalized_host}')

            from .opensearch_client import OpenSearchClient

            client = OpenSearchClient(
                host=normalized_host,
                username=username if use_auth else None,
                password=password if use_auth else None,
                verify_certs=False,
                ssl_show_warn=False,
            )

            mode_lower = mode.lower() if mode else ''
            if mode_lower in ('false', 'index', ''):
                mode = 'index'
            elif mode_lower in ('true', 'vstore'):
                mode = 'vstore'
            else:
                raise Exception(f'Invalid mode: {mode}')

            # Mode specific validation
            if mode == 'vstore':
                if vector_dim <= 0:
                    warning('Embedding dimension is required and must be > 0 for vector store mode')
                    debug('Validation failed: missing or invalid vector dimension')
                    return
                try:
                    s_val = float(score)
                    if s_val < 0 or s_val > 1:
                        warning('Retrieval score must be between 0 and 1')
                        debug(f'Validation failed: score out of range {s_val}')
                        return
                except Exception:
                    warning('Retrieval score must be a number')
                    debug('Validation failed: score not numeric')
                    return
            else:
                search_enabled = connConfig.get('search')
                if search_enabled:
                    self._load_search_flags(connConfig)

            if not client.ping():
                warning('Unable to reach OpenSearch at provided host')
                debug(f'Ping failed for host={normalized_host} auth={use_auth}')
            else:
                debug(f'Ping succeeded for host={normalized_host} auth={use_auth}')

        except Exception as e:
            warning(_format_error(e))

    def endGlobal(self):
        # Release the store/client based on backend
        if self.backend == 'elasticsearch':
            self.store = None
        elif self.backend == 'opensearch':
            if self.client is not None:
                try:
                    self.client.close()
                except Exception:
                    pass
            debug('OpenSearch endGlobal cleaning up client')
            self.client = None

    def _ensure_dependencies(self):
        """Ensure the dependencies are installed."""
        from depends import depends

        requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        debug(f'Ensuring dependencies from {requirements}')
        depends(requirements)

    def _load_search_flags(self, connConfig):
        """
        Load search behavior options chosen in the configuration.

        Only captures values; enforcement/behavior is handled elsewhere.
        """
        # New UI: enum dropdown matchOperator ('and'|'or'|'exact')
        match_operator_raw = (connConfig.get('matchOperator') or connConfig.get('match_operator') or '').strip().lower()
        if match_operator_raw not in ('and', 'or', 'exact', ''):
            warning(f"matchOperator must be 'and', 'or', or 'exact', got: {match_operator_raw}")
            match_operator_raw = ''

        self.search_match_operator = match_operator_raw or 'or'

        slop_val = connConfig.get('slop')
        try:
            self.search_exact_slop = int(slop_val or 0) if self.search_match_operator == 'exact' else 0
        except Exception:
            self.search_exact_slop = 0

        self.search_highlight_enabled = bool(connConfig.get('highlight', False))
        if self.search_highlight_enabled:
            self.search_highlight_fragment_size = int(connConfig.get('fragment_size') or 250)

        debug(f'Search options: enabled={self.search_enabled} matchOperator={self.search_match_operator} slop={self.search_exact_slop} highlight={self.search_highlight_enabled} fragment_size={self.search_highlight_fragment_size}')


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

