"""
Unit tests for ai.modules.data.data_conn.DataConn — pure-logic methods.

DataConn handles per-pipe DAP data flow. The async I/O paths (open / write
/ close / disconnect, _monitor_pipes) require deep mock infrastructure;
this test file focuses on the pure-logic and small-state methods:

- ``_determine_lane`` — MIME-type → lane router
- ``_begin`` / ``_end`` — per-lane framing dispatchers
- ``_reset_pipe_activity`` — timestamp setter
- ``_cleanup_pipe`` — pipe lifecycle finaliser (with monitoring side effects)
- ``_write`` / ``_close`` on the text lane — UTF-8 decoding across writes
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import asyncio

import pytest

from ai.modules.data import data_conn
from ai.modules.data.data_conn import DataConn, DataConnPipe


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_conn():
    """Build a DataConn instance with __init__ bypassed.

    `DataConn._target` is a lazy `@property` delegating to `self._server._target`,
    so target injection happens on the server mock — not directly on the conn.
    """
    conn = DataConn.__new__(DataConn)
    conn._server = MagicMock()
    conn._server._target = MagicMock()
    conn.debug_message = MagicMock()
    # The tables __init__ makes: the request-id index of open pipes, and the bindings whose close is in flight
    conn._open_by_correlation = {}
    conn._closing = {}
    return conn


def _make_pipe_with_listeners(listeners):
    """Build a fake IServiceFilterPipe whose getListeners() returns the supplied set.

    ``hasListener`` answers from the same set, the way the engine's Binder does —
    a bare MagicMock would return a truthy mock for every lane and hide exactly
    the "nobody reads this" case these tests exist to pin.
    """
    pipe = MagicMock()
    pipe.getListeners = MagicMock(return_value=set(listeners))
    pipe.hasListener = MagicMock(side_effect=lambda lane: lane in set(listeners))
    return pipe


# ---------------------------------------------------------------------------
# _determine_lane
# ---------------------------------------------------------------------------


def test_determine_lane_direct_lane_specifier_extracts_name():
    """A 'lane/<name>' MIME bypasses MIME-type detection and returns the name."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners([])
    assert conn._determine_lane('lane/text', pipe) == 'text'
    assert conn._determine_lane('lane/questions', pipe) == 'questions'
    assert conn._determine_lane('lane/documents', pipe) == 'documents'


def test_determine_lane_rocketlib_tag_uses_tag_lane():
    """The custom 'application/rocketlib-tag' MIME maps to the 'tag' lane."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners([])
    assert conn._determine_lane('application/rocketlib-tag', pipe) == 'tag'


def test_determine_lane_question_with_questions_listener():
    """Question MIMEs go to the 'questions' lane when that listener exists."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['questions'])
    assert conn._determine_lane('application/rocketride-question+json', pipe) == 'questions'


def test_determine_lane_question_without_listener_falls_back_to_raw():
    """Without a 'questions' listener, the question MIME falls back to raw."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners([])
    assert conn._determine_lane('application/rocketride-question+json', pipe) == 'raw'


def test_determine_lane_json_with_json_listener():
    """'application/json' maps to the 'json' lane when that listener exists."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['json'])
    assert conn._determine_lane('application/json', pipe) == 'json'


def test_determine_lane_json_without_listener_falls_back_to_raw():
    """Without a 'json' listener, 'application/json' falls back to raw."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners([])
    assert conn._determine_lane('application/json', pipe) == 'raw'


def test_determine_lane_json_tolerates_charset_parameter():
    """'application/json; charset=utf-8' still maps to the 'json' lane."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['json'])
    assert conn._determine_lane('application/json; charset=utf-8', pipe) == 'json'


@pytest.mark.parametrize(
    'mime',
    [
        'application/json',
        'application/json; charset=utf-8',
        'Application/JSON',
        'application/vnd.github+json',
        'application/xml',
        'application/atom+xml',
        'application/x-ndjson',
        'application/yaml',
    ],
)
def test_determine_lane_structured_text_goes_to_text_when_only_text_is_read(mime):
    """JSON, XML and similar bodies reach a text reader instead of falling to raw."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['text'])
    assert conn._determine_lane(mime, pipe) == 'text'


def test_determine_lane_json_prefers_json_lane_over_text():
    """With both readers present, JSON keeps going to the json lane."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['json', 'text'])
    assert conn._determine_lane('application/json', pipe) == 'json'


def test_determine_lane_question_without_questions_listener_does_not_become_text():
    """A question body never turns into plain text, even when text is read."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['text'])
    assert conn._determine_lane('application/rocketride-question+json', pipe) == 'raw'


def test_determine_lane_structured_text_keeps_raw_when_tags_is_read():
    """A tags reader (e.g. parse) keeps getting JSON on raw, even when text is read too."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['text', 'tags'])
    assert conn._determine_lane('application/json', pipe) == 'raw'


def test_determine_lane_structured_text_without_text_listener_falls_back_to_raw():
    """Without a text reader, XML still falls back to raw."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['image'])
    assert conn._determine_lane('application/xml', pipe) == 'raw'


@pytest.mark.parametrize(
    'mime, listener, expected',
    [
        ('text/plain', 'text', 'text'),
        ('text/csv', 'text', 'text'),
        ('image/png', 'image', 'image'),
        ('image/jpeg', 'image', 'image'),
        ('video/mp4', 'video', 'video'),
        ('audio/wav', 'audio', 'audio'),
    ],
)
def test_determine_lane_picks_matching_lane_when_listener_present(mime, listener, expected):
    """Each MIME family routes to its corresponding lane when the listener exists."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners([listener])
    assert conn._determine_lane(mime, pipe) == expected


@pytest.mark.parametrize(
    'mime',
    [
        'text/plain',
        'image/png',
        'video/mp4',
        'audio/wav',
    ],
)
def test_determine_lane_falls_back_to_raw_without_listener(mime):
    """Without the matching listener, every typed MIME falls back to 'raw'."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners([])  # no listeners
    assert conn._determine_lane(mime, pipe) == 'raw'


def test_determine_lane_unknown_mime_goes_to_raw():
    """An unrecognised MIME type also falls back to 'raw'."""
    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['text', 'image'])  # listeners don't matter here
    assert conn._determine_lane('application/x-unknown', pipe) == 'raw'


# ---------------------------------------------------------------------------
# _warn_on_unconsumed_lane
# ---------------------------------------------------------------------------


def test_warn_on_unconsumed_lane_stays_quiet_when_the_lane_is_read(monkeypatch):
    """A lane with a consumer produces no warning."""
    warnings = []
    monkeypatch.setattr('ai.modules.data.data_conn.warning', warnings.append)

    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['text'])
    conn._warn_on_unconsumed_lane('text/plain', 'text', pipe)

    assert warnings == []


def test_warn_on_unconsumed_lane_warns_when_nothing_reads_it(monkeypatch):
    """JSON sent to a text-only pipeline warns, naming the MIME and the read lanes."""
    warnings = []
    monkeypatch.setattr('ai.modules.data.data_conn.warning', warnings.append)

    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['text'])
    conn._warn_on_unconsumed_lane('application/json', 'raw', pipe)

    assert len(warnings) == 1
    message = warnings[0]
    assert 'application/json' in message
    assert 'text' in message


def test_warn_on_unconsumed_lane_resolves_raw_through_the_tags_method(monkeypatch):
    """The 'raw' lane is checked against 'tags' — a tags consumer silences it.

    ``writeTagData`` dispatches on the binder's ``tags`` method, so a pipeline
    whose first node reads ``tags`` does receive raw-routed data and must not
    be warned about.
    """
    warnings = []
    monkeypatch.setattr('ai.modules.data.data_conn.warning', warnings.append)

    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['tags'])
    conn._warn_on_unconsumed_lane('application/json', 'raw', pipe)

    assert warnings == []


def test_warn_on_unconsumed_lane_reports_no_read_lanes_as_none(monkeypatch):
    """With nothing wired downstream the message says so rather than printing an empty list."""
    warnings = []
    monkeypatch.setattr('ai.modules.data.data_conn.warning', warnings.append)

    conn = _make_conn()
    pipe = _make_pipe_with_listeners([])
    conn._warn_on_unconsumed_lane('application/json', 'raw', pipe)

    assert len(warnings) == 1
    assert 'none' in warnings[0]


def test_warn_on_unconsumed_lane_omits_lifecycle_methods_from_the_suggestion(monkeypatch):
    """open/closing/close are bound on every component and must not be offered as lanes."""
    warnings = []
    monkeypatch.setattr('ai.modules.data.data_conn.warning', warnings.append)

    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['open', 'closing', 'close', 'text'])
    conn._warn_on_unconsumed_lane('application/json', 'raw', pipe)

    assert len(warnings) == 1
    message = warnings[0]
    assert 'reads: text.' in message
    for lifecycle in ('open', 'closing', 'close'):
        assert f'{lifecycle},' not in message


def test_warn_on_unconsumed_lane_is_symmetric_for_text_on_a_json_pipeline(monkeypatch):
    """The mismatch is not JSON-specific: text into a json-only pipeline warns too."""
    warnings = []
    monkeypatch.setattr('ai.modules.data.data_conn.warning', warnings.append)

    conn = _make_conn()
    pipe = _make_pipe_with_listeners(['json'])
    conn._warn_on_unconsumed_lane('text/plain', 'raw', pipe)

    assert len(warnings) == 1
    assert 'text/plain' in warnings[0]
    assert 'json' in warnings[0]


# ---------------------------------------------------------------------------
# _begin / _end — per-lane framing dispatch
# ---------------------------------------------------------------------------


def _make_pipe_conn(lane, mime_type='text/plain'):
    """Build a DataConnPipe stand-in with the bare attributes _begin/_end use."""
    pipe = MagicMock()
    return SimpleNamespace(
        pipe=pipe, lane=lane, mime_type=mime_type, text_decoder=None, text_parts=None, has_failed=False, cancelled=False
    )


def test_begin_audio_calls_writeAudio_with_begin_action():
    """The audio lane writes an AVI_ACTION.BEGIN to the pipe."""
    from rocketlib import AVI_ACTION

    conn = _make_conn()
    pipe_conn = _make_pipe_conn('audio', 'audio/wav')
    conn._begin(pipe_conn)
    pipe_conn.pipe.writeAudio.assert_called_once_with(AVI_ACTION.BEGIN, 'audio/wav')


def test_begin_video_calls_writeVideo_with_begin_action():
    """The video lane writes an AVI_ACTION.BEGIN."""
    from rocketlib import AVI_ACTION

    conn = _make_conn()
    pipe_conn = _make_pipe_conn('video', 'video/mp4')
    conn._begin(pipe_conn)
    pipe_conn.pipe.writeVideo.assert_called_once_with(AVI_ACTION.BEGIN, 'video/mp4')


def test_begin_image_calls_writeImage_with_begin_action():
    """The image lane writes an AVI_ACTION.BEGIN."""
    from rocketlib import AVI_ACTION

    conn = _make_conn()
    pipe_conn = _make_pipe_conn('image', 'image/png')
    conn._begin(pipe_conn)
    pipe_conn.pipe.writeImage.assert_called_once_with(AVI_ACTION.BEGIN, 'image/png')


def test_begin_raw_writes_tag_object_and_stream():
    """The raw lane opens with writeTagBeginObject + writeTagBeginStream."""
    conn = _make_conn()
    pipe_conn = _make_pipe_conn('raw')
    conn._begin(pipe_conn)
    pipe_conn.pipe.writeTagBeginObject.assert_called_once_with()
    pipe_conn.pipe.writeTagBeginStream.assert_called_once_with()


def test_begin_other_lane_is_noop():
    """Lanes like 'text', 'questions', 'tag' don't need framing."""
    conn = _make_conn()
    for lane in ['text', 'questions', 'tag', 'unknown']:
        pipe_conn = _make_pipe_conn(lane)
        conn._begin(pipe_conn)
        # No framing calls were made.
        pipe_conn.pipe.writeAudio.assert_not_called()
        pipe_conn.pipe.writeVideo.assert_not_called()
        pipe_conn.pipe.writeImage.assert_not_called()
        pipe_conn.pipe.writeTagBeginObject.assert_not_called()


def test_end_audio_calls_writeAudio_with_end_action():
    """The audio lane closes with an AVI_ACTION.END."""
    from rocketlib import AVI_ACTION

    conn = _make_conn()
    pipe_conn = _make_pipe_conn('audio', 'audio/mp3')
    conn._end(pipe_conn)
    pipe_conn.pipe.writeAudio.assert_called_once_with(AVI_ACTION.END, 'audio/mp3')


def test_end_raw_writes_tag_end_stream_and_object():
    """The raw lane closes with writeTagEndStream + writeTagEndObject."""
    conn = _make_conn()
    pipe_conn = _make_pipe_conn('raw')
    conn._end(pipe_conn)
    pipe_conn.pipe.writeTagEndStream.assert_called_once_with()
    pipe_conn.pipe.writeTagEndObject.assert_called_once_with()


# ---------------------------------------------------------------------------
# _write_text — UTF-8 across chunks
# ---------------------------------------------------------------------------


def test_write_text_keeps_a_character_split_between_chunks():
    """A multi-byte character cut by the chunk boundary arrives whole."""
    conn = _make_conn()
    pipe_conn = SimpleNamespace(pipe=MagicMock(), text_decoder=None, text_parts=None, has_failed=False, cancelled=False)
    body = '{"name": "Zoë"}'.encode('utf-8')
    cut = body.index('ë'.encode('utf-8')) + 1  # inside the two-byte ë
    conn._write_text(pipe_conn, body[:cut])
    conn._write_text(pipe_conn, body[cut:])
    conn._flush_text(pipe_conn)
    pipe_conn.pipe.writeText.assert_called_once_with('{"name": "Zoë"}')


def test_a_chunked_text_body_is_written_once_when_complete():
    """Two chunks make one writeText, so a `question` node asks one question, not two halves."""
    conn = _make_conn()
    pipe_conn = SimpleNamespace(pipe=MagicMock(), text_decoder=None, text_parts=None, has_failed=False, cancelled=False)
    conn._write_text(pipe_conn, b'{"action": "opened", ')
    conn._write_text(pipe_conn, b'"number": 7}')
    pipe_conn.pipe.writeText.assert_not_called()
    conn._flush_text(pipe_conn)
    conn._flush_text(pipe_conn)  # idempotent: _end flushes again on other paths
    pipe_conn.pipe.writeText.assert_called_once_with('{"action": "opened", "number": 7}')


def test_a_text_body_over_the_hold_limit_streams_instead_of_growing(monkeypatch):
    """Past the limit the held text is written and later chunks go straight through, as before buffering."""
    monkeypatch.setattr(data_conn, 'TEXT_LANE_HOLD_BYTES', 4)
    conn = _make_conn()
    pipe_conn = SimpleNamespace(pipe=MagicMock(), text_decoder=None, text_parts=None, has_failed=False, cancelled=False)
    conn._write_text(pipe_conn, b'ab')
    conn._write_text(pipe_conn, b'cd')
    pipe_conn.pipe.writeText.assert_not_called()  # at the limit, still one text

    conn._write_text(pipe_conn, b'ef')
    conn._write_text(pipe_conn, b'gh')
    conn._flush_text(pipe_conn)

    assert [c.args[0] for c in pipe_conn.pipe.writeText.call_args_list] == ['abcdef', 'gh']


def test_end_text_flushes_and_rejects_a_truncated_character():
    """A body that ends inside a character is invalid UTF-8 and raises at the end."""
    conn = _make_conn()
    pipe_conn = SimpleNamespace(
        pipe=MagicMock(),
        lane='text',
        mime_type='text/plain',
        text_decoder=None,
        text_parts=None,
        has_failed=False,
        cancelled=False,
    )
    conn._write_text(pipe_conn, 'ë'.encode('utf-8')[:1])
    with pytest.raises(ValueError, match='ends inside a character'):
        conn._end(pipe_conn)
    pipe_conn.pipe.writeText.assert_not_called()


def _text_pipe_on_conn(conn):
    conn_pipe = DataConnPipe(
        pipe_id=1, pipe=MagicMock(), mime_type='application/json', lane='text', is_open=True, entry=MagicMock()
    )
    conn._pipe_map = {1: conn_pipe}
    conn._reset_pipe_activity = MagicMock()
    conn._cleanup_pipe = MagicMock()
    conn.build_response = MagicMock(return_value={'success': True})
    return conn_pipe


@pytest.mark.asyncio
async def test_close_reports_a_text_body_that_ends_inside_a_character():
    """The truncated body reaches the client as an error; it is not swallowed by close's catch-all."""
    conn = _make_conn()
    conn_pipe = _text_pipe_on_conn(conn)
    conn._write_text(conn_pipe, '{"name": "Zoë"'.encode('utf-8')[:-2])

    with pytest.raises(ValueError, match='ends inside a character'):
        await conn._close({'command': 'rrext_process'}, {'pipeId': 1})

    assert conn_pipe.has_failed is True
    conn_pipe.pipe.writeText.assert_not_called()
    conn_pipe.pipe.close.assert_not_called()
    conn._cleanup_pipe.assert_called_once_with(conn_pipe)


@pytest.mark.asyncio
async def test_close_writes_the_whole_text_body_once_before_closing_the_pipe():
    conn = _make_conn()
    conn_pipe = _text_pipe_on_conn(conn)
    calls = []
    conn_pipe.pipe.writeText.side_effect = lambda text: calls.append(('writeText', text))
    conn_pipe.pipe.close.side_effect = lambda: calls.append(('close',))
    conn._write_text(conn_pipe, b'{"a": ')
    conn._write_text(conn_pipe, b'1}')

    assert await conn._close({'command': 'rrext_process'}, {'pipeId': 1}) == {'success': True}

    assert calls == [('writeText', '{"a": 1}'), ('close',)]


def test_determine_lane_text_check_ignores_mime_case():
    conn = _make_conn()
    pipe = _make_pipe_with_listeners({'text'})
    assert conn._determine_lane('Text/Plain; charset=utf-8', pipe) == 'text'


def test_end_text_without_writes_is_noop():
    """A text pipe that never wrote has no decoder and nothing to flush."""
    conn = _make_conn()
    pipe_conn = _make_pipe_conn('text')
    conn._end(pipe_conn)
    pipe_conn.pipe.writeText.assert_not_called()


# ---------------------------------------------------------------------------
# _reset_pipe_activity
# ---------------------------------------------------------------------------


def test_reset_pipe_activity_updates_last_activity_timestamp(monkeypatch):
    """_reset_pipe_activity sets the pipe's last_activity_time to current time."""
    from ai.modules.data import data_conn as data_conn_mod

    monkeypatch.setattr(data_conn_mod.time, 'time', lambda: 1234.5)

    conn = _make_conn()
    pipe_conn = SimpleNamespace(last_activity_time=0.0, pipe_id='p-1')
    conn._reset_pipe_activity(pipe_conn)
    assert pipe_conn.last_activity_time == 1234.5


# ---------------------------------------------------------------------------
# _cleanup_pipe — pipe lifecycle finaliser
# ---------------------------------------------------------------------------


def test_cleanup_pipe_returns_pipe_to_endpoint_on_success(monkeypatch):
    """A non-failed pipe is returned to the endpoint and monitorCompleted is called."""
    from ai.modules.data import data_conn as data_conn_mod

    completed = []
    failed = []
    monkeypatch.setattr(data_conn_mod, 'monitorCompleted', lambda s: completed.append(s))
    monkeypatch.setattr(data_conn_mod, 'monitorFailed', lambda s: failed.append(s))

    conn = _make_conn()
    pipe = MagicMock()
    pipe_conn = SimpleNamespace(
        correlation_id=None,
        hold_started=None,
        trace_id=None,
        pipe=pipe,
        pipe_id='p-1',
        size=None,
        written=42,
        has_failed=False,
        entry=MagicMock(),
    )
    conn._cleanup_pipe(pipe_conn)

    assert completed == [42]  # used written size
    assert failed == []
    conn._target.putPipe.assert_called_once_with(pipe)
    assert pipe_conn.entry is None


def test_cleanup_pipe_calls_monitor_failed_on_error(monkeypatch):
    """A failed pipe routes through monitorFailed with the byte count."""
    from ai.modules.data import data_conn as data_conn_mod

    completed = []
    failed = []
    monkeypatch.setattr(data_conn_mod, 'monitorCompleted', lambda s: completed.append(s))
    monkeypatch.setattr(data_conn_mod, 'monitorFailed', lambda s: failed.append(s))

    conn = _make_conn()
    pipe = MagicMock()
    pipe_conn = SimpleNamespace(
        correlation_id=None,
        hold_started=None,
        trace_id=None,
        pipe=pipe,
        pipe_id='p-1',
        size=100,
        written=42,
        has_failed=True,
        entry=None,
    )
    conn._cleanup_pipe(pipe_conn)

    assert failed == [100]  # explicit size wins over written
    assert completed == []


def test_cleanup_pipe_swallows_target_errors(monkeypatch):
    """A target.putPipe exception is logged but not re-raised."""
    from ai.modules.data import data_conn as data_conn_mod

    monkeypatch.setattr(data_conn_mod, 'monitorCompleted', lambda s: None)
    monkeypatch.setattr(data_conn_mod, 'monitorFailed', lambda s: None)

    conn = _make_conn()
    conn._target.putPipe = MagicMock(side_effect=RuntimeError('cannot return'))
    pipe_conn = SimpleNamespace(
        hold_started=None,
        trace_id=None,
        pipe=MagicMock(),
        pipe_id='p-1',
        size=None,
        written=0,
        has_failed=False,
        entry=None,
    )

    conn._cleanup_pipe(pipe_conn)  # must not raise
    conn.debug_message.assert_called()


def test_cleanup_pipe_handles_missing_pipe_object():
    """If the conn_pipe has no actual pipe, putPipe is not called and no exception bubbles."""
    conn = _make_conn()
    pipe_conn = SimpleNamespace(
        hold_started=None,
        trace_id=None,
        pipe=None,
        pipe_id='p-1',
        size=None,
        written=0,
        has_failed=False,
        entry=None,
    )
    conn._cleanup_pipe(pipe_conn)
    conn._target.putPipe.assert_not_called()


# ---------------------------------------------------------------------------
# _write / _close — the text lane decodes UTF-8 across writes
# ---------------------------------------------------------------------------


def _make_text_conn(monkeypatch):
    """Build a DataConn holding one open text-lane pipe (id 1).

    Args:
        monkeypatch: pytest fixture, used to silence the monitoring hooks.

    Returns:
        The DataConn and its DataConnPipe.
    """
    from ai.modules.data import data_conn as data_conn_mod
    from ai.modules.data.data_conn import DataConnPipe

    monkeypatch.setattr(data_conn_mod, 'monitorCompleted', lambda s: None)
    monkeypatch.setattr(data_conn_mod, 'monitorFailed', lambda s: None)

    conn = _make_conn()
    conn.build_response = MagicMock(side_effect=lambda request, body=None: body)
    entry = MagicMock(objectId='obj-1', objectFailed=False)
    entry.response.toDict = MagicMock(return_value={})
    conn_pipe = DataConnPipe(
        pipe_id=1, pipe=MagicMock(), mime_type='text/plain', lane='text', is_open=True, entry=entry
    )
    conn._pipe_map = {1: conn_pipe}
    return conn, conn_pipe


def _written_text(conn_pipe):
    """Join every string the pipe received through writeText.

    Args:
        conn_pipe: The DataConnPipe whose pipe mock recorded the calls.

    Returns:
        The concatenated text.
    """
    return ''.join(call.args[0] for call in conn_pipe.pipe.writeText.call_args_list)


@pytest.mark.asyncio
async def test_write_text_joins_a_character_split_across_two_writes(monkeypatch):
    """An HTTP body stream cuts at any byte; a character cut in half still arrives whole."""
    conn, conn_pipe = _make_text_conn(monkeypatch)
    data = 'Привет, мир'.encode('utf-8')

    # 'П' is two bytes; the first write ends after its first byte
    await conn._write({}, {'pipeId': 1, 'data': data[:1]})
    await conn._write({}, {'pipeId': 1, 'data': data[1:]})
    await conn._close({}, {'pipeId': 1})

    assert _written_text(conn_pipe) == 'Привет, мир'
    assert not conn_pipe.has_failed


@pytest.mark.asyncio
async def test_write_text_one_byte_at_a_time_sends_no_empty_text(monkeypatch):
    """A write that holds only part of a character sends nothing downstream."""
    conn, conn_pipe = _make_text_conn(monkeypatch)

    for byte in 'あいう'.encode('utf-8'):
        await conn._write({}, {'pipeId': 1, 'data': bytes([byte])})
    await conn._close({}, {'pipeId': 1})

    assert _written_text(conn_pipe) == 'あいう'
    assert all(call.args[0] for call in conn_pipe.pipe.writeText.call_args_list)


@pytest.mark.asyncio
async def test_write_text_still_rejects_bytes_that_are_not_utf8(monkeypatch):
    """A byte that can never start a character fails the write at once."""
    conn, conn_pipe = _make_text_conn(monkeypatch)

    with pytest.raises(UnicodeDecodeError):
        await conn._write({}, {'pipeId': 1, 'data': b'ok \xff'})

    assert conn_pipe.has_failed


@pytest.mark.asyncio
async def test_a_frame_for_another_request_never_reaches_a_reused_slot(monkeypatch):
    """A slot reaped and reopened for another request refuses the first request's write, close and tool frames."""
    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn_pipe.correlation_id = 'req-b'

    with pytest.raises(ValueError, match='another request'):
        await conn._write({}, {'pipeId': 1, 'data': b'x', '_caller': {'correlationId': 'req-a'}})
    with pytest.raises(ValueError, match='another request'):
        await conn._close({}, {'pipeId': 1, '_caller': {'correlationId': 'req-a'}})
    with pytest.raises(ValueError, match='another request'):
        await conn._tool({}, {'pipeId': 1, 'tool': 't', '_caller': {'correlationId': 'req-a'}})
    assert conn._pipe_map == {1: conn_pipe}, "the other request's binding is untouched"

    # The request the slot was opened for, and a binding the engine opened itself, go through
    await conn._write({}, {'pipeId': 1, 'data': b'ok', '_caller': {'correlationId': 'req-b'}})
    conn_pipe.correlation_id = None
    await conn._write({}, {'pipeId': 1, 'data': b'ok', '_caller': {'correlationId': 'req-a'}})
    # A text body reaches the pipeline as one text when its pipe closes
    await conn._close({}, {'pipeId': 1, '_caller': {'correlationId': 'req-a'}})
    assert _written_text(conn_pipe) == 'okok'


@pytest.mark.asyncio
async def test_close_after_whole_text_closes_the_pipe(monkeypatch):
    """A text that ends on a character boundary closes normally."""
    conn, conn_pipe = _make_text_conn(monkeypatch)
    await conn._write({}, {'pipeId': 1, 'data': 'Привет'.encode('utf-8')})

    result = await conn._close({}, {'pipeId': 1})

    assert result['objectId'] == 'obj-1'
    conn_pipe.pipe.close.assert_called_once_with()
    assert not conn_pipe.has_failed


@pytest.mark.asyncio
async def test_close_fails_text_that_ends_inside_a_character(monkeypatch):
    """A body cut inside its last character fails the close; the pipe still goes back."""
    conn, conn_pipe = _make_text_conn(monkeypatch)
    await conn._write({}, {'pipeId': 1, 'data': 'ok П'.encode('utf-8')[:-1]})

    with pytest.raises(UnicodeDecodeError):
        await conn._close({}, {'pipeId': 1})

    assert conn_pipe.has_failed
    conn._target.putPipe.assert_called_once_with(conn_pipe.pipe)


@pytest.mark.asyncio
async def test_close_after_a_failed_write_does_not_raise_a_second_error(monkeypatch):
    """A pipe whose write already failed closes as before, without a new decode error."""
    conn, conn_pipe = _make_text_conn(monkeypatch)
    await conn._write({}, {'pipeId': 1, 'data': 'П'.encode('utf-8')[:1]})
    with pytest.raises(UnicodeDecodeError):
        await conn._write({}, {'pipeId': 1, 'data': b'\xff'})

    result = await conn._close({}, {'pipeId': 1})

    assert result['objectId'] == 'obj-1'
    conn_pipe.pipe.close.assert_called_once_with()


# ---------------------------------------------------------------------------
# _open / _tool / _cleanup_pipe — the caller rides the PIPE and the hold is booked
# ---------------------------------------------------------------------------


def test_cleanup_pipe_books_the_hold_and_flushes_a_snapshot(monkeypatch):
    """PutPipe ends the hold: hold_time (ms) and bytes_in land in the metrics and a >MET* snapshot goes out."""
    import time as _time

    from ai.modules.data import data_conn as data_conn_mod
    from ai.modules.data.data_conn import DataConnPipe

    monkeypatch.setattr(data_conn_mod, 'monitorCompleted', lambda s: None)
    monkeypatch.setattr(data_conn_mod, 'monitorFailed', lambda s: None)
    booked = []
    counted = []
    flushed = []
    fake_metrics = MagicMock()
    fake_metrics.add_time = lambda timers: booked.append(timers)
    fake_metrics.counter = lambda name, value: counted.append((name, value))
    fake_metrics.report = lambda: {'timers': {'hold_time': 1.0}, 'counters': {}, 'events': []}
    monkeypatch.setattr(data_conn_mod, 'metrics', fake_metrics)
    monkeypatch.setattr(data_conn_mod, 'monitorMetrics', lambda report: flushed.append(report))

    conn = _make_conn()
    target = MagicMock()
    conn._server._target = target
    conn_pipe = DataConnPipe(pipe_id=4, pipe=MagicMock(), written=120, hold_started=_time.perf_counter() - 0.05)

    conn._cleanup_pipe(conn_pipe)

    target.putPipe.assert_called_once_with(conn_pipe.pipe)
    assert len(booked) == 1 and booked[0]['hold_time'] >= 50.0
    assert counted == [('bytes_in', 120)]
    assert flushed == [{'timers': {'hold_time': 1.0}, 'counters': {}, 'events': []}]


def test_cleanup_pipe_without_a_hold_books_nothing(monkeypatch):
    """A record that never took a pipe (an open that failed) has no hold to bill."""
    from ai.modules.data import data_conn as data_conn_mod
    from ai.modules.data.data_conn import DataConnPipe

    monkeypatch.setattr(data_conn_mod, 'monitorCompleted', lambda s: None)
    fake_metrics = MagicMock()
    monkeypatch.setattr(data_conn_mod, 'metrics', fake_metrics)
    conn = _make_conn()
    conn._server._target = MagicMock()

    conn._cleanup_pipe(DataConnPipe(pipe_id=5, pipe=MagicMock(), written=10))

    fake_metrics.add_time.assert_not_called()


@pytest.mark.asyncio
async def test_open_stamps_the_caller_on_the_pipe_at_its_trace_level(monkeypatch):
    """_caller leaves the arguments and lands on the pipe right after getPipe; the binding binds at the caller's trace level."""
    from ai.modules.data import data_conn as data_conn_mod

    conn = _make_conn()
    pipe = MagicMock(pipeId=7, traceId=3)
    target = MagicMock()
    target.getPipe.return_value = pipe
    conn._server._target = target
    conn._require_target = lambda: target
    conn._pipe_sem = asyncio.Semaphore(2)
    conn._thread_count = 2
    conn._pipe_map = {}
    conn._open_by_correlation = {}
    conn._pipe_timeout = 60
    conn._ensure_pipe_sem = AsyncMock(return_value=conn._pipe_sem)
    conn._determine_lane = lambda mime, p: 'raw'
    conn._warn_on_unconsumed_lane = lambda *a: None
    conn._begin = lambda conn_pipe: None
    conn.build_response = MagicMock(side_effect=lambda request, body=None: body)
    entry = MagicMock(hasSize=False)
    monkeypatch.setattr(data_conn_mod, 'getObject', lambda obj: entry)
    caller = {'userId': 'u1', 'params': {'prompt_1': {'instructions': 'dry'}}, 'traceLevel': 'full'}

    body = await conn._open(
        {'command': 'rrext_process', 'seq': 1, 'arguments': {}},
        {'object': {'name': 'x'}, 'mimeType': 'application/octet-stream', '_caller': dict(caller)},
    )

    assert body == {'pipeId': 7, 'traceId': 3}
    target.getPipe.assert_called_once_with('full')
    assert pipe.caller == caller
    record = conn._pipe_map[7]
    assert record.caller == caller and record.hold_started is not None
    # The Entry never carries the context (nodes copy metadata into stored documents)
    entry.fromDict.assert_not_called()


@pytest.mark.asyncio
async def test_a_borrowed_tool_pipe_carries_the_caller_and_books_its_hold(monkeypatch):
    """A standalone tool call borrows a pipe like an open: caller stamped, hold booked, traceId in the body."""
    conn = _make_conn()
    pipe = MagicMock(pipeId=2, traceId=11)
    param_out = {'answer': 42}

    def invoke(param):
        param.output = param_out

    # The borrowed pipe IS the chain head and the one tool node
    pipe.pipeType.id = 'tool_1'
    pipe.next = None
    pipe.pyInstance.invoke = invoke
    target = MagicMock()
    target.getPipe.return_value = pipe
    conn._server._target = target
    conn._pipe_sem = asyncio.Semaphore(2)
    conn._ensure_pipe_sem = AsyncMock(return_value=conn._pipe_sem)
    conn._emit_tool_trace = lambda *a, **k: None
    conn.build_response = MagicMock(side_effect=lambda request, body=None: body)
    holds = []
    monkeypatch.setattr(
        conn, '_record_hold', lambda started, bytes_in, trace_id=None: holds.append((started, bytes_in, trace_id))
    )
    caller = {'userId': 'u1', 'traceLevel': 'none'}

    body = await conn._tool(
        {'command': 'rrext_process', 'seq': 2, 'arguments': {}},
        {'tool': 'ask', 'nodeId': 'tool_1', 'input': {'q': 1}, '_caller': dict(caller)},
    )

    assert body == {'result': param_out, 'traceId': 11}
    target.getPipe.assert_called_once_with('none')
    assert pipe.caller == caller
    target.putPipe.assert_called_once_with(pipe)
    assert len(holds) == 1 and holds[0][0] is not None and holds[0][1] == 0
    assert holds[0][2] == 11, "the hold is booked into the borrowed tool's own tree"


def test_record_hold_books_the_tree_less_its_queue_wait_and_closes_it(monkeypatch):
    """Occupancy, never contention (P29): the model server's queue wait inside the request comes off the hold;
    the hold and bytes land in the tree's bucket, which is then final.
    """
    from ai.modules.data import data_conn as data_conn_mod

    calls = []
    fake_metrics = MagicMock()
    fake_metrics.trace_timer = lambda trace_id, name: 20.0 if (trace_id, name) == (7, 'gpu_queue_wait') else 0.0
    # The thread was bound to tree 3 before: the restore must put it back
    fake_metrics.set_current_trace = lambda trace_id: (calls.append(('bind', trace_id)), 3)[1]
    fake_metrics.add_time = lambda timers: calls.append(('time', timers))
    fake_metrics.counter = lambda name, value: calls.append(('count', name, value))
    fake_metrics.close_trace = lambda trace_id: calls.append(('close', trace_id))
    fake_metrics.report = lambda: {'timers': {}, 'counters': {}, 'events': [], 'traces': {}}
    monkeypatch.setattr(data_conn_mod, 'metrics', fake_metrics)
    monkeypatch.setattr(data_conn_mod, 'monitorMetrics', lambda report: calls.append(('flush',)))

    # A fixed clock: the hold is exactly 100 ms, 20 ms of it the GPU queue
    monkeypatch.setattr(data_conn_mod.time, 'perf_counter', lambda: 1000.0)
    data_conn_mod.DataConn._record_hold(1000.0 - 0.1, 64, 7)
    kinds = [c[0] for c in calls]
    assert kinds == ['bind', 'time', 'count', 'bind', 'close', 'flush']
    assert calls[0] == ('bind', 7) and calls[3] == ('bind', 3), 'bound to the tree, then the previous tree restored'
    assert calls[1][1]['hold_time'] == pytest.approx(80.0)
    assert calls[2] == ('count', 'bytes_in', 64) and calls[4] == ('close', 7)


# ---------------------------------------------------------------------------
# cancel — flags the engine pipe; the write in flight answers TASK_CANCELLED
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancel_flags_the_pipe_and_keeps_the_binding(monkeypatch):
    """One store on the engine pipe, no removal: the close that follows releases the slot."""
    conn, conn_pipe = _make_text_conn(monkeypatch)

    body = await conn._cancel({}, {'pipeId': 1})

    conn_pipe.pipe.cancel.assert_called_once_with()
    assert conn_pipe.cancelled, 'the record carries the flag for the tool path'
    assert body == {'pipeId': 1, 'cancelled': True}
    assert conn._pipe_map[1] is conn_pipe
    assert conn_pipe.is_open


@pytest.mark.asyncio
async def test_cancel_on_a_slot_that_is_not_open_is_refused(monkeypatch):
    """A slot nobody opened, or one open for another request, never reaches the engine."""
    conn, conn_pipe = _make_text_conn(monkeypatch)

    with pytest.raises(ValueError, match='not found'):
        await conn._cancel({}, {'pipeId': 2})

    conn_pipe.correlation_id = 'req-a'
    with pytest.raises(ValueError, match='another request'):
        await conn._cancel({}, {'pipeId': 1, '_caller': {'correlationId': 'req-b'}})
    conn_pipe.pipe.cancel.assert_not_called()


@pytest.mark.asyncio
async def test_a_write_the_binder_refused_as_cancelled_answers_with_the_cancelled_code(monkeypatch):
    """The binder's Ec.Cancelled arrives as a plain exception with an int code; the frame answers TASK_CANCELLED."""
    from rocketlib import Ec

    from ai.constants import CONST_TASK_CANCELLED_CODE
    from ai.modules.data.data_conn import RequestCancelled

    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn_pipe.lane = 'json'
    refused = Exception('Cancelled: Pipeline request cancelled')
    refused.code = int(Ec.Cancelled)
    conn_pipe.pipe.writeJson.side_effect = refused

    with pytest.raises(RequestCancelled) as err:
        await conn._write({}, {'pipeId': 1, 'data': b'{"k": 1}'})
    assert err.value.code == CONST_TASK_CANCELLED_CODE
    assert conn_pipe.has_failed
    # The binding stays for the close
    assert conn._pipe_map[1] is conn_pipe


@pytest.mark.asyncio
async def test_any_other_write_error_passes_through_unchanged(monkeypatch):
    """Only the binder's Cancelled is re-coded; a node's own error keeps its type."""
    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn_pipe.lane = 'json'
    conn_pipe.pipe.writeJson.side_effect = RuntimeError('node blew up')

    with pytest.raises(RuntimeError, match='node blew up'):
        await conn._write({}, {'pipeId': 1, 'data': b'{"k": 1}'})


# ---------------------------------------------------------------------------
# A text body is written as one text when its pipe closes, so a text request's
# pipeline work runs inside the close frame: the close is what a cancel ends
# and what the request tree's metrics are booked from
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_text_request_refused_as_cancelled_answers_with_the_cancelled_code_at_its_close(monkeypatch):
    """The binder refuses the held text at the close: that frame answers TASK_CANCELLED and the slot is released."""
    from rocketlib import Ec

    from ai.constants import CONST_TASK_CANCELLED_CODE
    from ai.modules.data.data_conn import RequestCancelled

    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn._cleanup_pipe = MagicMock()
    refused = Exception('Cancelled: Pipeline request cancelled')
    refused.code = int(Ec.Cancelled)
    conn_pipe.pipe.writeText.side_effect = refused

    await conn._write({}, {'pipeId': 1, 'data': b'more'})
    conn_pipe.pipe.writeText.assert_not_called()  # held until the close

    with pytest.raises(RequestCancelled) as err:
        await conn._close({}, {'pipeId': 1})
    assert err.value.code == CONST_TASK_CANCELLED_CODE
    assert conn_pipe.has_failed
    assert 1 not in conn._pipe_map and 1 not in conn._closing
    conn._cleanup_pipe.assert_called_once_with(conn_pipe)


@pytest.mark.asyncio
async def test_a_node_error_on_a_text_body_passes_through_its_close_unchanged(monkeypatch):
    """Only the binder's Cancelled is re-coded at the close; a node's own error keeps its type."""
    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn._cleanup_pipe = MagicMock()
    conn_pipe.pipe.writeText.side_effect = RuntimeError('node blew up')

    await conn._write({}, {'pipeId': 1, 'data': b'x'})
    with pytest.raises(RuntimeError, match='node blew up'):
        await conn._close({}, {'pipeId': 1})
    assert 1 not in conn._closing


@pytest.mark.asyncio
async def test_cancel_reaches_a_text_request_while_its_close_runs(monkeypatch):
    """The close took the binding out of the pipe map, and cancel still finds it: the work in flight ends as cancelled."""
    import threading

    from rocketlib import Ec

    from ai.modules.data.data_conn import RequestCancelled

    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn._cleanup_pipe = MagicMock()
    conn_pipe.correlation_id = 'req-a'
    working, flagged = threading.Event(), threading.Event()

    def write_text(_text):
        # The pipeline is working on the body; the binder refuses it at the next node once cancel flagged the pipe
        working.set()
        assert flagged.wait(10), 'cancel never reached the closing binding'
        refused = Exception('Cancelled: Pipeline request cancelled')
        refused.code = int(Ec.Cancelled)
        raise refused

    conn_pipe.pipe.writeText.side_effect = write_text
    conn_pipe.pipe.cancel.side_effect = flagged.set

    await conn._write({}, {'pipeId': 1, 'data': b'summarise this'})
    closing = asyncio.ensure_future(conn._close({}, {'pipeId': 1, '_caller': {'correlationId': 'req-a'}}))
    assert await asyncio.to_thread(working.wait, 10)

    # Only cancel reaches a closing binding, and only for its own request
    with pytest.raises(ValueError, match='not found'):
        await conn._write({}, {'pipeId': 1, 'data': b'late'})
    with pytest.raises(ValueError, match='another request'):
        await conn._cancel({}, {'pipeId': 1, '_caller': {'correlationId': 'req-b'}})
    body = await conn._cancel({}, {'pipeId': 1, '_caller': {'correlationId': 'req-a'}})
    assert body == {'pipeId': 1, 'cancelled': True}

    with pytest.raises(RequestCancelled):
        await closing
    assert 1 not in conn._closing
    with pytest.raises(ValueError, match='not found'):
        await conn._cancel({}, {'pipeId': 1})


@pytest.mark.asyncio
async def test_a_cancel_before_the_close_drops_the_held_text(monkeypatch):
    """A request cancelled while its body was still held never reaches the pipeline; the close releases the slot as usual."""
    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn._cleanup_pipe = MagicMock()

    await conn._write({}, {'pipeId': 1, 'data': b'never mind'})
    await conn._cancel({}, {'pipeId': 1})
    body = await conn._close({}, {'pipeId': 1})

    conn_pipe.pipe.writeText.assert_not_called()
    conn_pipe.pipe.close.assert_called_once_with()
    assert body['objectId'] == 'obj-1'


@pytest.mark.asyncio
async def test_a_text_body_is_written_bound_to_its_request_tree(monkeypatch):
    """The held text runs the pipeline at the close: its metrics land in the request tree's bucket (plan 8.1)."""
    from ai.modules.data import data_conn as data_conn_mod

    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn._cleanup_pipe = MagicMock()
    conn_pipe.trace_id = 7
    bound = [None]
    fake_metrics = MagicMock()

    def set_current_trace(trace_id):
        previous, bound[0] = bound[0], trace_id
        return previous

    fake_metrics.set_current_trace = set_current_trace
    monkeypatch.setattr(data_conn_mod, 'metrics', fake_metrics)
    seen = []
    conn_pipe.pipe.writeText.side_effect = lambda _text: seen.append(bound[0])

    await conn._write({}, {'pipeId': 1, 'data': b'count me'})
    await conn._close({}, {'pipeId': 1})

    assert seen == [7], 'the text was written while the thread was bound to tree 7'
    assert bound[0] is None, 'the previous binding is restored'


@pytest.mark.asyncio
async def test_a_cancelled_json_write_keeps_the_cancelled_code(monkeypatch):
    """The json lane converts only its parse to ValueError: the binder's Cancelled from the write keeps its code."""
    from rocketlib import Ec

    from ai.modules.data.data_conn import RequestCancelled

    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn_pipe.lane = 'json'
    refused = Exception('Cancelled: Pipeline request cancelled')
    refused.code = int(Ec.Cancelled)
    conn_pipe.pipe.writeJson.side_effect = refused

    with pytest.raises(RequestCancelled):
        await conn._write({}, {'pipeId': 1, 'data': b'{"k": 1}'})
    # A parse failure is still the lane's ValueError
    conn_pipe.has_failed = False
    with pytest.raises(ValueError):
        await conn._write({}, {'pipeId': 1, 'data': b'not json'})


@pytest.mark.asyncio
async def test_close_still_closes_the_pipe_when_end_is_refused(monkeypatch):
    """After a cancel the END lane write is refused; pipe.close() must still run so the slot is released."""
    from rocketlib import Ec

    conn, conn_pipe = _make_text_conn(monkeypatch)
    conn_pipe.lane = 'audio'
    refused = Exception('Cancelled: Pipeline request cancelled')
    refused.code = int(Ec.Cancelled)
    conn_pipe.pipe.writeAudio.side_effect = refused

    body = await conn._close({}, {'pipeId': 1})

    conn_pipe.pipe.close.assert_called_once_with()
    assert conn_pipe.has_failed
    assert body['objectId'] == 'obj-1'
    assert 1 not in conn._pipe_map


@pytest.mark.asyncio
async def test_a_cancelled_pipe_refuses_a_tool_dispatch_before_any_candidate_runs(monkeypatch):
    """Tool functions are invoked directly, without the binder: the dispatch reads the record's flag itself."""
    from ai.modules.data.data_conn import DataConnPipe, RequestCancelled

    conn = _make_conn()
    pipe = MagicMock(pipeId=1, traceId=11)
    pipe.pipeType.id = 'tool_1'
    pipe.next = None
    pipe.pyInstance.invoke = MagicMock(side_effect=AssertionError('a cancelled request must not run a tool'))
    conn._emit_tool_trace = lambda *a, **k: None
    conn.build_response = MagicMock(side_effect=lambda request, body=None: body)
    conn._pipe_map = {1: DataConnPipe(pipe_id=1, pipe=pipe, is_open=True, cancelled=True)}

    with pytest.raises(RequestCancelled):
        await conn._tool(
            {'command': 'rrext_process', 'seq': 2, 'arguments': {}},
            {'tool': 'ask', 'nodeId': 'tool_1', 'input': {}, 'pipeId': 1, '_caller': {'userId': 'u1'}},
        )
    pipe.pyInstance.invoke.assert_not_called()
