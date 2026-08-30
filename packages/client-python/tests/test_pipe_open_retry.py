import asyncio

import pytest

from rocketride.core.exceptions import PipeException
from rocketride.mixins.data import DataMixin, _PIPE_OPEN_RETRY_ATTEMPTS


class ScriptedTransport:
    """Fake transport that answers each `send()` with a scripted response, resolving
    the request's future the same way a real server reply would via `on_receive`.
    """

    def __init__(self, results):
        # results: list of ('ok', body) | ('fail', message) tuples, consumed in send() order.
        self._results = list(results)
        self.client = None  # set after construction, once the client exists
        self.send_count = 0

    def bind(self, **handlers):
        self.handlers = handlers

    def is_connected(self):
        return True

    async def send(self, message):
        self.send_count += 1
        kind, payload = self._results.pop(0)
        response = {'type': 'response', 'request_seq': message['seq']}
        if kind == 'ok':
            response['success'] = True
            response['body'] = payload
        else:
            response['success'] = False
            response['message'] = payload
        await self.client.on_receive(response)


def _make_pipe(results):
    transport = ScriptedTransport(results)
    client = DataMixin(module='TEST', transport=transport)
    transport.client = client
    pipe = DataMixin.DataPipe(client, token='tok', mime_type='text/plain')
    return pipe, transport


def test_open_retries_on_transient_connect_error(monkeypatch):
    _real_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, 'sleep', lambda *_a, **_kw: _real_sleep(0))

    pipe, transport = _make_pipe(
        [
            ('fail', "Failed to open a data pipe.\n\nConnect call failed ('127.0.0.1', 40006)"),
            ('ok', {'pipe_id': 7}),
        ]
    )

    async def run_test():
        await pipe.open()
        assert transport.send_count == 2
        assert pipe.pipe_id == 7
        assert pipe.is_opened

    asyncio.run(run_test())


def test_open_gives_up_after_exhausting_retries(monkeypatch):
    _real_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, 'sleep', lambda *_a, **_kw: _real_sleep(0))

    transient_failure = ('fail', "Connect call failed ('127.0.0.1', 40006)")
    pipe, transport = _make_pipe([transient_failure] * (_PIPE_OPEN_RETRY_ATTEMPTS + 1))

    async def run_test():
        with pytest.raises(PipeException, match='Connect call failed'):
            await pipe.open()
        assert transport.send_count == _PIPE_OPEN_RETRY_ATTEMPTS
        assert not pipe.is_opened

    asyncio.run(run_test())


def test_open_does_not_retry_non_transient_failure():
    pipe, transport = _make_pipe([('fail', 'No pipeline found for token')])

    async def run_test():
        with pytest.raises(PipeException, match='No pipeline found'):
            await pipe.open()
        assert transport.send_count == 1
        assert not pipe.is_opened

    asyncio.run(run_test())
