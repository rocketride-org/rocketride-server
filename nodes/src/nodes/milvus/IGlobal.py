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
from rocketlib import OPEN_MODE, warning
from ai.common.config import Config
from ai.common.transform import IGlobalTransform


class IGlobal(IGlobalTransform):
    """Global interface for the Milvus node."""

    # Precompiled rules for Milvus collection names
    NAME_PATTERN = re.compile(r'^[A-Za-z_][A-Za-z0-9_]{0,254}$')
    RULES_TEXT = 'Rules: 1) length 1–255, 2) Letters (A–Z, a–z), digits (0–9), and underscores only, 3) start with a letter or underscore, 4) subsequent characters may be letters, digits, or underscores.'

    def validateConfig(self):
        """Validate Milvus configuration at save-time with a minimal probe."""
        try:
            from depends import depends  # type: ignore

            requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
            depends(requirements)

            # Defer imports after deps
            from pymilvus import connections, utility, exceptions as milvus_exc

            # Read config
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
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

    def beginGlobal(self):
        """Initialize global resources for the Milvus node."""
        # Are we in config mode or some other mode?
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            # We are going to get a call to configureService but
            # we don't actually need to load the driver for that
            pass
        else:
            # Import store definition - even though
            from .milvus import Store

            # Declare store
            self.store: Store | None = None

            # Get our bag
            bag = self.IEndpoint.endpoint.bag

            # The parameters are in different places based on whether we
            # are a filter or an endpoint. If we are a filter, they are in
            # glb.connConfig, otherwise the are in IEndpoint.endpoint.parameters
            connConfig = self.getConnConfig()

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

    def endGlobal(self):
        """Release global resources for the Milvus node."""
        # Release the index and embeddings
        self.store = None

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
