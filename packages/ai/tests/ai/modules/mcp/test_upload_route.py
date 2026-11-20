# Copyright 2026 Aparavi Software AG. MIT License.
"""The dropper widget's upload door: ``POST /mcp/upload/{nonce}`` (plan 3.7).

``run_dropper_pipe`` mints a one-time nonce bound to the task it started and
to the caller identity the tool call ran under; the route redeems it once and
forwards the bytes into the task over the CALLER's engine client, with no
credential on the widget's request. These tests drive the real ASGI mount
end to end (the same ``FakeWebServer`` harness as test_identity.py) and, for
the public-path decision, the real ``WebServer`` + ``AuthMiddleware`` (the
harness of test_route_reservation.py).
"""

import contextlib
import json
from types import SimpleNamespace
from urllib.parse import urlsplit

import httpx
import pytest

from ai.modules.mcp import apps, registry as registry_mod
from ai.modules.mcp.registry import TaskRegistry

PIPE = {'components': [], 'source': 'x'}

_HEADERS = {
    'content-type': 'application/json',
    'accept': 'application/json, text/event-stream',
    'authorization': 'Bearer rr_e2e_key',
    'MCP-Protocol-Version': '2026-07-28',
}


def _tools_call(name, arguments):
    return {
        'jsonrpc': '2.0',
        'id': 1,
        'method': 'tools/call',
        'params': {
            'name': name,
            'arguments': arguments,
            '_meta': {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientCapabilities': {},
            },
        },
    }


def _tool_result(resp):
    """The tool's JSON result out of a Streamable-HTTP response (SSE or JSON)."""
    assert resp.status_code == 200, resp.text[:300]
    if resp.headers.get('content-type', '').startswith('text/event-stream'):
        messages = [json.loads(line[5:]) for line in resp.text.splitlines() if line.startswith('data:')]
    else:
        messages = [resp.json()]
    message = next(m for m in messages if 'result' in m)
    return message['result']['structuredContent']


def _recording_factory(built):
    from .conftest import FakeEngineClient

    def _make(config, on_event=None):
        client = FakeEngineClient(env_keys=[], auth=config.get('rocketride_auth'))
        built.append(client)
        return client

    return _make


@contextlib.asynccontextmanager
async def _mcp_app(monkeypatch, built):
    """Mount the real `/mcp` on a FakeWebServer; record every engine client built."""
    import ai.modules.mcp as mcp_module

    from .conftest import FakeWebServer

    monkeypatch.setattr(mcp_module, 'make_engine_client', _recording_factory(built))
    srv = FakeWebServer()
    mcp_module.initModule(srv, {'mcp_dev_no_auth': True})
    try:
        for handler in srv.app.router.on_startup:
            await handler()
        transport = httpx.ASGITransport(app=srv.app)
        async with httpx.AsyncClient(transport=transport, base_url='http://testserver') as client:
            yield client
    finally:
        for handler in srv.app.router.on_shutdown:
            await handler()


async def _start_dropper(app, headers=_HEADERS):
    headers = {**headers, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'run_dropper_pipe'}
    result = _tool_result(
        await app.post('/mcp', json=_tools_call('run_dropper_pipe', {'pipeline': PIPE}), headers=headers)
    )
    assert result['ok'] is True, result
    return result


async def _upload(app, upload_url, **kwargs):
    """POST the widget's multipart body to the route: no header, no query credential."""
    files = kwargs.pop('files', {'file_0': ('a.txt', b'hello', 'text/plain')})
    return await app.post(urlsplit(upload_url).path, files=files, **kwargs)


# --- the registry: nonces live and die with the RUN (its control id) -------

ADDRESS = 'acme.proj.src'


def test_registry_issues_a_nonce_only_for_a_tracked_task():
    tasks = TaskRegistry()
    with pytest.raises(KeyError):
        tasks.issue_upload_nonce(ADDRESS, 'rr_x')
    tasks.add(ADDRESS, instance='c1', pipeline_ref='<inline>')
    nonce = tasks.issue_upload_nonce(ADDRESS, 'rr_x')
    assert nonce and '/' not in nonce and '?' not in nonce
    # the control id names the same entry: every MCP verb hands the registry a control id
    assert tasks.get('c1') == tasks.get(ADDRESS) == {'token': ADDRESS, 'instance': 'c1', 'pipeline_ref': '<inline>'}
    assert tasks.instance_of(ADDRESS) == tasks.instance_of('c1') == 'c1'
    assert tasks.issue_upload_nonce('c1', 'rr_x')


def test_registry_nonce_is_redeemed_exactly_once():
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    nonce = tasks.issue_upload_nonce(ADDRESS, None)
    assert tasks.consume_upload_nonce(nonce) == {'token': ADDRESS, 'instance': 'c1', 'caller_auth': None}
    assert tasks.consume_upload_nonce(nonce) is None
    assert tasks.consume_upload_nonce('never-issued') is None


def test_registry_remove_by_either_handle_drops_the_tasks_nonces_and_keeps_the_others():
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    tasks.add('other.proj.src', instance='c2')
    gone = tasks.issue_upload_nonce(ADDRESS, 'rr_a')
    kept = tasks.issue_upload_nonce('other.proj.src', 'rr_b')
    tasks.remove('c1')  # terminate names the control id
    assert tasks.get(ADDRESS) is None and tasks.instance_of('c1') is None
    assert tasks.consume_upload_nonce(gone) is None
    assert tasks.consume_upload_nonce(kept) == {'token': 'other.proj.src', 'instance': 'c2', 'caller_auth': 'rr_b'}


def test_registry_eviction_drops_the_evicted_tasks_nonces(monkeypatch):
    monkeypatch.setattr(registry_mod, 'MAX_TASKS', 2)
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    nonce = tasks.issue_upload_nonce(ADDRESS, None)
    tasks.add('b.proj.src', instance='c2')
    tasks.add('c.proj.src', instance='c3')  # evicts ADDRESS
    assert tasks.get(ADDRESS) is None
    assert tasks.consume_upload_nonce(nonce) is None


def test_registry_re_add_of_the_same_run_keeps_the_tasks_nonces():
    """`use_existing` attached to the LIVE run: use() answers the same control id, the nonce stays valid."""
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    nonce = tasks.issue_upload_nonce(ADDRESS, None)
    tasks.add(ADDRESS, instance='c1', pipeline_ref='<inline>')
    assert tasks.consume_upload_nonce(nonce) == {'token': ADDRESS, 'instance': 'c1', 'caller_auth': None}


def test_registry_new_run_at_the_same_address_drops_the_earlier_runs_nonces():
    """The address is reused by the next run of the same project/source and the
    engine never calls remove on expiry: a different control id at the address
    is a new run, so the earlier run's nonce must not redeem into it.
    """
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    stale = tasks.issue_upload_nonce(ADDRESS, 'rr_first_caller')
    tasks.add(ADDRESS, instance='c2', pipeline_ref='<inline>')
    assert tasks.consume_upload_nonce(stale) is None
    assert tasks.instance_of(ADDRESS) == 'c2' and tasks.get('c1') is None


def test_registry_refuses_a_replacement_link_for_a_superseded_run():
    """The replacement link a redeemed nonce buys must name the run that nonce
    was minted for: after a fresh launch took the address over, the old control
    id is refused; a same-run re-add keeps it current.
    """
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    bound = tasks.consume_upload_nonce(tasks.issue_upload_nonce(ADDRESS, 'rr_a'))
    assert bound == {'token': ADDRESS, 'instance': 'c1', 'caller_auth': 'rr_a'}
    tasks.add(ADDRESS, instance='c1')
    assert tasks.issue_upload_nonce(ADDRESS, 'rr_a', instance=bound['instance'])
    tasks.add(ADDRESS, instance='c2')  # a fresh launch at the same address
    with pytest.raises(KeyError):
        tasks.issue_upload_nonce(ADDRESS, 'rr_a', instance=bound['instance'])
    assert tasks.issue_upload_nonce(ADDRESS, 'rr_b')  # unqualified minting (run_dropper_pipe) is unaffected


def test_allocate_keys_never_shadows_a_submitted_key():
    assert apps._allocate_keys(['file', 'file', 'file_0']) == ['file_1', 'file_2', 'file_0']
    assert apps._allocate_keys(['file_0', 'file', 'file']) == ['file_0', 'file_1', 'file_2']
    assert apps._allocate_keys(['a', 'b', 'a', 'c']) == ['a_0', 'b', 'a_1', 'c']
    assert apps._allocate_keys(['only']) == ['only']
    assert apps._allocate_keys([]) == []


def test_dropper_csp_admits_the_mcp_origin_next_to_the_engine_origin(tmp_path):
    (tmp_path / 'dropper.html').write_text('<!doctype html>', encoding='utf-8')
    [two] = apps.list_ui_resources(tmp_path, 'https://engine.example', 'https://mcp.example')
    assert two.meta == {'ui': {'csp': {'connectDomains': ['https://engine.example', 'https://mcp.example']}}}
    # one engine mounting its own MCP module: one origin, listed once
    [one] = apps.list_ui_resources(tmp_path, 'https://api.example', 'https://api.example')
    assert one.meta == {'ui': {'csp': {'connectDomains': ['https://api.example']}}}


def test_registry_caps_live_nonces_per_task_oldest_first(monkeypatch):
    monkeypatch.setattr(registry_mod, 'MAX_UPLOAD_NONCES_PER_TASK', 2)
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    first = tasks.issue_upload_nonce(ADDRESS, None)
    second = tasks.issue_upload_nonce(ADDRESS, None)
    third = tasks.issue_upload_nonce(ADDRESS, None)
    assert tasks.consume_upload_nonce(first) is None
    assert tasks.consume_upload_nonce(second) is not None
    assert tasks.consume_upload_nonce(third) is not None


# --- the route, end to end on the real /mcp mount -------------------------


@pytest.mark.asyncio
async def test_nonce_upload_is_accepted_once_and_the_bytes_land_in_the_task_as_the_caller(monkeypatch):
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        started = await _start_dropper(app)
        # No credential inside either URL: the nonce is the only URL-carried
        # value and the address does not ride the upload link either.
        assert 'rr_e2e_key' not in started['upload_url'] and 'rr_e2e_key' not in started['dropper_url']
        assert '?' not in started['upload_url'] and 'auth=' not in started['dropper_url']
        assert urlsplit(started['upload_url']).path.startswith('/mcp/upload/')
        assert len(built) == 1  # the tool call's per-caller client, already closed
        assert built[0].close_calls == 1

        resp = await _upload(app, started['upload_url'], files={'file_0': ('a.txt', b'hello', 'text/plain')})

    assert resp.status_code == 200, resp.text
    envelope = resp.json()
    assert envelope['status'] == 'OK'
    data = envelope['data']
    assert data['objectsRequested'] == 1 and data['objectsCompleted'] == 1
    assert data['objects']['file_0']['status'] == 'OK'
    # The route built the CALLER's engine client (the credential the nonce was
    # minted under), sent open -> write -> close on the caller's control --
    # the SDK's send -- and closed that client when the request ended.
    assert len(built) == 2
    uploader = built[1]
    assert uploader.auth == 'rr_e2e_key'
    assert uploader.sent == [
        {
            'token': started['address'],
            'data': b'hello',
            'objinfo': {'name': 'a.txt', 'size': 5},
            'mimetype': 'text/plain',
        }
    ]
    assert uploader.close_calls == 1


@pytest.mark.asyncio
async def test_nonce_reuse_is_refused_and_the_response_carried_the_next_one(monkeypatch):
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        started = await _start_dropper(app)
        first = await _upload(app, started['upload_url'])
        assert first.status_code == 200
        # one nonce, one upload
        again = await _upload(app, started['upload_url'])
        assert again.status_code == 404
        assert again.json()['status'] == 'Error'
        # the accepted upload handed the widget the next link; it works exactly once too
        next_url = first.json()['upload_url']
        assert next_url != started['upload_url'] and 'rr_e2e_key' not in next_url
        second = await _upload(app, next_url, files={'file_0': ('b.txt', b'again', 'text/plain')})
        assert second.status_code == 200
        assert (await _upload(app, next_url)).status_code == 404

    assert [c.sent[0]['data'] for c in built if c.sent] == [b'hello', b'again']


@pytest.mark.asyncio
async def test_a_nonce_from_another_session_is_refused(monkeypatch):
    """A nonce is bound to the tracker that minted it: another MCP server
    (another session's tracker) does not know it and answers 404.
    """
    # One recording list: the monkeypatched factory is module-level, so the
    # second mount records every client built for either server.
    built = []
    async with _mcp_app(monkeypatch, built) as app_a, _mcp_app(monkeypatch, built) as app_b:
        started = await _start_dropper(app_a)
        resp = await _upload(app_b, started['upload_url'])
        assert resp.status_code == 404
        assert not any(c.sent for c in built)
        # ...and the right session still accepts it
        assert (await _upload(app_a, started['upload_url'])).status_code == 200

    assert [c.sent[0]['token'] for c in built if c.sent] == [started['address']]


@pytest.mark.asyncio
async def test_a_nonce_is_refused_after_terminate(monkeypatch):
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        started = await _start_dropper(app)
        headers = {**_HEADERS, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'terminate'}
        result = _tool_result(
            await app.post('/mcp', json=_tools_call('terminate', {'address': started['address']}), headers=headers)
        )
        assert result == {'ok': True, 'terminated': started['address']}

        resp = await _upload(app, started['upload_url'])

    assert resp.status_code == 404
    assert not any(c.sent for c in built)


@pytest.mark.asyncio
async def test_unknown_nonce_is_refused_without_building_a_client(monkeypatch):
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        resp = await app.post('/mcp/upload/not-a-nonce', files={'file_0': ('a.txt', b'x', 'text/plain')})
    assert resp.status_code == 404
    assert built == []


@pytest.mark.asyncio
async def test_a_query_credential_is_refused_before_the_nonce_is_spent(monkeypatch):
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        started = await _start_dropper(app)
        refused = await _upload(app, started['upload_url'], params={'auth': 'rr_leaked'})
        assert refused.status_code == 400
        assert 'auth' in refused.json()['error']['error']
        # the nonce was not consumed by the refused request
        assert (await _upload(app, started['upload_url'])).status_code == 200


@pytest.mark.asyncio
async def test_a_failed_part_is_reported_per_object_and_the_rest_still_land(monkeypatch):
    from .conftest import FakeEngineClient

    built = []

    def _make(config, on_event=None):
        client = FakeEngineClient(env_keys=[], auth=config.get('rocketride_auth'))

        async def _send(token, data, objinfo=None, mimetype=None, on_sse=None):
            if data == b'bad':
                raise RuntimeError('engine refused the object')
            client.sent.append({'token': token, 'data': data, 'objinfo': objinfo, 'mimetype': mimetype})
            return {'text': data.decode(), 'result_types': {'text': 'text'}}

        client.send = _send
        built.append(client)
        return client

    import ai.modules.mcp as mcp_module

    from .conftest import FakeWebServer

    monkeypatch.setattr(mcp_module, 'make_engine_client', _make)
    srv = FakeWebServer()
    mcp_module.initModule(srv, {'mcp_dev_no_auth': True})
    for handler in srv.app.router.on_startup:
        await handler()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=srv.app), base_url='http://testserver') as app:
            started = await _start_dropper(app)
            resp = await app.post(
                urlsplit(started['upload_url']).path,
                files=[('file', ('ok.txt', b'fine', 'text/plain')), ('file', ('bad.txt', b'bad', 'text/plain'))],
                data={'question': 'what is this'},
            )
    finally:
        for handler in srv.app.router.on_shutdown:
            await handler()

    assert resp.status_code == 200, resp.text
    data = resp.json()['data']
    assert data['objectsRequested'] == 3 and data['objectsCompleted'] == 2
    assert data['objects']['file_0'] == {'text': 'fine', 'status': 'OK'}
    assert data['objects']['file_1']['status'] == 'Error'
    assert data['objects']['question'] == {'text': 'what is this', 'status': 'OK'}
    assert data['resultTypes'] == {'text': 'text'}
    # the string field went in as text/plain under a generated name
    string_part = next(s for s in built[-1].sent if s['data'] == b'what is this')
    assert string_part['mimetype'] == 'text/plain' and string_part['objinfo']['name'].startswith('question-')


@pytest.mark.asyncio
async def test_raw_body_upload_is_one_object_named_by_content_disposition(monkeypatch):
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        started = await _start_dropper(app)
        resp = await app.post(
            urlsplit(started['upload_url']).path,
            content=b'%PDF-1.4',
            headers={'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="doc.pdf"'},
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()['data']['objects']['content']['status'] == 'OK'
    assert built[-1].sent == [
        {
            'token': started['address'],
            'data': b'%PDF-1.4',
            'objinfo': {'name': 'doc.pdf', 'size': 8},
            'mimetype': 'application/pdf',
        }
    ]


def test_upload_url_composes_on_the_engine_origin():
    assert apps.upload_url('http://localhost:5565/', 'n0nce') == 'http://localhost:5565/mcp/upload/n0nce'
    assert apps.UPLOAD_PATH == '/mcp/upload/{nonce}'


# --- the public-path decision on the real WebServer + AuthMiddleware -------


def _web_server(monkeypatch, tmp_path, built):
    """The test_route_reservation.py harness: real WebServer, any credential accepted."""
    pytest.importorskip('rocketlib')
    import ai.modules.mcp as mcp_module
    import ai.modules.shell.shell as shell_mod
    from ai.web.server import WebServer

    (tmp_path / 'index.html').write_text('<!doctype html><title>shell</title>')
    monkeypatch.setattr(shell_mod, '_shell_root', str(tmp_path))
    monkeypatch.setattr(mcp_module, 'make_engine_client', _recording_factory(built))

    server = WebServer()
    for name in ('ROCKETRIDE_URI', 'MCP_RESOURCE_IDENTIFIER', 'MCP_DEV_NO_AUTH'):
        monkeypatch.delenv(name, raising=False)

    async def _accept_any(authorization):
        return SimpleNamespace(auth=authorization)

    monkeypatch.setattr(server, '_authenticate_credential_inner', _accept_any)
    server.use('shell', {})
    server.use('mcp', {})
    return server


@contextlib.asynccontextmanager
async def _serve(server):
    await server._user_startup()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url='http://testserver') as c:
            yield c
    finally:
        await server._user_shutdown()


def test_only_the_upload_route_is_public_under_mcp(monkeypatch, tmp_path):
    server = _web_server(monkeypatch, tmp_path, [])
    assert server.is_public_route('/mcp/upload/some-nonce') is True
    for path in ('/mcp', '/mcp/', '/mcp/anything', '/mcp/upload', '/mcp/upload/a/b'):
        assert server.is_public_route(path) is False, path


@pytest.mark.asyncio
async def test_credential_less_upload_passes_auth_middleware_and_lands_as_the_caller(monkeypatch, tmp_path):
    """The widget's POST carries no credential, so AuthMiddleware must let it
    through to the route (404 for a bad nonce, never 401) -- and a real nonce
    minted through the authenticated /mcp door forwards as that caller.
    """
    built = []
    server = _web_server(monkeypatch, tmp_path, built)
    async with _serve(server) as app:
        unknown = await app.post('/mcp/upload/not-a-nonce', files={'file_0': ('a.txt', b'x', 'text/plain')})
        assert unknown.status_code == 404, unknown.text[:200]

        started = await _start_dropper(app)
        resp = await _upload(app, started['upload_url'])

    assert resp.status_code == 200, resp.text[:300]
    assert resp.json()['status'] == 'OK'
    assert built[-1].auth == 'rr_e2e_key'
    assert built[-1].sent[0]['token'] == started['address'] and built[-1].sent[0]['data'] == b'hello'


# --- CodeRabbit round 1: origin, byte cap, key collisions, task instance ---


@pytest.mark.asyncio
async def test_links_point_at_the_mcp_server_not_the_engine(monkeypatch):
    """With rocketride_uri on another host, the engine origin differs from this
    server's: upload_url (initial AND rotated) must name THIS server, the only
    holder of the nonce; dropper_url stays the engine's shell app.
    """
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        started = await _start_dropper(app)
        # The fake engine client answers base_url 'http://localhost:5565' whatever
        # the configured URI; this server's own origin resolves to 127.0.0.1.
        engine_origin = built[0].base_url
        assert started['dropper_url'].startswith(f'{engine_origin}/')
        assert started['upload_url'].startswith('http://127.0.0.1:')
        assert not started['upload_url'].startswith(engine_origin)
        first = await _upload(app, started['upload_url'])
        assert first.status_code == 200
        rotated = first.json()['upload_url']
        assert rotated.startswith('http://127.0.0.1:') and not rotated.startswith(engine_origin)


@pytest.mark.asyncio
async def test_declared_oversize_is_refused_before_the_nonce_is_spent(monkeypatch):
    monkeypatch.setattr(apps, 'MAX_UPLOAD_BYTES', 16)
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        started = await _start_dropper(app)
        refused = await app.post(urlsplit(started['upload_url']).path, content=b'x' * 64)
        assert refused.status_code == 413
        body = refused.json()
        assert body['status'] == 'Error' and '16 byte limit' in body['error']['error']
        # the same link is still good: the nonce was not spent
        assert body['upload_url'] == started['upload_url']
        assert (await app.post(urlsplit(started['upload_url']).path, content=b'small')).status_code == 200

    assert [c.sent[0]['data'] for c in built if c.sent] == [b'small']


@pytest.mark.asyncio
async def test_streaming_oversize_is_cut_off_before_buffering_and_nothing_is_forwarded(monkeypatch):
    """A body that declares no length is counted as it arrives and refused the
    moment it passes the cap -- on the raw path and on the multipart path --
    with no part forwarded; the spent nonce is replaced in the 413 answer.
    """
    import json as _json

    from starlette.requests import Request

    from .conftest import FakeEngineClient

    monkeypatch.setattr(apps, 'MAX_UPLOAD_BYTES', 16)
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    clients = []

    def factory():
        # as the module's own factory does: bucket the per-request client so the
        # route closes it when the request ends
        from ai.modules.mcp import identity

        client = FakeEngineClient()
        clients.append(client)
        identity.REQUEST_CLIENTS.get().append(client)
        return client

    async def drive(content_type, chunks):
        nonce = tasks.issue_upload_nonce(ADDRESS, 'rr_x')
        pending = [{'type': 'http.request', 'body': chunk, 'more_body': True} for chunk in chunks]
        pending.append({'type': 'http.request', 'body': b'', 'more_body': False})

        async def receive():
            return pending.pop(0)

        scope = {
            'type': 'http',
            'method': 'POST',
            'path': f'/mcp/upload/{nonce}',
            'headers': [(b'content-type', content_type)],
            'query_string': b'',
            'path_params': {'nonce': nonce},
        }
        response = await apps.handle_upload(Request(scope, receive), factory, tasks, 'http://mcp.test')
        return nonce, response, _json.loads(response.body)

    nonce, response, body = await drive(b'application/octet-stream', [b'x' * 10, b'y' * 10, b'z' * 10])
    assert response.status_code == 413 and 'limit' in body['error']['error']
    assert tasks.consume_upload_nonce(nonce) is None  # the request spent it...
    assert body['upload_url'].startswith('http://mcp.test/mcp/upload/')  # ...and was handed the next one

    boundary = b'----b'
    part = b'--' + boundary + b'\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\n\r\n'
    nonce, response, body = await drive(
        b'multipart/form-data; boundary=' + boundary, [part, b'x' * 10, b'y' * 10, b'\r\n--' + boundary + b'--\r\n']
    )
    assert response.status_code == 413
    assert not any(c.sent for c in clients)
    assert all(c.close_calls == 1 for c in clients)


@pytest.mark.asyncio
async def test_colliding_field_names_all_land_in_the_result_map(monkeypatch):
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        started = await _start_dropper(app)
        resp = await app.post(
            urlsplit(started['upload_url']).path,
            files=[
                ('file', ('one.txt', b'1', 'text/plain')),
                ('file', ('two.txt', b'2', 'text/plain')),
                ('file_0', ('zero.txt', b'0', 'text/plain')),
            ],
        )
    assert resp.status_code == 200, resp.text
    data = resp.json()['data']
    assert data['objectsRequested'] == 3 and data['objectsCompleted'] == 3
    assert set(data['objects']) == {'file_1', 'file_2', 'file_0'}
    assert [s['objinfo']['name'] for s in built[-1].sent] == ['one.txt', 'two.txt', 'zero.txt']


@pytest.mark.asyncio
async def test_a_new_run_at_the_same_address_refuses_the_old_nonce_and_use_existing_keeps_it(monkeypatch):
    """use() answers the run's control id in its token slot: the same id when
    use_existing attached to the live run, a new one for a fresh launch at the
    same address -- and the earlier run's nonce must not upload into that.
    """
    import ai.modules.mcp as mcp_module

    from .conftest import FakeEngineClient, FakeWebServer

    built = []
    runs = {'live': None, 'count': 0}

    def _make(config, on_event=None):
        client = FakeEngineClient(env_keys=[], auth=config.get('rocketride_auth'))

        async def _use(**kwargs):
            if not (kwargs.get('use_existing') and runs['live']):
                runs['count'] += 1
                runs['live'] = f'c{runs["count"]}'
            return {'token': runs['live'], 'address': ADDRESS, 'projectId': 'p', 'source': 's'}

        client.use = _use
        built.append(client)
        return client

    monkeypatch.setattr(mcp_module, 'make_engine_client', _make)
    srv = FakeWebServer()
    mcp_module.initModule(srv, {'mcp_dev_no_auth': True})
    for handler in srv.app.router.on_startup:
        await handler()
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=srv.app), base_url='http://testserver') as app:
            headers = {**_HEADERS, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'run_dropper_pipe'}

            async def start(**extra):
                args = {'pipeline': PIPE, **extra}
                result = _tool_result(
                    await app.post('/mcp', json=_tools_call('run_dropper_pipe', args), headers=headers)
                )
                assert result['ok'] is True and result['address'] == runs['live']
                return result['upload_url']

            first = await start()
            attached = await start(use_existing=True)  # the same live run (same control id): both links stay good
            assert (await _upload(app, first)).status_code == 200
            relaunched = await start()  # a fresh launch at the same address: a new control id
            assert (await _upload(app, attached)).status_code == 404
            assert (await _upload(app, relaunched)).status_code == 200
            # every forwarded upload named the RUN it was minted for, never the address
            assert [c.sent[0]['token'] for c in built if c.sent] == ['c1', 'c2']
    finally:
        for handler in srv.app.router.on_shutdown:
            await handler()


# --- CodeRabbit round 2: replacement links bind to the redeemed instance -----


async def _drive_renewal(monkeypatch, between, *, oversize=False, body=None, content_type=b'application/octet-stream'):
    """Redeem a nonce, run `between(tasks)` while the body is being read (the
    window a fresh launch can land in), and return the parsed answer.
    """
    import json as _json

    from starlette.requests import Request

    from ai.modules.mcp import identity

    from .conftest import FakeEngineClient

    monkeypatch.setattr(apps, 'MAX_UPLOAD_BYTES', 16)
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    nonce = tasks.issue_upload_nonce(ADDRESS, 'rr_x')

    def factory():
        client = FakeEngineClient()
        identity.REQUEST_CLIENTS.get().append(client)
        return client

    body = body if body is not None else b'x' * (64 if oversize else 4)
    pending = [{'type': 'http.request', 'body': body, 'more_body': False}]

    async def receive():
        between(tasks)  # the body arrives after the nonce was redeemed
        return pending.pop(0)

    scope = {
        'type': 'http',
        'method': 'POST',
        'path': f'/mcp/upload/{nonce}',
        'headers': [(b'content-type', content_type)],
        'query_string': b'',
        'path_params': {'nonce': nonce},
    }
    response = await apps.handle_upload(Request(scope, receive), factory, tasks, 'http://mcp.test')
    return response.status_code, _json.loads(response.body)


@pytest.mark.asyncio
async def test_a_fresh_launch_between_redeem_and_renewal_gets_no_replacement_link(monkeypatch):
    status, body = await _drive_renewal(monkeypatch, lambda tasks: tasks.add(ADDRESS, instance='c2'))
    assert status == 200 and body['status'] == 'OK'
    assert 'upload_url' not in body

    status, body = await _drive_renewal(monkeypatch, lambda tasks: tasks.add(ADDRESS, instance='c2'), oversize=True)
    assert status == 413
    assert 'upload_url' not in body


@pytest.mark.asyncio
async def test_a_same_instance_re_add_between_redeem_and_renewal_keeps_the_replacement_link(monkeypatch):
    status, body = await _drive_renewal(monkeypatch, lambda tasks: tasks.add(ADDRESS, instance='c1'))
    assert status == 200
    assert body['upload_url'].startswith('http://mcp.test/mcp/upload/')

    status, body = await _drive_renewal(monkeypatch, lambda tasks: tasks.add(ADDRESS, instance='c1'), oversize=True)
    assert status == 413
    assert body['upload_url'].startswith('http://mcp.test/mcp/upload/')


# --- CodeRabbit round 3: a dead nonce is 404 first; a body-read failure keeps the retry ---


def test_registry_has_upload_nonce_peeks_without_redeeming():
    tasks = TaskRegistry()
    tasks.add(ADDRESS, instance='c1')
    nonce = tasks.issue_upload_nonce(ADDRESS, None)
    assert tasks.has_upload_nonce(nonce) is True
    assert tasks.has_upload_nonce(nonce) is True  # a peek spends nothing
    assert tasks.has_upload_nonce('never-issued') is False
    assert tasks.consume_upload_nonce(nonce) is not None
    assert tasks.has_upload_nonce(nonce) is False


@pytest.mark.asyncio
async def test_a_dead_nonce_with_an_oversize_declaration_is_404_and_echoes_no_link(monkeypatch):
    monkeypatch.setattr(apps, 'MAX_UPLOAD_BYTES', 16)
    built = []
    async with _mcp_app(monkeypatch, built) as app:
        unknown = await app.post('/mcp/upload/not-a-nonce', content=b'x' * 64)
        assert unknown.status_code == 404
        assert 'upload_url' not in unknown.json()

        started = await _start_dropper(app)
        assert (await app.post(urlsplit(started['upload_url']).path, content=b'ok')).status_code == 200  # spends it
        spent = await app.post(urlsplit(started['upload_url']).path, content=b'x' * 64)
        assert spent.status_code == 404
        assert 'upload_url' not in spent.json()

        # a LIVE nonce over the cap keeps its contract: 413, the same link, unspent
        again = await _start_dropper(app)
        refused = await app.post(urlsplit(again['upload_url']).path, content=b'x' * 64)
        assert refused.status_code == 413 and refused.json()['upload_url'] == again['upload_url']
        assert (await app.post(urlsplit(again['upload_url']).path, content=b'ok')).status_code == 200


_BROKEN_MULTIPART = (b'multipart/form-data; boundary=----b', b'not multipart')  # under the 16-byte test cap


@pytest.mark.asyncio
async def test_a_body_read_failure_answers_400_with_a_replacement_link_for_the_same_run(monkeypatch):
    content_type, body = _BROKEN_MULTIPART
    status, answer = await _drive_renewal(monkeypatch, lambda tasks: None, body=body, content_type=content_type)
    assert status == 400 and answer['status'] == 'Error'
    assert answer['upload_url'].startswith('http://mcp.test/mcp/upload/')


@pytest.mark.asyncio
async def test_a_body_read_failure_after_a_fresh_launch_or_removal_carries_no_link(monkeypatch):
    content_type, body = _BROKEN_MULTIPART
    status, answer = await _drive_renewal(
        monkeypatch, lambda tasks: tasks.add(ADDRESS, instance='c2'), body=body, content_type=content_type
    )
    assert status == 400 and 'upload_url' not in answer

    status, answer = await _drive_renewal(
        monkeypatch, lambda tasks: tasks.remove(ADDRESS), body=body, content_type=content_type
    )
    assert status == 400 and 'upload_url' not in answer
