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
Supabase tool node — global (shared) state.

Connects to the official Supabase MCP server via Streamable HTTP transport.

MCP server: github.com/supabase-community/supabase-mcp (v0.8.1, pre-1.0)
Default endpoint: https://mcp.supabase.com/mcp (configurable; local CLI: http://localhost:54321/mcp)
Transport:  streamable-http (recommended since October 2025; replaces stdio/npx)
Auth:       OAuth 2.1 dynamic client registration (primary, browser-based) OR
            Authorization: Bearer ${SUPABASE_ACCESS_TOKEN} (CI / headless fallback)

URL query parameters (optional, appended to the endpoint):
  project_ref=<id>   — scope to a specific Supabase project
  read_only=true     — restrict to read-only Postgres user
  features=<groups>  — comma-separated tool group subset (e.g. database,docs,storage)

See: https://supabase.com/docs/guides/ai-tools/mcp
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional
import urllib.parse

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .mcp_streamable_http_client import McpStreamableHttpClient, McpToolDef

# Fallback endpoint used only when the config field is absent (e.g. old saved configs).
_SUPABASE_MCP_URL_DEFAULT = 'https://mcp.supabase.com/mcp'

# Default tool namespace exposed to agents: "supabase.<tool>"
_DEFAULT_SERVER_NAME = 'supabase'


class IGlobal(IGlobalBase):
    """Global state for the Supabase tool node."""

    serverName: str = _DEFAULT_SERVER_NAME

    @staticmethod
    def _is_mapping(obj: Any) -> bool:
        """Check if obj is dict-like (supports .get and .items), including IJson."""
        return hasattr(obj, 'get') and hasattr(obj, 'items')

    def beginGlobal(self) -> None:
        # Skip heavy initialization in CONFIG mode (matches other nodes).
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        # Allow the server name (tool namespace) to be overridden; default 'supabase'.
        self.serverName = str((cfg.get('serverName') or _DEFAULT_SERVER_NAME)).strip()

        # Base endpoint is user-configurable (set in services.json; defaults to the
        # Supabase-hosted remote server). The local CLI profile pre-fills this field
        # with http://localhost:54321/mcp instead — no separate boolean needed.
        base_url = str(cfg.get('endpoint') or _SUPABASE_MCP_URL_DEFAULT).strip()
        if not base_url:
            raise Exception('supabase: endpoint is required')

        # Optional URL parameters supported by the Supabase MCP server.
        # These are appended as query params, not CLI flags.
        project_ref = str(cfg.get('projectRef') or '').strip()
        read_only = str(cfg.get('readOnly') or '').strip().lower() in ('true', '1', 'yes')
        features = str(cfg.get('features') or '').strip()

        params: Dict[str, str] = {}
        if project_ref:
            params['project_ref'] = project_ref
        if read_only:
            params['read_only'] = 'true'
        if features:
            params['features'] = features

        if params:
            # Merge params into any existing query string via urlparse so a trailing
            # '?' or pre-existing params are handled correctly without string hacking.
            _parsed = urllib.parse.urlparse(base_url)
            _existing = urllib.parse.parse_qs(_parsed.query, keep_blank_values=True)
            _existing.update({k: [v] for k, v in params.items()})
            _new_query = urllib.parse.urlencode({k: v[0] for k, v in _existing.items()})
            endpoint = urllib.parse.urlunparse(_parsed._replace(query=_new_query))
        else:
            endpoint = base_url

        # Auth: build the Authorization header from the bearer token config field.
        # Primary path is OAuth 2.1 (browser-based, no token needed here).
        # CI / headless fallback: set SUPABASE_ACCESS_TOKEN; this node passes it
        # as Authorization: Bearer <token> if present.
        # Config.getNodeConfig does NOT expand ${VAR} references — do it here.
        bearer_raw = str(cfg.get('bearer') or '').strip()
        bearer = os.path.expandvars(bearer_raw) if bearer_raw else ''
        # If expansion left an unexpanded reference (env var not set), discard it.
        if '${' in bearer:
            bearer = ''
        headers: Dict[str, str] = {}
        if bearer:
            headers['Authorization'] = f'Bearer {bearer}'

        try:
            self._client = McpStreamableHttpClient(
                endpoint=endpoint,
                headers=headers or None,
                client_name='RocketRideSupabaseMcpClient',
            )
            self._client.start()
            tools = self._client.list_tools()
            self._cache_tools(tools)
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
            endpoint = str(cfg.get('endpoint') or '').strip()
            if not endpoint:
                warning('supabase: endpoint is required')
                return
            project_ref = str(cfg.get('projectRef') or '').strip()
            # project_ref is strongly recommended but not strictly required
            # (omitting it enables account-level tools across all projects).
            if not project_ref:
                warning(
                    'supabase: projectRef is not set — the MCP server will expose '
                    'account-level tools across all projects. Set projectRef to scope '
                    'to a single project.'
                )
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
            raise Exception(f'Unknown MCP serverName {server_name!r} (this node configured as {self.serverName!r})')
        if self._client is None:
            raise Exception('Supabase MCP client is not connected')
        return self._client.call_tool(name=tool_name, arguments=arguments or {})
