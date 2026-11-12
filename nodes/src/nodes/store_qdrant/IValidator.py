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
Qdrant save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a fast connectivity
probe against the configured server. The qdrant client is imported inside the
probe so this module stays import-light.
"""

import os
import re
from typing import Mapping

from rocketlib import IValidatorBase, warning

from ai.common.config import warn_if_credential_unresolved

QDRANT_COLLECTION_RE = re.compile(r'^[A-Za-z0-9._-]{1,255}$')


def probe_connection(config: Mapping) -> None:
    """
    Validate Qdrant config at save-time with a fast SDK probe.

    - Build client from exact user host/port (no normalization), api_key optional
    - Probe with get_collections() (read-only, minimal)
    - Validate collection name format locally (no existence check)
    - Surface concise SDK/HTTP errors via a unified formatter

    Reports problems with ``warning()`` and never raises: the user is still
    editing the node.

    Args:
        config: The resolved node config (host, port, collection, profile; apikey on the cloud branch).
    """
    try:
        host = (config['host'] or '').strip()
        port = config['port']
        apikey = (config.get('apikey') or '').strip()
        collection = (config['collection'] or '').strip()

        # Validate collection name format (no existence lookup)
        if not QDRANT_COLLECTION_RE.fullmatch(collection or ''):
            warning("Collection name is invalid. Use 1-255 chars: letters, digits, '_', '-', '.'; no '/' or spaces")
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

        # Import Qdrant client after depends
        from qdrant_client import QdrantClient  # type: ignore

        # Build URL from host/port.
        # If the host already includes a scheme (http:// or https://), use it as-is.
        # Otherwise, infer from the profile: cloud -> https://, local -> http://.
        if '://' in host:
            url = f'{host}:{port_int}'
        else:
            scheme = 'https' if config['profile'] == 'cloud' else 'http'
            url = f'{scheme}://{host}:{port_int}'

        # Create client - REST only (prefer_grpc=False); validation-timeout is 10s
        # Note: Cloud with an incorrect port does not return HTTP status; SDK only times out.
        # 10s absorbs occasional TLS handshake delays seen in cloud; 3s caused intermittent warnings.
        client = QdrantClient(url=url, api_key=(apikey or None), prefer_grpc=False, timeout=10)

        # Minimal probe: list collections (read-only, quick)
        try:
            client.get_collections()
        finally:
            try:
                client.close()
            except Exception:
                pass

    except Exception as e:
        warning(_format_error(e))


def _format_error(e: Exception) -> str:
    """Concise error string for qdrant's httpx-based exceptions.

    Behaviour:
    - ``httpx.HTTPStatusError`` → ``"Error <status>: <body>"`` where the body
      is the response's ``message`` / ``error`` JSON field if parseable,
      otherwise the raw response text, otherwise ``reason_phrase``.
    - ``httpx.RequestError`` / ``socket.timeout`` → ``str(e).strip()``.
    - Anything else (including the case where ``httpx`` is not installed) →
      ``str(e).strip()``.
    """
    try:
        import httpx  # type: ignore
        import socket  # type: ignore
        import json  # type: ignore
    except Exception:
        return str(e).strip()

    if isinstance(e, httpx.HTTPStatusError):
        resp = e.response
        status = getattr(resp, 'status_code', None)
        text = (getattr(resp, 'text', '') or '').strip()
        if text and text.lstrip().startswith(('{', '[')):
            try:
                data = json.loads(text)
                text = (data.get('message') or data.get('error') or text).strip()
            except Exception:
                pass
        if not text:
            text = (getattr(resp, 'reason_phrase', '') or '').strip()
        return f'Error {status}: {text}' if status else (text or str(e).strip())

    if isinstance(e, (httpx.RequestError, socket.timeout)):
        return str(e).strip()

    return str(e).strip()


class IValidator(IValidatorBase):
    """Schema check through the resolver, then the connectivity probe."""

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
        # An unfilled reference is reported as such; the probe must not send
        # the placeholder text as the key and surface Qdrant's "unauthorized".
        # The local branch has no key, so its None passes the check.
        if warn_if_credential_unresolved(self.glb.logicalType, 'apikey', config.get('apikey')):
            return
        probe_connection(config)
