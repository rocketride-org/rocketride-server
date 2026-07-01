# =============================================================================
# RocketRide Engine
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
FalkorDB tool node - global (shared) state.

Reads the connection settings from config, creates a FalkorDB client and
verifies connectivity. Tool logic lives on IInstance via @tool_function.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, debug, warning

from falkordb import FalkorDB


def _int_or(value, default: int, *, lo: int, hi: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(n, hi))


def _bool_of(value) -> bool:
    if isinstance(value, str):
        return value.strip().lower() in {'1', 'true', 'yes', 'on'}
    return bool(value)


class IGlobal(IGlobalBase):
    """Global state for tool_falkordb."""

    client: FalkorDB | None = None
    # Unprefixed config values set during beginGlobal.
    graph_name: str = 'agent'
    allow_writes: bool = False
    max_rows: int = 250
    query_timeout_ms: int = 30000

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        host = str((cfg.get('host') or 'localhost')).strip() or 'localhost'
        port = _int_or(cfg.get('port'), 6379, lo=1, hi=65535)
        username = str((cfg.get('username') or '')).strip()
        # Do NOT strip the password — whitespace is valid in passwords.
        password = str(cfg.get('password') or '')
        tls = _bool_of(cfg.get('tls'))

        self.graph_name = str((cfg.get('graph') or 'agent')).strip() or 'agent'
        self.allow_writes = _bool_of(cfg.get('allow_writes'))
        self.max_rows = _int_or(cfg.get('max_rows'), 250, lo=1, hi=25000)
        self.query_timeout_ms = _int_or(cfg.get('query_timeout_ms'), 30000, lo=100, hi=600000)

        client_kwargs = {'host': host, 'port': port}
        if username:
            client_kwargs['username'] = username
        if password:
            client_kwargs['password'] = password
        if tls:
            client_kwargs['ssl'] = True

        self.client = FalkorDB(**client_kwargs)
        # Fail fast on bad host/credentials instead of on the first tool call.
        self.client.list_graphs()
        debug(f'tool_falkordb: connected to {host}:{port}, default graph={self.graph_name}')

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            host = str((cfg.get('host') or '')).strip()
            if not host:
                warning('host is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        if self.client is not None:
            try:
                self.client.close()
            except Exception as e:
                warning(f'tool_falkordb: close failed: {e}')
            finally:
                self.client = None
