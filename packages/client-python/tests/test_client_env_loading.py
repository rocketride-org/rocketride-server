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
