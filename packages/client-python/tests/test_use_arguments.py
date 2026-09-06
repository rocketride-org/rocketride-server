# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""Unit tests for RocketRideClient.use() argument building.

These tests do not require a running server: `call()` is monkeypatched with an
AsyncMock so `use()` runs its argument-assembly logic in isolation and we
assert on the kwargs that would have been sent as the `execute` DAP command.
"""

from unittest.mock import AsyncMock

import pytest

from rocketride.client import RocketRideClient

from echo_pipeline import get_echo_pipeline


def _make_client() -> RocketRideClient:
    client = RocketRideClient(uri='ws://localhost:5565', auth='MYAPIKEY')
    client.call = AsyncMock(return_value={'token': 'tok-1', 'replicas': 1})
    return client


@pytest.mark.asyncio
async def test_use_omits_replicas_and_torch_threads_when_not_provided():
    client = _make_client()

    await client.use(pipeline=get_echo_pipeline(), token='tok-1')

    _, kwargs = client.call.call_args
    assert 'replicas' not in kwargs
    assert 'torchThreads' not in kwargs


@pytest.mark.asyncio
async def test_use_forwards_replicas_as_replicas():
    client = _make_client()

    await client.use(pipeline=get_echo_pipeline(), token='tok-1', replicas=4)

    _, kwargs = client.call.call_args
    assert kwargs['replicas'] == 4


@pytest.mark.asyncio
async def test_use_forwards_torch_threads_as_torchThreads():
    client = _make_client()

    await client.use(pipeline=get_echo_pipeline(), token='tok-1', torch_threads=8)

    _, kwargs = client.call.call_args
    assert kwargs['torchThreads'] == 8


@pytest.mark.asyncio
async def test_use_forwards_threads_unchanged():
    client = _make_client()

    await client.use(pipeline=get_echo_pipeline(), token='tok-1', threads=16)

    _, kwargs = client.call.call_args
    assert kwargs['threads'] == 16
