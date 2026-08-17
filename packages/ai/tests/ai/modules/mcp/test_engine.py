# Copyright 2026 Aparavi Software AG. MIT License.
import asyncio

import pytest


def test_make_engine_client_requires_uri(monkeypatch):
    from ai.modules.mcp.engine import make_engine_client

    monkeypatch.delenv('ROCKETRIDE_URI', raising=False)
    monkeypatch.setenv('ROCKETRIDE_APIKEY', 'k')
    with pytest.raises(ValueError):
        make_engine_client({})


def test_make_engine_client_requires_auth(monkeypatch):
    from ai.modules.mcp.engine import make_engine_client

    monkeypatch.setenv('ROCKETRIDE_URI', 'ws://localhost:5565')
    monkeypatch.delenv('ROCKETRIDE_AUTH', raising=False)
    monkeypatch.delenv('ROCKETRIDE_APIKEY', raising=False)
    with pytest.raises(ValueError):
        make_engine_client({})


class _FakeDeployApi:
    """Stand-in for RocketRideClient.deploy (cached_property sub-API)."""

    def __init__(self) -> None:
        self.add_calls = []
        self.list_calls = 0
        self.status_calls = []
        self.remove_calls = []
        self.update_calls = []

    async def add(self, pipeline, *, schedule=None) -> dict:
        self.add_calls.append({'pipeline': pipeline, 'schedule': schedule})
        return {'project_id': 'dep-1'}

    async def list(self) -> list:
        self.list_calls += 1
        return [{'project_id': 'dep-1'}]

    async def status(self, project_id) -> dict:
        self.status_calls.append(project_id)
        return {'project_id': project_id, 'state': 'active'}

    async def remove(self, project_id) -> None:
        self.remove_calls.append(project_id)

    async def update(self, project_id, *, pipeline=None, schedule=None) -> None:
        self.update_calls.append({'project_id': project_id, 'pipeline': pipeline, 'schedule': schedule})


class _FakeEventSession:
    """Stand-in for the event stream session returned by log.open_event_stream()."""

    def __init__(self) -> None:
        self.seek_calls = []
        self.get_traces_calls = []
        self.get_trace_calls = []
        self.close_calls = 0
        self._get_trace_raises = None

    async def seek(self, position: str) -> None:
        self.seek_calls.append(position)

    async def get_traces(self, n: int) -> dict:
        self.get_traces_calls.append(n)
        return {'open': [{'seq': 1, 'kind': 'open-trace'}], 'closed': [{'seq': 2, 'kind': 'closed-trace'}]}

    async def get_trace(self, begin_seq: int) -> dict:
        self.get_trace_calls.append(begin_seq)
        if self._get_trace_raises:
            raise self._get_trace_raises
        return {'summary': {'beginSeq': begin_seq}, 'events': [{'seq': begin_seq, 'kind': 'trace'}]}

    def close_event_stream(self) -> None:
        self.close_calls += 1


class _FakeLogApi:
    """Stand-in for RocketRideClient.log (cached_property sub-API)."""

    def __init__(self) -> None:
        self.chapters_calls = []
        self.read_calls = []
        self.open_event_stream_calls = []
        self._session = _FakeEventSession()
        # Scriptable: override with {'chapters': [...]} before calling
        # log_traces(chapter_begin_seq=...) to control the lookup result.
        self.chapters_result = None

    # Signatures mirror the real SDK exactly (team_id is KEYWORD-ONLY there):
    # a positional third argument must fail here the same way it fails live.

    async def chapters(self, project_id: str, source: str, *, team_id: str = '') -> dict:
        self.chapters_calls.append({'project_id': project_id, 'source': source, 'team_id': team_id})
        if self.chapters_result is not None:
            return self.chapters_result
        return {'project_id': project_id, 'chapters': []}

    async def read(
        self,
        project_id: str,
        source: str,
        *,
        team_id: str = '',
        from_seq: int = None,
        cursor: int = None,
        max_events: int = None,
        max_bytes: int = None,
        types: list = None,
    ) -> dict:
        self.read_calls.append(
            {
                'project_id': project_id,
                'source': source,
                'team_id': team_id,
                'from_seq': from_seq,
                'cursor': cursor,
                'max_events': max_events,
                'max_bytes': max_bytes,
                'types': types,
            }
        )
        return {'project_id': project_id, 'events': []}

    def open_event_stream(self, project_id: str, source: str, *, team_id: str = '') -> _FakeEventSession:
        self.open_event_stream_calls.append({'project_id': project_id, 'source': source, 'team_id': team_id})
        return self._session


class _FakeAccountApi:
    """Stand-in for RocketRideClient.account (cached_property sub-API)."""

    def __init__(self) -> None:
        self.get_environment_keys_calls = 0

    async def get_environment_keys(self) -> list:
        self.get_environment_keys_calls += 1
        return ['ROCKETRIDE_FOO', 'ROCKETRIDE_BAR']


class _FakeUnderlyingClient:
    """Stand-in for RocketRideClient that records lifecycle calls without any I/O."""

    def __init__(self) -> None:
        self.connect_calls = 0
        self.connect_gate = None  # optional asyncio.Event: connect() suspends until set
        self.disconnect_calls = 0
        self.request_calls = 0
        self.get_services_calls = 0
        self.get_service_calls = []
        self.validate_calls = []
        self.use_calls = []
        self.send_calls = []
        self.terminate_calls = []
        self.send_files_calls = []
        self.fs_read_string_calls = []
        self.fs_list_dir_calls = []
        self.save_template_calls = []
        self.get_template_calls = []
        self.get_task_status_calls = []
        self.fs_stat_calls = []
        self.fs_get_url_calls = []
        self.deploy = _FakeDeployApi()
        self.log = _FakeLogApi()
        self.account = _FakeAccountApi()

    async def connect(self) -> None:
        self.connect_calls += 1
        if self.connect_gate is not None:
            await self.connect_gate.wait()

    async def disconnect(self) -> None:
        self.disconnect_calls += 1

    def build_request(self, command: str) -> dict:
        return {'command': command}

    async def request(self, req: dict) -> dict:
        self.request_calls += 1
        return {'body': {'tasks': []}}

    async def use(self, **kwargs) -> dict:
        self.use_calls.append(kwargs)
        return {'token': 'tok', **kwargs}

    async def send(
        self,
        token: str,
        data: bytes,
        objinfo: dict = None,
        mimetype: str = None,
        on_sse=None,
    ) -> dict:
        self.send_calls.append(
            {'token': token, 'data': data, 'objinfo': objinfo, 'mimetype': mimetype, 'on_sse': on_sse}
        )
        return {'ok': True}

    async def get_services(self) -> dict:
        self.get_services_calls += 1
        return {'services': {'ocr': {}}, 'version': 'x'}

    async def get_service(self, service: str) -> dict:
        self.get_service_calls.append(service)
        return {'name': service}

    async def validate(self, pipeline, *, source=None) -> dict:
        self.validate_calls.append({'pipeline': pipeline, 'source': source})
        return {'valid': True}

    async def terminate(self, token: str) -> None:
        self.terminate_calls.append(token)

    async def send_files(self, files, token: str) -> dict:
        self.send_files_calls.append({'files': files, 'token': token})
        return {'uploaded': len(files)}

    async def fs_read_string(self, path: str) -> str:
        self.fs_read_string_calls.append(path)
        return 'contents'

    async def fs_list_dir(self, path: str = '') -> dict:
        self.fs_list_dir_calls.append(path)
        return {'entries': []}

    async def save_template(self, template_id: str, pipeline: dict) -> None:
        self.save_template_calls.append({'template_id': template_id, 'pipeline': pipeline})

    async def get_template(self, template_id: str) -> dict:
        self.get_template_calls.append(template_id)
        return {'template_id': template_id}

    async def get_task_status(self, token: str) -> dict:
        self.get_task_status_calls.append(token)
        return {'state': 5, 'completed': True}

    async def fs_stat(self, path: str) -> dict:
        self.fs_stat_calls.append(path)
        return {'exists': True, 'type': 'file', 'size': 12, 'modified': 1700000000}

    async def fs_get_url(self, path: str, expires_in: int = 3600, download_name: str = None) -> str:
        self.fs_get_url_calls.append({'path': path, 'expires_in': expires_in, 'download_name': download_name})
        return 'https://signed.example/f?sig=abc'


def _make_client_with_fake():
    """Build a real WsEngineClient (no network) and swap in the fake underlying client."""
    from ai.modules.mcp.engine import WsEngineClient

    client = WsEngineClient(uri='ws://localhost:5565', auth='test-auth')
    fake = _FakeUnderlyingClient()
    client._client = fake
    return client, fake


async def test_ensure_connected_memoizes_across_sequential_calls():
    client, fake = _make_client_with_fake()

    await client.list_tasks()
    await client.list_tasks()

    assert fake.connect_calls == 1
    assert fake.request_calls == 2
    assert client._connected is True


async def test_ensure_connected_memoizes_under_concurrent_calls():
    """Both calls start while the first connect is genuinely suspended, so
    this pins the lock — an ungated fake could pass with no synchronization
    at all (first coroutine finishes connect before the second checks).
    """
    client, fake = _make_client_with_fake()
    fake.connect_gate = asyncio.Event()

    first = asyncio.create_task(client.list_tasks())
    await asyncio.sleep(0)
    second = asyncio.create_task(client.list_tasks())
    await asyncio.sleep(0)

    assert fake.connect_calls == 1  # second call waits on the lock, no second connect
    fake.connect_gate.set()
    await asyncio.gather(first, second)

    assert fake.connect_calls == 1
    assert client._connected is True


async def test_close_disconnects_when_connected():
    client, fake = _make_client_with_fake()

    await client.list_tasks()
    assert client._connected is True

    await client.close()

    assert fake.disconnect_calls == 1
    assert client._connected is False


async def test_close_is_noop_when_never_connected():
    client, fake = _make_client_with_fake()

    await client.close()

    assert fake.disconnect_calls == 0
    assert client._connected is False


async def test_close_is_idempotent_when_called_twice():
    client, fake = _make_client_with_fake()

    await client.list_tasks()
    await client.close()
    await client.close()

    assert fake.disconnect_calls == 1
    assert client._connected is False


async def test_get_services_calls_sdk():
    client, fake = _make_client_with_fake()

    result = await client.get_services()

    assert fake.get_services_calls == 1
    assert result == {'services': {'ocr': {}}, 'version': 'x'}


async def test_get_environment_keys_calls_sdk():
    client, fake = _make_client_with_fake()

    result = await client.get_environment_keys()

    assert fake.account.get_environment_keys_calls == 1
    assert result == ['ROCKETRIDE_FOO', 'ROCKETRIDE_BAR']


async def test_get_service_calls_sdk_with_name():
    client, fake = _make_client_with_fake()

    result = await client.get_service('ocr')

    assert fake.get_service_calls == ['ocr']
    assert result == {'name': 'ocr'}


async def test_validate_calls_sdk_with_pipeline_and_source():
    client, fake = _make_client_with_fake()
    pipeline = {'components': []}

    result = await client.validate(pipeline, source='file.pipe')

    assert fake.validate_calls == [{'pipeline': pipeline, 'source': 'file.pipe'}]
    assert result == {'valid': True}


async def test_validate_defaults_source_to_none():
    client, fake = _make_client_with_fake()

    await client.validate({'components': []})

    assert fake.validate_calls == [{'pipeline': {'components': []}, 'source': None}]


async def test_use_passes_full_kwargs_and_returns_dict():
    client, fake = _make_client_with_fake()

    result = await client.use(filepath='p.pipe', ttl=30, env={'X': '1'}, name='n')

    assert fake.use_calls == [{'filepath': 'p.pipe', 'ttl': 30, 'env': {'X': '1'}, 'name': 'n'}]
    assert result == {'token': 'tok', 'filepath': 'p.pipe', 'ttl': 30, 'env': {'X': '1'}, 'name': 'n'}


async def test_send_forwards_objinfo_mimetype():
    """The seam's `send` must forward `objinfo`/`mimetype`/`on_sse` through to
    the underlying SDK client unchanged, not just `token`/`data`.
    """
    client, fake = _make_client_with_fake()

    def _on_sse(_event):  # pragma: no cover - identity/passthrough check only
        pass

    result = await client.send('tok-1', 'payload', objinfo={'name': 'a.txt'}, mimetype='text/plain', on_sse=_on_sse)

    assert fake.send_calls == [
        {'token': 'tok-1', 'data': 'payload', 'objinfo': {'name': 'a.txt'}, 'mimetype': 'text/plain', 'on_sse': _on_sse}
    ]
    assert result == {'ok': True}


async def test_terminate_calls_sdk_with_token():
    client, fake = _make_client_with_fake()

    result = await client.terminate('tok-1')

    assert fake.terminate_calls == ['tok-1']
    assert result is None


async def test_send_files_passes_files_then_token():
    """Footgun: SDK arg order is (files, token) — token second, not first."""
    client, fake = _make_client_with_fake()
    files = ['/tmp/a.pdf', ('/tmp/b.pdf', {'name': 'b'})]

    result = await client.send_files(files, 'tok-2')

    assert fake.send_files_calls == [{'files': files, 'token': 'tok-2'}]
    assert result == {'uploaded': 2}


async def test_fs_read_string_calls_sdk_with_path():
    client, fake = _make_client_with_fake()

    result = await client.fs_read_string('/store/a.txt')

    assert fake.fs_read_string_calls == ['/store/a.txt']
    assert result == 'contents'


async def test_fs_list_dir_calls_sdk_not_fs_dir():
    """Footgun: real SDK method name is fs_list_dir, not fs_dir."""
    client, fake = _make_client_with_fake()

    result = await client.fs_list_dir('/store')

    assert fake.fs_list_dir_calls == ['/store']
    assert result == {'entries': []}


async def test_fs_list_dir_defaults_path_to_empty_string():
    client, fake = _make_client_with_fake()

    await client.fs_list_dir()

    assert fake.fs_list_dir_calls == ['']


async def test_save_template_calls_sdk_with_id_and_pipeline():
    client, fake = _make_client_with_fake()
    pipeline = {'components': []}

    result = await client.save_template('tpl-1', pipeline)

    assert fake.save_template_calls == [{'template_id': 'tpl-1', 'pipeline': pipeline}]
    assert result is None


async def test_get_template_calls_sdk_with_id():
    client, fake = _make_client_with_fake()

    result = await client.get_template('tpl-1')

    assert fake.get_template_calls == ['tpl-1']
    assert result == {'template_id': 'tpl-1'}


async def test_deploy_add_passes_schedule_as_keyword():
    """Footgun: client.deploy.add(pipeline, schedule=schedule) — schedule is keyword-only."""
    client, fake = _make_client_with_fake()
    pipeline = {'components': []}

    result = await client.deploy_add(pipeline, schedule='0/15 * * * *')

    assert fake.deploy.add_calls == [{'pipeline': pipeline, 'schedule': '0/15 * * * *'}]
    assert result == {'project_id': 'dep-1'}


async def test_deploy_add_defaults_schedule_to_none():
    client, fake = _make_client_with_fake()

    await client.deploy_add({'components': []})

    assert fake.deploy.add_calls == [{'pipeline': {'components': []}, 'schedule': None}]


async def test_deploy_list_calls_sdk():
    """Footgun: seam calls client.deploy.list() (sub-API), not a top-level method."""
    client, fake = _make_client_with_fake()

    result = await client.deploy_list()

    assert fake.deploy.list_calls == 1
    assert result == [{'project_id': 'dep-1'}]


async def test_get_task_status_calls_sdk_with_token():
    client, fake = _make_client_with_fake()

    result = await client.get_task_status('tok-3')

    assert fake.get_task_status_calls == ['tok-3']
    assert result == {'state': 5, 'completed': True}


async def test_fs_stat_calls_sdk_with_path():
    client, fake = _make_client_with_fake()

    result = await client.fs_stat('a/b.txt')

    assert fake.fs_stat_calls == ['a/b.txt']
    assert result == {'exists': True, 'type': 'file', 'size': 12, 'modified': 1700000000}


async def test_fs_get_url_passes_expires_in_and_download_name():
    client, fake = _make_client_with_fake()

    result = await client.fs_get_url('a/b.txt', expires_in=60, download_name='x.txt')

    assert fake.fs_get_url_calls == [{'path': 'a/b.txt', 'expires_in': 60, 'download_name': 'x.txt'}]
    assert result == 'https://signed.example/f?sig=abc'


async def test_fs_get_url_defaults_expires_in_and_download_name():
    client, fake = _make_client_with_fake()

    await client.fs_get_url('a/b.txt')

    assert fake.fs_get_url_calls == [{'path': 'a/b.txt', 'expires_in': 3600, 'download_name': None}]


async def test_deploy_status_calls_sdk_namespace():
    """Footgun: seam calls client.deploy.status(project_id) (sub-API), not a top-level method."""
    client, fake = _make_client_with_fake()

    result = await client.deploy_status('dep-1')

    assert fake.deploy.status_calls == ['dep-1']
    assert result == {'project_id': 'dep-1', 'state': 'active'}


async def test_deploy_remove_calls_sdk_namespace():
    """Footgun: seam calls client.deploy.remove(project_id) (sub-API), not a top-level method."""
    client, fake = _make_client_with_fake()

    result = await client.deploy_remove('dep-1')

    assert fake.deploy.remove_calls == ['dep-1']
    assert result is None


async def test_deploy_update_passes_pipeline_and_schedule_as_keywords():
    """Footgun: client.deploy.update(project_id, pipeline=..., schedule=...) — keyword-only kwargs."""
    client, fake = _make_client_with_fake()
    pipeline = {'components': []}

    result = await client.deploy_update('dep-1', pipeline=pipeline, schedule='0 * * * *')

    assert fake.deploy.update_calls == [{'project_id': 'dep-1', 'pipeline': pipeline, 'schedule': '0 * * * *'}]
    assert result is None


async def test_deploy_update_defaults_pipeline_and_schedule_to_none():
    client, fake = _make_client_with_fake()

    await client.deploy_update('dep-1')

    assert fake.deploy.update_calls == [{'project_id': 'dep-1', 'pipeline': None, 'schedule': None}]


def test_base_url_normalizes_scheme_and_strips_trailing_slash():
    from ai.modules.mcp.engine import WsEngineClient

    assert WsEngineClient(uri='ws://localhost:5565/', auth='k').base_url == 'http://localhost:5565'
    assert WsEngineClient(uri='wss://host/', auth='k').base_url == 'https://host'
    assert WsEngineClient(uri='http://localhost:5565', auth='k').base_url == 'http://localhost:5565'


async def test_log_chapters_calls_sdk_with_args():
    """log_chapters forwards project_id, source, team_id and returns the SDK dict."""
    client, fake = _make_client_with_fake()

    result = await client.log_chapters('proj-1', 'source-a', 'team-prod')

    assert fake.log.chapters_calls == [{'project_id': 'proj-1', 'source': 'source-a', 'team_id': 'team-prod'}]
    assert result == {'project_id': 'proj-1', 'chapters': []}


async def test_log_chapters_defaults_team_id_to_own_dev_stream():
    client, fake = _make_client_with_fake()

    await client.log_chapters('proj-1', 'source-a')

    assert fake.log.chapters_calls == [{'project_id': 'proj-1', 'source': 'source-a', 'team_id': ''}]


async def test_log_read_forwards_keyword_args():
    """log_read forwards all keyword args through to the SDK."""
    client, fake = _make_client_with_fake()

    result = await client.log_read(
        'proj-1', 'source-a', 'team-prod', from_seq=10, cursor=20, max_events=50, max_bytes=1024, types=['task_start']
    )

    assert fake.log.read_calls == [
        {
            'project_id': 'proj-1',
            'source': 'source-a',
            'team_id': 'team-prod',
            'from_seq': 10,
            'cursor': 20,
            'max_events': 50,
            'max_bytes': 1024,
            'types': ['task_start'],
        }
    ]
    assert result == {'project_id': 'proj-1', 'events': []}


async def test_log_traces_seeks_live_calls_get_traces_closes_finally():
    """log_traces seeks 'live', calls get_traces(n), and ALWAYS closes the session.

    The seam is a faithful transport: it returns the SDK's raw nested
    ``{'open': [...], 'closed': [...]}`` shape verbatim, no flattening.
    """
    client, fake = _make_client_with_fake()

    result = await client.log_traces('proj-1', 'source-a', 'team-prod', n=10)

    assert fake.log.open_event_stream_calls == [{'project_id': 'proj-1', 'source': 'source-a', 'team_id': 'team-prod'}]
    assert fake.log._session.seek_calls == ['live']
    assert fake.log._session.get_traces_calls == [10]
    assert fake.log._session.close_calls == 1
    assert result == {'open': [{'seq': 1, 'kind': 'open-trace'}], 'closed': [{'seq': 2, 'kind': 'closed-trace'}]}


async def test_log_traces_with_chapter_begin_seq_seeks_chapter_end_time():
    """Finding 1: chapter_begin_seq looks up the matching chapter via
    log.chapters() and seeks its endTime (a closed chapter) rather than
    'live'.
    """
    client, fake = _make_client_with_fake()
    fake.log.chapters_result = {
        'chapters': [
            {'beginTime': 1.0, 'beginSeq': 10, 'endTime': 20.0, 'outcome': 'ok'},
            {'beginTime': 21.0, 'beginSeq': 30, 'endTime': 40.0, 'outcome': 'ok'},
        ]
    }

    result = await client.log_traces('proj-1', 'source-a', 'team-prod', n=10, chapter_begin_seq=30)

    assert fake.log.chapters_calls == [{'project_id': 'proj-1', 'source': 'source-a', 'team_id': 'team-prod'}]
    assert fake.log._session.seek_calls == [40.0]
    assert fake.log._session.get_traces_calls == [10]
    assert fake.log._session.close_calls == 1
    assert result == {'open': [{'seq': 1, 'kind': 'open-trace'}], 'closed': [{'seq': 2, 'kind': 'closed-trace'}]}


async def test_log_traces_with_chapter_begin_seq_seeks_live_when_chapter_open():
    """A chapter with no endTime is still open/live -- seek 'live', not None."""
    client, fake = _make_client_with_fake()
    fake.log.chapters_result = {'chapters': [{'beginTime': 1.0, 'beginSeq': 10, 'endTime': None, 'outcome': None}]}

    await client.log_traces('proj-1', 'source-a', 'team-prod', n=10, chapter_begin_seq=10)

    assert fake.log._session.seek_calls == ['live']


async def test_log_traces_with_unknown_chapter_begin_seq_raises_keyerror():
    """No chapter matches chapter_begin_seq -> KeyError(chapter_begin_seq), and
    the session is still closed in the finally block.
    """
    client, fake = _make_client_with_fake()
    fake.log.chapters_result = {'chapters': [{'beginTime': 1.0, 'beginSeq': 10, 'endTime': 20.0, 'outcome': 'ok'}]}

    with pytest.raises(KeyError, match='999'):
        await client.log_traces('proj-1', 'source-a', 'team-prod', n=10, chapter_begin_seq=999)

    assert fake.log._session.seek_calls == []
    assert fake.log._session.get_traces_calls == []
    assert fake.log._session.close_calls == 1


async def test_log_traces_defaults_chapter_begin_seq_to_none_seeks_live():
    """chapter_begin_seq is optional; omitting it keeps today's seek('live')
    behavior and never calls log.chapters().
    """
    client, fake = _make_client_with_fake()

    await client.log_traces('proj-1', 'source-a', 'team-prod', n=10)

    assert fake.log.chapters_calls == []
    assert fake.log._session.seek_calls == ['live']


async def test_log_trace_seeks_live_calls_get_trace_closes_in_finally():
    """log_trace seeks 'live', calls get_trace(begin_seq), and closes in finally.

    The seam is a faithful transport: it returns the SDK's raw
    ``{'summary': {...}, 'events': [...]}`` shape verbatim, no unwrapping.
    """
    client, fake = _make_client_with_fake()

    result = await client.log_trace('proj-1', 'source-a', 'team-prod', begin_seq=5)

    assert fake.log.open_event_stream_calls == [{'project_id': 'proj-1', 'source': 'source-a', 'team_id': 'team-prod'}]
    assert fake.log._session.seek_calls == ['live']
    assert fake.log._session.get_trace_calls == [5]
    assert fake.log._session.close_calls == 1
    assert result == {'summary': {'beginSeq': 5}, 'events': [{'seq': 5, 'kind': 'trace'}]}


async def test_log_trace_wraps_keyerror_and_closes_session():
    """log_trace narrows the SDK's plain KeyError to LogNotFound and still
    closes the session in the finally block.
    """
    from ai.modules.mcp.engine import LogNotFound

    client, fake = _make_client_with_fake()
    fake.log._session._get_trace_raises = KeyError('not_found')

    with pytest.raises(LogNotFound):
        await client.log_trace('proj-1', 'source-a', 'team-prod', begin_seq=5)

    assert fake.log._session.close_calls == 1


async def test_transport_drop_unlatches_connected_so_next_call_reconnects():
    """A 'Server is not connected' RuntimeError from the SDK clears the
    cached flag: the singleton must reconnect on the next call instead of
    failing for the life of the process. An unrelated RuntimeError must NOT
    clear it (a spurious re-connect() on a live SDK client is unsafe).
    """
    client, fake = _make_client_with_fake()
    await client.get_services()
    assert client._connected is True

    async def _raise_dropped():
        raise RuntimeError('Server is not connected')

    fake.get_services = _raise_dropped
    with pytest.raises(RuntimeError):
        await client.get_services()
    assert client._connected is False  # unlatched -> next call reconnects

    # restore, reconnect, then an unrelated RuntimeError keeps the flag set
    fake.get_services = lambda: _async_value({'services': {}})
    await client.get_services()
    assert client._connected is True and fake.connect_calls == 2

    async def _raise_unrelated():
        raise RuntimeError('bad argument')

    fake.get_services = _raise_unrelated
    with pytest.raises(RuntimeError):
        await client.get_services()
    assert client._connected is True


def _async_value(value):
    async def _coro():
        return value

    return _coro()
