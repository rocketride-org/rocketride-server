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


# Module-level regex constant for collection name validation (official rule)
WEAVIATE_COLLECTION_RE = re.compile(r'^[A-Z][_0-9A-Za-z]*$')


class IGlobal(StoreGlobalBase):
    serverName: str = 'weaviate'

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so config mode never loads the driver."""
        from .weaviate import Store

        return Store(logical_type, conn_config, bag)

    def _sub_key(self) -> str:
        """Return the transform sub-key: host/port/collection."""
        return f'{self.store.host}/{self.store.port}/{self.store.collection}'

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """
        Validate Weaviate config at save-time with a fast, SDK-driven probe.

        - Cloud: connect_to_weaviate_cloud + client.is_ready()
        - Local: connect_to_local (host, port, grpc_port) + client.is_ready()
        - Collection name format check (no existence check)
        - Minimal timeouts; SDK/HTTP exceptions surfaced without truncation
        """
        try:
            host = (config.get('host', '')).strip()
            port = config.get('port')
            grpc_port = config.get('grpc_port')
            apikey = (config.get('apikey', '')).strip()
            collection = (config.get('collection', '')).strip()

            # Collection name validation (official Weaviate rule)
            if not WEAVIATE_COLLECTION_RE.fullmatch(collection or ''):
                warning(
                    'Start with uppercase; only letters/numbers/underscore; no spaces or special characters (/ , . : ; \' " { } ( ) % ^ & $ # @ - ! ? * + = [ ] | \\ ~ < >).'
                )
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
                headers = {'Authorization': f'Bearer {apikey}'} if apikey else {}
                r = httpx.get(url, headers=headers, timeout=3)
                r.raise_for_status()
                return
            else:
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


def _format_error(e: Exception) -> str:
    """Concise error string for weaviate's httpx-based exceptions.

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
