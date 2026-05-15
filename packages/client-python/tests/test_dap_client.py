import asyncio

import pytest

from rocketride.core.dap_client import DAPClient


class FailingSendTransport:
    def __init__(self):
        self.send_count = 0
        self.handlers = {}

    def bind(self, **handlers):
        self.handlers = handlers

    def is_connected(self):
        return True

    async def send(self, message):
        self.send_count += 1
        raise RuntimeError('send failed')


def test_request_cleans_pending_request_when_send_fails():
    async def run_test():
        transport = FailingSendTransport()
        client = DAPClient(module='TEST', transport=transport)

        with pytest.raises(ConnectionError, match='Could not send request'):
            await client.request({'type': 'request', 'command': 'example', 'seq': 42})

        assert transport.send_count == 1
        assert client._pending_requests == {}

    asyncio.run(run_test())
