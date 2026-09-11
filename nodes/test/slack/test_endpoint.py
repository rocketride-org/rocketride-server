# =============================================================================
# MIT License
# =============================================================================

import asyncio
import hashlib
import hmac
import importlib
import inspect
import json
import threading
import time
import types

import pytest
from fastapi import Request

from nodes.slack.slack_events import RoutedEvent, TtlDedupCache


SECRET = 'endpoint-secret'


class FakeRequest:
    def __init__(self, body, *, headers=None):
        self._body = body
        self.headers = headers or {}

    async def body(self):
        return self._body

    async def stream(self):
        yield self._body


class FakePipe:
    def __init__(self, *, fail_at=None):
        self.fail_at = fail_at
        self.opened = []
        self.text = []
        self.json = []
        self.closed = 0

    def open(self, entry):
        self.opened.append(entry)
        if self.fail_at == 'open':
            raise RuntimeError('open failed')

    def writeText(self, text):
        self.text.append(text)
        if self.fail_at == 'text':
            raise RuntimeError('text failed')

    def writeJson(self, value):
        self.json.append(value)
        if self.fail_at == 'json':
            raise RuntimeError('json failed')

    def close(self):
        self.closed += 1
        if self.fail_at == 'close':
            raise RuntimeError('close failed')


class FakeTarget:
    def __init__(self, pipe):
        self.pipe = pipe
        self.acquired = 0
        self.released = []

    def getPipe(self):
        self.acquired += 1
        return self.pipe

    def putPipe(self, pipe):
        self.released.append(pipe)


def _module():
    return importlib.import_module('nodes.slack.IEndpoint')


def _signature(body, timestamp):
    base = b'v0:' + str(timestamp).encode() + b':' + body
    return 'v0=' + hmac.new(SECRET.encode(), base, hashlib.sha256).hexdigest()


def _request(payload, *, timestamp=None, extra_headers=None):
    body = payload if isinstance(payload, bytes) else json.dumps(payload, separators=(',', ':')).encode()
    timestamp = int(time.time()) if timestamp is None else timestamp
    headers = {
        'X-Slack-Request-Timestamp': str(timestamp),
        'X-Slack-Signature': _signature(body, timestamp),
    }
    headers.update(extra_headers or {})
    return FakeRequest(body, headers=headers)


def _endpoint():
    endpoint = _module().IEndpoint()
    endpoint._signing_secret = SECRET
    endpoint._queue = asyncio.Queue(maxsize=1)
    endpoint._dedup = TtlDedupCache()
    endpoint._accepting = True
    return endpoint


def test_request_handler_declares_fastapi_request_parameter():
    parameter = inspect.signature(_module().IEndpoint._request_handler).parameters['request']

    assert parameter.annotation is Request


def _event(event_id='Ev1', *, inner=None):
    return {
        'type': 'event_callback',
        'event_id': event_id,
        'team_id': 'T1',
        'event': inner or {'type': 'app_mention', 'text': '<@A> hello'},
    }


@pytest.mark.asyncio
async def test_rejects_invalid_signature_before_json_or_queue(monkeypatch):
    endpoint = _endpoint()
    request = FakeRequest(
        b'{not json', headers={'X-Slack-Request-Timestamp': str(int(time.time())), 'X-Slack-Signature': 'v0=bad'}
    )
    monkeypatch.setattr(_module().json, 'loads', lambda _value: pytest.fail('decoded'))

    response = await endpoint._request_handler(request)

    assert response.status_code == 401
    assert endpoint._queue.empty()


@pytest.mark.asyncio
async def test_request_handler_preserves_exact_under_limit_raw_body_for_signature(monkeypatch):
    endpoint = _endpoint()
    module = _module()
    body = b'{"type":"url_verification","challenge":"\xc3\xa9"}'
    timestamp = int(time.time())
    request = FakeRequest(
        body,
        headers={
            'X-Slack-Request-Timestamp': str(timestamp),
            'X-Slack-Signature': _signature(body, timestamp),
        },
    )
    verified = []
    monkeypatch.setattr(
        module,
        'verify_slack_signature',
        lambda secret, timestamp, signature, raw: verified.append(raw) or True,
    )

    response = await endpoint._request_handler(request)

    assert response.status_code == 200
    assert verified == [body]


@pytest.mark.asyncio
async def test_request_handler_rejects_body_over_hard_limit_without_signature_check(monkeypatch):
    endpoint = _endpoint()
    module = _module()
    chunks = [b'a' * module.MAX_SLACK_REQUEST_BODY_BYTES, b'b']

    class ChunkedRequest(FakeRequest):
        async def stream(self):
            for chunk in chunks:
                yield chunk

    monkeypatch.setattr(module, 'verify_slack_signature', lambda *args: pytest.fail('signature checked'))

    response = await endpoint._request_handler(ChunkedRequest(b'', headers={}))

    assert response.status_code == 413


@pytest.mark.asyncio
async def test_rejects_stale_timestamp_before_json_or_queue(monkeypatch):
    endpoint = _endpoint()
    request = _request(b'{not json', timestamp=int(time.time()) - 301)
    monkeypatch.setattr(_module().json, 'loads', lambda _value: pytest.fail('decoded'))

    response = await endpoint._request_handler(request)

    assert response.status_code == 401
    assert endpoint._queue.empty()


@pytest.mark.asyncio
async def test_verified_challenge_returns_exact_text_without_queueing():
    endpoint = _endpoint()

    response = await endpoint._request_handler(_request({'type': 'url_verification', 'challenge': 'challenge-value'}))

    assert response.status_code == 200
    assert response.body == b'challenge-value'
    assert endpoint._queue.empty()


@pytest.mark.asyncio
async def test_supported_callback_enqueues_once_and_duplicate_returns_ok():
    endpoint = _endpoint()
    request = _request(_event())

    assert (await endpoint._request_handler(request)).status_code == 200
    assert (await endpoint._request_handler(request)).status_code == 200

    routed = endpoint._queue.get_nowait()
    assert routed.event_type == 'app_mention'
    assert endpoint._queue.empty()


@pytest.mark.asyncio
async def test_full_queue_returns_503_without_dedup_marking_so_retry_enqueues():
    endpoint = _endpoint()
    endpoint._queue.put_nowait('full')
    request = _request(_event())

    assert (await endpoint._request_handler(request)).status_code == 503
    assert not endpoint._dedup.contains('Ev1')
    endpoint._queue.get_nowait()

    assert (await endpoint._request_handler(request)).status_code == 200
    assert endpoint._dedup.contains('Ev1')


@pytest.mark.asyncio
async def test_malformed_authenticated_json_returns_400_without_enqueue():
    endpoint = _endpoint()

    response = await endpoint._request_handler(_request(b'{not json'))

    assert response.status_code == 400
    assert endpoint._queue.empty()


@pytest.mark.asyncio
@pytest.mark.parametrize('envelope', [[], 'not-an-object', 7, None])
async def test_authenticated_non_object_json_returns_400_without_queue_access(envelope):
    endpoint = _endpoint()

    class NoQueueAccess:
        def __getattr__(self, _name):
            pytest.fail('queue accessed')

    endpoint._queue = NoQueueAccess()
    response = await endpoint._request_handler(_request(envelope))

    assert response.status_code == 400


@pytest.mark.asyncio
async def test_unsupported_callback_and_retry_headers_do_not_bypass_deduplication():
    endpoint = _endpoint()
    unsupported = _event(inner={'type': 'reaction_removed'})
    assert (await endpoint._request_handler(_request(unsupported))).status_code == 200
    assert endpoint._queue.empty()

    request = _request(_event(), extra_headers={'X-Slack-Retry-Num': '1', 'X-Slack-Retry-Reason': 'http_timeout'})
    assert (await endpoint._request_handler(request)).status_code == 200
    assert (await endpoint._request_handler(request)).status_code == 200
    assert endpoint._queue.qsize() == 1


def test_emit_text_sets_native_metadata_and_releases_pipe(monkeypatch):
    endpoint = _endpoint()
    pipe = FakePipe()
    endpoint.target = FakeTarget(pipe)
    completed = []
    monkeypatch.setattr(_module(), 'monitorCompleted', completed.append)
    routed = RoutedEvent('app_mention', 'text', 'hé', _event())

    endpoint._emit_event(routed)

    entry = pipe.opened[0]
    assert entry.url == 'slack://T1/Ev1'
    assert entry.metadata.toDict() == routed.envelope
    assert pipe.text == ['hé']
    assert pipe.json == []
    assert endpoint.target.acquired == len(endpoint.target.released) == 1
    assert completed == [len('hé'.encode())]


@pytest.mark.parametrize(
    ('lane', 'fail_at'),
    [('text', 'open'), ('text', 'text'), ('json', 'json'), ('text', 'close')],
)
def test_emit_releases_pipe_for_every_open_write_and_close_failure(monkeypatch, lane, fail_at):
    endpoint = _endpoint()
    pipe = FakePipe(fail_at=fail_at)
    endpoint.target = FakeTarget(pipe)
    failed = []
    monkeypatch.setattr(_module(), 'monitorFailed', failed.append)
    inner = {'type': 'reaction_added', 'reaction': 'eyes'}
    routed = RoutedEvent(
        'reaction_added' if lane == 'json' else 'app_mention',
        lane,
        inner if lane == 'json' else 'text',
        _event(inner=inner),
    )

    endpoint._emit_event(routed)

    assert endpoint.target.acquired == len(endpoint.target.released) == 1
    assert failed


@pytest.mark.asyncio
async def test_consumer_survives_pipe_acquisition_failure_and_processes_next_event(monkeypatch):
    endpoint = _endpoint()
    endpoint._queue = asyncio.Queue()
    pipe = FakePipe()

    class FlakyTarget(FakeTarget):
        def getPipe(self):
            if self.acquired == 0:
                self.acquired += 1
                raise RuntimeError('temporary pool failure')
            return super().getPipe()

    endpoint.target = FlakyTarget(pipe)
    failed = []
    monkeypatch.setattr(_module(), 'monitorFailed', failed.append)
    monkeypatch.setattr(_module(), 'monitorCompleted', lambda _size: None)
    endpoint._queue.put_nowait(RoutedEvent('app_mention', 'text', 'first', _event()))
    endpoint._queue.put_nowait(RoutedEvent('app_mention', 'text', 'second', _event('Ev2')))
    endpoint._queue.put_nowait(None)

    await endpoint._consume_queue()

    assert failed == [0]
    assert pipe.text == ['second']


@pytest.mark.parametrize(
    ('parameters', 'expected_capacity', 'expected_ttl'),
    [
        ({'queueCapacity': 0, 'dedupTtlSeconds': 0}, 1, 300),
        ({'queueCapacity': 10001, 'dedupTtlSeconds': 3601}, 10000, 3600),
    ],
)
def test_runtime_clamps_queue_and_dedup_settings_to_schema_bounds(parameters, expected_capacity, expected_ttl):
    endpoint = _endpoint()
    endpoint.endpoint = types.SimpleNamespace(serviceConfig={'parameters': parameters})

    assert endpoint._queue_capacity() == expected_capacity
    assert endpoint._dedup_ttl() == expected_ttl


@pytest.mark.asyncio
async def test_startup_and_shutdown_manage_queue_worker_route_state_and_secret(monkeypatch):
    endpoint = _endpoint()
    endpoint.endpoint = types.SimpleNamespace(
        serviceConfig={'parameters': {'queueCapacity': 3, 'dedupTtlSeconds': 700}}
    )
    endpoint.target = FakeTarget(FakePipe())
    statuses = []
    monkeypatch.setattr(_module(), 'monitorStatus', statuses.append)

    await endpoint._startup()

    assert endpoint._queue.maxsize == 3
    assert endpoint._dedup.ttl_seconds == 700
    assert endpoint._consumer_task is not None
    assert statuses[-1] == 'Slack Events ready - waiting for events'

    await endpoint._shutdown()

    assert endpoint._signing_secret == ''
    assert endpoint._accepting is False


@pytest.mark.asyncio
async def test_shutdown_stops_intake_and_drains_queued_and_inflight_work(monkeypatch):
    endpoint = _endpoint()
    endpoint.endpoint = types.SimpleNamespace(serviceConfig={'parameters': {}})
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    emitted = []

    def emit(routed):
        emitted.append(routed)
        if len(emitted) == 1:
            loop.call_soon_threadsafe(started.set)
            release.wait()

    endpoint._emit_event = emit
    await endpoint._startup()
    endpoint._queue.put_nowait(RoutedEvent('app_mention', 'text', 'in-flight', _event()))
    await started.wait()
    endpoint._queue.put_nowait(RoutedEvent('app_mention', 'text', 'queued', _event('Ev2')))
    shutdown = asyncio.create_task(endpoint._shutdown())
    await asyncio.sleep(0)

    assert not endpoint._accepting
    assert not shutdown.done()
    assert (await endpoint._request_handler(_request(_event('Ev3')))).status_code == 503
    release.set()
    await shutdown

    assert [item.payload for item in emitted] == ['in-flight', 'queued']


@pytest.mark.asyncio
async def test_shutdown_cancels_consumer_after_bounded_drain_timeout(monkeypatch):
    endpoint = _endpoint()
    endpoint._queue = asyncio.Queue()
    endpoint._accepting = True
    monitor = []

    async def owned_consumer():
        await asyncio.Event().wait()

    async def timeout(awaitable, *, timeout):
        awaitable.close()
        raise asyncio.TimeoutError

    owned = asyncio.create_task(owned_consumer())
    endpoint._consumer_task = owned
    monkeypatch.setattr(_module().asyncio, 'wait_for', timeout)
    monkeypatch.setattr(_module(), 'monitorOther', lambda *args: monitor.append(args))

    await endpoint._shutdown()

    assert endpoint._consumer_task is None
    assert owned.cancelled()
    assert endpoint._signing_secret == ''
    assert monitor == [('usr', '')]


@pytest.mark.asyncio
async def test_shutdown_records_delivery_failure_after_cancelling_consumer(monkeypatch):
    endpoint = _endpoint()
    endpoint._queue = asyncio.Queue()
    endpoint._accepting = True
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()
    failed = []

    def emit(_routed):
        loop.call_soon_threadsafe(started.set)
        release.wait()
        raise RuntimeError('delivery failed')

    async def timeout(awaitable, *, timeout):
        awaitable.close()
        raise asyncio.TimeoutError

    endpoint._emit_event = emit
    monkeypatch.setattr(_module().asyncio, 'wait_for', timeout)
    monkeypatch.setattr(_module(), 'monitorFailed', failed.append)
    endpoint._consumer_task = asyncio.create_task(endpoint._consume_queue())
    endpoint._queue.put_nowait(RoutedEvent('app_mention', 'text', 'blocked', _event()))
    await started.wait()

    shutdown = asyncio.create_task(endpoint._shutdown())
    await asyncio.sleep(0)
    release.set()
    await shutdown

    assert failed == [0]
    assert endpoint._delivery_task is None


@pytest.mark.asyncio
async def test_shutdown_waits_for_delivery_thread_after_drain_timeout(monkeypatch):
    endpoint = _endpoint()
    endpoint.endpoint = types.SimpleNamespace(serviceConfig={'parameters': {}})
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    release = threading.Event()

    def emit(_routed):
        loop.call_soon_threadsafe(started.set)
        release.wait()

    endpoint._emit_event = emit
    await endpoint._startup()
    endpoint._queue.put_nowait(RoutedEvent('app_mention', 'text', 'blocked', _event()))
    await started.wait()

    async def timeout(awaitable, *, timeout):
        awaitable.close()
        raise asyncio.TimeoutError

    monkeypatch.setattr(_module().asyncio, 'wait_for', timeout)
    shutdown = asyncio.create_task(endpoint._shutdown())
    await asyncio.sleep(0)
    assert not shutdown.done()
    release.set()
    await shutdown


def test_execution_lifecycle_binds_only_the_public_slack_events_post_route(monkeypatch):
    module = _module()
    created = []

    class FakeServer:
        def __init__(self, *, config, on_startup, on_shutdown):
            self.config = config
            self.on_startup = on_startup
            self.on_shutdown = on_shutdown
            self.app = types.SimpleNamespace(state=types.SimpleNamespace())
            self.routes = []
            self.ran = False
            created.append(self)

        def add_route(self, path, handler, methods, *, public):
            self.routes.append((path, handler, methods, public))

        def run(self):
            self.ran = True

    monkeypatch.setattr(module, 'WebServer', FakeServer)
    endpoint = module.IEndpoint()
    endpoint.endpoint = types.SimpleNamespace(target='target', openMode=module.OPEN_MODE.SOURCE)

    endpoint.scanObjects('', lambda _item: None)

    assert created[0].routes == [('/slack/events', endpoint._request_handler, ['POST'], True)]
    assert created[0].ran

    config_endpoint = module.IEndpoint()
    config_endpoint.endpoint = types.SimpleNamespace(target='target', openMode=module.OPEN_MODE.CONFIG)
    config_endpoint.scanObjects('', lambda _item: None)
    assert len(created) == 1
