# Copyright 2026 Aparavi Software AG. MIT License.
"""Tests for per-request caller identity context and credential stashing."""

import contextlib

import httpx
import pytest

from ai.modules.mcp import identity


# --- credential_from_scope -----------------------------------------------


def test_credential_from_scope_returns_stashed_credential():
    """credential_from_scope extracts mcp_credential from scope state."""
    scope = {'state': {'mcp_credential': 'rr_abc123'}}
    assert identity.credential_from_scope(scope) == 'rr_abc123'


def test_credential_from_scope_returns_none_when_absent():
    """credential_from_scope returns None when mcp_credential is not stashed."""
    scope = {'state': {}}
    assert identity.credential_from_scope(scope) is None


def test_credential_from_scope_returns_none_when_state_missing():
    """credential_from_scope returns None when state dict is missing."""
    scope = {}
    assert identity.credential_from_scope(scope) is None


def test_credential_from_scope_returns_none_when_not_dict():
    """credential_from_scope returns None when scope is not a dict."""
    assert identity.credential_from_scope(None) is None
    assert identity.credential_from_scope('not a dict') is None
    assert identity.credential_from_scope([]) is None


def test_credential_from_scope_returns_none_when_state_not_dict():
    """credential_from_scope returns None when state is not a dict."""
    scope = {'state': 'not a dict'}
    assert identity.credential_from_scope(scope) is None


# --- ContextVars ---------------------------------------------------------


def test_caller_auth_contextvar_has_none_default():
    """CALLER_AUTH ContextVar defaults to None."""
    # Get a fresh copy by resetting the context
    assert identity.CALLER_AUTH.get() is None


def test_request_clients_contextvar_has_none_default():
    """REQUEST_CLIENTS ContextVar defaults to None."""
    # Get a fresh copy by resetting the context
    assert identity.REQUEST_CLIENTS.get() is None


# --- _make_engine_factory --------------------------------------------------


def test_engine_factory_honors_caller_auth(monkeypatch):
    """CALLER_AUTH set -> a FRESH client is built with the caller's auth
    merged over the service config, and bucketed into REQUEST_CLIENTS.
    """
    from ai.modules import mcp as mcp_mod

    built = []
    monkeypatch.setattr(mcp_mod, 'make_engine_client', lambda cfg: built.append(cfg) or object())
    factory = mcp_mod._make_engine_factory({'rocketride_uri': 'ws://x', 'rocketride_auth': 'svc-key'})
    token = identity.CALLER_AUTH.set('rr_caller_key')
    bucket_token = identity.REQUEST_CLIENTS.set([])
    try:
        factory()
        assert built[-1]['rocketride_auth'] == 'rr_caller_key'
        assert built[-1]['rocketride_uri'] == 'ws://x'
        assert len(identity.REQUEST_CLIENTS.get()) == 1
    finally:
        identity.REQUEST_CLIENTS.reset(bucket_token)
        identity.CALLER_AUTH.reset(token)


def test_engine_factory_falls_back_to_singleton(monkeypatch):
    """CALLER_AUTH unset: two calls -> one construction (the cached singleton),
    byte-identical to the pre-integrations behavior.
    """
    from ai.modules import mcp as mcp_mod

    built = []
    monkeypatch.setattr(mcp_mod, 'make_engine_client', lambda cfg: built.append(cfg) or object())
    factory = mcp_mod._make_engine_factory({'rocketride_uri': 'ws://x', 'rocketride_auth': 'svc-key'})

    assert identity.CALLER_AUTH.get() is None  # sanity: nothing bound in this test's context

    first = factory()
    second = factory()

    assert first is second
    assert len(built) == 1
    assert built[0] == {'rocketride_uri': 'ws://x', 'rocketride_auth': 'svc-key'}


def test_engine_factory_per_caller_client_not_cached(monkeypatch):
    """CALLER_AUTH set: every call builds a NEW client -- unlike the singleton
    path, nothing here is cached across calls.
    """
    from ai.modules import mcp as mcp_mod

    built = []
    monkeypatch.setattr(mcp_mod, 'make_engine_client', lambda cfg: built.append(cfg) or object())
    factory = mcp_mod._make_engine_factory({'rocketride_uri': 'ws://x', 'rocketride_auth': 'svc-key'})
    token = identity.CALLER_AUTH.set('rr_caller_key')
    bucket_token = identity.REQUEST_CLIENTS.set([])
    try:
        first = factory()
        second = factory()
        assert first is not second
        assert len(built) == 2
        assert len(identity.REQUEST_CLIENTS.get()) == 2
    finally:
        identity.REQUEST_CLIENTS.reset(bucket_token)
        identity.CALLER_AUTH.reset(token)


def test_engine_factory_state_exposed_for_shutdown(monkeypatch):
    """`factory._state` is the same mutable singleton-state dict `initModule`'s
    shutdown hook reads to close the shared client -- this is the contract
    that lets `_make_engine_factory` be extracted without changing shutdown.
    """
    from ai.modules import mcp as mcp_mod

    sentinel = object()
    monkeypatch.setattr(mcp_mod, 'make_engine_client', lambda cfg: sentinel)
    factory = mcp_mod._make_engine_factory({'rocketride_uri': 'ws://x', 'rocketride_auth': 'svc-key'})

    assert factory._state['client'] is None
    result = factory()
    assert result is sentinel
    assert factory._state['client'] is sentinel


# --- e2e: the ContextVar must survive into the SDK's dispatch task --------


@contextlib.asynccontextmanager
async def _e2e_mcp_app(monkeypatch, make_engine_client_fn):
    """Drive the real ASGI `/mcp` mount end to end.

    Same `FakeWebServer` double and router-event lifespan handling as
    test_dual_revision.py's `_mcp_test_app`, parameterized on the
    `make_engine_client` override instead of a fixed `fake_engine` so this
    module can record which auth each per-request client was actually built
    with -- the thing under test.
    """
    import ai.modules.mcp as mcp_module

    from .conftest import FakeWebServer

    monkeypatch.setattr(mcp_module, 'make_engine_client', make_engine_client_fn)

    srv = FakeWebServer()
    mcp_module.initModule(srv, {'mcp_dev_no_auth': True})
    try:
        for handler in srv.app.router.on_startup:
            await handler()
        transport = httpx.ASGITransport(app=srv.app)
        async with httpx.AsyncClient(
            transport=transport, base_url='http://testserver', follow_redirects=True
        ) as client:
            yield client
    finally:
        for handler in srv.app.router.on_shutdown:
            await handler()


_E2E_TOOLS_CALL = {
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

_E2E_HEADERS = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'authorization': 'Bearer rr_e2e_key',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'tools/call',
    'Mcp-Name': 'list_running_pipelines',
}


@pytest.mark.asyncio
async def test_caller_auth_contextvar_survives_into_sdk_dispatch(monkeypatch):
    """The heart of Task 5: a real `tools/call` POST to `/mcp` carrying
    `Authorization: Bearer rr_e2e_key` must reach `engine_factory()` with that
    exact credential -- proving the `identity.CALLER_AUTH` ContextVar set in
    `handle_mcp` survives into whatever task the SDK dispatches request
    handling onto, all the way down to `_on_call_tool`.
    """
    from .conftest import FakeEngineClient

    built = []

    def _recording_make_engine_client(config):
        client = FakeEngineClient(env_keys=[], auth=config.get('rocketride_auth'))
        built.append(client)
        return client

    async with _e2e_mcp_app(monkeypatch, _recording_make_engine_client) as app:
        resp = await app.post('/mcp', json=_E2E_TOOLS_CALL, headers=_E2E_HEADERS)
        assert resp.status_code == 200

    assert built, 'engine_factory() never constructed a client for this request'
    assert built[-1].auth == 'rr_e2e_key'
    # The per-request client is closed by handle_mcp's finally block once the
    # request completes -- proven here, not just asserted by reading the code.
    assert built[-1].close_calls == 1


_JWT_MCP_PROJECT = '999000111222333444'
_JWT_ISSUER = 'https://auth.rocketride.ai'  # oauth_resource.DEFAULT_AUTHORIZATION_SERVER


def _make_e2e_jwt(private_key, *, aud=_JWT_MCP_PROJECT, iss=_JWT_ISSUER, expires_in=3600, sub='e2e-oauth-caller'):
    """Mint a Zitadel-shaped access token, mirroring test_auth.py's `make_token`."""
    import time

    import jwt

    now = int(time.time())
    return jwt.encode(
        {'iss': iss, 'sub': sub, 'aud': aud, 'iat': now, 'exp': now + expires_in},
        private_key,
        algorithm='RS256',
    )


@pytest.mark.asyncio
async def test_caller_auth_contextvar_survives_into_sdk_dispatch_for_verified_jwt(monkeypatch):
    """Same proof as the API-key e2e test above, but for a verified OAuth JWT.

    Passing the JWT verbatim as `rocketride_auth` is the intended design (the
    spec's project decision: OAuth callers resolve to a RocketRide client
    authenticated with their own credential) -- this is not a path to gate or
    special-case, just the second credential shape that must reach
    `engine_factory()` unchanged, the same as the API-key path above.

    Reuses the keypair/JWKS-bypass technique test_auth.py's `keypair` /
    `_local_jwks` fixtures use to mint a verifiable token without a network
    call: a local RSA keypair stands in for Zitadel's signing key, and
    `auth._signing_key_for` is monkeypatched to return its public half
    directly instead of fetching a JWKS document.
    """
    from cryptography.hazmat.primitives.asymmetric import rsa

    from ai.modules.mcp import auth as auth_mod
    from .conftest import FakeEngineClient

    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(auth_mod, '_signing_key_for', lambda token: private.public_key())
    monkeypatch.setenv(auth_mod.ENV_EXPECTED_AUDIENCE, _JWT_MCP_PROJECT)

    token = _make_e2e_jwt(private)

    built = []

    def _recording_make_engine_client(config):
        client = FakeEngineClient(env_keys=[], auth=config.get('rocketride_auth'))
        built.append(client)
        return client

    headers = dict(_E2E_HEADERS)
    headers['authorization'] = f'Bearer {token}'

    async with _e2e_mcp_app(monkeypatch, _recording_make_engine_client) as app:
        resp = await app.post('/mcp', json=_E2E_TOOLS_CALL, headers=headers)
        assert resp.status_code == 200

    assert built, 'engine_factory() never constructed a client for this request'
    # The verified JWT reaches rocketride_auth VERBATIM -- no unwrapping, no
    # re-encoding, no gating on the fact that it's a JWT rather than an API key.
    assert built[-1].auth == token
    assert built[-1].close_calls == 1


@pytest.mark.asyncio
async def test_rejected_request_builds_no_engine_client_and_leaves_caller_auth_unset(monkeypatch):
    """An auth-REJECTED request must never reach `engine_factory()` at all.

    `auth.authorize()` stashes `mcp_credential` on some rejected requests too
    (Task 4's carry-note), so this pins the guard that matters: rejection
    short-circuits `handle_mcp` before `CALLER_AUTH`/`REQUEST_CLIENTS` are
    ever set, so no per-request engine client is built and the ContextVar
    stays at its default.

    Uses an opaque, non-JWT credential with an audience configured -- the
    same "refused while enforcing" shape as test_auth.py's
    `test_opaque_unrecognised_credential_is_refused_when_enforcing`.
    """
    from ai.modules.mcp import auth as auth_mod
    from .conftest import FakeEngineClient

    monkeypatch.setenv(auth_mod.ENV_EXPECTED_AUDIENCE, _JWT_MCP_PROJECT)

    built = []

    def _recording_make_engine_client(config):
        client = FakeEngineClient(env_keys=[], auth=config.get('rocketride_auth'))
        built.append(client)
        return client

    headers = dict(_E2E_HEADERS)
    headers['authorization'] = 'Bearer K1aQ9zOpaqueZitadelAccessToken'

    async with _e2e_mcp_app(monkeypatch, _recording_make_engine_client) as app:
        resp = await app.post('/mcp', json=_E2E_TOOLS_CALL, headers=headers)
        assert resp.status_code == 401

    assert built == [], 'a rejected request must never construct an engine client'
    assert identity.CALLER_AUTH.get() is None
    assert identity.REQUEST_CLIENTS.get() is None


# --- handle_mcp's finally-block: cancellation safety -----------------------


@pytest.mark.asyncio
async def test_handle_mcp_drain_survives_a_cancelled_close_and_still_resets_both_contextvars(monkeypatch):
    """Regression for the review finding on __init__.py's drain loop.

    A `CancelledError` raised while closing one bucketed client must not:
      (a) abandon the remaining clients in the bucket, or
      (b) skip either ContextVar reset.
    It must still propagate out of `handle_mcp` once cleanup has run, so the
    caller's cancellation is not silently swallowed.

    `StreamableHTTPSessionManager.handle_request` is replaced with a fake
    that populates the request's REQUEST_CLIENTS bucket directly (standing in
    for what `engine_factory()` would have appended during real dispatch),
    so this test exercises the real `finally` block in `__init__.py` --
    unlike `test_caller_auth_contextvar_survives_into_sdk_dispatch`, which
    only ever produces one bucketed client per request via the real tool
    dispatch path.
    """
    import asyncio

    from starlette.routing import Mount

    import ai.modules.mcp as mcp_module

    from .conftest import FakeWebServer

    monkeypatch.setattr(mcp_module, 'make_engine_client', lambda cfg, on_event=None: object())

    close_order = []

    class _RecordingClient:
        def __init__(self, name, raise_exc=None):
            self.name = name
            self._raise = raise_exc

        async def close(self):
            close_order.append(self.name)
            if self._raise is not None:
                raise self._raise

    first = _RecordingClient('first', raise_exc=asyncio.CancelledError())
    second = _RecordingClient('second')

    async def _fake_handle_request(self, scope, receive, send):
        bucket = identity.REQUEST_CLIENTS.get()
        bucket.append(first)
        bucket.append(second)

    monkeypatch.setattr(mcp_module.StreamableHTTPSessionManager, 'handle_request', _fake_handle_request)

    srv = FakeWebServer()
    mcp_module.initModule(srv, {'mcp_dev_no_auth': True})

    handle_mcp = next(route.app for route in srv.app.router.routes if isinstance(route, Mount) and route.path == '/mcp')

    scope = {
        'type': 'http',
        'method': 'POST',
        'path': '/mcp',
        'headers': [(b'authorization', b'Bearer rr_test_key')],
    }

    async def _receive():
        return {'type': 'http.disconnect'}

    async def _send(message):
        pass

    with pytest.raises(asyncio.CancelledError):
        await handle_mcp(scope, _receive, _send)

    # Both clients were drained despite the first one's close() raising --
    # the cancellation did not abort the loop early.
    assert close_order == ['first', 'second']
    # Both ContextVars were reset back to their defaults, not left bound to
    # this request's (now torn-down) auth/bucket.
    assert identity.CALLER_AUTH.get() is None
    assert identity.REQUEST_CLIENTS.get() is None
