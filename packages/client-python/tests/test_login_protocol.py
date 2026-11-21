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

"""The login names the wire protocol: the ``auth`` arguments carry ``protocol: 2``."""

import asyncio

import pytest

from rocketride import RocketRideClient
from rocketride.core.constants import WIRE_PROTOCOL
from rocketride.core.exceptions import AuthenticationException


def _login(response):
    """
    Run the client's login against a scripted ``auth`` response.

    Args:
        response: The DAP response the server answers the ``auth`` request with.

    Returns:
        dict: The ``auth`` request the client sent.
    """
    client = RocketRideClient(uri='http://localhost:5565', auth='rr_key', env={})
    sent = []

    async def request(message, timeout=None):
        sent.append(message)
        return response

    client.request = request

    async def run():
        try:
            await client._internal_login()
        finally:
            assert len(sent) == 1

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(run())
    finally:
        loop.close()
    return sent[0]


def test_the_sdk_speaks_protocol_2():
    """The constant is the protocol major the server of this release speaks."""
    assert WIRE_PROTOCOL == 2


def test_login_arguments_carry_the_protocol():
    """Every login sends ``protocol`` beside the credential and the client identity."""
    request = _login({'type': 'response', 'command': 'auth', 'success': True, 'body': {}})

    assert request['command'] == 'auth'
    arguments = request['arguments']
    assert arguments['protocol'] == 2
    assert type(arguments['protocol']) is int
    assert arguments['auth'] == 'rr_key'
    assert arguments['clientVersion']


def test_a_refused_protocol_fails_the_login():
    """A server that does not speak the protocol refuses the login; the client raises."""
    refusal = {
        'type': 'response',
        'command': 'auth',
        'success': False,
        'message': 'This server speaks protocol 3; the client sent protocol 2',
        'code': 'TASK_VERSION_MISMATCH',
    }
    with pytest.raises(AuthenticationException, match='protocol 3'):
        _login(refusal)
