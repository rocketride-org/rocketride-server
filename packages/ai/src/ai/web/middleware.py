"""Authentication middleware supporting both HTTP and WebSocket.

Uses pure ASGI middleware instead of BaseHTTPMiddleware because
Starlette's BaseHTTPMiddleware does not support WebSocket connections
(returns 403 on all WebSocket upgrade requests).

Per Reddit 2026: BaseHTTPMiddleware is HTTP-only — use raw ASGI
for auth middleware when WebSocket routes exist.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING
from starlette.requests import Request
from starlette.responses import Response
from starlette.types import ASGIApp, Receive, Scope, Send

if TYPE_CHECKING:
    from ai.web.server import WebServer

logger = logging.getLogger(__name__)


class AuthMiddleware:
    """Pure ASGI authentication middleware.

    Supports both HTTP requests and WebSocket connections.
    Extracts auth from Authorization header or ?auth= query param.
    """

    def __init__(self, app: ASGIApp) -> None:  # noqa: D107
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope['type'] not in ('http', 'websocket'):
            await self.app(scope, receive, send)
            return

        # Get server reference from app state
        app = scope.get('app')
        server: WebServer | None = getattr(getattr(app, 'state', None), 'server', None)

        if not server:
            await self.app(scope, receive, send)
            return

        path = scope.get('path', '/')

        # Skip auth for public routes
        if server.is_public_route(path):
            await self.app(scope, receive, send)
            return

        if scope['type'] == 'http':
            await self._handle_http(scope, receive, send, server)
        elif scope['type'] == 'websocket':
            await self._handle_websocket(scope, receive, send, server)

    async def _handle_http(self, scope: Scope, receive: Receive, send: Send, server: WebServer) -> None:
        """Authenticate HTTP requests."""
        from ai.web import exception

        request = Request(scope, receive, send)

        try:
            error_response = await server.authenticate_request(request)
            if error_response:
                await error_response(scope, receive, send)
                return
            await self.app(scope, receive, send)
        except Exception as e:
            response = exception(e)
            await response(scope, receive, send)

    async def _handle_websocket(self, scope: Scope, receive: Receive, send: Send, server: WebServer) -> None:
        """Authenticate WebSocket connections.

        Extracts auth from query params since WebSocket clients
        cannot set custom headers during the upgrade handshake.
        """
        request = Request(scope, receive, send)

        try:
            error_response = await server.authenticate_request(request, return_tuple=True)
            if error_response:
                # Reject WebSocket — send HTTP 403 before upgrade
                response = Response(status_code=403, content='Authentication failed')
                await response(scope, receive, send)
                return
            await self.app(scope, receive, send)
        except Exception as e:
            logger.error('WebSocket auth error: %s', e)
            response = Response(status_code=403, content='Authentication error')
            await response(scope, receive, send)
