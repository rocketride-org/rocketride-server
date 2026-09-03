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
            patch(
                'rocketride.client.read_connection_discovery',
                return_value={'uri': 'http://localhost:54321', 'apiKey': 'MYAPIKEY', 'pid': 4242, 'updatedAt': ''},
            ),
        ):
            client = RocketRideClient()

        self.assertEqual(client._uri, ConnectionMixin._get_websocket_uri('http://localhost:54321'))
        self.assertEqual(client._apikey, 'MYAPIKEY')

    def test_explicit_auth_wins_over_the_discovered_api_key(self) -> None:
        """The discovery hint's apiKey must only fill in when nothing else
        provided one -- an explicitly-passed auth always wins.
        """
        with (
            patch.dict(os.environ, {}, clear=True),
            patch('rocketride.client.os.path.exists', return_value=False),
            patch(
                'rocketride.client.read_connection_discovery',
                return_value={'uri': 'http://localhost:54321', 'apiKey': 'MYAPIKEY', 'pid': 4242, 'updatedAt': ''},
            ),
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
