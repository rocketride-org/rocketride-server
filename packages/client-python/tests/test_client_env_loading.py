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

"""Regression tests for RocketRideClient environment resolution."""

import os
import unittest
from unittest.mock import patch

from rocketride.client import RocketRideClient
from rocketride.core import CONST_DEFAULT_WEB_CLOUD
from rocketride.mixins.connection import ConnectionMixin

DISCOVERED_INFO = {'uri': 'http://localhost:54321', 'pid': 4242, 'updatedAt': ''}


class TestRocketRideClientEnvLoading(unittest.TestCase):
    def test_uses_process_environment_when_env_argument_is_not_provided(self) -> None:
        """RocketRideClient should honor process env vars without requiring .env."""
        with (
            patch.dict(
                os.environ,
                {
                    'ROCKETRIDE_URI': 'http://127.0.0.1:8765',
                    'ROCKETRIDE_APIKEY': 'process-env-token',
                },
                clear=True,
            ),
            patch('rocketride.client.os.path.exists', return_value=False),
        ):
            client = RocketRideClient()

        self.assertEqual(client._uri, ConnectionMixin._get_websocket_uri('http://127.0.0.1:8765'))
        self.assertEqual(client._apikey, 'process-env-token')

    def test_explicit_rocketride_uri_env_var_wins_over_connection_discovery(self) -> None:
        """An explicit ROCKETRIDE_URI must never be overridden by the discovery
        hint -- the fallback is a last resort, not a preference.
        """
        with (
            patch.dict(os.environ, {'ROCKETRIDE_URI': 'http://127.0.0.1:8765'}, clear=True),
            patch('rocketride.client.os.path.exists', return_value=False),
            patch('rocketride.client.read_connection_discovery') as mock_discovery,
        ):
            client = RocketRideClient()

        mock_discovery.assert_not_called()
        self.assertEqual(client._uri, ConnectionMixin._get_websocket_uri('http://127.0.0.1:8765'))

    def test_falls_back_to_connection_discovery_when_nothing_else_is_set(self) -> None:
        """No explicit uri, no ROCKETRIDE_URI env/.env -- a local engine's
        connection discovery hint should be used instead of jumping straight
        to the cloud default.
        """
        with (
            patch.dict(os.environ, {}, clear=True),
            patch('rocketride.client.os.path.exists', return_value=False),
            patch('rocketride.client.read_connection_discovery', return_value=DISCOVERED_INFO),
        ):
            client = RocketRideClient()

        self.assertEqual(client._uri, ConnectionMixin._get_websocket_uri('http://localhost:54321'))

    def test_discovery_never_supplies_a_credential(self) -> None:
        """Discovery only ever carries `uri`/`pid`/`updatedAt` -- auth comes
        from an explicit `auth` or `ROCKETRIDE_APIKEY` only, never from the
        discovery file (there is no `apiKey` field to read anymore; see the
        #1851 review).
        """
        with (
            patch.dict(os.environ, {}, clear=True),
            patch('rocketride.client.os.path.exists', return_value=False),
            patch('rocketride.client.read_connection_discovery', return_value=DISCOVERED_INFO),
        ):
            client = RocketRideClient()

        self.assertIsNone(client._apikey)

    def test_explicit_auth_wins_over_env_and_is_unaffected_by_discovery(self) -> None:
        with (
            patch.dict(os.environ, {}, clear=True),
            patch('rocketride.client.os.path.exists', return_value=False),
            patch('rocketride.client.read_connection_discovery', return_value=DISCOVERED_INFO),
        ):
            client = RocketRideClient(auth='explicit-token')

        self.assertEqual(client._apikey, 'explicit-token')

    def test_falls_back_to_cloud_default_when_discovery_also_finds_nothing(self) -> None:
        """No env, no .env, no live local engine -- must still land on the
        documented cloud default, not raise or leave the URI empty.
        """
        with (
            patch.dict(os.environ, {}, clear=True),
            patch('rocketride.client.os.path.exists', return_value=False),
            patch('rocketride.client.read_connection_discovery', return_value=None),
        ):
            client = RocketRideClient()

        self.assertEqual(client._uri, ConnectionMixin._get_websocket_uri(CONST_DEFAULT_WEB_CLOUD))

    def test_explicit_empty_rocketride_uri_env_var_still_raises(self) -> None:
        """An explicitly-set `ROCKETRIDE_URI=''` must behave exactly as it did
        on develop before discovery existed: it reaches `_get_websocket_uri()`
        and raises there. Discovery is only consulted when ROCKETRIDE_URI is
        genuinely absent, not when it's present-but-empty -- otherwise a typo'd
        empty override would silently start talking to a different host
        (discovery, then the cloud default) instead of failing loudly.
        """
        with (
            patch.dict(os.environ, {'ROCKETRIDE_URI': ''}, clear=True),
            patch('rocketride.client.os.path.exists', return_value=False),
            patch('rocketride.client.read_connection_discovery') as mock_discovery,
        ):
            with self.assertRaises(ValueError):
                RocketRideClient()

        mock_discovery.assert_not_called()

    def test_falls_back_to_discovery_when_rocketride_uri_is_genuinely_unset(self) -> None:
        """The absent-vs-empty distinction cuts both ways: a genuinely unset
        ROCKETRIDE_URI (the common case) must still reach discovery, not raise.
        """
        with (
            patch.dict(os.environ, {}, clear=True),
            patch('rocketride.client.os.path.exists', return_value=False),
            patch('rocketride.client.read_connection_discovery', return_value=DISCOVERED_INFO) as mock_discovery,
        ):
            client = RocketRideClient()

        mock_discovery.assert_called_once()
        self.assertEqual(client._uri, ConnectionMixin._get_websocket_uri('http://localhost:54321'))
