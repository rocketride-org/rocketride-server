"""
Unit tests for the FastAPI handlers under ai.web.endpoints.

Each handler is a small function that either calls server methods or
returns a fixed payload. Tests build a minimal FastAPI app with the
handler mounted on a route and drive it through the synchronous
``TestClient``. ``request.app.state.server`` is set to a MagicMock so
the handlers can read whatever attributes they touch.
"""

from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ai/web/endpoints/__init__.py re-exports each handler function under the
# same name as its submodule (e.g. `auth_callback` is the function, not the
# module). To monkeypatch module-level helpers like `version.getVersion` or
# `status.time`, we resolve the submodules via sys.modules — those entries
# were populated by the __init__ when it ran ``from .X import X``.
import ai.web.endpoints  # noqa: F401  (ensures the submodules are loaded)

auth_callback_mod = sys.modules['ai.web.endpoints.auth_callback']
vscode_oauth_bounce_mod = sys.modules['ai.web.endpoints.vscode_oauth_bounce']
ping_mod = sys.modules['ai.web.endpoints.ping']
shutdown_mod = sys.modules['ai.web.endpoints.shutdown']
status_mod = sys.modules['ai.web.endpoints.status']
use_mod = sys.modules['ai.web.endpoints.use']
version_mod = sys.modules['ai.web.endpoints.version']


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _client(app: FastAPI) -> TestClient:
    """
    Wrap a FastAPI app in a TestClient.

    Args:
        app: a fully configured FastAPI app with at least one route added.

    Returns:
        TestClient: ready to send synchronous requests to the app.
    """
    return TestClient(app)


def _app_with_server(handler, server, *, path: str = '/x', method: str = 'GET'):
    """
    Build a minimal FastAPI app whose ``state.server`` is the supplied mock
    and which mounts ``handler`` on ``path``.

    Args:
        handler: the endpoint callable.
        server: object stored at app.state.server for the handler to read.
        path: the URL path to register.
        method: HTTP method to register.

    Returns:
        FastAPI: ready to be wrapped in a TestClient.
    """
    app = FastAPI()
    app.state.server = server
    if method.upper() == 'POST':
        app.post(path)(handler)
    else:
        app.get(path)(handler)
    return app


# ---------------------------------------------------------------------------
# ping
# ---------------------------------------------------------------------------


def test_ping_returns_ok_envelope():
    """The ping endpoint always returns status='OK' and HTTP 200."""
    app = FastAPI()
    app.get('/ping')(ping_mod.ping)
    r = _client(app).get('/ping')
    assert r.status_code == 200
    assert r.json() == {'status': 'OK'}


# ---------------------------------------------------------------------------
# version
# ---------------------------------------------------------------------------


def test_version_returns_value_from_get_version(monkeypatch):
    """
    The version endpoint returns whatever rocketlib.getVersion() reports.

    getVersion() returns a dict like ``{'version': '...', 'hash': '...',
    'stamp': '...'}`` — the response envelope's ``data`` field is typed as
    ``Optional[dict]``, so feeding a plain string here would trip Pydantic
    validation and produce a 400 instead of 200.
    """
    fake_version = {'version': '4.2.1', 'hash': 'abc', 'stamp': '2026-01-01'}
    monkeypatch.setattr(version_mod, 'getVersion', lambda: fake_version)
    app = FastAPI()
    app.get('/version')(version_mod.version)
    r = _client(app).get('/version')
    assert r.status_code == 200
    assert r.json() == {'status': 'OK', 'data': fake_version}


def test_version_converts_get_version_exception_to_error_response(monkeypatch):
    """If getVersion() raises, the endpoint returns the standardised error envelope."""

    def _raise():
        """Stand-in version probe that always fails."""
        raise RuntimeError('version unavailable')

    monkeypatch.setattr(version_mod, 'getVersion', _raise)

    app = FastAPI()
    app.get('/version')(version_mod.version)
    r = _client(app).get('/version')
    assert r.status_code == 400
    body = r.json()
    assert body['status'] == 'Error'
    assert 'version unavailable' in body['error']['message']


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def test_status_combines_server_info_and_runs_status_callbacks(monkeypatch):
    """The status endpoint reads server start time and walks _statusCallbacks."""
    monkeypatch.setattr(status_mod, 'getVersion', lambda: '4.2.1')

    # Pretend the server started 100 seconds ago.
    monkeypatch.setattr(status_mod.time, 'time', lambda: 200.0)

    invoked_callbacks = []

    def _cb_a(payload):
        """Add a marker so we can prove the callback fired."""
        payload['cb_a'] = True
        invoked_callbacks.append('cb_a')

    def _cb_b(payload):
        """Also injects a marker — proves all callbacks run."""
        payload['cb_b'] = True
        invoked_callbacks.append('cb_b')

    server = SimpleNamespace(_startTime=100.0, _statusCallbacks=[_cb_a, _cb_b])
    app = _app_with_server(status_mod.status, server, path='/status')
    r = _client(app).get('/status')

    assert r.status_code == 200
    body = r.json()
    assert body['status'] == 'OK'
    data = body['data']
    assert data['server'] == {'version': '4.2.1', 'startTime': 100.0, 'uptime': 100}
    assert data['cb_a'] is True
    assert data['cb_b'] is True
    assert invoked_callbacks == ['cb_a', 'cb_b']


def test_status_converts_callback_failure_to_error_response(monkeypatch):
    """Any exception during callback execution becomes the standard error envelope."""
    monkeypatch.setattr(status_mod, 'getVersion', lambda: '4.2.1')

    def _bad(payload):
        """Callback that raises — should not crash the response."""
        raise RuntimeError('callback exploded')

    server = SimpleNamespace(_startTime=0.0, _statusCallbacks=[_bad])
    app = _app_with_server(status_mod.status, server, path='/status')
    r = _client(app).get('/status')
    assert r.status_code == 400
    assert r.json()['status'] == 'Error'


# ---------------------------------------------------------------------------
# shutdown
# ---------------------------------------------------------------------------


def test_shutdown_invokes_server_shutdown_and_returns_ok():
    """The shutdown endpoint calls server.shutdown() and returns an OK envelope."""
    server = MagicMock()
    app = _app_with_server(shutdown_mod.shutdown, server, path='/shutdown', method='POST')
    r = _client(app).post('/shutdown')
    assert r.status_code == 200
    assert r.json() == {'status': 'OK'}
    server.shutdown.assert_called_once()


def test_shutdown_converts_server_shutdown_failure_to_error():
    """server.shutdown() raising returns the standard error envelope."""
    server = MagicMock()
    server.shutdown.side_effect = RuntimeError('cannot stop')
    app = _app_with_server(shutdown_mod.shutdown, server, path='/shutdown', method='POST')
    r = _client(app).post('/shutdown')
    assert r.status_code == 400
    assert r.json()['status'] == 'Error'


# ---------------------------------------------------------------------------
# use
# ---------------------------------------------------------------------------


def test_use_calls_server_use_with_name_and_config():
    """The use endpoint forwards name + body to server.use and returns OK."""
    server = MagicMock()
    app = _app_with_server(use_mod.use, server, path='/use', method='POST')
    r = _client(app).post('/use?name=plugin-x', json={'k': 'v'})
    assert r.status_code == 200
    assert r.json() == {'status': 'OK'}
    server.use.assert_called_once_with('plugin-x', {'k': 'v'})


def test_use_returns_error_when_server_use_raises():
    """A use-handler exception becomes the standard error envelope."""
    server = MagicMock()
    server.use.side_effect = ValueError('unknown plugin')
    app = _app_with_server(use_mod.use, server, path='/use', method='POST')
    r = _client(app).post('/use?name=plugin-x', json={'k': 'v'})
    assert r.status_code == 400
    body = r.json()
    assert body['status'] == 'Error'
    assert 'unknown plugin' in body['error']['message']


# ---------------------------------------------------------------------------
# auth_callback — _js_literal helper
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'value',
    [
        'https://app.example.com',
        'https://app.example.com/sub/path',
        'simple"with"quotes',
        "with'single'quotes",
        'with\\backslash',
        '',
    ],
)
def test_auth_callback_js_literal_is_safe_json_string(value):
    """_js_literal returns a JSON-encoded JS string suitable for inline <script> use."""
    result = auth_callback_mod._js_literal(value)
    # Round-trip: parsing the JS literal as JSON returns the original string.
    import json as _json

    assert _json.loads(result) == value


def test_auth_callback_js_literal_escapes_script_close_tag():
    """An embedded ``</`` is escaped so the script tag cannot be broken out of."""
    result = auth_callback_mod._js_literal('hello</script>')
    # The literal "</" must not appear unescaped in the result.
    assert '</' not in result
    # The escaped form must be present.
    assert '<\\/' in result


# ---------------------------------------------------------------------------
# auth_callback — full HTTP flow
# ---------------------------------------------------------------------------


def test_auth_callback_uses_request_base_url_when_rr_app_url_unset(monkeypatch):
    """Without RR_APP_URL, the handler falls back to the request's base URL."""
    monkeypatch.delenv('RR_APP_URL', raising=False)
    app = FastAPI()
    app.get('/cb')(auth_callback_mod.auth_callback)
    r = _client(app).get('/cb')
    assert r.status_code == 200
    assert r.headers['content-type'].startswith('text/html')
    # The script body should mention "testserver" (the FastAPI TestClient default host).
    assert 'testserver' in r.text


def test_auth_callback_uses_rr_app_url_when_set(monkeypatch):
    """Setting RR_APP_URL pins the redirect target regardless of the request host."""
    monkeypatch.setenv('RR_APP_URL', 'https://app.example.com')
    app = FastAPI()
    app.get('/cb')(auth_callback_mod.auth_callback)
    r = _client(app).get('/cb')
    assert r.status_code == 200
    # The URL is rendered as a JSON-encoded JS literal — assert against the
    # quoted form so the position is anchored to its actual context (and so
    # CodeQL's URL-substring-sanitisation check is satisfied).
    assert '"https://app.example.com"' in r.text
    assert r.text.count('"https://app.example.com"') >= 1


def test_auth_callback_trailing_slash_in_rr_app_url_is_stripped(monkeypatch):
    """RR_APP_URL's trailing slash is removed so query strings concat cleanly."""
    monkeypatch.setenv('RR_APP_URL', 'https://app.example.com/')
    app = FastAPI()
    app.get('/cb')(auth_callback_mod.auth_callback)
    r = _client(app).get('/cb')
    # The page should contain the trimmed form, not the trailing-slash form.
    assert 'app.example.com/"' not in r.text  # no `<base>/` artefact
    # Assert against the quoted JS-literal form so the URL position is
    # anchored (also satisfies CodeQL's URL-sanitisation check).
    assert '"https://app.example.com"' in r.text


def test_auth_callback_response_is_html_content_type(monkeypatch):
    """The endpoint always returns an HTML response."""
    monkeypatch.delenv('RR_APP_URL', raising=False)
    app = FastAPI()
    app.get('/cb')(auth_callback_mod.auth_callback)
    r = _client(app).get('/cb')
    assert r.headers['content-type'].startswith('text/html')


# ---------------------------------------------------------------------------
# vscode_oauth_bounce — broker → VS Code deep-link forwarder
# ---------------------------------------------------------------------------


def _bounce_client() -> TestClient:
    """TestClient with the bounce handler mounted at its real path."""
    app = FastAPI()
    app.get('/auth/vscode/google')(vscode_oauth_bounce_mod.vscode_oauth_bounce)
    return _client(app)


def test_vscode_oauth_bounce_default_scheme_is_vscode():
    """Without a ``scheme`` param the page targets the vscode:// deep link."""
    r = _bounce_client().get('/auth/vscode/google')
    assert r.status_code == 200
    assert r.headers['content-type'].startswith('text/html')
    assert '"vscode"' in r.text
    assert "'://rocketride.rocketride/auth/google'" in r.text


def test_vscode_oauth_bounce_honors_allowed_scheme():
    """An allowlisted editor scheme (e.g. cursor) is injected verbatim."""
    r = _bounce_client().get('/auth/vscode/google', params={'scheme': 'cursor'})
    assert r.status_code == 200
    assert '"cursor"' in r.text
    assert '"vscode"' not in r.text


@pytest.mark.parametrize('bad', ['javascript', 'https', 'vscode://x', 'file', '', 'VSCODE'])
def test_vscode_oauth_bounce_rejects_unlisted_scheme(bad):
    """Anything outside the allowlist falls back to the vscode scheme."""
    r = _bounce_client().get('/auth/vscode/google', params={'scheme': bad})
    assert r.status_code == 200
    assert '"vscode"' in r.text
    # The rejected value must not appear as the injected JS literal.
    if bad and bad != 'vscode':
        assert f'"{bad}"' not in r.text


def test_vscode_oauth_bounce_never_interpolates_tokens_into_html():
    """Token material stays in location.search — never in the HTML body."""
    secret = 'ya29.SECRET-ACCESS-TOKEN'
    r = _bounce_client().get(
        '/auth/vscode/google', params={'scheme': 'vscode', 'tokens': secret, 'state': 'abc123state'}
    )
    assert r.status_code == 200
    assert secret not in r.text
    assert 'abc123state' not in r.text


def test_vscode_oauth_bounce_forwards_only_expected_params():
    """The script forwards exactly the params CloudAuthProvider reads."""
    r = _bounce_client().get('/auth/vscode/google')
    for key in ('tokens', 'state', 'oauth_error', 'error', 'error_description'):
        assert f"'{key}'" in r.text
    # Our own routing param must not be forwarded to the deep link.
    assert "'scheme'" not in r.text
