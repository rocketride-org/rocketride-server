# Copyright 2026 Aparavi Software AG. MIT License.
"""The /mcp endpoint advertises itself as an RFC 9728 protected resource."""

import pytest

from ai.web import oauth_resource as oauth


@pytest.mark.asyncio
async def test_metadata_route_is_mounted_and_public(monkeypatch, fake_engine):
    """Discovery must work unauthenticated, or clients can never bootstrap."""
    pytest.importorskip('rocketlib')
    from ai.web.server import WebServer
    import ai.modules.mcp as mcp_module

    monkeypatch.setattr(mcp_module, 'make_engine_client', lambda cfg, on_event=None: fake_engine)

    server = WebServer()
    server.use('mcp', {})

    expected = oauth.metadata_path()
    paths = {getattr(r, 'path', None) for r in server.app.routes}
    assert expected in paths, f'{expected} not mounted; got {sorted(p for p in paths if p)}'
    assert expected in list(server._public_paths or []), 'metadata document must be public'


@pytest.mark.asyncio
async def test_mcp_itself_stays_authenticated(monkeypatch, fake_engine):
    """Publishing the document must not accidentally open the resource."""
    pytest.importorskip('rocketlib')
    from ai.web.server import WebServer
    import ai.modules.mcp as mcp_module

    monkeypatch.setattr(mcp_module, 'make_engine_client', lambda cfg, on_event=None: fake_engine)

    server = WebServer()
    server.use('mcp', {})

    public = list(server._public_paths or [])
    assert '/mcp' not in public
    assert '/mcp/' not in public


def test_document_body_points_at_zitadel():
    doc = oauth.protected_resource_metadata()
    assert doc['authorization_servers'] == ['https://auth.rocketride.ai']
    assert doc['resource'].endswith('/mcp')


@pytest.mark.asyncio
async def test_websocket_to_mcp_is_closed_not_served(monkeypatch, fake_engine):
    """AuthMiddleware only wraps 'http' scopes.

    Mount routes by path regardless of scope type, so a websocket would reach
    the MCP handler with no authentication having run. It must be closed, not
    handed to the session manager.
    """
    pytest.importorskip('rocketlib')
    from ai.web.server import WebServer
    import ai.modules.mcp as mcp_module

    monkeypatch.setattr(mcp_module, 'make_engine_client', lambda cfg, on_event=None: fake_engine)

    server = WebServer()
    server.use('mcp', {})

    handler = next(route.app for route in server.app.router.routes if getattr(route, 'path', None) == '/mcp')

    sent = []

    async def send(message):
        sent.append(message)

    async def receive():
        return {'type': 'websocket.connect'}

    await handler({'type': 'websocket', 'path': '/mcp', 'headers': [], 'state': {}}, receive, send)

    assert sent == [{'type': 'websocket.close', 'code': 1008}]
