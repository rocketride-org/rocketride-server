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


class IGlobal(StoreGlobalBase):
    """Global interface for the Milvus node."""

    serverName: str = 'milvus'

    # Precompiled rules for Milvus collection names
    NAME_PATTERN = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,254}$')
    RULES_TEXT = 'Rules: 1) length 1–255, 2) Letters (A–Z, a–z), digits (0–9), and underscores only, 3) start with a letter or underscore, 4) subsequent characters may be letters, digits, or underscores.'

    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]):
        """Return the driver's Store, imported lazily so config mode never loads the driver."""
        from .milvus import Store

        return Store(logical_type, conn_config, bag)

    def _sub_key(self) -> str:
        """Return the transform sub-key: host/port/collection."""
        return f'{self.store.host}/{self.store.port}/{self.store.collection}'

    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Validate Milvus configuration at save-time with a minimal probe."""
        try:
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Defer imports after deps
            from pymilvus import connections, utility, exceptions as milvus_exc

            # Read config
            host_raw = config.get('host', '').strip()
            token = (config.get('apikey') or '').strip()  # cloud
            # Use port exactly as provided by UI (let SDK validate)
            port = config.get('port')
            collection = config.get('collection', '').strip()

            # Collection name rules: ASCII only, start rule, length 1–255
            if len(collection) >= 256 or not self.NAME_PATTERN.match(collection):
                warning(f'Invalid collection name. {self.RULES_TEXT}')
                return

            # Connect (no creation during validation)
            try:
                alias = 'validate'
                # Clear previous validation connection if present
                try:
                    connections.disconnect(alias)
                except Exception:
                    pass

                if token:
                    # Cloud: pass UI host and port verbatim via URI
                    uri = f'{host_raw}:{port}'
                    connections.connect(alias=alias, uri=uri, token=token, timeout=5)
                else:
                    # Local: pass host/port exactly as provided
                    connections.connect(alias=alias, host=host_raw, port=port, timeout=5)

                # Minimal probe on the same alias
                utility.get_server_version(using=alias)
                return
            except milvus_exc.MilvusException as e:
                warning(self._format_error(e))
                return
            except Exception as e:
                warning(self._format_error(e))
                return

        except Exception as e:
            warning(str(e))
            return

    def _format_error(self, exc: Exception) -> str:
        """Return concise error string for Milvus/driver exceptions."""
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
