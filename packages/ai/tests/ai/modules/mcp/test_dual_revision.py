# Copyright 2026 Aparavi Software AG. MIT License.
"""A legacy (2025-11-25) client must still connect through the mounted `/mcp`
endpoint after the 2026-07-28 SDK bump -- the compat-window gate
(sdk-api-notes.md §6: dual-revision serving is unconditional in v2, no
opt-in flag) pinned as a regression test.

Drives the real ASGI app `initModule` builds (FastAPI `FakeServer.app`, same
double as test_mcp_module.py) over `httpx.ASGITransport`, with the mounted
`/mcp` Starlette `Mount`'s session-manager lifespan actually running --
required, since `handle_mcp` delegates to `StreamableHTTPSessionManager.
handle_request`, which raises if its `run()` context was never entered
(`__init__.py`'s `_startup`/`_shutdown`, wired onto `app.router.
on_startup`/`on_shutdown` for the FakeServer double). `asgi-lifespan`'s
`LifespanManager` is not installed in this venv, so the router's event
handlers are invoked directly -- the same pattern test_mcp_module.py's
shutdown tests already use.
"""

import contextlib
import json

import httpx


LEGACY_INIT = {
    'jsonrpc': '2.0',
    'id': 1,
    'method': 'initialize',
    'params': {
        'protocolVersion': '2025-11-25',
        'capabilities': {},
        'clientInfo': {'name': 'legacy-probe', 'version': '0.0.1'},
    },
}

LEGACY_HEADERS = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
}

MODERN_TOOLS_LIST = {
    'jsonrpc': '2.0',
    'id': 1,
    'method': 'tools/list',
    'params': {
        '_meta': {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
        }
    },
}

MODERN_HEADERS = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': 'tools/list',
}


def _first_jsonrpc_payload(resp):
    """Parse a JSON-RPC payload from either framing the endpoint may use."""
    ctype = resp.headers.get('content-type', '')
    if ctype.startswith('application/json'):
        return resp.json()
    # text/event-stream: first `data:` line carries the JSON-RPC message
    for line in resp.text.splitlines():
        if line.startswith('data:'):
            return json.loads(line[len('data:') :].strip())
    raise AssertionError(f'no JSON-RPC payload in response (content-type={ctype!r})')


@contextlib.asynccontextmanager
async def _mcp_test_app(monkeypatch, fake_engine):
    """An `httpx.AsyncClient` over the FastAPI app `initModule` mounts `/mcp`
    onto, with the session-manager lifespan actually running for the
    duration of the `async with` block.

    Same `FakeServer` double as `test_initmodule_mounts_mcp_route` /
    `test_shutdown_*` in test_mcp_module.py, but wrapped so `srv.app.router.
    on_startup`/`on_shutdown` fire around the yielded client instead of being
    invoked standalone -- the mounted `Mount(app=handle_mcp)` needs the
    session manager's `run()` context entered before any request reaches it.

    This is an `@asynccontextmanager` helper, not a `yield`-based pytest
    fixture, so setup/requests/teardown all execute in one continuous
    coroutine (the calling test's own task). `session_manager.run()` opens an
    `anyio.create_task_group()`, and anyio cancel scopes must be exited in
    the same asyncio Task they were entered in; pytest-asyncio resumes a
    `yield`-based async fixture's teardown half in a *different* Task than
    its setup half, which trips exactly that check (`RuntimeError: Attempted
    to exit cancel scope in a different task than it was entered in`, seen
    when this was first written as a fixture). `follow_redirects=True` is
    required too: Starlette's `Mount` 307-redirects a bare `/mcp` POST to
    `/mcp/` (no trailing slash on `_MOUNT_PATH` in `__init__.py`), which a
    real Streamable-HTTP client follows transparently (307 preserves method
    + body) -- httpx does not follow redirects by default.
    """
    import ai.modules.mcp as mcp_module

    from .conftest import FakeWebServer

    monkeypatch.setattr(mcp_module, 'make_engine_client', lambda cfg, on_event=None: fake_engine)

    srv = FakeWebServer()
    mcp_module.initModule(srv, {'mcp_dev_no_auth': True})

    try:
        # Inside the try: a handler raising mid-startup must still reach the
        # finally-shutdown, or the session-manager task group leaks and the
        # test fails on a teardown artifact instead of the real error.
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


async def test_legacy_initialize_still_answered(monkeypatch, fake_engine):
    async with _mcp_test_app(monkeypatch, fake_engine) as mcp_test_app:
        resp = await mcp_test_app.post('/mcp', json=LEGACY_INIT, headers=LEGACY_HEADERS)
        assert resp.status_code == 200
        body = _first_jsonrpc_payload(resp)
        assert 'result' in body
        assert body['result']['protocolVersion'] == '2025-11-25'


async def test_legacy_client_can_list_tools_after_initialize(monkeypatch, fake_engine):
    """The stronger regression pin: a legacy client that completes the full
    initialize -> notifications/initialized -> tools/list handshake must
    still get a real tool listing back, not just an `initialize` echo.

    Note on session continuity: `__init__.py` wires the session manager with
    `stateless=True`, and the legacy dispatch branch for stateless mode
    (`StreamableHTTPSessionManager._handle_stateless_request`) builds a
    brand-new transport per POST with `mcp_session_id=None` -- stateless mode
    never mints an `Mcp-Session-Id` header at all (confirmed by reading
    `streamable_http_manager.py`: "No session ID needed in stateless mode").
    So there is no session id to capture or echo back here; each POST below
    is independently a fresh legacy-dispatch transport, and the comment in
    the SDK itself notes the stateless path is "born-ready" -- it seeds
    `ctx.protocol_version` straight from the `MCP-Protocol-Version` header
    and does not require having seen `initialize` first. This test still
    sends the full three-message handshake sequence a real legacy client
    would use, to pin that the whole flow -- not just a bare `tools/list` --
    keeps working end to end.
    """
    async with _mcp_test_app(monkeypatch, fake_engine) as mcp_test_app:
        init_resp = await mcp_test_app.post('/mcp', json=LEGACY_INIT, headers=LEGACY_HEADERS)
        assert init_resp.status_code == 200
        assert 'result' in _first_jsonrpc_payload(init_resp)

        initialized_notification = {'jsonrpc': '2.0', 'method': 'notifications/initialized'}
        notify_resp = await mcp_test_app.post('/mcp', json=initialized_notification, headers=LEGACY_HEADERS)
        assert notify_resp.status_code in (200, 202)

        list_tools = {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list', 'params': {}}
        list_resp = await mcp_test_app.post('/mcp', json=list_tools, headers=LEGACY_HEADERS)
        assert list_resp.status_code == 200
        body = _first_jsonrpc_payload(list_resp)
        assert 'result' in body, body
        names = {tool['name'] for tool in body['result']['tools']}
        assert 'list_components' in names


async def test_modern_client_can_list_tools_through_the_real_mount(monkeypatch, fake_engine):
    """A self-describing 2026-07-28 request must clear the modern-path validation
    ladder through the real `/mcp` mount, not just the in-memory `Client`.

    Every other 2026-07-28 test in this module (test_cache_policy.py,
    test_module_registration.py, etc.) drives `mcp.client.Client` directly,
    which never touches `StreamableHTTPSessionManager._handle_request`'s
    header-inspecting dual-revision branch (sdk-api-notes.md §6) or the ASGI
    mount/lifespan wiring at all. This is the one place in the suite that
    exercises the real HTTP entry for the modern path.

    Per `mcp/shared/inbound.py::classify_inbound_request` (imported by
    `mcp/server/_streamable_http_modern.py`), a modern request must clear:
    1. `params._meta` carrying the envelope pair `io.modelcontextprotocol/
       protocolVersion` + `io.modelcontextprotocol/clientCapabilities`
       (`clientInfo` is optional -- omitted here).
    2. The `MCP-Protocol-Version` header equal to the envelope's protocol
       version, and `Mcp-Method` equal to the body's `method` -- both routing
       headers, checked before the version is even looked up in the supported
       set (a mismatch is `HEADER_MISMATCH` / -32020, not
       `UNSUPPORTED_PROTOCOL_VERSION`). `Mcp-Name` is required only for the
       `NAME_BEARING_METHODS` (`tools/call`, `prompts/get`, `resources/read`)
       -- `tools/list` isn't one, so it's omitted.

    This is also the only place in the suite that can assert the wire-level
    camelCase cache-hint aliases (`ttlMs`/`cacheScope`): the in-memory
    `Client` in test_cache_policy.py decodes straight to the snake_case
    pydantic fields, never touching the JSON the wire actually carries.
    """
    from ai.modules.mcp.cache_policy import CACHE_SCOPE, TOOLS_TTL_MS

    async with _mcp_test_app(monkeypatch, fake_engine) as mcp_test_app:
        resp = await mcp_test_app.post('/mcp', json=MODERN_TOOLS_LIST, headers=MODERN_HEADERS)
        assert resp.status_code == 200
        body = _first_jsonrpc_payload(resp)
        assert 'result' in body, body
        result = body['result']
        from .conftest import EXPECTED_TOOL_NAMES

        assert len(result['tools']) == len(EXPECTED_TOOL_NAMES)
        # python-side snake_case fields are ttl_ms/cache_scope; the wire keeps
        # the camelCase aliases (sdk-api-notes.md §3) -- this is the only test
        # in the module that goes through JSON serialization to see them.
        assert result['ttlMs'] == TOOLS_TTL_MS
        assert result['cacheScope'] == CACHE_SCOPE
