from ai.web import exception, Request
from starlette.middleware.base import BaseHTTPMiddleware
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ai.web import WebServer


class AuthMiddleware(BaseHTTPMiddleware):
    """
    Middleware that setups account and apikey info.
    """

    async def dispatch(self, request: Request, call_next):
        try:
            # Save the server off, it is removed by /chat
            server: WebServer = request.app.state.server

            # If this is a public endpoint, just call it
            if server.is_public_route(request.url.path):
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
