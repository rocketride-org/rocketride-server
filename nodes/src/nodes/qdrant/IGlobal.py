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
from ai.common.config import Config
from ai.common.transform import IGlobalTransform
from rocketlib import OPEN_MODE
from rocketlib import warning


# Module-level regex for collection name (1-255 of A-Z a-z 0-9 . _ - ; no '/')
QDRANT_COLLECTION_RE = re.compile(r'^[A-Za-z0-9._-]{1,255}$')


class IGlobal(IGlobalTransform):
    serverName: str = 'qdrant'

    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition - even though
            from .qdrant import Store

            # Declare store
            self.store: Store | None = None

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            connConfig = self.getConnConfig()

            # Resolve the namespace used for agent-facing tool names
            # (qdrant.search/upsert/delete). Read from the merged config
            # so it honors both profile defaults and user overrides.
            cfg = Config.getNodeConfig(self.glb.logicalType, connConfig)
            resolved_name = cfg.get('serverName') if isinstance(cfg, dict) or hasattr(cfg, 'get') else None
            if isinstance(resolved_name, str) and resolved_name.strip():
                self.serverName = resolved_name.strip()

            # Get the configuration
            self.store = Store(self.glb.logicalType, connConfig, bag)

            # Get the info about our store
            collection = self.store.collection
            host = self.store.host
            port = self.store.port

            # Format it into a subKey
            subKey = f'{host}/{port}/{collection}'

            # Call the base
            super().beginGlobal(subKey)
            return

    def validateConfig(self):
        """
        Validate Qdrant config at save-time with a fast SDK probe.

        - Build client from exact user host/port (no normalization), api_key optional
        - Probe with get_collections() (read-only, minimal)
        - Validate collection name format locally (no existence check)
        - Surface concise SDK/HTTP errors via a unified formatter
        """
        try:
            # Load configuration
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
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

            # Build URL directly from user inputs; support hosts that already include scheme
            lower_host = host.lower()
            if lower_host.startswith('http://') or lower_host.startswith('https://'):
                url = f'{host}:{port_int}'
            else:
                # Prefer http for localhost/127.*, otherwise use https for cloud/443
                is_local = host == 'localhost' or host.startswith('127.')
                scheme = 'http'
                if not is_local and (str(port_int) == '443' or host.endswith('.qdrant.io')):
                    scheme = 'https'
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

    def endGlobal(self):
        # Release the index and embeddings
        self.store = None


def _format_error(e: Exception) -> str:
    """Concise, provider-first error string with early returns."""
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
