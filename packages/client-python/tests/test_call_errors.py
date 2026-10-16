"""
A server rejection keeps its machine-readable code through ``client.call()``.

The spend gate answers a refused ``execute`` with ``code: OUT_OF_CREDITS``; the
SDK must hand that to the caller as an exception field, not bury it in prose.
"""

from unittest.mock import AsyncMock

import pytest

from rocketride import RocketRideClient
from rocketride.core.exceptions import ExecutionException


def _client_answering(response):
    client = RocketRideClient('http://localhost:1', 'MYAPIKEY')
    client.request = AsyncMock(return_value={'type': 'response', 'seq': 1, 'command': 'execute', **response})
    return client


@pytest.mark.asyncio
async def test_a_refused_start_carries_the_server_code():
    client = _client_answering({'success': False, 'message': 'Out of credits', 'code': 'OUT_OF_CREDITS'})
    with pytest.raises(ExecutionException) as exc_info:
        await client.call('execute', pipeline={})
    assert exc_info.value.code == 'OUT_OF_CREDITS'
    assert str(exc_info.value) == 'Out of credits'
    assert isinstance(exc_info.value, RuntimeError)


@pytest.mark.asyncio
async def test_a_rejection_without_a_code_is_still_a_runtime_error():
    client = _client_answering({'success': False})
    with pytest.raises(RuntimeError, match='execute failed') as exc_info:
        await client.call('execute')
    assert exc_info.value.code is None
