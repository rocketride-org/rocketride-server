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
Milvus save-time validation.

The engine imports this module alone in CONFIG mode: the schema check is the
resolver (``self.config``), and the semantic check is a fast connectivity
probe against the configured server. The pymilvus client is imported inside
the probe so this module stays import-light.
"""

import os
import re
from typing import Mapping

from rocketlib import IValidatorBase, warning

from ai.common.config import warn_if_credential_unresolved

from .mode import is_local

# Milvus collection names: 1-255 chars, letters, digits and underscores, not starting with a digit
NAME_PATTERN = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,254}$')
RULES_TEXT = (
    'Rules: 1) length 1-255, 2) Letters (A-Z, a-z), digits (0-9), and underscores only, '
    '3) start with a letter or underscore, 4) subsequent characters may be letters, digits, or underscores.'
)


def probe_connection(config: Mapping) -> None:
    """
    Validate Milvus configuration at save-time with a minimal probe.

    Reports problems with ``warning()`` and never raises: the user is still
    editing the node.

    Args:
        config: The resolved node config (host, port, collection, profile; apikey on the cloud branch).
    """
    try:
        host = (config['host'] or '').strip()
        port = config['port']
        collection = (config['collection'] or '').strip()
        # The token goes to a cloud server only: a local server gets none, as in the running store.
        token = '' if is_local(config) else (config['apikey'] or '').strip()

        if not NAME_PATTERN.match(collection):
            warning(f'Invalid collection name. {RULES_TEXT}')
            return

        from depends import depends  # type: ignore

        depends(os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt')

        from pymilvus import connections, utility, exceptions as milvus_exc

        alias = 'validate'
        # Clear a previous validation connection if present
        try:
            connections.disconnect(alias)
        except Exception:
            pass

        try:
            if token:
                # Cloud: pass host and port verbatim via URI
                connections.connect(alias=alias, uri=f'{host}:{port}', token=token, timeout=5)
            else:
                # Local: pass host/port exactly as provided
                connections.connect(alias=alias, host=host, port=port, timeout=5)
            # Minimal probe on the same alias
            utility.get_server_version(using=alias)
        except milvus_exc.MilvusException as e:
            warning(_format_error(e))
        except Exception as e:
            warning(_format_error(e))
    except Exception as e:
        warning(str(e))


def _format_error(exc: Exception) -> str:
    """Return a concise error string for Milvus/driver exceptions."""
    try:
        # gRPC-specific formatting
        try:
            import grpc  # type: ignore

            if isinstance(exc, grpc.RpcError):
                code_obj = exc.code()
                details = exc.details()
                code_name = getattr(code_obj, 'name', str(code_obj))
                return f'gRPC {code_name}: {details}'.strip()
        except Exception:
            pass

        # HTTP-style exceptions (e.g., httpx/requests beneath pymilvus)
        resp = getattr(exc, 'response', None)
        if resp is not None:
            status = getattr(resp, 'status_code', None)
            try:
                body = resp.text
            except Exception:
                body = getattr(resp, 'content', None)
            body_str = str(body).strip() if body is not None else str(exc).strip()
            if status is not None:
                return f'Error {status}: {body_str}' if body_str else f'Error {status}'
            return body_str

        status = getattr(exc, 'status_code', None)
        if status is not None:
            msg = getattr(exc, 'message', None) or getattr(exc, 'detail', None) or str(exc)
            return f'Error {status}: {str(msg).strip()}'

        # pymilvus exceptions often have .code and .message
        code = getattr(exc, 'code', None)
        msg = getattr(exc, 'message', None)
        if msg is None:
            # Some exceptions expose args like (code, message)
            args = getattr(exc, 'args', ())
            if isinstance(args, (list, tuple)) and len(args) >= 2:
                code = code or args[0]
                msg = args[1]
            elif isinstance(args, (list, tuple)) and len(args) == 1:
                msg = args[0]
        msg_str = str(msg).strip() if msg is not None else str(exc).strip()
        if code is not None and str(code) not in msg_str:
            return f'Error {code}: {msg_str}' if msg_str else f'Error {code}'
        return msg_str
    except Exception:
        return str(exc).strip()


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
        # An unfilled reference is reported as such; the probe must not send the placeholder as the token
        if not is_local(config) and warn_if_credential_unresolved(self.glb.logicalType, 'apikey', config['apikey']):
            return
        probe_connection(config)
