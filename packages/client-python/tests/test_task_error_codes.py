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


"""Task failures carry a machine-readable code (#2097).

``build_exception`` copies an exception's ``code`` onto the DAP error packet,
and ``DAPException`` exposes ``code`` / ``hint`` so a caller classifies a
failure without matching the English message.
"""

from rocketride.core.dap_base import DAPBase
from rocketride.core.exceptions import DAPException, PipeException


class _Base(DAPBase):
    """DAPBase with the transport left out: only the packet builders are used."""

    def __init__(self):
        self._seq_counter = 0


class _Coded(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


REQUEST = {'seq': 1, 'command': 'rrext_process'}


def test_build_exception_carries_a_code_when_the_error_has_one():
    """A coded exception reaches the wire with its code beside the message."""
    packet = _Base().build_exception(REQUEST, _Coded('TASK_NOT_REGISTERED', 'Your pipeline is not running'))

    assert packet['success'] is False
    assert packet['message'] == 'Your pipeline is not running'
    assert packet['code'] == 'TASK_NOT_REGISTERED'


def test_build_exception_omits_the_code_for_a_plain_exception():
    """A plain exception still produces the packet it produced before."""
    packet = _Base().build_exception(REQUEST, RuntimeError('boom'))

    assert 'code' not in packet
    assert packet['message'] == 'boom'


def test_build_exception_ignores_a_non_string_code():
    """An unrelated attribute named code cannot inject a non-string into the packet."""
    packet = _Base().build_exception(REQUEST, _Coded(42, 'boom'))

    assert 'code' not in packet


def test_exception_exposes_code_and_hint():
    """The SDK exception surfaces both fields, and the message stays clean."""
    e = PipeException(
        {'message': 'Your pipeline is not running', 'code': 'TASK_NOT_REGISTERED', 'hint': 'Common causes:\n- ...'}
    )

    assert str(e) == 'Your pipeline is not running'
    assert e.code == 'TASK_NOT_REGISTERED'
    assert e.hint.startswith('Common causes:')


def test_exception_code_and_hint_default_to_none():
    """Neither field is required; both read as None when absent."""
    e = DAPException({'message': 'boom'})

    assert e.code is None
    assert e.hint is None


async def test_a_refused_command_keeps_the_servers_code():
    """call() raises a CommandException carrying the code, still a RuntimeError."""
    from rocketride import RocketRideClient
    from rocketride.core.exceptions import CommandException

    client = RocketRideClient(uri='http://localhost:1', auth='key')
    refused = {'success': False, 'message': 'acme.echo is not published to you', 'code': 'NODE_NOT_ENTITLED'}

    async def request(message, timeout=None):
        return refused

    client.request = request
    try:
        await client.call('execute', pipeline={})
    except CommandException as e:
        assert isinstance(e, RuntimeError)
        assert e.code == 'NODE_NOT_ENTITLED' and str(e) == 'acme.echo is not published to you'
    else:
        raise AssertionError('call() did not raise')


def _refusing_client(code='NODE_NOT_ENTITLED', message='acme.echo is not published to you'):
    from rocketride import RocketRideClient

    client = RocketRideClient(uri='http://localhost:1', auth='key')

    async def request(message_, timeout=None):
        return {'success': False, 'message': message, 'code': code}

    client.request = request
    return client


async def test_a_refused_validation_keeps_the_code():
    from rocketride.core.exceptions import CommandException

    try:
        await _refusing_client().validate({'components': []})
    except CommandException as e:
        assert e.code == 'NODE_NOT_ENTITLED' and str(e).startswith('Pipeline validation failed: ')
    else:
        raise AssertionError('validate() did not raise')


async def test_a_refused_restart_keeps_the_code():
    from rocketride.core.exceptions import CommandException

    try:
        await _refusing_client().restart(token='tk', project_id='p', source='s', pipeline={})
    except CommandException as e:
        assert e.code == 'NODE_NOT_ENTITLED' and isinstance(e, RuntimeError)
    else:
        raise AssertionError('restart() did not raise')
