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

from mcp.server.fastmcp import FastMCP

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


def create_mcp_server() -> FastMCP:
    """Create and configure the MCP server with RocketRide tools."""
    mcp = FastMCP('rocketride-mcp')

    @mcp.tool()
    async def list_pipelines() -> str:
        """List available RocketRide pipelines."""
        client = _get_client()
        try:
            await client.connect()
            tools = await get_tools(client)
            names = [t.get('name', '') for t in tools]
            return f'Available pipelines: {", ".join(names)}' if names else 'No pipelines configured.'
        finally:
            await client.disconnect()

    @mcp.tool()
    async def run_pipeline(name: str, filepath: str) -> str:
        """Run a RocketRide pipeline on a file.

        Args:
            name: Pipeline name to execute.
            filepath: Path to the input file.
        """
        client = _get_client()
        try:
            await client.connect()
            result = await execute_tool(client=client, name=name, filepath=filepath)
            return str(result)
        finally:
            await client.disconnect()

    return mcp


def create_app() -> Starlette:
    """Create the Starlette app with SSE transport and optional auth."""
    mcp = create_mcp_server()

    async def health(_request: Request) -> JSONResponse:
        return JSONResponse({'status': 'ok', 'server': 'rocketride-mcp'})

    middleware = [Middleware(AuthMiddleware)] if _API_KEY else []

    return Starlette(
        routes=[
            Route('/health', health),
            Mount('/', app=mcp.sse_app()),
        ],
        middleware=middleware,
    )


def main():
    """Start the MCP SSE server."""
    parser = argparse.ArgumentParser(description='RocketRide MCP SSE Server')
    parser.add_argument('--host', default='0.0.0.0', help='Bind host')
    parser.add_argument('--port', type=int, default=8080, help='Bind port')
    args = parser.parse_args()

    if _API_KEY:
        logger.info('MCP SSE server starting with API key authentication')
    else:
        logger.warning('MCP SSE server starting WITHOUT authentication — set MCP_API_KEY to secure')

    app = create_app()
    uvicorn.run(app, host=args.host, port=args.port, log_level='info')


if __name__ == '__main__':
    main()
