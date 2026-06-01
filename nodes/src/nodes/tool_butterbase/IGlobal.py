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
Butterbase tool node - global (shared) state.

A purpose-built clone of the generic ``tool_mcp_client`` node, hardcoded to
Butterbase's Streamable HTTP MCP server (https://api.butterbase.ai/mcp). On
open it connects, performs the MCP initialize handshake, and discovers
Butterbase's tools (init_app, schema, auth, storage, functions, …) via
tools/list, caching them so the agent can call them as ``butterbase.<tool>``.

Auth is a single Bearer API key (``bb_sk_...``). The only required config is
that key; the endpoint defaults to production and is overridable.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, error, warning

from .mcp_streamable_http_client import McpStreamableHttpClient, McpToolDef

_DEFAULT_ENDPOINT = 'https://api.butterbase.ai/mcp'
_SERVER_NAME = 'butterbase'


class IGlobal(IGlobalBase):
    """Global state for tool_butterbase."""

    serverName: str = _SERVER_NAME
    endpoint: str = _DEFAULT_ENDPOINT

    def beginGlobal(self) -> None:
        # Skip heavy initialization in CONFIG mode (matches other nodes).
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        api_key = str(cfg.get('api_key') or os.environ.get('BUTTERBASE_API_KEY', '')).strip()
        if not api_key:
            error('tool_butterbase: api_key is required — set it in node config or BUTTERBASE_API_KEY env var')
            raise ValueError('tool_butterbase: api_key is required')

        self.serverName = str(cfg.get('serverName') or _SERVER_NAME).strip() or _SERVER_NAME
        self.endpoint = str(cfg.get('endpoint') or _DEFAULT_ENDPOINT).strip() or _DEFAULT_ENDPOINT

        headers: Dict[str, str] = {'Authorization': f'Bearer {api_key}'}

        try:
            self._client = McpStreamableHttpClient(endpoint=self.endpoint, headers=headers)
            self._client.start()
            tools = self._client.list_tools()
            self._cache_tools(tools)
        except Exception as e:
            warning(str(e))
            raise

    def validateConfig(self) -> None:
        """Validate config at save-time with quick local checks."""
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            api_key = str(cfg.get('api_key') or os.environ.get('BUTTERBASE_API_KEY', '')).strip()
            if not api_key:
                warning('api_key is required (Butterbase bb_sk_... key)')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        try:
            client = getattr(self, '_client', None)
            if client is not None:
                client.stop()
        finally:
            self._client = None
            self._tools_by_original = {}
            self._tools_by_namespaced = {}

    # ------------------------------------------------------------------
    # Tool cache + accessors for IInstance hooks
    # ------------------------------------------------------------------
    def _cache_tools(self, tools: List[McpToolDef]) -> None:
        self._tools_by_original: Dict[str, McpToolDef] = {}
        self._tools_by_namespaced: Dict[str, McpToolDef] = {}
        for t in tools:
            self._tools_by_original[t.name] = t
            self._tools_by_namespaced[f'{self.serverName}.{t.name}'] = t

    def list_namespaced_tools(self) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for namespaced, tool in (self._tools_by_namespaced or {}).items():
            out.append({'name': namespaced, 'description': tool.description, 'input_schema': tool.inputSchema})
        return out

    def get_tool(self, *, server_name: str, tool_name: str) -> Optional[McpToolDef]:
        if server_name != self.serverName:
            return None
        return (self._tools_by_original or {}).get(tool_name)

    def call_tool(self, *, server_name: str, tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
        if server_name != self.serverName:
            raise Exception(
                f'Unknown Butterbase serverName {server_name!r} (this node configured as {self.serverName!r})'
            )
        if self._client is None:
            raise Exception('Butterbase MCP client is not connected')
        return self._client.call_tool(name=tool_name, arguments=arguments or {})
