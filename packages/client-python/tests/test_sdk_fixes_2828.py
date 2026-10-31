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

"""Unit tests for Python SDK fixes (issue #2828)."""

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from rocketride import RocketRideClient
from rocketride.core.dap_client import DAPClient
from rocketride.core.exceptions import AuthenticationException, DAPException


class TestReconnectDebugMessageAndAuthError:
    """Tests for ConnectionMixin._schedule_reconnect, _do_reconnect, and _internal_login."""

    async def test_schedule_and_do_reconnect_use_debug_message(self):
        client = RocketRideClient(auth='test_key', uri='http://localhost:5565')
        client._desired_state = 'authenticated'
        client._current_reconnect_delay = 0.001
        client._internal_attach = AsyncMock()
        client._internal_login = AsyncMock()

        client._schedule_reconnect()
        assert client._reconnect_timer is not None
        await client._reconnect_timer

        client._internal_attach.assert_awaited_once()
        client._internal_login.assert_awaited_once()
        assert client._current_reconnect_delay == 0.25

    async def test_internal_login_handles_explicit_none_message(self):
        client = RocketRideClient(auth='test_key', uri='http://localhost:5565')
        client.build_request = lambda command, **kwargs: {'type': 'request', 'command': command}
        client.request = AsyncMock(return_value={'success': False, 'message': None})
        client.did_fail = lambda response: not response.get('success', True)

        with pytest.raises(AuthenticationException, match='Authentication failed'):
            await client._internal_login()


class TestSyncAndAsyncEventCallbacks:
    """Tests for sync and async callbacks in EventsMixin and DataMixin."""

    async def test_on_event_accepts_sync_callback(self):
        received = []

        def sync_handler(event):
            received.append(event)

        client = RocketRideClient(auth='test_key', uri='http://localhost:5565', on_event=sync_handler)
        msg = {'type': 'event', 'event': 'apaevt_test', 'body': {'ok': True}}
        await client.on_event(msg)

        assert received == [msg]

    async def test_on_event_accepts_async_callback(self):
        received = []

        async def async_handler(event):
            received.append(event)

        client = RocketRideClient(auth='test_key', uri='http://localhost:5565', on_event=async_handler)
        msg = {'type': 'event', 'event': 'apaevt_test', 'body': {'ok': True}}
        await client.on_event(msg)

        assert received == [msg]

    async def test_sse_pipe_callback_accepts_sync_and_async_callbacks(self):
        sync_events = []
        async_events = []

        def sync_sub(evt_type, data):
            sync_events.append((evt_type, data))

        async def async_sub(evt_type, data):
            async_events.append((evt_type, data))

        client = RocketRideClient(auth='test_key', uri='http://localhost:5565')
        client._register_sse_pipe(1, sync_sub)
        client._register_sse_pipe(2, async_sub)

        await client.on_event(
            {'type': 'event', 'event': 'apaevt_sse', 'body': {'pipe_id': 1, 'type': 'chunk', 'data': {'n': 1}}}
        )
        await client.on_event(
            {'type': 'event', 'event': 'apaevt_sse', 'body': {'pipe_id': 2, 'type': 'chunk', 'data': {'n': 2}}}
        )

        assert sync_events == [('chunk', {'n': 1})]
        assert async_events == [('chunk', {'n': 2})]

    async def test_connection_lifecycle_callbacks_accept_sync_functions(self):
        calls = []

        client = RocketRideClient(
            auth='test_key',
            uri='http://localhost:5565',
            on_connected=lambda info: calls.append(('connected', info)),
            on_disconnected=lambda reason, err: calls.append(('disconnected', reason, err)),
            on_connect_error=lambda err: calls.append(('error', err)),
        )

        await client.on_connected('ws://localhost:5565')
        await client.on_disconnected('closed', False)
        await client.on_connect_error(RuntimeError('boom'))

        assert calls == [
            ('connected', 'ws://localhost:5565'),
            ('disconnected', 'closed', False),
            ('error', 'boom'),
        ]


class TestSendFilesMissingFileAndSyncProgress:
    """Tests for DataMixin.send_files file existence check and sync progress callback."""

    async def test_send_files_raises_file_not_found_for_missing_path(self, tmp_path: Path):
        client = RocketRideClient(auth='test_key', uri='http://localhost:5565')
        client.pipe = AsyncMock()

        missing_path = tmp_path / 'does_not_exist.txt'
        with pytest.raises(FileNotFoundError, match='File not found'):
            await client.send_files([str(missing_path)], token='tok_1')

        client.pipe.assert_not_awaited()


class TestDAPClientNullTransportGuards:
    """Tests for DAPClient.request and disconnect when _transport is None."""

    async def test_request_without_transport_raises_runtime_error(self):
        client = DAPClient(module='TEST', transport=None)

        with pytest.raises(RuntimeError, match='Server is not connected'):
            await client.request({'type': 'request', 'command': 'ping', 'seq': 1})

    async def test_disconnect_without_transport_is_noop(self):
        client = DAPClient(module='TEST', transport=None)
        await client.disconnect()


class TestPingForwardsToken:
    """Tests for PingMixin.ping forwarding token to self.call."""

    async def test_ping_forwards_token(self):
        client = RocketRideClient(auth='test_key', uri='http://localhost:5565')
        client.call = AsyncMock(return_value={'body': {}})

        await client.ping(token='task-token-123')

        client.call.assert_awaited_once_with('rrext_ping', token='task-token-123')


class TestExplicitNoneErrorMessageFallbacks:
    """Tests that explicit None error messages fall back to default strings."""

    def test_dap_exception_with_none_message_uses_fallback(self):
        exc = DAPException({'message': None, 'command': 'test'})
        assert 'Unknown DAP error' in str(exc)
