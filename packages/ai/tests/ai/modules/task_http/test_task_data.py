"""
Unit tests for ai.modules.task_http.task_data.

``task_Data`` is the FastAPI handler that uploads bytes / files /
multipart form data through a ``RocketRideClient`` pipe. The most
interesting logic lives in the ``RequestProcessing`` helper:

- ``_getMimeType`` / ``_getMimeRequestType`` — header normalisation
- ``_processSingleResult`` — exception vs dict result handling
- ``_send_bytes`` — happy path + exception capture (pipe context manager
  failures show up as ``Exception`` results, not raised exceptions)
- ``_processSingle`` — wraps ``_send_stream`` and merges its result
- ``process`` — picks multipart vs single based on Content-Type
- ``task_Data`` — top-level handler error path (client connect failure)

The pipe is faked with a small async context-manager stand-in so the
test never touches a real ``RocketRideClient``.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task_http.task_data import (
    DataResult,
    RequestProcessing,
    task_Data,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _FakePipe:
    """A fake DAP pipe that records writes and returns a canned close-result."""

    def __init__(self, result=None, *, raise_on=None):
        """Capture write calls and store the close-result and optional failure."""
        self.pipe_id = 'pipe-1'
        self.writes = []
        self._result = result if result is not None else {'data': b'ok'}
        self._raise_on = raise_on

    async def write(self, chunk):
        """Record the chunk and optionally raise to exercise the error path."""
        if self._raise_on == 'write':
            raise RuntimeError('write failed')
        self.writes.append(chunk)

    async def close(self):
        """Return the canned result (or raise if configured to)."""
        if self._raise_on == 'close':
            raise RuntimeError('close failed')
        return self._result


class _FakePipeCM:
    """An async context-manager wrapper around a ``_FakePipe`` instance."""

    def __init__(self, pipe):
        """Store the pipe that ``__aenter__`` should yield."""
        self._pipe = pipe

    async def __aenter__(self):
        """Yield the underlying pipe."""
        return self._pipe

    async def __aexit__(self, exc_type, exc, tb):
        """No-op; the pipe is fully owned by the test."""
        return None


def _make_client(pipe=None):
    """
    Build a fake ``RocketRideClient`` whose ``pipe()`` returns an async CM.

    Args:
        pipe: optional pre-constructed ``_FakePipe`` to wrap. Defaults to a
            fresh one with a generic OK result.

    Returns:
        MagicMock: client stand-in with ``pipe`` / ``debug_message`` /
        ``connect`` / ``disconnect`` configured.
    """
    pipe = pipe if pipe is not None else _FakePipe()
    client = MagicMock()
    client.debug_message = MagicMock()
    client.connect = AsyncMock()
    client.disconnect = AsyncMock()
    # client.pipe(...) is called with `await`, then used as `async with` — so it
    # must be an AsyncMock that returns the context manager.
    client.pipe = AsyncMock(return_value=_FakePipeCM(pipe))
    return client


# ---------------------------------------------------------------------------
# DataResult — Pydantic shape
# ---------------------------------------------------------------------------


def test_data_result_defaults():
    """DataResult initialises with zero counts and empty maps."""
    r = DataResult()
    assert r.objectsRequested == 0
    assert r.objectsCompleted == 0
    assert r.resultTypes == {}
    assert r.objects == {}


# ---------------------------------------------------------------------------
# _getMimeType / _getMimeRequestType
# ---------------------------------------------------------------------------


def test_get_mime_type_strips_params_and_lowercases():
    """_getMimeType drops anything after ';' and returns lowercase."""
    proc = RequestProcessing(_make_client(), 'tk_x')
    assert proc._getMimeType('Application/JSON; charset=utf-8') == 'application/json'
    assert proc._getMimeType('text/plain') == 'text/plain'


def test_get_mime_request_type_reads_header():
    """_getMimeRequestType pulls Content-Type from the request and normalises."""
    proc = RequestProcessing(_make_client(), 'tk_x')
    req = MagicMock()
    req.headers = {'Content-Type': 'TEXT/CSV; charset=utf-8'}
    assert proc._getMimeRequestType(req) == 'text/csv'


def test_get_mime_request_type_defaults_when_header_missing():
    """If the request has no Content-Type, the default is application/octet-stream."""
    proc = RequestProcessing(_make_client(), 'tk_x')
    req = MagicMock()
    req.headers = {}
    assert proc._getMimeRequestType(req) == 'application/octet-stream'


# ---------------------------------------------------------------------------
# _processSingleResult
# ---------------------------------------------------------------------------


def test_process_single_result_records_exception_envelope():
    """When the per-item result is an Exception, the envelope is stored under unique_key."""
    proc = RequestProcessing(_make_client(), 'tk_x')
    obj = SimpleNamespace(objectId='oid', size=10)
    results = DataResult()
    proc._processSingleResult(RuntimeError('boom'), obj, results, 'file-1')
    assert 'file-1' in results.objects
    # objectsCompleted is NOT incremented for failures.
    assert results.objectsCompleted == 0


def test_process_single_result_records_ok_dict():
    """A dict result is stored with status='OK' and objectsCompleted is bumped."""
    proc = RequestProcessing(_make_client(), 'tk_x')
    obj = SimpleNamespace(objectId='oid', size=10)
    results = DataResult()
    proc._processSingleResult({'data': b'something'}, obj, results, 'file-1')
    assert results.objects['file-1']['status'] == 'OK'
    assert results.objectsCompleted == 1


def test_process_single_result_merges_result_types():
    """A result with 'result_types' key has those types merged into DataResult.resultTypes."""
    proc = RequestProcessing(_make_client(), 'tk_x')
    obj = SimpleNamespace(objectId='oid', size=10)
    results = DataResult()
    proc._processSingleResult(
        {'data': b'x', 'result_types': {'tA': 'binary', 'tB': 'text'}},
        obj,
        results,
        'file-1',
    )
    assert results.resultTypes == {'tA': 'binary', 'tB': 'text'}
    # The 'result_types' key was popped before storage.
    assert 'result_types' not in results.objects['file-1']


# ---------------------------------------------------------------------------
# _send_bytes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_bytes_writes_content_and_returns_result(monkeypatch):
    """The happy path writes the content through the pipe and returns the dict result."""
    from ai.modules.task_http import task_data as task_data_mod

    # Stub ``getObject`` so we don't depend on the real rocketlib factory.
    monkeypatch.setattr(
        task_data_mod,
        'getObject',
        lambda filename=None: SimpleNamespace(objectId='oid', size=0, storeSize=0, toDict=lambda: {'objectId': 'oid'}),
    )

    pipe = _FakePipe(result={'data': b'OK'})
    client = _make_client(pipe=pipe)
    proc = RequestProcessing(client, 'tk_x')

    key, result, obj = await proc._send_bytes(b'hello', 'text/plain', 'a.txt', 'a')
    assert key == 'a'
    assert result == {'data': b'OK'}
    assert pipe.writes == [b'hello']


@pytest.mark.asyncio
async def test_send_bytes_returns_exception_on_pipe_failure(monkeypatch):
    """When the pipe write raises, _send_bytes returns the exception, not raises it."""
    from ai.modules.task_http import task_data as task_data_mod

    monkeypatch.setattr(
        task_data_mod,
        'getObject',
        lambda filename=None: SimpleNamespace(objectId='oid', size=0, storeSize=0, toDict=lambda: {'objectId': 'oid'}),
    )

    pipe = _FakePipe(raise_on='write')
    client = _make_client(pipe=pipe)
    proc = RequestProcessing(client, 'tk_x')

    key, result, obj = await proc._send_bytes(b'hello', 'text/plain', 'b.txt', 'b')
    assert key == 'b'
    assert isinstance(result, Exception)


@pytest.mark.asyncio
async def test_send_bytes_defaults_filename_when_missing(monkeypatch):
    """A missing filename argument is replaced with a uuid-based default."""
    from ai.modules.task_http import task_data as task_data_mod

    captured = {}
    monkeypatch.setattr(
        task_data_mod,
        'getObject',
        lambda filename=None: (
            captured.setdefault('filename', filename)
            or SimpleNamespace(objectId='oid', size=0, storeSize=0, toDict=lambda: {'objectId': 'oid'})
        ),
    )

    pipe = _FakePipe(result={})
    client = _make_client(pipe=pipe)
    proc = RequestProcessing(client, 'tk_x')

    await proc._send_bytes(b'x', 'text/plain', None, 'k')
    # The source unconditionally replaces a None filename with
    # 'content-<uuid>' before calling getObject — so the captured name MUST
    # be a string, never None.
    assert isinstance(captured['filename'], str)
    assert captured['filename'].startswith('content-')


# ---------------------------------------------------------------------------
# process — dispatch by MIME type
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_process_routes_multipart_to_processMultipart():
    """A multipart/form-data MIME triggers _processMultipart."""
    client = _make_client()
    proc = RequestProcessing(client, 'tk_x')
    proc._processMultipart = AsyncMock(return_value=DataResult(objectsRequested=2, objectsCompleted=2))
    proc._processSingle = AsyncMock()

    req = MagicMock()
    req.headers = {'Content-Type': 'multipart/form-data; boundary=xyz'}

    result = await proc.process(req)
    proc._processMultipart.assert_awaited_once_with(req)
    proc._processSingle.assert_not_called()
    # Result is a JSONResponse-ish object.
    body = result.body.decode() if hasattr(result, 'body') else str(result)
    assert 'OK' in body


@pytest.mark.asyncio
async def test_process_routes_other_mime_to_processSingle():
    """Anything other than multipart/form-data triggers _processSingle."""
    client = _make_client()
    proc = RequestProcessing(client, 'tk_x')
    proc._processSingle = AsyncMock(return_value=DataResult(objectsRequested=1, objectsCompleted=1))
    proc._processMultipart = AsyncMock()

    req = MagicMock()
    req.headers = {'Content-Type': 'application/octet-stream'}

    await proc.process(req)
    proc._processSingle.assert_awaited_once_with(req)
    proc._processMultipart.assert_not_called()


@pytest.mark.asyncio
async def test_process_wraps_exception():
    """A raised exception inside the processing routine becomes the error envelope."""
    client = _make_client()
    proc = RequestProcessing(client, 'tk_x')
    proc._processSingle = AsyncMock(side_effect=RuntimeError('boom'))

    req = MagicMock()
    req.headers = {'Content-Type': 'application/octet-stream'}

    result = await proc.process(req)
    body = result.body.decode() if hasattr(result, 'body') else str(result)
    assert 'Error' in body


# ---------------------------------------------------------------------------
# task_Data — top-level handler error paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_task_data_returns_error_on_client_connect_failure(monkeypatch):
    """If the RocketRideClient cannot connect, the endpoint returns the error envelope."""
    from ai.modules.task_http import task_data as task_data_mod

    fake_client_cls = MagicMock()
    fake_client = MagicMock()
    fake_client.connect = AsyncMock(side_effect=RuntimeError('connect refused'))
    fake_client.disconnect = AsyncMock()
    fake_client_cls.return_value = fake_client
    monkeypatch.setattr(task_data_mod, 'RocketRideClient', fake_client_cls)

    req = MagicMock()
    req.app.state.server.get_port = MagicMock(return_value=9999)
    req.state.account = SimpleNamespace(auth='ak_x')
    req.headers = {'Content-Type': 'application/octet-stream'}

    result = await task_Data(req, token='tk_x', authorization='Bearer ak_x')
    body = result.body.decode() if hasattr(result, 'body') else str(result)
    assert 'Error' in body
    # disconnect runs even when connect failed.
    fake_client.disconnect.assert_awaited_once()


@pytest.mark.asyncio
async def test_task_data_runs_full_request_processing(monkeypatch):
    """A connected client drives RequestProcessing.process and returns its result."""
    from ai.modules.task_http import task_data as task_data_mod

    fake_client_cls = MagicMock()
    fake_client = MagicMock()
    fake_client.connect = AsyncMock()
    fake_client.disconnect = AsyncMock()
    fake_client.debug_message = MagicMock()
    fake_client_cls.return_value = fake_client
    monkeypatch.setattr(task_data_mod, 'RocketRideClient', fake_client_cls)

    captured = {}

    class _CaptureProc(RequestProcessing):
        """RequestProcessing stand-in that records the .process() call."""

        async def process(self, request):
            """Record the request and return a stub response."""
            captured['request'] = request
            return task_data_mod.response({'objectsCompleted': 0, 'objectsRequested': 0})

    monkeypatch.setattr(task_data_mod, 'RequestProcessing', _CaptureProc)

    req = MagicMock()
    req.app.state.server.get_port = MagicMock(return_value=9999)
    req.state.account = SimpleNamespace(auth='ak_x')
    req.headers = {'Content-Type': 'application/octet-stream'}

    result = await task_Data(req, token='tk_x', authorization='Bearer ak_x')
    assert captured['request'] is req
    fake_client.disconnect.assert_awaited_once()
    body = result.body.decode() if hasattr(result, 'body') else str(result)
    assert 'OK' in body
