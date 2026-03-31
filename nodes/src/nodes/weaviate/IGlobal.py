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

import os
import re
from ai.common.config import Config
from ai.common.transform import IGlobalTransform
from rocketlib import OPEN_MODE
from rocketlib import warning

from nodes.library.internet.ssrf_guard import validate_url


# Module-level regex constant for collection name validation (official rule)
WEAVIATE_COLLECTION_RE = re.compile(r'^[A-Z][_0-9A-Za-z]*$')


class IGlobal(IGlobalTransform):
    def beginGlobal(self):
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition - even though
            from .weaviate import Store

            # Declare store
            self.store: Store | None = None

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # Get the passed configuration
            connConfig = self.getConnConfig()

            # SSRF validation: validate the connection URL before creating
            # the Store (which opens a real network connection in __init__)
            config = Config.getNodeConfig(self.glb.logicalType, connConfig)
            host = (config.get('host', '')).strip()
            port = config.get('port')
            profile = config.get('mode')

            if profile == 'cloud':
                cloud_url = host if host.startswith('https://') else f'https://{host}'
                validate_url(cloud_url)
            else:
                local_url = host if host.startswith('http') else f'http://{host}'
                if port:
                    local_url = f'{local_url}:{port}'
                validate_url(local_url)

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
        Validate Weaviate config at save-time with a fast, SDK-driven probe.

        - Cloud: connect_to_weaviate_cloud + client.is_ready()
        - Local: connect_to_local (host, port, grpc_port) + client.is_ready()
        - Collection name format check (no existence check)
        - Minimal timeouts; SDK/HTTP exceptions surfaced without truncation
        """
        try:
            # Get config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            host = (config.get('host', '')).strip()
            port = config.get('port')
            grpc_port = config.get('grpc_port')
            apikey = (config.get('apikey', '')).strip()
            collection = (config.get('collection', '')).strip()

            # Collection name validation (official Weaviate rule)
            if not WEAVIATE_COLLECTION_RE.fullmatch(collection or ''):
                warning('Start with uppercase; only letters/numbers/underscore; no spaces or special characters (/ , . : ; \' " { } ( ) % ^ & $ # @ - ! ? * + = [ ] | \\ ~ < >).')
                return

            # Load dependencies before importing SDK
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Imports used for SDK clients
            import weaviate  # type: ignore
            from weaviate.classes.init import AdditionalConfig, Timeout  # type: ignore
            import httpx  # type: ignore
            import socket  # type: ignore

            # Decide cloud vs local: treat localhost/127.* as local; otherwise cloud
            is_local = host in ('localhost', '127.0.0.1') or host.startswith('127.')
            is_cloud = not is_local

            # Build base URL (add scheme if missing)
            if is_local:
                base_url = host if host.startswith('http') else f'http://{host}'
                if port:
                    base_url = f'{base_url}:{port}'
            else:
                base_url = host if host.startswith('https://') else f'https://{host}'

            if is_cloud:
                # Cloud: REST + API key only; do not probe gRPC
                url = base_url.rstrip('/') + '/v1/meta'
                validate_url(url)
                headers = {'Authorization': f'Bearer {apikey}'} if apikey else {}
                r = httpx.get(url, headers=headers, timeout=3, follow_redirects=False)
                r.raise_for_status()
                return
            else:
                # Local: validate URL before connecting
                validate_url(base_url)
                # Local: use SDK client and a lightweight call (no API key)
                client = weaviate.connect_to_local(
                    host=host,
                    port=port,
                    grpc_port=grpc_port,
                    additional_config=AdditionalConfig(timeout=Timeout(init=3, query=3)),
                )
                try:
                    # REST check via SDK (hits /v1/schema)
                    client.collections.list_all()
                    # gRPC READY (grpc_port is required by UI)
                    gp = int(grpc_port)
                    try:
                        import grpc  # type: ignore

                        grpc.channel_ready_future(grpc.insecure_channel(f'{host}:{gp}')).result(timeout=3)
                    except ImportError:
                        with socket.create_connection((host, gp), timeout=3):
                            pass
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
