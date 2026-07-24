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
import re
from typing import Any, Dict

from ai.common.store import StoreGlobalBase
from rocketlib import warning


# Module-level regex for collection name (1-255 of A-Z a-z 0-9 . _ - ; no '/')
QDRANT_COLLECTION_RE = re.compile(r'^[A-Za-z0-9._-]{1,255}$')


class IGlobal(StoreGlobalBase):
    serverName: str = 'qdrant'

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so config mode never loads the driver."""
        from .qdrant import Store

        return Store(logical_type, conn_config, bag)

    def _sub_key(self) -> str:
        """Return the transform sub-key: host/port/collection."""
        collection = self.store.collection
        host = self.store.host
        port = self.store.port
        return f'{host}/{port}/{collection}'

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """
        Validate Qdrant config at save-time with a fast SDK probe.

        - Build client from exact user host/port (no normalization), api_key optional
        - Probe with get_collections() (read-only, minimal)
        - Validate collection name format locally (no existence check)
        - Surface concise SDK/HTTP errors via a unified formatter
        """
        try:
            host = (config.get('host', '')).strip()
            port = config.get('port')
            apikey = (config.get('apikey', '')).strip()
            collection = (config.get('collection', '')).strip()

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
                profile = (self.glb.connConfig.get('profile', '') or '').lower()
                scheme = 'https' if profile == 'cloud' else 'http'
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
