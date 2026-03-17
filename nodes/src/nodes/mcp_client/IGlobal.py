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
MCP tool client node - global (shared) state.

Step 3: STDIO transport (no external MCP SDK dependency).
- Spawns MCP server process
- Performs MCP initialize handshake
- Discovers tools at startup via tools/list and caches them
"""

from __future__ import annotations

import shlex
from typing import Any, Dict, List, Optional

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning


def _is_mapping(obj: Any) -> bool:
    """Check if obj is dict-like (supports .get and .items), including IJson."""
    return hasattr(obj, 'get') and hasattr(obj, 'items')

from .mcp_stdio_client import McpStdioClient, McpToolDef
from .mcp_sse_client import McpSseClient
from .mcp_streamable_http_client import McpStreamableHttpClient
from .mcp_driver import McpDriver


class IGlobal(IGlobalBase):
    """Global state for mcp_client."""

    driver: McpDriver | None = None

    def beginGlobal(self) -> None:
        # Skip heavy initialization in CONFIG mode (matches other nodes).
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Use the node's catalog name as the tool namespace prefix, falling
        # back to the legacy serverName config key, then 'mcp'.
        self.serverName = str((cfg.get('name') or cfg.get('serverName') or 'mcp')).strip()
        self.transport = str((cfg.get('transport') or 'stdio')).strip().lower()

        # The UI nests transport-specific fields under 'stdio'/'sse'/'http'
        # objects. Resolve the nested config so field lookups work regardless
        # of whether the config is flat (preconfig/back-compat) or nested (UI).
        _transport_key = {'stdio': 'stdio', 'sse': 'sse', 'streamable-http': 'http'}.get(self.transport)
        _sub = cfg.get(_transport_key) if _transport_key else None
        tcfg = _sub if _is_mapping(_sub) else {}

        def _get(key: str, default: str = '') -> str:
            """Look up a config key from the transport sub-object first, then top-level."""
            val = tcfg.get(key) if tcfg else None
            if not val:
                val = cfg.get(key)
            return str(val).strip() if val else default

        try:
            if self.transport == 'stdio':
                # Preferred: parse a single command line string.
                command_line = _get('commandLine')
                if command_line:
                    parts = shlex.split(command_line)
                    if not parts:
                        raise Exception('mcp_client commandLine must not be empty')
                    command, args = parts[0], parts[1:]
                else:
                    # Back-compat: older configs used `command` + `args`.
                    command = _get('command', 'python')
                    args = tcfg.get('args') or cfg.get('args') or []
                    if isinstance(args, str):
                        args = [args]
                    if not isinstance(args, list):
                        raise Exception('mcp_client args must be a list of strings')
                    args = [str(a) for a in args]

                self._client = McpStdioClient(command=command, args=args)

            elif self.transport in ('sse', 'streamable-http'):
                # Shared auth headers for HTTP transports
                headers = tcfg.get('headers') or cfg.get('headers') or None
                if headers is not None and not _is_mapping(headers):
                    raise Exception('mcp_client headers must be a dictionary of strings')
                if _is_mapping(headers):
                    headers = {str(k): str(v) for k, v in headers.items()}

                bearer = _get('bearer') or None

                if self.transport == 'sse':
                    # Legacy HTTP+SSE transport
                    sse_endpoint = _get('sse_endpoint') or _get('endpoint')
                    if not sse_endpoint:
                        raise Exception('mcp_client sse_endpoint is required for sse transport')

                    if bearer:
                        headers = dict(headers or {})
                        headers['Authorization'] = f'Bearer {bearer}'

                    self._client = McpSseClient(sse_endpoint=sse_endpoint, headers=headers)

                elif self.transport == 'streamable-http':
                    endpoint = _get('endpoint')
                    if not endpoint:
                        raise Exception('mcp_client endpoint is required for streamable-http transport')

                    if bearer:
                        headers = dict(headers or {})
                        headers['Authorization'] = f'Bearer {bearer}'

                    self._client = McpStreamableHttpClient(endpoint=endpoint, headers=headers)

            else:
                raise Exception(
                    f'mcp_client transport {self.transport!r} not supported '
                    '(use stdio, streamable-http, or sse)'
                )

            self._client.start()
            tools = self._client.list_tools()
            self._cache_tools(tools)

            self.driver = McpDriver(
                server_name=self.serverName,
                list_namespaced_tools=self.list_namespaced_tools,
                get_tool=lambda server, name: self.get_tool(server_name=server, tool_name=name),
                call_tool=lambda server, name, args: self.call_tool(server_name=server, tool_name=name, arguments=args),
            )
        except Exception as e:
            warning(str(e))
            raise

    def validateConfig(self) -> None:
        """
        Validate config at save-time with quick local checks.

        Matches other nodes: surface issues via warning().
        """
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            transport = str((cfg.get('transport') or 'stdio')).strip().lower()
            if transport not in ('stdio', 'sse', 'streamable-http'):
                warning('transport must be stdio, streamable-http, or sse')
                return

            _transport_key = {'stdio': 'stdio', 'sse': 'sse', 'streamable-http': 'http'}.get(transport)
            _sub = cfg.get(_transport_key) if _transport_key else None
            tcfg = _sub if _is_mapping(_sub) else {}

            def _vget(key: str) -> str:
                val = tcfg.get(key) if tcfg else None
                if not val:
                    val = cfg.get(key)
                return str(val).strip() if val else ''

            if transport == 'stdio':
                command_line = _vget('commandLine')
                if command_line:
                    try:
                        parts = shlex.split(command_line)
                    except Exception:
                        warning('commandLine is invalid (unable to parse)')
                        return
                    if not parts:
                        warning('commandLine must not be empty')
                        return
                else:
                    # Back-compat: older configs used `command` + `args`.
                    command = _vget('command')
                    if not command:
                        warning('commandLine is required for stdio transport')
                        return
                    args = tcfg.get('args') or cfg.get('args') or []
                    if not isinstance(args, list):
                        warning('args must be a list for stdio transport')
                        return
            elif transport == 'sse':
                endpoint = _vget('sse_endpoint')
                if not endpoint:
                    warning('sse_endpoint is required for sse transport')
                    return
            else:
                endpoint = _vget('endpoint')
                if not endpoint:
                    warning('endpoint is required for streamable-http transport')
                    return
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        try:
            client = getattr(self, '_client', None)
            if client is not None:
                client.stop()
        finally:
            self.driver = None
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
                f'Unknown MCP serverName {server_name!r} (this node configured as {self.serverName!r})'
            )
        if self._client is None:
            raise Exception('MCP client is not connected')
        return self._client.call_tool(name=tool_name, arguments=arguments or {})

