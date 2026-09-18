# Copyright 2026 Aparavi Software AG. MIT License.
"""`/mcp` and `/mcp/...` belong to the MCP API, not to a shell page.

The shell used to serve a public marketing page at `/mcp`. Because the MCP
endpoint is a `Mount` (which only matches `/mcp/...`), that page route won the
bare path: `POST /mcp` answered 405 with no `WWW-Authenticate` challenge, so
spec clients -- which POST to the advertised resource `.../mcp` -- never saw
the OAuth challenge. Worse, the page marked `/mcp` public, so AuthMiddleware
skipped every request to it.

These tests drive the REAL `WebServer` + `AuthMiddleware` with the shell and
mcp modules loaded in eaas order (shell first).
"""

import contextlib
from types import SimpleNamespace

import httpx
import pytest

_TOOLS_CALL = {
    'jsonrpc': '2.0',
    'id': 1,
    'method': 'tools/call',
    'params': {
        'name': 'list_running_pipelines',
        'arguments': {},
        '_meta': {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
        },
    },
}

_HEADERS = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'tools/call',
    'Mcp-Name': 'list_running_pipelines',
}

_AUTH_HEADERS = {**_HEADERS, 'authorization': 'Bearer rr_e2e_key'}

_SHELL_HTML = '<!doctype html><title>shell</title>'


def _recording_factory(built):
    from .conftest import FakeEngineClient

    def _make(config, on_event=None):
        client = FakeEngineClient(env_keys=[], auth=config.get('rocketride_auth'))
        built.append(client)
        return client

    return _make


def _web_server(monkeypatch, tmp_path, built):
    """Build a real WebServer with shell + mcp prerequisites stubbed.

    The account layer accepts any credential, so only AuthMiddleware's
    public-path decision and the MCP handler's own gate are under test.
    """
    pytest.importorskip('rocketlib')  # WebServer needs the engine env
    import ai.modules.mcp as mcp_module
    import ai.modules.shell.shell as shell_mod
    from ai.web.server import WebServer

    (tmp_path / 'index.html').write_text(_SHELL_HTML)
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    monkeypatch.setattr(mcp_module, 'make_engine_client', _recording_factory(built))
    monkeypatch.delenv('MCP_DEV_NO_AUTH', raising=False)

    server = WebServer()
    # WebServer.__init__ loads `dist/server/.env`, so a developer's local
    # engine settings (ROCKETRIDE_URI=http://localhost:5565, a resource
    # identifier) would otherwise decide what these tests resolve. Clear them
    # AFTER construction: these tests are about routing and auth, and the
    # engine URI rules have their own suite (test_engine_uri.py).
    for name in ('ROCKETRIDE_URI', 'MCP_RESOURCE_IDENTIFIER'):
        monkeypatch.delenv(name, raising=False)

    async def _accept_any(authorization):
        return SimpleNamespace(auth=authorization)

    monkeypatch.setattr(server, '_authenticate_credential_inner', _accept_any)
    return server


@contextlib.asynccontextmanager
async def _serve(server):
    await server._user_startup()
    try:
        transport = httpx.ASGITransport(app=server.app)
        async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
            yield client
    finally:
        await server._user_shutdown()


def _eaas_order(server, mcp_config=None):
    server.use('shell', {})
    server.use('mcp', mcp_config or {})


# --- credential-less requests are challenged, never served -----------------


@pytest.mark.asyncio
@pytest.mark.parametrize('path', ['/mcp', '/mcp/'])
async def test_post_without_credentials_gets_oauth_challenge(monkeypatch, tmp_path, path):
    built = []
    server = _web_server(monkeypatch, tmp_path, built)
    _eaas_order(server)

    async with _serve(server) as app:
        resp = await app.post(path, json=_TOOLS_CALL, headers=_HEADERS)

    assert resp.status_code == 401, f'{path}: {resp.status_code} {resp.text[:200]}'
    assert 'resource_metadata=' in resp.headers.get('www-authenticate', '')
    assert built == [], 'a credential-less request must never reach an engine client'


@pytest.mark.asyncio
async def test_get_mcp_without_credentials_is_challenged_not_the_shell_page(monkeypatch, tmp_path):
    built = []
    server = _web_server(monkeypatch, tmp_path, built)
    _eaas_order(server)

    async with _serve(server) as app:
        resp = await app.get('/mcp')

    assert resp.status_code == 401
    assert 'resource_metadata=' in resp.headers.get('www-authenticate', '')
    assert '<title>shell</title>' not in resp.text
    assert built == []


def test_mcp_paths_are_not_public(monkeypatch, tmp_path):
    server = _web_server(monkeypatch, tmp_path, [])
    _eaas_order(server)

    for path in ('/mcp', '/mcp/', '/mcp/anything'):
        assert server.is_public_route(path) is False, path


# --- the marketing page moved, and still serves publicly -------------------


@pytest.mark.asyncio
async def test_mcp_server_page_is_public_and_served(monkeypatch, tmp_path):
    server = _web_server(monkeypatch, tmp_path, [])
    _eaas_order(server)

    assert server.is_public_route('/mcp-server') is True
    async with _serve(server) as app:
        resp = await app.get('/mcp-server')

    assert resp.status_code == 200
    assert '<title>shell</title>' in resp.text


# --- authenticated callers reach the handler on both path forms -----------


@pytest.mark.asyncio
@pytest.mark.parametrize('path', ['/mcp', '/mcp/'])
async def test_header_credential_reaches_handler_without_redirect(monkeypatch, tmp_path, path):
    built = []
    server = _web_server(monkeypatch, tmp_path, built)
    _eaas_order(server)

    async with _serve(server) as app:
        resp = await app.post(path, json=_TOOLS_CALL, headers=_AUTH_HEADERS)

    assert resp.status_code == 200, f'{path}: {resp.status_code} {resp.text[:200]}'
    assert built and built[-1].auth == 'rr_e2e_key'


# --- dev bypass: exactly the MCP paths, only on loopback -------------------


def _public_paths_after(monkeypatch, tmp_path, mcp_config):
    server = _web_server(monkeypatch, tmp_path, [])
    _eaas_order(server, mcp_config)
    return server, set(server._public_paths)


def test_dev_bypass_makes_exactly_the_mcp_paths_public(monkeypatch, tmp_path):
    _, baseline = _public_paths_after(monkeypatch, tmp_path, {})
    server, bypassed = _public_paths_after(monkeypatch, tmp_path, {'mcp_dev_no_auth': True})

    assert server.config.get('host', 'localhost') in ('localhost', '127.0.0.1', '::1')
    assert bypassed - baseline == {'/mcp', '/mcp/'}
    assert server.is_public_route('/mcp') is True
    assert server.is_public_route('/mcp/') is True
    assert server.is_public_route('/mcp/anything') is False


@pytest.mark.asyncio
@pytest.mark.parametrize('path', ['/mcp', '/mcp/'])
async def test_dev_bypass_serves_both_forms_on_the_shared_client(monkeypatch, tmp_path, path):
    built = []
    server = _web_server(monkeypatch, tmp_path, built)
    _eaas_order(server, {'mcp_dev_no_auth': True})

    async with _serve(server) as app:
        resp = await app.post(path, json=_TOOLS_CALL, headers=_HEADERS)

    assert resp.status_code == 200, f'{path}: {resp.status_code} {resp.text[:200]}'
    assert built and built[-1].auth is None


def test_dev_bypass_ignored_on_non_loopback_bind(monkeypatch, tmp_path):
    server = _web_server(monkeypatch, tmp_path, [])
    server.config['host'] = '0.0.0.0'
    _eaas_order(server, {'mcp_dev_no_auth': True})

    assert server.is_public_route('/mcp') is False
    assert server.is_public_route('/mcp/') is False


# --- startup guard: nothing else may claim the MCP paths -------------------


async def _page(request):
    return None


@pytest.mark.parametrize('path', ['/mcp', '/mcp/', '/mcp/docs'])
def test_mcp_refuses_to_mount_over_a_route_claiming_its_paths(monkeypatch, tmp_path, path):
    server = _web_server(monkeypatch, tmp_path, [])
    server.add_route(path=path, routeHandler=_page, methods=['GET'], public=True)

    with pytest.raises(RuntimeError, match='/mcp'):
        server.use('mcp', {})


@pytest.mark.parametrize(
    'pattern',
    [
        '/mcp/{rest:path}',
        '/mcp/{name}',
        '/mcp/probe',
        '/mcp',
        '/mcp/',
        # Converter-typed patterns match no probe LITERAL the guard can guess:
        # `/mcp/{id:int}` compiles to a digits-only regex, so probing alone
        # never sees it. It is caught by reading the registered patterns.
        '/mcp/{id:int}',
        '/mcp/{when:uuid}',
        '  /mcp/{id:int}  ',
    ],
)
def test_mcp_refuses_to_mount_under_a_public_pattern_matching_it(monkeypatch, tmp_path, pattern):
    """A public pattern needs no route of its own to disarm authentication.

    `_public_paths` entries are PATTERNS compiled with Starlette's
    `compile_path`, and AuthMiddleware consults them before routing. A
    `/mcp/{path}` entry therefore makes the middleware skip requests the Mount
    still forwards to `handle_mcp` -- while never matching `/mcp` or `/mcp/`
    themselves, which is all the guard used to probe.

    Probing cannot be made exhaustive: a converter (`{id:int}`, `{x:uuid}`)
    narrows the compiled regex to values no fixed probe string satisfies. So
    the registered PATTERN STRINGS are inspected too, and anything rooted at
    the MCP mount is refused whatever it would match.
    """
    server = _web_server(monkeypatch, tmp_path, [])
    server._public_paths.append(pattern)
    server._compiled_public_paths = None

    with pytest.raises(RuntimeError, match='/mcp'):
        server.use('mcp', {})


@pytest.mark.parametrize('pattern', ['/mcp-server', '/mcpx', '/mcp-server/{page}', '/mcpx/{rest:path}', '/'])
def test_public_patterns_that_merely_start_with_mcp_do_not_trip_the_guard(monkeypatch, tmp_path, pattern):
    """The namespace is `/mcp` and `/mcp/...` -- not every path spelled `mcp*`.

    `/mcp-server` (the marketing page) and `/mcpx` are unrelated routes that
    the Mount never forwards, so refusing them would be a false positive that
    stops the engine booting for no reason.
    """
    server = _web_server(monkeypatch, tmp_path, [])
    server._public_paths.append(pattern)
    server._compiled_public_paths = None

    server.use('mcp', {})  # must not raise
    assert server.is_public_route('/mcp') is False


def test_the_discovery_document_stays_public_and_does_not_trip_the_guard(monkeypatch, tmp_path):
    """The RFC 9728 metadata document is public by necessity; it lives outside
    the MCP namespace, so widening the probe must not catch it.
    """
    server = _web_server(monkeypatch, tmp_path, [])
    _eaas_order(server)

    assert server.is_public_route('/.well-known/oauth-protected-resource/mcp') is True


@pytest.mark.asyncio
@pytest.mark.parametrize('path', ['/mcp', '/mcp/'])
async def test_dev_bypass_still_needs_loopback_to_serve_anonymously(monkeypatch, tmp_path, path):
    """Both halves agree: the public list AND auth.authorize read the same
    dev-bypass answer, so a non-loopback bind serves nobody anonymously.
    """
    built = []
    server = _web_server(monkeypatch, tmp_path, built)
    server.config['host'] = '0.0.0.0'
    _eaas_order(server, {'mcp_dev_no_auth': True})

    async with _serve(server) as app:
        resp = await app.post(path, json=_TOOLS_CALL, headers=_HEADERS)

    assert resp.status_code == 401, f'{path}: {resp.status_code} {resp.text[:200]}'
    assert built == [], 'a credential-less request must never reach an engine client'
