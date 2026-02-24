# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
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
Global state for the LLM MCP Agent: connects to one or more MCP servers via
SSE at startup, discovers tools dynamically, and caches the merged LangChain
tool list for use by all IInstance threads.

Configuration is read from the node's connConfig (under the ``mcpServers`` key)
or from the ``MCP_SERVERS_JSON`` environment variable.

Expected format::

    {
        "mcpServers": {
            "aql":  { "url": "http://localhost:8000/sse" },
            "docs": { "url": "http://other:4000/sse", "headers": { "Authorization": "Bearer tok" } }
        },
        "prompt": "You are a data analyst. Always return structured results."
    }

The optional top-level ``prompt`` string is injected into the system prompt
sent to the LLM.
"""

import json
import os

from rocketlib import IGlobalBase, debug
from ai.common.config import Config

from .mcp_client import McpConnectionError, McpServerConnection
from .mcp_tool_bridge import mcp_tools_to_langchain


class IGlobal(IGlobalBase):
    """Connects to MCP servers, discovers tools, exposes merged LangChain tool list."""

    _connections: list[McpServerConnection]
    _all_tools: list  # list[StructuredTool]
    _prompt: str  # optional user-defined system prompt

    def beginGlobal(self):
        self._connections = []
        self._all_tools = []
        self._prompt = ''

        try:
            self._begin_global_inner()
        except Exception as exc:
            debug(f'[llm_mcp_agent] beginGlobal failed: {type(exc).__name__}: {exc}')

    def _begin_global_inner(self):
        from depends import depends  # type: ignore

        req = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
        depends(req)

        # --- Read config ---
        config = self._load_config()
        self._prompt = str(config.get('prompt', '') or '').strip()
        mcp_servers = config.get('mcpServers') or {}
        if not mcp_servers:
            debug('[llm_mcp_agent] No MCP servers configured — node will have no tools')
            return

        # --- Connect to each MCP server ---
        for name, server_cfg in mcp_servers.items():
            url = server_cfg.get('url', '').strip()
            if not url:
                debug(f'[llm_mcp_agent] Server {name!r} has no url — skipping')
                continue

            headers = server_cfg.get('headers') or {}
            timeout = float(server_cfg.get('timeout', 30))

            conn = McpServerConnection(name=name, url=url, headers=headers, timeout=timeout)
            try:
                conn.connect()
                self._connections.append(conn)
                debug(f'[llm_mcp_agent] Connected to {name!r} — {len(conn.get_tools())} tools discovered')
            except McpConnectionError as exc:
                debug(f'[llm_mcp_agent] Failed to connect to MCP server {name!r}: {exc}')
            except Exception as exc:
                debug(f'[llm_mcp_agent] Error connecting to {name!r}: {exc}')

        # --- Convert discovered tools to LangChain StructuredTools ---
        for conn in self._connections:
            lc_tools = mcp_tools_to_langchain(conn)
            self._all_tools.extend(lc_tools)

        debug(
            f'[llm_mcp_agent] Ready — {len(self._connections)} server(s), '
            f'{len(self._all_tools)} tools'
        )

    def _load_config(self) -> dict:
        """Load node config from connConfig or environment."""
        # Try node connConfig first
        try:
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        except Exception:
            config = {}

        mcp_servers = config.get('mcpServers')
        if mcp_servers and hasattr(mcp_servers, 'keys'):
            # Accept both plain dict and IJson (C++ backed dict-like object)
            # Convert IJson to plain dicts so downstream code works with standard types
            result = {}
            for name in mcp_servers.keys():
                srv = mcp_servers[name]
                if hasattr(srv, 'keys'):
                    result[str(name)] = {str(k): srv[k] for k in srv.keys()}
                elif isinstance(srv, str):
                    try:
                        result[str(name)] = json.loads(srv)
                    except (json.JSONDecodeError, TypeError):
                        result[str(name)] = {'url': srv}
                else:
                    result[str(name)] = dict(srv) if srv else {}
            config = dict(config) if hasattr(config, 'keys') else {}
            config['mcpServers'] = result
            return config

        # Fall back to environment variable
        env_json = os.environ.get('MCP_SERVERS_JSON', '').strip()
        if env_json:
            try:
                parsed = json.loads(env_json)
                if isinstance(parsed, dict):
                    servers = parsed.get('mcpServers', parsed)
                    return {'mcpServers': servers, 'prompt': parsed.get('prompt', '')}
            except json.JSONDecodeError as exc:
                debug(f'[llm_mcp_agent] Invalid MCP_SERVERS_JSON: {exc}')

        return {}

    @property
    def tools(self) -> list:
        """Merged LangChain StructuredTool list from all connected MCP servers."""
        return self._all_tools

    @property
    def tool_summary(self) -> str:
        """Auto-generated tool listing for the system prompt."""
        lines: list[str] = []
        for conn in self._connections:
            for t in conn.get_tools():
                lines.append(f'- [{conn.name}] {t.name}: {t.description or ""}')
        return '\n'.join(lines)

    @property
    def prompt(self) -> str:
        """Optional user-defined system prompt from node config."""
        return self._prompt

    @property
    def connections(self) -> list[McpServerConnection]:
        """Active MCP server connections."""
        return list(self._connections)

    def endGlobal(self):
        for conn in self._connections:
            try:
                conn.disconnect()
            except Exception as exc:
                debug(f'[llm_mcp_agent] Error disconnecting {conn.name}: {exc}')
        self._connections = []
        self._all_tools = []
