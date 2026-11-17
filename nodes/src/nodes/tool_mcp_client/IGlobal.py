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

- Reads the selected transport and its connection settings from the resolved
  config (the active transport branch is flattened in: commandLine for stdio,
  endpoint/headers/bearer for streamable-http, sse_endpoint/headers/bearer
  for the legacy SSE transport)
- Spawns or connects the MCP client and performs the initialize handshake
- Discovers tools at startup via tools/list and caches them
- Re-reads the catalog on every discovery query and on every lookup miss
  (rate-limited), so tools added or renamed on a running server become
  callable without restarting the engine (issue #1402)
- Passes configured environment variables to a stdio server, and exposes only
  the allowed tools when a call sets an allow list (a per-call parameter the
  instance reads and passes in; the cached catalog itself stays whole)
"""

from __future__ import annotations

import json
import re
import shlex
import threading
import time
from typing import Any, Dict, List, Optional

from rocketlib import IGlobalBase, warning

from .mcp_stdio_client import McpStdioClient, McpToolDef
from .mcp_sse_client import McpSseClient
from .mcp_streamable_http_client import McpStreamableHttpClient

# The catalog is re-read from the server on every discovery query (a new
# agent instance building its tool list, or the agent host re-querying this
# node after a miss) and on every lookup miss - but at most this often, so a
# burst of queries or repeated misses for one unknown tool (schema lookup,
# then invoke) costs the server a single tools/list.
REFRESH_MIN_INTERVAL_S = 1.0


def _monotonic() -> float:
    """Clock used for the refresh rate limit.

    Indirection on purpose: tests drive this instead of patching
    ``time.monotonic`` on the stdlib module, which is process-wide and would
    reach anything else relying on it.
    """
    return time.monotonic()


class ToolUnavailableError(Exception):
    """A tool the agent asked for is not on the MCP server, even after a
    catalog refresh. Distinct from a transport failure so callers can tell
    "this tool does not exist" from "the server did not answer".
    """


def _headers(cfg, bearer: str) -> Optional[Dict[str, str]]:
    """The HTTP headers of the active transport branch, with the bearer token applied."""
    raw = cfg.get('headers') or None
    if raw is not None and not (hasattr(raw, 'get') and hasattr(raw, 'items')):
        raise Exception('mcp_client headers must be a dictionary of strings')
    headers = {str(k): str(v) for k, v in raw.items()} if raw else None
    if bearer:
        headers = dict(headers or {})
        headers['Authorization'] = f'Bearer {bearer}'
    return headers


def _env(cfg) -> Optional[Dict[str, str]]:
    """The environment variables of the stdio branch, as strings; None when none are set."""
    raw = cfg.get('env') or None
    if raw is not None and not (hasattr(raw, 'get') and hasattr(raw, 'items')):
        raise Exception('mcp_client env must be a dictionary of strings')
    return {str(k): str(v) for k, v in raw.items()} if raw else None


class IGlobal(IGlobalBase):
    """Global state for mcp_client: the MCP session and its tool catalog, keyed by original tool name."""

    def beginGlobal(self) -> None:
        # The resolved config: the transport branch, its endpoint required by the
        # schema. serverName is the call's namespace over the catalog, not the control's
        cfg = self.config

        self.transport = cfg.transport

        try:
            if self.transport == 'stdio':
                parts = shlex.split(cfg.commandLine)
                if not parts:
                    raise Exception('mcp_client commandLine must not be empty')
                self._client = McpStdioClient(command=parts[0], args=parts[1:], env=_env(cfg))
            else:
                # The bearer token reaches the node through its config (a
                # ${ROCKETRIDE_MCP_CLIENT_BEARER} reference resolved per call)
                headers = _headers(cfg, str(cfg.get('bearer') or '').strip())
                if self.transport == 'sse':
                    # Legacy HTTP+SSE transport
                    self._client = McpSseClient(sse_endpoint=cfg.sse_endpoint.strip(), headers=headers)
                else:
                    self._client = McpStreamableHttpClient(endpoint=cfg.endpoint.strip(), headers=headers)
            self._client.start()
            tools = self._client.list_tools()
            self._cache_tools(tools)
        except Exception as e:
            warning(str(e))
            raise

    def endGlobal(self) -> None:
        try:
            client = getattr(self, '_client', None)
            if client is not None:
                client.stop()
        finally:
            self._client = None
            self._tools_by_original = {}

    # ------------------------------------------------------------------
    # Tool cache + accessors for IInstance hooks
    # ------------------------------------------------------------------
    def _cache_tools(self, tools: List[McpToolDef]) -> None:
        """Replace the cached catalog atomically.

        Both maps are built locally and swapped in with plain attribute
        assignment, so a reader iterating the previous maps never observes a
        half-filled catalog.
        """
        by_original: Dict[str, McpToolDef] = {}
        for t in tools:
            by_original[t.name] = t
        self._tools_by_original = by_original
        self._catalog_fetched_at = _monotonic()

    def refresh_tools(self, *, reason: str, min_age_s: float = 0.0, label: str = 'mcp') -> bool:
        """Re-read tools/list from the server and swap the cache.

        Returns True when the catalog was refreshed, False when there is no
        connected client, the catalog is younger than ``min_age_s``, or the
        server did not answer (the previous catalog is kept in that case).
        Serialized so concurrent misses trigger one tools/list, not a
        stampede. Emits a warning naming the tools that appeared or
        disappeared, so a changed catalog is visible in the run.
        """
        client = getattr(self, '_client', None)
        if client is None:
            return False
        lock = self.__dict__.setdefault('_refresh_lock', threading.Lock())
        with lock:
            fetched_at = getattr(self, '_catalog_fetched_at', None)
            if fetched_at is not None and min_age_s > 0 and (_monotonic() - fetched_at) < min_age_s:
                return False
            try:
                tools = client.list_tools()
            except Exception as e:
                warning(f"mcp_client '{label}': tool catalog refresh ({reason}) failed: {e}")
                return False
            before = set((getattr(self, '_tools_by_original', None) or {}).keys())
            self._cache_tools(tools)
            after = set(self._tools_by_original.keys())
            added, removed = sorted(after - before), sorted(before - after)
            if added or removed:
                warning(
                    f"mcp_client '{label}': tool catalog changed on refresh ({reason}); added={added} removed={removed}"
                )
            return True

    def list_namespaced_tools(self, server_name: str, allowed: Optional[set] = None) -> List[Dict[str, Any]]:
        """The catalog under one call's namespace (``server_name.tool``).

        ``allowed`` is the call's allow list (``parse_allowed_tools``): when
        set, tools outside it are left out, so the agent never sees them, and
        a listed name the server does not offer is reported in a warning
        together with the names it does offer.
        """
        self.refresh_tools(reason='catalog query', min_age_s=REFRESH_MIN_INTERVAL_S, label=server_name)
        catalog = getattr(self, '_tools_by_original', None) or {}
        if allowed is not None:
            missing = sorted(allowed - set(catalog))
            if missing:
                warning(
                    f"mcp_client '{server_name}': allowed tools not on the server: {missing}; "
                    f'server tools: {sorted(catalog)}'
                )
        out: List[Dict[str, Any]] = []
        for name, tool in catalog.items():
            if allowed is not None and name not in allowed:
                continue
            out.append(
                {'name': f'{server_name}.{name}', 'description': tool.description, 'inputSchema': tool.inputSchema}
            )
        return out

    def get_tool(self, *, server_name: str, tool_name: str, allowed: Optional[set] = None) -> Optional[McpToolDef]:
        """One tool of the catalog by original name; ``server_name`` (the call's, already checked) labels a refresh.

        A name outside the call's ``allowed`` list is None, without a refresh.
        """
        if allowed is not None and tool_name not in allowed:
            # No refresh can make a tool outside allowedTools available.
            return None
        tool = (getattr(self, '_tools_by_original', None) or {}).get(tool_name)
        if tool is None:
            self.refresh_tools(
                reason=f'lookup miss for {tool_name!r}', min_age_s=REFRESH_MIN_INTERVAL_S, label=server_name
            )
            # Re-read whatever the attempt returned: False also means "another
            # thread refreshed inside the rate-limit window", and that refresh
            # may be the one carrying this tool.
            tool = (getattr(self, '_tools_by_original', None) or {}).get(tool_name)
        return tool

    def call_tool(
        self, *, server_name: str, tool_name: str, arguments: Dict[str, Any], allowed: Optional[set] = None
    ) -> Dict[str, Any]:
        """Call one tool; ``server_name`` (the call's, already checked) names the server in errors.

        A tool outside the call's ``allowed`` list is refused as unknown and
        never sent to the server.
        """
        if getattr(self, '_client', None) is None:
            raise Exception('MCP client is not connected')
        # A tool the catalog does not know is refreshed once, then refused
        # loudly rather than handed to the server (whose "not found" a weak
        # planner narrates around).
        if self.get_tool(server_name=server_name, tool_name=tool_name, allowed=allowed) is None:
            known = sorted(
                name for name in (getattr(self, '_tools_by_original', None) or {}) if allowed is None or name in allowed
            )
            raise ToolUnavailableError(
                f"Tool {tool_name!r} is not available on MCP server '{server_name}' "
                f'(catalog refreshed; known tools: {known})'
            )
        return self._client.call_tool(name=tool_name, arguments=arguments or {})


def parse_allowed_tools(raw: Any) -> Optional[set]:
    """Read the allowed tool names from a call's settings.

    Accepts the config panel's rows (``[{'toolName': ...}]``), a list of
    names, or a string of names separated by commas or newlines. Returns
    ``None`` when no names are set, which allows every tool.
    """
    if raw is None or raw == '':
        return None
    if not isinstance(raw, (str, list)):
        # An engine JSON value (IJson) prints as its JSON text.
        try:
            raw = json.loads(str(raw))
        except (json.JSONDecodeError, ValueError) as e:
            raise ValueError(f'allowedTools is malformed and cannot be parsed: {e}') from e
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.startswith(('[', '{')):
            try:
                raw = json.loads(stripped)
            except (json.JSONDecodeError, ValueError) as e:
                raise ValueError(f'allowedTools is malformed and cannot be parsed: {e}') from e
        else:
            raw = re.split(r'[,\n]', stripped)
    if not isinstance(raw, list):
        raise ValueError('allowedTools must be a list of tool names')
    names = set()
    for item in raw:
        if hasattr(item, 'get'):
            # A blank row is ignored, but a row naming its tool under another
            # key must not leave the list empty and expose every tool.
            if item and item.get('toolName') is None:
                raise ValueError(f'allowedTools row {item!r} has no toolName')
            item = item.get('toolName')
        name = str(item or '').strip()
        if name:
            names.add(name)
    return names or None
