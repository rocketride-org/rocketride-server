# Copyright 2026 Aparavi Software AG. MIT License.
"""Unit tests for RFC 9728 protected-resource metadata derivation."""

import pytest

from ai.web import oauth_resource as oauth


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    """Each test starts from the built-in defaults."""
    monkeypatch.delenv(oauth.ENV_RESOURCE, raising=False)
    monkeypatch.delenv(oauth.ENV_AUTH_SERVER, raising=False)


def test_defaults_to_api_host_with_mcp_path():
    assert oauth.resource_identifier() == 'https://api.rocketride.ai/mcp'
    assert oauth.authorization_servers() == ['https://auth.rocketride.ai']


def test_env_overrides_and_strips_trailing_slash(monkeypatch):
    monkeypatch.setenv(oauth.ENV_RESOURCE, 'https://mcp.rocketride.ai/')
    assert oauth.resource_identifier() == 'https://mcp.rocketride.ai'


def test_path_style_resource_inserts_well_known_before_path():
    """RFC 9728 3.1: the well-known segment goes between host and path."""
    assert oauth.metadata_path('https://api.rocketride.ai/mcp') == '/.well-known/oauth-protected-resource/mcp'
    assert (
        oauth.metadata_url('https://api.rocketride.ai/mcp')
        == 'https://api.rocketride.ai/.well-known/oauth-protected-resource/mcp'
    )


def test_host_style_resource_serves_at_root():
    assert oauth.metadata_path('https://mcp.rocketride.ai') == '/.well-known/oauth-protected-resource'
    assert (
        oauth.metadata_url('https://mcp.rocketride.ai')
        == 'https://mcp.rocketride.ai/.well-known/oauth-protected-resource'
    )


def test_metadata_document_names_the_authorization_server():
    doc = oauth.protected_resource_metadata()
    assert doc['resource'] == 'https://api.rocketride.ai/mcp'
    assert doc['authorization_servers'] == ['https://auth.rocketride.ai']
    assert doc['bearer_methods_supported'] == ['header']


def test_covers_request_path_for_path_style_resource():
    assert oauth.covers_request_path('/mcp') is True
    assert oauth.covers_request_path('/mcp/messages') is True
    assert oauth.covers_request_path('/mcpother') is False
    assert oauth.covers_request_path('/task') is False


def test_covers_every_path_for_host_style_resource(monkeypatch):
    """A host-dedicated resource makes the whole origin the protected resource."""
    monkeypatch.setenv(oauth.ENV_RESOURCE, 'https://mcp.rocketride.ai')
    assert oauth.covers_request_path('/anything') is True


def test_challenge_advertises_metadata_url():
    challenge = oauth.www_authenticate_value()
    assert challenge.startswith('Bearer ')
    assert 'resource_metadata="https://api.rocketride.ai/.well-known/oauth-protected-resource/mcp"' in challenge
    assert 'error=' not in challenge


def test_challenge_includes_error_when_token_was_rejected():
    challenge = oauth.www_authenticate_value(error='invalid_token', description='Authentication failed')
    assert 'error="invalid_token"' in challenge
    assert 'error_description="Authentication failed"' in challenge


def test_challenge_quotes_are_stripped_from_description():
    """A quote in the message must not break header parsing."""
    challenge = oauth.www_authenticate_value(error='invalid_token', description='bad "token" here')
    assert challenge.count('"') % 2 == 0
    assert 'bad token here' in challenge


# --- 401 challenge wiring -------------------------------------------------


def _http_scope(path: str) -> dict:
    """Build a minimal ASGI scope for an unauthenticated request."""
    return {
        'type': 'http',
        'method': 'POST',
        'path': path,
        'headers': [(b'accept', b'application/json')],
        'query_string': b'',
    }


@pytest.mark.asyncio
async def test_mcp_401_carries_the_challenge():
    """An unauthenticated /mcp call must tell the client where to look."""
    pytest.importorskip('rocketlib')
    from starlette.requests import Request

    from ai.web.server import WebServer

    server = WebServer()
    response = await server.authenticate_request(Request(_http_scope('/mcp')))

    assert response is not None, 'expected a 401 response, got None (auth passed?)'
    assert response.status_code == 401
    challenge = response.headers.get('WWW-Authenticate')
    assert challenge is not None, 'no WWW-Authenticate header on the 401'
    assert 'resource_metadata=' in challenge


@pytest.mark.asyncio
async def test_unrelated_route_401_has_no_mcp_challenge():
    """Only the MCP resource advertises MCP's metadata."""
    pytest.importorskip('rocketlib')
    from starlette.requests import Request

    from ai.web.server import WebServer

    server = WebServer()
    response = await server.authenticate_request(Request(_http_scope('/task')))

    assert response is not None
    assert response.status_code == 401
    assert response.headers.get('WWW-Authenticate') is None
