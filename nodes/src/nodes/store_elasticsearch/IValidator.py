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
Elasticsearch / OpenSearch save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a fast probe of the
server: a cluster health call for Elasticsearch, a ping for OpenSearch. The
clients are imported inside the probes so this module stays import-light.
"""

import re
from typing import Mapping

from rocketlib import IValidatorBase, debug, warning

from ai.common.config import warn_if_credential_unresolved

from .backend import normalize_opensearch_host, resolve_backend
from .constants import BACKEND_OPENSEARCH

# Index/collection name: 1-255 chars, lowercase letters, digits, . _ - ; no /
INDEX_NAME_RE = re.compile(r'^[a-z0-9._-]{1,255}$')


def probe_elasticsearch(config: Mapping) -> None:
    """
    Validate the Elasticsearch config with a quick cluster health check.

    Reports problems with ``warning()`` and never raises: the user is still
    editing the node.

    Args:
        config: The resolved node config (host, port, index, profile; apikey on the cloud branches).
    """
    try:
        host = (config['host'] or '').strip()
        port = int(config['port'])
        apikey = (config.get('apikey') or '').strip()
        index = (config['index'] or '').strip()

        if not INDEX_NAME_RE.fullmatch(index):
            warning(
                "Index name is invalid. Use 1-255 lowercase chars: letters, digits, '_', '-', '.'; no '/' or spaces"
            )
            return
        if port == 0:
            warning('Port cannot be 0')
            return

        from elasticsearch import Elasticsearch  # type: ignore

        if host.startswith('http://') or host.startswith('https://'):
            url = f'{host}:{port}'
        else:
            is_local = host == 'localhost' or host.startswith('127.') or config['profile'] == 'self-managed'
            url = f'{"http" if is_local else "https"}://{host}:{port}'

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


def probe_opensearch(config: Mapping) -> None:
    """
    Validate the OpenSearch config and ping the host.

    Reports problems with ``warning()`` and never raises: the user is still
    editing the node.

    Args:
        config: The resolved node config (host, collection, auth, mode; username and password on the basic branch).
    """
    try:
        host = (config['host'] or '').strip()
        collection = (config['collection'] or '').strip()
        use_auth = config['auth'] == 'basic'
        username = (config['username'] or '').strip() if use_auth else None
        password = config['password'] if use_auth else None

        if not host:
            warning('Host is required for OpenSearch')
            return
        if collection and not INDEX_NAME_RE.fullmatch(collection):
            warning("Collection name is invalid. Use 1-255 chars: letters, digits, '_', '-', '.'; no '/' or spaces")
            return
        if use_auth and not username:
            warning('Username is required when basic auth is enabled')
            return

        normalized_host = normalize_opensearch_host(host, use_auth)
        from .opensearch_client import OpenSearchClient

        client = OpenSearchClient(
            host=normalized_host,
            username=username,
            password=password,
            verify_certs=False,
            ssl_show_warn=False,
        )
        if not client.ping():
            warning('Unable to reach OpenSearch at provided host')
        else:
            debug(f'Ping succeeded for host={normalized_host} auth={use_auth}')
    except Exception as e:
        warning(_format_error(e))


def _format_error(e: Exception) -> str:
    """Concise error string for Elasticsearch / OpenSearch exceptions.

    The elasticsearch and opensearch Python clients attach a dict at
    ``e.info`` shaped like ``{'error': {'reason': '...'}}`` for query
    errors. Pull the inner ``reason`` so the user sees one useful sentence
    instead of the full nested response. Falls back to ``str(e).strip()``
    for any exception that does not match that shape.
    """
    info = getattr(e, 'info', None)
    if isinstance(info, dict):
        error = info.get('error')
        if isinstance(error, dict):
            reason = error.get('reason')
            if isinstance(reason, str) and reason.strip():
                return reason.strip()
    return str(e).strip()


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the backend's probe."""

    def validateConfig(self, syntaxOnly: bool = False) -> None:
        """
        Validate the stored config and, unless ``syntaxOnly``, probe the server.

        Args:
            syntaxOnly (bool): True checks the shape only; no network.

        Raises:
            ConfigError: The stored configuration does not fit the schema.
        """
        config = self.config
        if syntaxOnly:
            return
        logical_type = self.glb.logicalType
        if resolve_backend(logical_type) == BACKEND_OPENSEARCH:
            # An unfilled password is reported as such, and the ping does not send it
            if config['auth'] == 'basic' and warn_if_credential_unresolved(
                logical_type, 'password', config['password']
            ):
                return
            probe_opensearch(config)
            return
        # Do not send a ${...} the engine left unfilled to the server as the key:
        # its reply would say the key is wrong, not which variable is missing
        if 'apikey' in config and warn_if_credential_unresolved(logical_type, 'apikey', config['apikey']):
            return
        probe_elasticsearch(config)
