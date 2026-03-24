# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
HTTP/SSE transport for the RocketRide MCP server.

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

from mcp.server.fastmcp import FastMCP

from .config import load_settings
from .tools import get_tools, execute_tool

logger = logging.getLogger(__name__)


def create_mcp_server() -> FastMCP:
    """Create and configure the MCP server with RocketRide tools."""
    mcp = FastMCP('rocketride-mcp')

    @mcp.tool()
    async def list_pipelines() -> str:
        """List available RocketRide pipelines."""
        settings = load_settings()
        tools = get_tools(settings)
        names = [t['name'] for t in tools]
        return f'Available pipelines: {", ".join(names)}' if names else 'No pipelines configured.'

    @mcp.tool()
    async def run_pipeline(name: str, filepath: str) -> str:
        """Run a RocketRide pipeline on a file.

        Args:
            name: Pipeline name to execute.
            filepath: Path to the input file.
        """
        settings = load_settings()
        tools = get_tools(settings)
        result = await execute_tool(name, {'filepath': filepath}, tools, settings)
        return str(result)

    return mcp


def create_app() -> Starlette:
    """Create the Starlette app with SSE transport."""
    mcp = create_mcp_server()

    async def health(request: Request) -> JSONResponse:
        return JSONResponse({'status': 'ok', 'server': 'rocketride-mcp'})

    return Starlette(
        routes=[
            Route('/health', health),
            Mount('/', app=mcp.sse_app()),
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
