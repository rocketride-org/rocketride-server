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

"""Tests for the hint added to the server's 'No authorization provided' answer."""

import unittest
from typing import Any, Dict
from unittest.mock import AsyncMock

from rocketride.client import RocketRideClient
from rocketride.cli.utils.common import hint_for
from rocketride.core.exceptions import AuthenticationException


def _client(apikey: str, response: Dict[str, Any]) -> RocketRideClient:
    client = RocketRideClient(uri='http://127.0.0.1:1', auth=apikey, env={})
    client.request = AsyncMock(return_value=response)  # type: ignore[method-assign]
    return client


class TestNoAuthHint(unittest.IsolatedAsyncioTestCase):
    async def test_empty_credential_keeps_message_and_sets_hint(self) -> None:
        client = _client('', {'success': False, 'message': 'No authorization provided'})
        with self.assertRaises(AuthenticationException) as ctx:
            await client._internal_login()
        self.assertEqual(str(ctx.exception), 'No authorization provided')
        hint = ctx.exception.hint
        self.assertIsNotNone(hint)
        self.assertIn('Set ROCKETRIDE_APIKEY', hint or '')
        self.assertIn('rocketride login', hint or '')

    async def test_empty_credential_adds_hint_as_traceback_note(self) -> None:
        client = _client('', {'success': False, 'message': 'No authorization provided'})
        with self.assertRaises(AuthenticationException) as raised:
            await client._internal_login()
        if not hasattr(raised.exception, 'add_note'):
            self.skipTest('exception notes need Python 3.11 or newer')
        self.assertEqual(getattr(raised.exception, '__notes__', []), [raised.exception.hint])
        self.assertEqual(str(raised.exception), 'No authorization provided')

    async def test_non_empty_credential_adds_no_hint(self) -> None:
        client = _client('bad-key', {'success': False, 'message': 'No authorization provided'})
        with self.assertRaises(AuthenticationException) as ctx:
            await client._internal_login()
        self.assertEqual(str(ctx.exception), 'No authorization provided')
        self.assertIsNone(ctx.exception.hint)

    async def test_other_message_with_empty_credential_adds_no_hint(self) -> None:
        client = _client('', {'success': False, 'message': 'Invalid API key'})
        with self.assertRaises(AuthenticationException) as ctx:
            await client._internal_login()
        self.assertEqual(str(ctx.exception), 'Invalid API key')
        self.assertIsNone(ctx.exception.hint)


class TestCliHintFor(unittest.TestCase):
    def test_exception_hint_is_returned_first(self) -> None:
        err = AuthenticationException({'message': 'Invalid API key', 'hint': 'Set the key.'})
        self.assertEqual(hint_for(err, 'http://x'), 'Set the key.')
