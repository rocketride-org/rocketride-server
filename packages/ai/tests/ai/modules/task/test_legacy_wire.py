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

"""
The protocol-1 edge translator (plan 11.3): ``legacy_wire`` and its two guards.

The fixture is a session in the shape a 1.6 SDK produces: a login without
``protocol``, ``use``, a pipe ``open``, ``write`` and ``close``, ``set_events``
and one SSE event. It is replayed through the real ``TaskConn.on_receive`` and
``TaskConn.send`` with the command handlers replaced by recorders that answer
in the server's own spelling, so what the handlers received and what reached
the transport are both observable.

Three real differences were found against the 1.6 SDKs, all the slot of a
pipe spelled ``pipe_id``: the arguments of ``write``/``close``/``tool``, the
body of the ``open`` response, and the body of an SSE event (delivered live,
and read back from the run log by ``rrext_log`` ``read`` and ``segment``).
"""

import ast
import copy
import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.modules.task import legacy_wire
from ai.modules.task.task_conn import TaskConn

from .test_task_conn import _make_account_info, _make_conn

# ==== The captured 1.6 session ===================================================

CONTROL = '=control/' + '1234abcd' * 4

# What a 1.6 SDK sends, in order. The login names no protocol; write and close
# name the slot as pipe_id; set_events already names its pipe filter pipeId.
SESSION_REQUESTS = [
    {
        'type': 'request',
        'command': 'auth',
        'seq': 1,
        'arguments': {'auth': 'rr_key', 'clientName': 'Python SDK', 'clientVersion': '1.6.0'},
    },
    {
        'type': 'request',
        'command': 'execute',
        'seq': 2,
        'arguments': {'pipeline': {'project_id': 'echo', 'source': 'webhook_1', 'components': []}},
    },
    {
        'type': 'request',
        'command': 'rrext_process',
        'seq': 3,
        'arguments': {
            'subcommand': 'open',
            'object': {'name': 'a.txt'},
            'mimeType': 'text/plain',
            'provider': None,
            'token': CONTROL,
        },
    },
    {
        'type': 'request',
        'command': 'rrext_monitor',
        'seq': 4,
        'arguments': {'types': ['SSE'], 'pipeId': 7, 'token': CONTROL},
    },
    {
        'type': 'request',
        'command': 'rrext_process',
        'seq': 5,
        'arguments': {'subcommand': 'write', 'pipe_id': 7, 'data': b'hello', 'token': CONTROL},
    },
    {
        'type': 'request',
        'command': 'rrext_process',
        'seq': 6,
        'arguments': {'subcommand': 'close', 'pipe_id': 7, 'token': CONTROL},
    },
]

# What the server's handlers answer, by request seq, in the server's spelling.
SERVER_BODIES = {
    2: {'token': CONTROL},
    3: {'pipeId': 7, 'traceId': '1.1.42'},
    4: {},
    5: {},
    6: {'name': 'a.txt', 'result_types': {}},
}

# The node's real-time message as the engine emits it (rocketlib.monitorSSE).
SSE_BODY = {'pipeId': 7, 'traceId': '1.1.42', 'type': 'thinking', 'data': {'message': 'working'}}

# ==== Replay =====================================================================


def _session_conn():
    """
    An unauthenticated connection whose command handlers record and answer.

    Returns:
        tuple: the connection, and the list its handlers append each request to.
    """
    account = _make_account_info()
    account.to_connect_result = MagicMock(return_value={'userToken': 'rr_key'})
    server = MagicMock()
    server._server.authenticate_credential = AsyncMock(return_value=account)
    server.broadcast_server_event = AsyncMock()
    conn = _make_conn(authenticated=False, server=server)

    handled = []

    async def answer(request):
        handled.append(request)
        return {
            'type': 'response',
            'command': request['command'],
            'request_seq': request['seq'],
            'success': True,
            'body': copy.deepcopy(SERVER_BODIES[request['seq']]),
        }

    for command in ('execute', 'rrext_process', 'rrext_monitor'):
        setattr(conn, f'on_{command}', answer)
    return conn, handled


async def _replay(login_arguments=None):
    """
    Run the session through a connection, then deliver the SSE event to it.

    Args:
        login_arguments: Extra arguments for the login (``{'protocol': 2}`` for
            a current SDK; nothing for a 1.6 one).

    Returns:
        tuple: the connection, the requests its handlers received, and every
        message it wrote to its transport after the login response.
    """
    conn, handled = _session_conn()
    requests = copy.deepcopy(SESSION_REQUESTS)
    requests[0]['arguments'].update(login_arguments or {})
    for request in requests:
        await TaskConn.on_receive(conn, request)

    # The body object is the one every subscribed connection is handed
    shared_body = copy.deepcopy(SSE_BODY)
    await conn.send_event('apaevt_sse', id=CONTROL, body=shared_body)
    assert shared_body == SSE_BODY, 'an event body is shared across connections and must not be changed'

    sent = [call.args[0] for call in conn._transport.send.await_args_list]
    return conn, handled, sent[1:]


@pytest.mark.asyncio
async def test_a_1_6_session_on_a_protocol_1_connection_uses_the_old_spellings():
    """Handlers see only pipeId; the client is sent pipe_id beside pipeId."""
    conn, handled, sent = await _replay()

    assert conn._protocol == 1

    # Inbound: every handler read the server's spelling and never the old one
    use, opened, subscribed, written, closed = (request['arguments'] for request in handled)
    assert 'pipe_id' not in opened and 'pipeId' not in opened
    assert subscribed['pipeId'] == 7
    assert written['pipeId'] == 7 and 'pipe_id' not in written
    assert closed['pipeId'] == 7 and 'pipe_id' not in closed
    assert written['data'] == b'hello'
    assert use == SESSION_REQUESTS[1]['arguments']

    # Outbound: the open response and the SSE event carry both names
    use_response, open_response, monitor_response, write_response, close_response, sse = sent
    assert open_response['body'] == {'pipeId': 7, 'pipe_id': 7, 'traceId': '1.1.42'}
    assert sse['event'] == 'apaevt_sse'
    assert sse['body'] == {**SSE_BODY, 'pipe_id': 7}
    # Everything else already fits a 1.6 client and is sent as the handler built it
    assert use_response['body'] == SERVER_BODIES[2]
    assert monitor_response['body'] == SERVER_BODIES[4]
    assert write_response['body'] == SERVER_BODIES[5]
    assert close_response['body'] == SERVER_BODIES[6]


@pytest.mark.asyncio
async def test_the_same_session_on_a_protocol_2_connection_is_not_translated():
    """A login naming protocol 2 turns both guards off: nothing is renamed and nothing is added."""
    conn, handled, sent = await _replay({'protocol': 2})

    assert conn._protocol == 2

    # Inbound: the handlers received exactly what was sent, old spellings included
    assert [request['arguments'] for request in handled] == [request['arguments'] for request in SESSION_REQUESTS[1:]]

    # Outbound: no message gained a pipe_id
    assert [message['body'] for message in sent] == [SERVER_BODIES[seq] for seq in (2, 3, 4, 5, 6)] + [SSE_BODY]


@pytest.mark.asyncio
async def test_the_session_login_is_refused_when_protocol_1_is_off(monkeypatch):
    """With the flag off the 1.6 login fails with the version mismatch and nothing is served."""
    from ai.modules.task import task_conn as tc_mod

    monkeypatch.setattr(tc_mod, 'CONST_ACCEPT_PROTOCOL_1', False)
    conn, handled = _session_conn()

    await TaskConn.on_receive(conn, copy.deepcopy(SESSION_REQUESTS[0]))

    refusal = conn._transport.send.await_args.args[0]
    assert refusal['success'] is False
    assert refusal['code'] == 'TASK_VERSION_MISMATCH'
    assert conn._authenticated is False
    conn._transport.disconnect.assert_called_once()
    assert handled == []


@pytest.mark.asyncio
@pytest.mark.parametrize('accept_protocol_1', [True, False])
async def test_a_protocol_3_login_is_refused_on_either_setting(monkeypatch, accept_protocol_1):
    """A protocol this server does not speak is refused whatever the protocol-1 flag says."""
    from ai.modules.task import task_conn as tc_mod

    monkeypatch.setattr(tc_mod, 'CONST_ACCEPT_PROTOCOL_1', accept_protocol_1)
    conn, _handled = _session_conn()
    login = copy.deepcopy(SESSION_REQUESTS[0])
    login['arguments']['protocol'] = 3

    await TaskConn.on_receive(conn, login)

    refusal = conn._transport.send.await_args.args[0]
    assert refusal['success'] is False
    assert refusal['code'] == 'TASK_VERSION_MISMATCH'
    assert conn._authenticated is False
    conn._transport.disconnect.assert_called_once()


# ==== The codec ==================================================================


def test_the_tables_are_the_whole_configuration():
    """Three rows, one per real difference against a 1.6 SDK, and the two places stored events ride."""
    assert legacy_wire.WIRE_FIELDS == (
        ('request:rrext_process', 'pipeId', 'pipe_id'),
        ('response:rrext_process', 'pipeId', 'pipe_id'),
        ('event:apaevt_sse', 'pipeId', 'pipe_id'),
    )
    assert legacy_wire.WIRE_CARRIERS == (
        ('response:rrext_log', 'events', 'list'),
        ('response:rrext_log', 'data', 'jsonl'),
    )


def test_decode_renames_and_does_not_change_its_input():
    """The old name becomes the new one in a copy; the request handed in is untouched."""
    request = {'type': 'request', 'command': 'rrext_process', 'seq': 1, 'arguments': {'pipe_id': 3, 'token': 't'}}
    before = copy.deepcopy(request)

    decoded = legacy_wire.decode(request)

    assert decoded['arguments'] == {'pipeId': 3, 'token': 't'}
    assert request == before
    assert {key: value for key, value in decoded.items() if key != 'arguments'} == {
        'type': 'request',
        'command': 'rrext_process',
        'seq': 1,
    }


def test_decode_keeps_the_new_name_when_both_are_sent():
    """A request carrying both spellings keeps the server's and loses the old one."""
    request = {'type': 'request', 'command': 'rrext_process', 'arguments': {'pipeId': 3, 'pipe_id': 9}}
    assert legacy_wire.decode(request)['arguments'] == {'pipeId': 3}


@pytest.mark.parametrize(
    'message',
    [
        {'type': 'request', 'command': 'rrext_process', 'arguments': {'subcommand': 'open'}},
        {'type': 'request', 'command': 'rrext_process'},
        {'type': 'request', 'command': 'rrext_process', 'arguments': None},
        {'type': 'request', 'command': 'execute', 'arguments': {'pipe_id': 3}},
        # set_events: a 1.6 SDK already sends pipeId, so the filter is not a row
        {'type': 'request', 'command': 'rrext_monitor', 'arguments': {'pipe_id': 3}},
        {'type': 'response', 'command': 'rrext_process', 'arguments': {'pipe_id': 3}},
        {},
    ],
)
def test_decode_returns_the_same_message_when_nothing_applies(message):
    """A message with no listed old name is returned as it came, not copied."""
    assert legacy_wire.decode(message) is message


@pytest.mark.parametrize(
    'message',
    [
        {'type': 'response', 'command': 'rrext_process', 'success': True, 'body': {'pipeId': 3, 'traceId': 't'}},
        {'type': 'event', 'event': 'apaevt_sse', 'body': {'pipeId': 3, 'type': 'x'}},
    ],
)
def test_encode_adds_beside_and_does_not_change_its_input(message):
    """The old name is added next to the new one in a copy; the shared body is untouched."""
    before = copy.deepcopy(message)

    encoded = legacy_wire.encode(message)

    assert encoded['body'] == {**before['body'], 'pipe_id': 3}
    assert encoded['body']['pipeId'] == 3
    assert message == before
    assert encoded['body'] is not message['body']


@pytest.mark.parametrize(
    'message',
    [
        {'type': 'response', 'command': 'rrext_process', 'success': True, 'body': {'result': 1}},
        {'type': 'response', 'command': 'rrext_process', 'success': False, 'message': 'no'},
        {'type': 'response', 'command': 'rrext_process', 'success': True, 'body': {'pipeId': 3, 'pipe_id': 3}},
        {'type': 'response', 'command': 'rrext_submit', 'success': True, 'body': {'pipeId': 3}},
        # A flow event names its slot `id` in both generations: not a row
        {'type': 'event', 'event': 'apaevt_flow', 'body': {'id': 3, 'pipeId': 3, 'op': 'enter'}},
        {'type': 'event', 'event': 'apaevt_status_update', 'body': {'pipeId': 3}},
        {'type': 'response', 'command': 'rrext_log', 'success': True, 'body': {'events': []}},
        {'type': 'response', 'command': 'rrext_log', 'success': True, 'body': {'streams': [{'pipeId': 3}]}},
        {'type': 'response', 'command': 'rrext_log', 'success': True, 'body': {'data': '', 'final': True}},
        {'type': 'response', 'command': 'rrext_process', 'success': True, 'body': {'events': [{'pipeId': 3}]}},
        {'type': 'request', 'command': 'rrext_process', 'body': {'pipeId': 3}},
        {},
    ],
)
def test_encode_returns_the_same_message_when_nothing_applies(message):
    """A message with no listed field is returned as it came, not copied."""
    assert legacy_wire.encode(message) is message


# ==== Stored events: the run log =================================================

# One SSE event and one flow event as the run log stores and returns them.
LOG_SSE = {
    'type': 'event',
    'event': 'apaevt_sse',
    'body': {'pipeId': 7, 'traceId': '1.1.42', 'type': 'thinking', 'eventTime': 10.0, 'logSeq': 5},
}
LOG_FLOW = {
    'type': 'event',
    'event': 'apaevt_flow',
    'body': {'id': 7, 'op': 'begin', 'pipes': [], 'traceId': '1.1.42', 'eventTime': 9.0, 'logSeq': 4},
}


def _log_response(body):
    """An ``rrext_log`` response carrying ``body``, as the handler builds it."""
    return {'type': 'response', 'command': 'rrext_log', 'request_seq': 9, 'success': True, 'body': body}


def _read_response():
    """A ``read`` page: a list of stored events."""
    return _log_response({'events': [copy.deepcopy(LOG_FLOW), copy.deepcopy(LOG_SSE)], 'nextSeq': 6})


def _segment_response():
    """A ``segment`` chunk: the stored lines as text, a keyframe line first."""
    lines = [{'type': 'keyframe', 'docs': {}}, LOG_FLOW, LOG_SSE]
    data = ''.join(json.dumps(line, separators=(',', ':')) + '\n' for line in lines)
    return _log_response(
        {'segment': 1, 'offset': 0, 'data': data, 'size': len(data), 'nextOffset': None, 'final': True}
    )


def test_encode_adds_pipe_id_to_the_sse_events_of_a_log_read():
    """Only the SSE event of the page gains pipe_id; the stored objects are not changed."""
    response = _read_response()
    before = copy.deepcopy(response)
    flow, sse = response['body']['events']

    encoded = legacy_wire.encode(response)

    sent_flow, sent_sse = encoded['body']['events']
    assert sent_sse['body'] == {**LOG_SSE['body'], 'pipe_id': 7}
    assert sent_flow is flow
    assert encoded['body']['nextSeq'] == 6
    # Nothing handed in was changed: the list, the event and its body are copies
    assert response == before
    assert encoded['body']['events'] is not response['body']['events']
    assert sent_sse is not sse and sent_sse['body'] is not sse['body']


def test_encode_adds_pipe_id_to_the_sse_lines_of_a_log_segment():
    """Only the SSE line of the chunk is rewritten; every other line and field is byte-identical."""
    response = _segment_response()
    before = copy.deepcopy(response)

    encoded = legacy_wire.encode(response)

    sent_lines = encoded['body']['data'].split('\n')
    stored_lines = before['body']['data'].split('\n')
    assert len(sent_lines) == len(stored_lines) and sent_lines[-1] == ''
    assert sent_lines[:2] == stored_lines[:2]
    assert json.loads(sent_lines[2])['body'] == {**LOG_SSE['body'], 'pipe_id': 7}
    assert {key: value for key, value in encoded['body'].items() if key != 'data'} == {
        key: value for key, value in before['body'].items() if key != 'data'
    }
    assert response == before


def test_a_segment_line_that_is_not_json_is_passed_on():
    """A line naming the event that does not parse is left exactly as stored."""
    response = _log_response({'data': '{"event":"apaevt_sse","body":{"pipeId":7\n', 'final': True})
    assert legacy_wire.encode(response) is response


@pytest.mark.asyncio
@pytest.mark.parametrize('build', [_read_response, _segment_response])
async def test_a_log_response_through_the_connection(build):
    """Protocol 1 is sent pipe_id beside pipeId on the SSE event only; protocol 2 is sent the response as built."""
    for protocol in (1, 2):
        conn = _make_conn()
        conn._protocol = protocol
        response = build()
        before = copy.deepcopy(response)

        await TaskConn.send(conn, response)

        sent = conn._transport.send.await_args.args[0]
        assert response == before
        if protocol == 2:
            assert sent is response
            continue
        if 'events' in sent['body']:
            events = sent['body']['events']
        else:
            events = [json.loads(line) for line in sent['body']['data'].split('\n') if line][1:]
        flow, sse = events
        assert sse['body']['pipeId'] == 7 and sse['body']['pipe_id'] == 7
        assert flow == LOG_FLOW


# ==== Isolation ==================================================================


def test_legacy_wire_imports_only_the_standard_library():
    """Every import in the module names a standard-library module, and none is relative."""
    tree = ast.parse(Path(legacy_wire.__file__).read_text(encoding='utf-8'))
    imported = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, 'legacy_wire must not import from its own package'
            imported.append(node.module)

    assert imported, 'the check found no imports to examine'
    for name in imported:
        assert name.split('.')[0] in sys.stdlib_module_names, f'legacy_wire imports {name}'


def test_legacy_wire_loads_without_its_package():
    """The file runs on its own: loaded by path, outside the ``ai`` package, it still translates."""
    spec = importlib.util.spec_from_file_location('legacy_wire_alone', legacy_wire.__file__)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    decoded = module.decode({'type': 'request', 'command': 'rrext_process', 'arguments': {'pipe_id': 1}})
    assert decoded['arguments'] == {'pipeId': 1}


def test_task_conn_is_the_only_caller():
    """No module under ``ai`` other than ``task_conn`` names ``legacy_wire``."""
    source_root = Path(legacy_wire.__file__).resolve().parents[3]
    callers = sorted(
        path.name
        for path in source_root.rglob('*.py')
        if path.name != 'legacy_wire.py' and 'legacy_wire' in path.read_text(encoding='utf-8', errors='ignore')
    )
    assert callers == ['task_conn.py']
