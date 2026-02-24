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
Synchronous wrapper around the async MCP Python SDK (SSE transport).

A dedicated daemon thread runs an asyncio event loop.  All MCP calls
(connect, list_tools, call_tool) are submitted as coroutines via
``asyncio.run_coroutine_threadsafe`` so the caller never blocks on
``asyncio.run()`` — which would fail inside the engine's own event loop.
"""

import asyncio
import logging
import threading
from contextlib import AsyncExitStack
from typing import Any

# NOTE: ``mcp`` is NOT imported at module level.  The package is installed by
# ``depends()`` in IGlobal.beginGlobal() which runs *after* the engine loads
# this module.  Every reference to mcp types is therefore a lazy import inside
# the method that needs it.

_log = logging.getLogger(__name__)


class McpConnectionError(Exception):
    """Raised when an MCP server cannot be reached or returns an error."""


class McpServerConnection:
    """Sync facade for a single MCP server reachable over SSE."""

    def __init__(
        self,
        name: str,
        url: str,
        headers: dict[str, str] | None = None,
        timeout: float = 30.0,
    ):
        self.name = name
        self.url = url
        self.headers = headers or {}
        self.timeout = timeout

        self._tools: list = []  # list of mcp.types.Tool (lazy import)
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._session = None  # mcp.ClientSession (lazy import)
        self._exit_stack: AsyncExitStack | None = None
        self._connected = False

    # ------------------------------------------------------------------
    # Async internals
    # ------------------------------------------------------------------

    def _start_loop(self) -> None:
        """Start a dedicated daemon thread with its own event loop."""
        self._loop = asyncio.new_event_loop()
        self._thread = threading.Thread(
            target=self._loop.run_forever,
            name=f'mcp-loop-{self.name}',
            daemon=True,
        )
        self._thread.start()

    def _run_sync(self, coro: Any) -> Any:
        """Submit *coro* to the background loop and block until done."""
        if self._loop is None or self._loop.is_closed():
            raise McpConnectionError(f'[{self.name}] Event loop not running')
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=self.timeout)

    async def _connect_async(self) -> None:
        """Open SSE transport → ClientSession → list_tools."""
        from mcp import ClientSession
        from mcp.client.sse import sse_client

        self._exit_stack = AsyncExitStack()
        sse_kwargs: dict[str, Any] = {'url': self.url}
        if self.headers:
            sse_kwargs['headers'] = self.headers

        streams = await self._exit_stack.enter_async_context(
            sse_client(**sse_kwargs)
        )
        self._session = await self._exit_stack.enter_async_context(
            ClientSession(*streams)
        )
        await self._session.initialize()
        await self._refresh_tools_async()

    async def _refresh_tools_async(self) -> None:
        """Fetch the current tool list from the MCP server."""
        if self._session is None:
            raise McpConnectionError(f'[{self.name}] No active session')
        result = await self._session.list_tools()
        self._tools = list(result.tools)
        _log.info(
            '[%s] Discovered %d tools: %s',
            self.name,
            len(self._tools),
            ', '.join(t.name for t in self._tools),
        )

    async def _call_tool_async(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Call a single tool and return the text content."""
        if self._session is None:
            raise McpConnectionError(f'[{self.name}] No active session')
        result = await self._session.call_tool(tool_name, arguments)
        parts: list[str] = []
        for block in result.content:
            if hasattr(block, 'text'):
                parts.append(block.text)
            else:
                parts.append(str(block))
        return '\n'.join(parts)

    async def _disconnect_async(self) -> None:
        """Tear down the SSE transport and session."""
        if self._exit_stack is not None:
            await self._exit_stack.aclose()
            self._exit_stack = None
        self._session = None

    # ------------------------------------------------------------------
    # Public synchronous API
    # ------------------------------------------------------------------

    def connect(self) -> None:
        """Connect to the MCP server, discover tools."""
        _log.info('[%s] Connecting to %s …', self.name, self.url)
        try:
            self._start_loop()
            self._run_sync(self._connect_async())
            self._connected = True
            _log.info('[%s] Connected — %d tools available', self.name, len(self._tools))
        except Exception as exc:
            self.disconnect()
            raise McpConnectionError(
                f'[{self.name}] Failed to connect to {self.url}: {exc}'
            ) from exc

    def call_tool(self, tool_name: str, arguments: dict[str, Any]) -> str:
        """Call a tool on this MCP server (synchronous)."""
        if not self._connected:
            raise McpConnectionError(f'[{self.name}] Not connected')
        try:
            return self._run_sync(self._call_tool_async(tool_name, arguments))
        except McpConnectionError:
            raise
        except Exception as exc:
            raise McpConnectionError(
                f'[{self.name}] Tool call {tool_name!r} failed: {exc}'
            ) from exc

    def get_tools(self) -> list:
        """Return cached MCP tool definitions (mcp.types.Tool objects)."""
        return list(self._tools)

    def refresh_tools(self) -> None:
        """Re-fetch tools/list to pick up server-side changes."""
        if not self._connected:
            raise McpConnectionError(f'[{self.name}] Not connected')
        self._run_sync(self._refresh_tools_async())

    def disconnect(self) -> None:
        """Tear down the connection and background loop."""
        if self._loop is not None and not self._loop.is_closed():
            try:
                self._run_sync(self._disconnect_async())
            except Exception:
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=5)
        self._connected = False
        self._session = None
        self._loop = None
        self._thread = None
        _log.info('[%s] Disconnected', self.name)

    @property
    def is_connected(self) -> bool:
        return self._connected
