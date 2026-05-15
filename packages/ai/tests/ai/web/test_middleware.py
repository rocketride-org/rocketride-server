"""
Unit tests for ai.web.middleware.AuthMiddleware.

AuthMiddleware skips public routes, calls server.authenticate_request for
private ones, and converts any uncaught exception into the standardised
error envelope.

Tests mount the middleware on a minimal FastAPI app with two routes
(``/public`` and ``/private``), set ``app.state.server`` to a MagicMock
that exposes ``is_public_route`` and ``authenticate_request``, and drive
the app via TestClient.
"""

from __future__ import annotations

import sys
from unittest.mock import AsyncMock, MagicMock

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

middleware_mod = sys.modules.get('ai.web.middleware') or __import__('ai.web.middleware', fromlist=['_'])
AuthMiddleware = middleware_mod.AuthMiddleware


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _build_app(server) -> FastAPI:
    """
    Build a minimal FastAPI app with AuthMiddleware mounted.

    Routes:
        GET /public  — returns {'ok': 'public'}
        GET /private — returns {'ok': 'private'}

    Args:
        server: object stored at app.state.server; tests configure its
            ``is_public_route`` and ``authenticate_request`` mocks.

    Returns:
        FastAPI: ready to be passed to TestClient.
    """
    app = FastAPI()
    app.state.server = server
    app.add_middleware(AuthMiddleware)

    @app.get('/public')
    def _public():
        """Public endpoint — should always reach the handler."""
        return {'ok': 'public'}

    @app.get('/private')
    def _private():
        """Private endpoint — should run only after authenticate_request returns None."""
        return {'ok': 'private'}

    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_public_route_bypasses_authentication():
    """When is_public_route returns True, authenticate_request is not called."""
    server = MagicMock()
    server.is_public_route.return_value = True
    server.authenticate_request = AsyncMock()

    client = TestClient(_build_app(server))
    r = client.get('/public')

    assert r.status_code == 200
    assert r.json() == {'ok': 'public'}
    server.is_public_route.assert_called_with('/public')
    server.authenticate_request.assert_not_called()


def test_private_route_calls_authenticate_request():
    """A non-public route triggers authenticate_request."""
    server = MagicMock()
    server.is_public_route.return_value = False
    server.authenticate_request = AsyncMock(return_value=None)  # auth ok → continue

    client = TestClient(_build_app(server))
    r = client.get('/private')

    assert r.status_code == 200
    assert r.json() == {'ok': 'private'}
    server.authenticate_request.assert_awaited_once()


def test_authentication_failure_short_circuits_with_error_response():
    """When authenticate_request returns an error response, the route handler is skipped."""
    error_response = JSONResponse(content={'error': 'forbidden'}, status_code=403)
    server = MagicMock()
    server.is_public_route.return_value = False
    server.authenticate_request = AsyncMock(return_value=error_response)

    client = TestClient(_build_app(server))
    r = client.get('/private')

    assert r.status_code == 403
    assert r.json() == {'error': 'forbidden'}


def test_unhandled_exception_in_handler_is_wrapped_in_error_envelope():
    """A handler that raises is converted to the standard error envelope by the middleware."""
    server = MagicMock()
    server.is_public_route.return_value = True

    app = FastAPI()
    app.state.server = server
    app.add_middleware(AuthMiddleware)

    @app.get('/explodes')
    def _explodes():
        """A handler that always raises — middleware must catch it."""
        raise RuntimeError('handler boom')

    client = TestClient(app, raise_server_exceptions=False)
    r = client.get('/explodes')
    assert r.status_code == 400
    body = r.json()
    assert body['status'] == 'Error'
    assert 'handler boom' in body['error']['message']


def test_exception_in_is_public_route_is_caught():
    """Errors from server.is_public_route itself land in the catch-all error envelope."""
    server = MagicMock()
    server.is_public_route.side_effect = RuntimeError('cannot decide')

    client = TestClient(_build_app(server), raise_server_exceptions=False)
    r = client.get('/private')

    assert r.status_code == 400
    body = r.json()
    assert body['status'] == 'Error'
    assert 'cannot decide' in body['error']['message']
