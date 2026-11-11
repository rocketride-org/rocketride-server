from ai.web import exception, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.types import Scope
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ai.web import WebServer


def route_path(scope: Scope) -> str:
    """The path the router matches: ``scope['path']`` with ``root_path`` stripped.

    Must match Starlette's router (``starlette._utils.get_route_path``), or
    the auth decision and the route that serves the request see different paths.

    Args:
        scope: The ASGI scope of an HTTP or websocket request.

    Returns:
        The path below ``root_path``; ``''`` when the path is ``root_path``
        itself, and the full path when it is not under ``root_path``.
    """
    path: str = scope['path']
    root_path = scope.get('root_path', '')
    if not root_path or not path.startswith(root_path):
        return path
    if path == root_path:
        return ''
    # '/api/x' is under root_path '/api'; '/apix' only shares its prefix.
    if path[len(root_path)] == '/':
        return path[len(root_path) :]
    return path


class AuthMiddleware(BaseHTTPMiddleware):
    """
    Middleware that setups account and apikey info.
    """

    async def dispatch(self, request: Request, call_next):
        try:
            # Save the server off, it is removed by /chat
            server: WebServer = request.app.state.server

            # If this is a public endpoint, just call it. Decide on the path the
            # router matches (root_path stripped, as Starlette's router does):
            # behind a proxy prefix the raw path would match no route at all.
            if server.is_public_route(route_path(request.scope)):
                # Call it
                return await call_next(request)

            # Get the authentication information - put the account
            # info into the request state
            error_response = await server.authenticate_request(request)

            # If we could not authenticate, return the error response
            if error_response:
                return error_response

            # Execute the request
            response = await call_next(request)

            # Return either the original response of the modified one
            return response

        except Exception as e:
            return exception(e)
