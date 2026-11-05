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

import pytest

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


def _client_answering(response):
    """A real client whose transport answers every request with ``response``."""
    from rocketride import RocketRideClient

    client = RocketRideClient(uri='http://127.0.0.1:1', auth='unused')

    async def fake_request(message, timeout=None):
        return response

    client.request = fake_request
    return client


def test_tool_failure_keeps_the_server_code():
    """client.tool() raises a CommandException carrying the server's code and message."""
    import asyncio

    from rocketride import CommandException

    client = _client_answering(
        {'type': 'response', 'success': False, 'message': 'Task is stopped', 'code': 'TASK_STOPPED'}
    )
    with pytest.raises(CommandException) as caught:
        asyncio.run(client.tool(token='tk_task', tool='read_query', node_id='graph_1', input={}))

    assert str(caught.value) == 'Task is stopped'
    assert caught.value.code == 'TASK_STOPPED'
    assert isinstance(caught.value, DAPException)


def test_command_failure_is_still_a_runtime_error():
    """Callers that caught RuntimeError from client.call() keep working."""
    import asyncio

    client = _client_answering({'type': 'response', 'success': False, 'message': 'execute tool is disabled'})
    with pytest.raises(RuntimeError) as caught:
        asyncio.run(client.call('rrext_process'))

    assert str(caught.value) == 'execute tool is disabled'
    assert caught.value.code is None


def test_command_failure_keeps_the_fallback_message():
    """With no server message the text stays '<command> failed'."""
    import asyncio

    client = _client_answering({'type': 'response', 'success': False})
    with pytest.raises(RuntimeError, match='^rrext_get_tasks failed$'):
        asyncio.run(client.call('rrext_get_tasks'))
