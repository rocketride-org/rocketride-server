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
Weaviate save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a fast connectivity
probe: a REST meta call for a cloud cluster, the SDK client plus a gRPC
readiness check for a local server. The weaviate client is imported inside
the probe so this module stays import-light.
"""

import os
import re
from typing import Mapping

from rocketlib import IValidatorBase, warning

from ai.common.config import warn_if_credential_unresolved

# Official Weaviate collection name rule
WEAVIATE_COLLECTION_RE = re.compile(r'^[A-Z][_0-9A-Za-z]*$')


def probe_connection(config: Mapping) -> None:
    """
    Validate Weaviate config at save-time with a fast, SDK-driven probe.

    - Collection name format check (no existence check)
    - Cloud: REST ``/v1/meta`` with the API key
    - Local: connect_to_local (host, port, grpc_port), list collections, gRPC READY

    Reports problems with ``warning()`` and never raises: the user is still
    editing the node.

    Args:
        config: The resolved node config (host, collection, profile; port and grpc_port on the local branch, apikey on the cloud branch).
    """
    try:
        host = (config['host'] or '').strip()
        collection = (config['collection'] or '').strip()

        if not WEAVIATE_COLLECTION_RE.fullmatch(collection):
            warning(
                'Start with uppercase; only letters/numbers/underscore; no spaces or special characters '
                '(/ , . : ; \' " { } ( ) % ^ & $ # @ - ! ? * + = [ ] | \\ ~ < >).'
            )
            return

        from depends import depends  # type: ignore

        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        import weaviate  # type: ignore
        from weaviate.classes.init import AdditionalConfig, Timeout  # type: ignore
        import httpx  # type: ignore
        import socket  # type: ignore

        if config['profile'] == 'cloud':
            # Cloud: REST + API key only; do not probe gRPC
            apikey = (config['apikey'] or '').strip()
            base_url = host if host.startswith('https://') else f'https://{host}'
            headers = {'Authorization': f'Bearer {apikey}'} if apikey else {}
            response = httpx.get(base_url.rstrip('/') + '/v1/meta', headers=headers, timeout=3)
            response.raise_for_status()
            return

        # Local: the SDK client and a lightweight call (no API key)
        port = config['port']
        grpc_port = config['grpc_port']
        client = weaviate.connect_to_local(
            host=host,
            port=port,
            grpc_port=grpc_port,
            additional_config=AdditionalConfig(timeout=Timeout(init=3, query=3)),
        )
        try:
            # REST check via SDK (hits /v1/schema)
            client.collections.list_all()
            # gRPC READY
            try:
                import grpc  # type: ignore

                grpc.channel_ready_future(grpc.insecure_channel(f'{host}:{grpc_port}')).result(timeout=3)
            except ImportError:
                with socket.create_connection((host, int(grpc_port)), timeout=3):
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
    - ``httpx.HTTPStatusError`` -> ``"Error <status>: <body>"`` where the body
      is the response's ``message`` / ``error`` JSON field if parseable,
      otherwise the raw response text, otherwise ``reason_phrase``.
    - ``httpx.RequestError`` / ``socket.timeout`` -> ``str(e).strip()``.
    - Anything else (including the case where ``httpx`` is not installed) ->
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
        # An unfilled reference is reported as such; the probe must not send the placeholder as the key
        if config['profile'] == 'cloud' and warn_if_credential_unresolved(
            self.glb.logicalType, 'apikey', config['apikey']
        ):
            return
        probe_connection(config)
