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

"""Regression tests for TransportWebSocket's loopback proxy bypass.

CodeRabbit on #1874: `websockets.connect()` honors HTTP_PROXY/HTTPS_PROXY/
WS_PROXY by default, so a connection to a loopback URI (discovery-selected or
not) could still be routed through a configured proxy, which could then
intercept whatever credential rides the first DAP message. `connect()` must
pass `proxy=None` for a loopback target, and leave a non-loopback target's
proxy behavior untouched.
"""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from rocketride.core import transport_websocket as tw
from rocketride.core.transport_websocket import TransportWebSocket


@contextmanager
def _connected(supports_proxy_kwarg: bool):
    """Patches `websockets.connect` to hand back a fake socket without
    starting a real background receive loop -- `_run_receive_task` is
    stubbed out too, since the real one would spin tightly against an
    AsyncMock socket's `recv()`, which is not what these tests are about.
    """
    fake_socket = AsyncMock()
    with (
        patch.object(tw, '_WEBSOCKETS_SUPPORTS_PROXY_KWARG', supports_proxy_kwarg),
        patch.object(tw.websockets, 'connect', AsyncMock(return_value=fake_socket)) as mock_connect,
        patch.object(TransportWebSocket, '_run_receive_task', AsyncMock(return_value=None)),
    ):
        yield mock_connect


@pytest.mark.parametrize(
    'uri',
    [
        'ws://localhost:54321',
        'ws://127.0.0.1:54321',
        'ws://[::1]:54321',
    ],
)
async def test_connect_disables_proxy_for_loopback_uri(uri):
    with _connected(supports_proxy_kwarg=True) as mock_connect:
        transport = TransportWebSocket(uri)
        await transport.connect()
        await transport._receive_task

    assert mock_connect.call_args.kwargs['proxy'] is None


async def test_connect_leaves_proxy_default_for_non_loopback_uri():
    with _connected(supports_proxy_kwarg=True) as mock_connect:
        transport = TransportWebSocket('wss://cloud.rocketride.ai')
        await transport.connect()
        await transport._receive_task

    assert 'proxy' not in mock_connect.call_args.kwargs


async def test_connect_omits_proxy_kwarg_on_older_websockets():
    """An installed websockets without `proxy` support must not receive the
    kwarg at all -- passing it would raise TypeError on that version.
    """
    with _connected(supports_proxy_kwarg=False) as mock_connect:
        transport = TransportWebSocket('ws://localhost:54321')
        await transport.connect()
        await transport._receive_task

    assert 'proxy' not in mock_connect.call_args.kwargs


def test_detect_proxy_kwarg_support_survives_uninspectable_connect():
    """CodeRabbit on #1874: inspect.signature() can itself raise for a
    callable it can't introspect. This module is imported by
    rocketride.core, so an uncaught exception here would break importing the
    whole SDK -- the detector must swallow it and default to False.
    """
    fake_websockets = SimpleNamespace(connect=lambda *a, **kw: None)
    with (
        patch.object(tw, 'websockets', fake_websockets),
        patch.object(tw.inspect, 'signature', side_effect=ValueError('no signature found')),
    ):
        assert tw._detect_proxy_kwarg_support() is False

    with (
        patch.object(tw, 'websockets', fake_websockets),
        patch.object(tw.inspect, 'signature', side_effect=TypeError('not a callable')),
    ):
        assert tw._detect_proxy_kwarg_support() is False


def test_detect_proxy_kwarg_support_false_when_websockets_missing():
    with patch.object(tw, 'websockets', None):
        assert tw._detect_proxy_kwarg_support() is False
