# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
HTTP/SSE transport for the RocketRide MCP server.

Exposes the same MCP tools as the stdio server but over HTTP/SSE,
allowing remote clients (like Glama) to connect via network.

Requires ROCKETRIDE_URI and optionally ROCKETRIDE_AUTH env vars
to connect to a running RocketRide engine.

Set MCP_API_KEY env var to require Bearer token authentication.

Usage:
    ROCKETRIDE_URI=ws://engine:5565 python -m rocketride_mcp.sse_server
"""

from __future__ import annotations

import argparse
import logging
import os

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.routing import Mount, Route
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
import uvicorn

from mcp.server.lowlevel import Server
from mcp.server.sse import SseServerTransport
import mcp.types as types

from rocketride import RocketRideClient

from .config import load_settings
from .tools import get_tools, execute_tool

logger = logging.getLogger(__name__)

_API_KEY = os.environ.get('MCP_API_KEY', '')


class AuthMiddleware(BaseHTTPMiddleware):
    """Require Bearer token for all non-health endpoints."""

    async def dispatch(self, request: Request, call_next) -> Response:  # noqa: ANN001
        """Check Authorization header against MCP_API_KEY."""
        if request.url.path == '/health':
            return await call_next(request)
        if _API_KEY:
            auth = request.headers.get('authorization', '')
            if auth != f'Bearer {_API_KEY}':
                return JSONResponse({'error': 'unauthorized'}, status_code=401)
        return await call_next(request)


def _get_client() -> RocketRideClient:
    """Create a RocketRideClient from environment/settings."""
    settings = load_settings()
    return RocketRideClient(
        uri=settings.uri,
        auth=settings.auth or '',
    )


async def _list_pipelines() -> str:
    """List available RocketRide pipelines."""
    client = _get_client()
    try:
        await client.connect()
        tools = await get_tools(client)
        names = [t.get('name') or t.get('pipeline', '') for t in tools]
        names = [n for n in names if n]
        return f'Available pipelines: {", ".join(names)}' if names else 'No pipelines configured.'
    finally:
        await client.disconnect()


async def _run_pipeline(name: str, filepath: str) -> str:
    """Run a RocketRide pipeline on a file."""
    client = _get_client()
    try:
        await client.connect()
        result = await execute_tool(client=client, name=name, filepath=filepath)
        if isinstance(result, dict) and result.get('error'):
            raise RuntimeError(f'{result["error"]} (status {result.get("status", "unknown")})')
        return str(result)
    finally:
        await client.disconnect()


_TOOLS: list[types.Tool] = [
    types.Tool(
        name='list_pipelines',
        description='List available RocketRide pipelines.',
        input_schema={'type': 'object', 'properties': {}},
    ),
    types.Tool(
        name='run_pipeline',
        description='Run a RocketRide pipeline on a file.',
        input_schema={
            'type': 'object',
            'properties': {
                'name': {'type': 'string', 'description': 'Pipeline name to execute'},
                'filepath': {'type': 'string', 'description': 'Path to the input file'},
            },
            'required': ['name', 'filepath'],
        },
    ),
]


def create_mcp_server() -> Server:
    """Create and configure the MCP server with RocketRide tools."""

    async def on_list_tools(ctx, params: types.PaginatedRequestParams | None) -> types.ListToolsResult:
        return types.ListToolsResult(tools=_TOOLS)

    async def on_call_tool(ctx, params: types.CallToolRequestParams) -> types.CallToolResult:
        arguments = dict(params.arguments or {})
        try:
            if params.name == 'list_pipelines':
                text = await _list_pipelines()
            elif params.name == 'run_pipeline':
                text = await _run_pipeline(str(arguments.get('name', '')), str(arguments.get('filepath', '')))
            else:
                raise RuntimeError(f'Unknown tool: {params.name}')
        except Exception as exc:
            return types.CallToolResult(
                content=[types.TextContent(type='text', text=str(exc))],
                is_error=True,
            )
        return types.CallToolResult(content=[types.TextContent(type='text', text=text)])

    return Server('rocketride-mcp', on_list_tools=on_list_tools, on_call_tool=on_call_tool)


def create_app() -> Starlette:
    """Create the Starlette app with SSE transport and optional auth."""
    server = create_mcp_server()
    # Same URLs FastMCP's sse_app() used to expose: GET /sse for the event
    # stream, POST /messages/ for client->server messages.
    sse = SseServerTransport('/messages/')

    async def handle_sse(request: Request) -> Response:
        async with sse.connect_sse(request.scope, request.receive, request._send) as streams:
            await server.run(streams[0], streams[1], server.create_initialization_options())
        return Response()

    async def health(_request: Request) -> JSONResponse:
        """Return server health status and engine reachability."""
        status: dict = {'status': 'ok', 'server': 'rocketride-mcp'}
        try:
            client = _get_client()
            await client.connect()
            await client.disconnect()
        except Exception:
            status['status'] = 'degraded'
            status['engine'] = 'unreachable'
        return JSONResponse(status)

    middleware = [Middleware(AuthMiddleware)] if _API_KEY else []

    return Starlette(
        routes=[
            Route('/health', health),
            Route('/sse', endpoint=handle_sse, methods=['GET']),
            Mount('/messages/', app=sse.handle_post_message),
        ],
        middleware=middleware,
    )


def main():
    """Start the MCP SSE server."""
    parser = argparse.ArgumentParser(description='RocketRide MCP SSE Server')
    parser.add_argument('--host', default='localhost', help='Bind host (use 0.0.0.0 for all interfaces)')
    parser.add_argument('--port', type=int, default=8080, help='Bind port')
    args = parser.parse_args()

    if _API_KEY:
        logger.info('MCP SSE server starting with API key authentication')
    else:
        # run_pipeline uploads any file the server process can read, so an
        # unauthenticated non-loopback bind is remote file access. Refuse to
        # start rather than warn-and-serve.
        if args.host not in ('localhost', '127.0.0.1', '::1'):
            parser.error(f'refusing to bind {args.host} without authentication — set MCP_API_KEY (or bind localhost)')
        logger.warning('MCP SSE server starting WITHOUT authentication — set MCP_API_KEY to secure')

    app = create_app()
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
