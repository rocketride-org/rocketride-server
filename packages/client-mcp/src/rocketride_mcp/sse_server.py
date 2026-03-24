# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
HTTP/SSE transport wrapper for the RocketRide MCP server.

Exposes the same MCP tools as the stdio server but over HTTP/SSE,
allowing remote clients (like Glama) to connect via network.

Usage:
    python -m rocketride_mcp.sse_server --host 0.0.0.0 --port 8080
"""

from __future__ import annotations

import argparse
import logging

from starlette.applications import Starlette
from starlette.routing import Mount, Route
from starlette.requests import Request
from starlette.responses import JSONResponse
import uvicorn

from mcp.server.lowlevel import Server, NotificationOptions
from mcp.server.models import InitializationOptions
from mcp.server.sse import SseServerTransport

from .config import load_settings
from .tools import get_tools, format_tools, execute_tool

logger = logging.getLogger(__name__)


def create_mcp_server() -> Server:
    """Create and configure the MCP server with RocketRide tools."""
    server = Server('rocketride-mcp')

    @server.list_tools()
    async def handle_list_tools():
        settings = load_settings()
        tools = get_tools(settings)
        return format_tools(tools)

    @server.call_tool()
    async def handle_call_tool(name: str, arguments: dict | None):
        settings = load_settings()
        tools = get_tools(settings)
        return await execute_tool(name, arguments or {}, tools, settings)

    return server


def create_app() -> Starlette:
    """Create the Starlette app with SSE transport."""
    mcp_server = create_mcp_server()
    sse = SseServerTransport('/messages/')

    async def handle_sse(request: Request):
        async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
            await mcp_server.run(
                streams[0],
                streams[1],
                InitializationOptions(
                    server_name='rocketride-mcp',
                    server_version='1.0.5',
                    capabilities=mcp_server.get_capabilities(
                        notification_options=NotificationOptions(),
                        experimental_capabilities={},
                    ),
                ),
            )

    async def health(request: Request):
        return JSONResponse({'status': 'ok', 'server': 'rocketride-mcp'})

    return Starlette(
        routes=[
            Route('/health', health),
            Route('/sse', handle_sse),
            Mount('/messages/', app=sse.handle_post_message),
        ],
    )


def main():
    """Start the MCP SSE server."""
    parser = argparse.ArgumentParser(description='RocketRide MCP SSE Server')
    parser.add_argument('--host', default='0.0.0.0', help='Bind host')
    parser.add_argument('--port', type=int, default=8080, help='Bind port')
    args = parser.parse_args()

    app = create_app()
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
