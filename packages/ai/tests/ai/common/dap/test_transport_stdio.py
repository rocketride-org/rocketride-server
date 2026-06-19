"""
Unit tests for ai.common.dap.transport_stdio.TransportStdio._process_message.

_process_message is the protocol parser that turns each line from a task
engine's stdio stream into a structured DAP event. Tests instantiate a real
TransportStdio (no subprocess) and replace its dispatch callbacks
(``_transport_receive``, ``_transport_disconnected``, ``_debug_message``)
with mocks, then drive the parser with one fixture string per message type.

Each test asserts the **dispatched event payload**, not the internal regex.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from ai.common.dap.transport_stdio import TransportStdio


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _Stub(TransportStdio):
    """
    TransportStdio with a no-op base init so tests can drive _process_message
    in isolation. Collects every dispatched message into ``self.events`` and
    every disconnect call into ``self.disconnects``.
    """

    def __init__(self):
        """Set up empty event log + disconnect log without invoking the parent init."""
        # NOTE: skip TransportBase.__init__ entirely; nothing below it is used
        # by _process_message.
        self.events: list = []
        self.disconnects: list = []
        self._process = None

    async def _transport_receive(self, message):
        """Capture a dispatched event for assertion."""
        self.events.append(message)

    async def _transport_disconnected(self, reason='', has_error=False):
        """Capture a disconnect call for assertion."""
        self.disconnects.append({'reason': reason, 'has_error': has_error})

    def _debug_message(self, *args, **kwargs):
        """No-op; tests do not assert on debug output."""


async def _drive(message, *, channel='stdout'):
    """
    Construct a stub, run ``_process_message`` against ``message``, and return
    the (events, disconnects) tuple captured during the call.

    Args:
        message: protocol line to parse.
        channel: 'stdout' or 'stderr' — currently unused by the parser but
            forwarded to keep tests honest if the signature ever changes.

    Returns:
        tuple[list[dict], list[dict]]: dispatched events and disconnect calls.
    """
    stub = _Stub()
    await TransportStdio._process_message(stub, channel, message)
    return stub.events, stub.disconnects


def _single_event(events):
    """Assert exactly one event was dispatched and return its dict."""
    assert len(events) == 1, f'expected exactly one event, got {events!r}'
    return events[0]


# ---------------------------------------------------------------------------
# Sentinels
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_none_message_is_silently_dropped():
    """End-of-stream (message=None) is a no-op: no event, no disconnect."""
    events, disconnects = await _drive(None)
    assert events == []
    assert disconnects == []


# ---------------------------------------------------------------------------
# >OBJ — object processing status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_obj_message_decodes_hex_size_and_name():
    """A well-formed OBJ line yields apaevt_status_object with hex-decoded size."""
    events, _ = await _drive('>OBJ*FF*my-object')
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_object'
    assert event['body'] == {'object': 'my-object', 'size': 0xFF}


@pytest.mark.asyncio
async def test_obj_message_with_non_hex_size_is_malformed():
    """A non-hex size triggers the malformed-OBJ output event."""
    events, _ = await _drive('>OBJ*not-hex*name')
    event = _single_event(events)
    assert event['event'] == 'output'
    assert 'Malformed OBJ message' in event['body']['output']


@pytest.mark.asyncio
async def test_obj_message_too_few_fields_is_incomplete():
    """Fewer than three '*'-separated fields yields an incomplete-OBJ output."""
    events, _ = await _drive('>OBJ*FF')
    event = _single_event(events)
    assert event['event'] == 'output'
    assert 'Incomplete OBJ message' in event['body']['output']


# ---------------------------------------------------------------------------
# >CNT — statistical counters
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cnt_message_decodes_all_hex_counters():
    """A well-formed CNT line decodes every counter as a hex integer.

    Dict-equality assertion pins the **exact** shape of the body. Any new
    counter added to the source without updating this expected dict makes
    the test fail, forcing the developer to update both sides at once.
    """
    # >CNT*total_size*total_count*completed_size*completed_count*failed_size*
    # failed_count*words_size*words_count*rate_size*rate_count
    raw = '>CNT*A*B*C*D*E*F*1*2*3*4'
    events, _ = await _drive(raw)
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_counts'
    assert event['body'] == {
        'totalSize': 0xA,
        'totalCount': 0xB,
        'completedSize': 0xC,
        'completedCount': 0xD,
        'failedSize': 0xE,
        'failedCount': 0xF,
        'wordsSize': 0x1,
        'wordsCount': 0x2,
        'rateSize': 0x3,
        'rateCount': 0x4,
    }


@pytest.mark.asyncio
async def test_cnt_message_too_short_is_incomplete():
    """Fewer than eleven fields yields an incomplete-CNT output event."""
    events, _ = await _drive('>CNT*A*B*C')
    event = _single_event(events)
    assert event['event'] == 'output'
    assert 'Incomplete CNT message' in event['body']['output']


@pytest.mark.asyncio
async def test_cnt_message_non_hex_field_is_malformed():
    """A non-hex field anywhere in the CNT line triggers the malformed path."""
    raw = '>CNT*A*B*C*D*E*F*1*2*not-hex*4'
    events, _ = await _drive(raw)
    event = _single_event(events)
    assert event['event'] == 'output'
    assert 'Malformed CNT message' in event['body']['output']


# ---------------------------------------------------------------------------
# >ERR — error message
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_err_message_extracts_text_after_star():
    """ERR yields apaevt_status_error with the text after '*'."""
    events, _ = await _drive('>ERR*disk full')
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_error'
    assert event['body'] == {'message': 'disk full'}


@pytest.mark.asyncio
async def test_err_message_with_empty_text_emits_empty_message():
    """'>ERR*' (matches the prefix but has no payload) yields message=''."""
    events, _ = await _drive('>ERR*')
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_error'
    assert event['body'] == {'message': ''}


# ---------------------------------------------------------------------------
# >WRN — warning message
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_wrn_message_extracts_text_after_star():
    """WRN yields apaevt_status_warning with the message text."""
    events, _ = await _drive('>WRN*disk almost full')
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_warning'
    assert event['body'] == {'message': 'disk almost full'}


# ---------------------------------------------------------------------------
# >DL — download / pip install info (JSON)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dl_message_dispatches_status_download():
    """A valid DL line emits apaevt_status_download with name/status/error keys."""
    payload = {'name': 'pkg', 'status': 'installing', 'error': []}
    events, _ = await _drive('>DL*' + json.dumps(payload))
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_download'
    assert event['body'] == {'info': payload}


@pytest.mark.asyncio
async def test_dl_message_bad_json_is_malformed():
    """Invalid JSON after the '*' is reported as a malformed-DL output event."""
    events, _ = await _drive('>DL*{not-valid}')
    event = _single_event(events)
    assert event['event'] == 'output'
    assert 'Malformed DL message' in event['body']['output']


# ---------------------------------------------------------------------------
# >USR — user-facing prompt JSON
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_usr_message_parses_json_payload():
    """USR yields apaevt_status_user with the parsed JSON value."""
    notes = [{'msg': 'enter value'}]
    events, _ = await _drive('>USR*' + json.dumps(notes))
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_user'
    assert event['body'] == {'notes': notes}


@pytest.mark.asyncio
async def test_usr_message_empty_payload_defaults_to_empty_list():
    """When the payload is missing entirely, the notes default to an empty list."""
    events, _ = await _drive('>USR*')
    event = _single_event(events)
    assert event['event'] == 'output'  # bad-JSON path: empty body triggers parser error
    assert 'Malformed USR message' in event['body']['output']


# ---------------------------------------------------------------------------
# >MET — metrics JSON
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_met_message_parses_json_metrics():
    """MET yields apaevt_status_metrics with the parsed JSON."""
    metrics = {'cpu': 12.5, 'memory_mb': 128}
    events, _ = await _drive('>MET*' + json.dumps(metrics))
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_metrics'
    assert event['body'] == {'metrics': metrics}


# ---------------------------------------------------------------------------
# >INF — info JSON
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_inf_message_parses_json_info():
    """INF yields apaevt_status_info with the parsed JSON."""
    info = {'version': '1.0', 'build': 'abc'}
    events, _ = await _drive('>INF*' + json.dumps(info))
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_info'
    assert event['body'] == {'info': info}


# ---------------------------------------------------------------------------
# >SVC — service status
# ---------------------------------------------------------------------------


@pytest.mark.parametrize('flag, expected', [('1', True), ('0', False)])
@pytest.mark.asyncio
async def test_svc_message_decodes_boolean_flag(flag, expected):
    """SVC*1 means service up; SVC*0 means service down."""
    events, _ = await _drive('>SVC*' + flag)
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_state'
    assert event['body'] == {'service': expected}


@pytest.mark.asyncio
async def test_svc_message_non_numeric_is_malformed():
    """Non-int values in SVC produce a malformed-SVC output event."""
    events, _ = await _drive('>SVC*maybe')
    event = _single_event(events)
    assert event['event'] == 'output'
    assert 'Malformed SVC message' in event['body']['output']


# ---------------------------------------------------------------------------
# >JOB — job status text
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_job_message_dispatches_status_message():
    """JOB yields apaevt_status_message with the text after '*'."""
    events, _ = await _drive('>JOB*running 50%')
    event = _single_event(events)
    assert event['event'] == 'apaevt_status_message'
    assert event['body'] == {'message': 'running 50%'}


# ---------------------------------------------------------------------------
# >DBG — debug command trace
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dbg_message_parses_all_fields():
    """A well-formed DBG line decodes op + ids + JSON trace.

    Dict-equality pins the body shape: a new key added on the source side
    without updating this expected dict will make the test fail.
    """
    trace = {'frame': 1}
    raw = '>DBG*EVAL*A*B*pipe-1*' + json.dumps(trace)
    events, _ = await _drive(raw)
    event = _single_event(events)
    assert event['event'] == 'apaevt_trace'
    assert event['body'] == {
        'op': 'eval',  # lowercased by the parser
        'id': 0xA,
        'total_pipes': 0xB,
        'pipe_id': 'pipe-1',
        'trace': trace,
    }


@pytest.mark.asyncio
async def test_dbg_message_invalid_trace_json_is_dropped_silently():
    """If the trace blob is not valid JSON, trace is replaced with {}."""
    raw = '>DBG*STEP*A*B*pipe-1*not-json'
    events, _ = await _drive(raw)
    event = _single_event(events)
    assert event['event'] == 'apaevt_trace'
    assert event['body']['trace'] == {}


@pytest.mark.asyncio
async def test_dbg_message_too_few_fields_is_malformed():
    """Fewer than six '*'-separated fields hits the malformed-DBG output path."""
    events, _ = await _drive('>DBG*STEP')
    event = _single_event(events)
    assert event['event'] == 'output'
    assert 'Malformed DBG message' in event['body']['output']


# ---------------------------------------------------------------------------
# >EXIT — process exit
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_exit_message_with_three_parts_dispatches_event_and_disconnect():
    """A 3-part EXIT yields apaevt_exit + a disconnect callback."""
    events, disconnects = await _drive('>EXIT*0*ok')
    event = _single_event(events)
    assert event['event'] == 'apaevt_exit'
    assert event['body'] == {'exitCode': 0, 'message': 'ok'}
    assert len(disconnects) == 1
    assert disconnects[0]['has_error'] is False


@pytest.mark.asyncio
async def test_exit_message_non_zero_code_marks_disconnect_as_error():
    """A non-zero exit code marks the disconnect callback with has_error=True."""
    events, disconnects = await _drive('>EXIT*FF*failed')
    assert events[0]['body']['exitCode'] == 0xFF
    assert disconnects[0]['has_error'] is True


@pytest.mark.asyncio
async def test_exit_message_cancelled_code_maps_to_zero():
    """The literal token CANCELLED is mapped to exit code 0 in 4-field form."""
    # 4-field form: >EXIT*code*message*trailing
    events, disconnects = await _drive('>EXIT*CANCELLED*user stop*x')
    assert events[0]['body']['exitCode'] == 0
    assert disconnects[0]['has_error'] is False


@pytest.mark.asyncio
async def test_exit_message_three_fields_unknown_token_maps_to_one():
    """In 3-field form, unparseable codes (not hex) map to exit code 1."""
    events, disconnects = await _drive('>EXIT*WHAT*broken')
    assert events[0]['body']['exitCode'] == 1
    assert disconnects[0]['has_error'] is True


@pytest.mark.asyncio
async def test_exit_message_too_short_dispatches_incomplete_event_and_disconnect():
    """'>EXIT*' (matches the prefix but lacks fields) hits the incomplete-exit branch."""
    events, disconnects = await _drive('>EXIT*')
    event = _single_event(events)
    assert event['event'] == 'apaevt_exit'
    assert event['body']['message'] == 'Incomplete exit message'
    assert disconnects[0]['has_error'] is True


# ---------------------------------------------------------------------------
# >SSE — server-sent event JSON
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sse_message_parses_json_payload():
    """SSE yields apaevt_sse with the decoded JSON body."""
    payload = {'pipe_id': 1, 'message': 'hello', 'data': {}}
    events, _ = await _drive('>SSE*' + json.dumps(payload))
    event = _single_event(events)
    assert event['event'] == 'apaevt_sse'
    assert event['body'] == payload


@pytest.mark.asyncio
async def test_sse_message_bad_json_is_silently_dropped():
    """Malformed JSON in an SSE line is logged but does not emit an event."""
    events, _ = await _drive('>SSE*{bad}')
    assert events == []  # no dispatched event


# ---------------------------------------------------------------------------
# Unknown control + regular console output
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_unknown_control_message_emits_output_event():
    """Any '>'-prefixed line we do not recognize falls through to a console output."""
    events, _ = await _drive('>UNKNOWN*x*y')
    event = _single_event(events)
    assert event['event'] == 'output'
    assert event['body']['category'] == 'console'
    assert 'Unknown control' in event['body']['output']


@pytest.mark.asyncio
async def test_regular_text_becomes_console_output():
    """A line without a '>' prefix is treated as ordinary console output."""
    events, _ = await _drive('hello from subprocess')
    event = _single_event(events)
    assert event['event'] == 'output'
    assert event['body'] == {'category': 'console', 'output': 'hello from subprocess\n'}


# ---------------------------------------------------------------------------
# Constructor — basic shape
# ---------------------------------------------------------------------------


def test_constructor_without_subprocess():
    """TransportStdio with no subprocess argument stores None and empty tasks."""
    transport = TransportStdio()
    assert transport._process is None
    assert transport._stdout_task is None
    assert transport._stderr_task is None


def test_constructor_with_subprocess_argument():
    """TransportStdio remembers the subprocess passed at construction."""
    fake_proc = object()  # any sentinel — TransportBase does not introspect it
    transport = TransportStdio(subprocess=fake_proc)
    assert transport._process is fake_proc


# ---------------------------------------------------------------------------
# connect — type validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_connect_rejects_non_subprocess():
    """connect() rejects a subprocess argument that is not an asyncio.subprocess.Process."""
    transport = TransportStdio(subprocess=object())  # not a real Process
    with pytest.raises(ValueError, match='asyncio.subprocess.Process'):
        await transport.connect()


# ---------------------------------------------------------------------------
# send — protocol framing + error paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_send_writes_json_with_newline(monkeypatch):
    """send() JSON-encodes the message and appends a newline before writing to stdin."""
    transport = TransportStdio()
    transport._connected = True

    written = []

    class _Stdin:
        """In-memory stdin double that records what was written."""

        def write(self, data):
            """Record the bytes written so the test can inspect them."""
            written.append(data)

        async def drain(self):
            """No-op — matches asyncio.StreamWriter.drain signature."""

    # Bypass is_connected() — it checks self._process.returncode by default.
    monkeypatch.setattr(transport, 'is_connected', lambda: True)

    fake_proc = type('P', (), {})()
    fake_proc.stdin = _Stdin()
    transport._process = fake_proc

    await transport.send({'command': 'pause', 'n': 1})

    assert len(written) == 1
    assert written[0].endswith(b'\n')
    payload = json.loads(written[0].decode('utf-8').strip())
    assert payload == {'command': 'pause', 'n': 1}


@pytest.mark.asyncio
async def test_send_raises_when_not_connected():
    """If the transport is not connected, send() raises ConnectionError."""
    transport = TransportStdio()
    transport._connected = False
    with pytest.raises(ConnectionError, match='not connected'):
        await transport.send({'command': 'whatever'})


@pytest.mark.asyncio
async def test_send_raises_when_stdin_missing(monkeypatch):
    """A connected transport with no stdin yields a clear ConnectionError."""
    transport = TransportStdio()
    transport._connected = True
    monkeypatch.setattr(transport, 'is_connected', lambda: True)
    fake_proc = type('P', (), {})()
    fake_proc.stdin = None
    transport._process = fake_proc

    with pytest.raises(ConnectionError, match='stdin not available'):
        await transport.send({'command': 'x'})


# ---------------------------------------------------------------------------
# disconnect — cleans up tasks and process state
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_disconnect_is_safe_when_already_disconnected():
    """disconnect() on an unconnected transport is a no-op."""
    transport = TransportStdio()
    transport._connected = False
    await transport.disconnect()  # must not raise
    assert transport._process is None


# ---------------------------------------------------------------------------
# _read_stream — line parsing + oversized-line recovery (crash hardening)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_read_stream_processes_normal_lines_in_order():
    """Normal-traffic regression: each newline-delimited message is parsed."""
    reader = asyncio.StreamReader()
    reader.feed_data(b'>SVC*1\n>JOB*hello\n')
    reader.feed_eof()

    stub = _Stub()
    await TransportStdio._read_stream(stub, reader, 'stderr')

    kinds = [e.get('event') for e in stub.events]
    assert kinds == ['apaevt_status_state', 'apaevt_status_message']


@pytest.mark.asyncio
async def test_read_stream_skips_oversized_line_and_keeps_going():
    """Regression: a line over the reader limit is skipped, not fatal to the reader."""
    reader = asyncio.StreamReader(limit=64)
    # oversized line + newline, then a normal message
    reader.feed_data(b'X' * 500 + b'\n' + b'>SVC*1\n')
    reader.feed_eof()

    stub = _Stub()
    await TransportStdio._read_stream(stub, reader, 'stderr')

    assert any(e.get('event') == 'apaevt_status_state' for e in stub.events), (
        f'message after the oversized line was not processed: {stub.events!r}'
    )
