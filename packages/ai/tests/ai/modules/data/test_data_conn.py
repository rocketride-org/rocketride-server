"""
Unit tests for ai.modules.data.data_conn.DataConn — pure-logic methods.

DataConn handles per-pipe DAP data flow. The async I/O paths (open / write
/ close / disconnect, _monitor_pipes) require deep mock infrastructure;
this test file focuses on the pure-logic and small-state methods:

- ``_determine_lane`` — MIME-type → lane router
- ``_begin`` / ``_end`` — per-lane framing dispatchers
- ``_reset_pipe_activity`` — timestamp setter
- ``_cleanup_pipe`` — pipe lifecycle finaliser (with monitoring side effects)
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from ai.modules.data.data_conn import DataConn


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_conn():
    """Build a DataConn instance with __init__ bypassed."""
    conn = DataConn.__new__(DataConn)
    conn._target = MagicMock()
    conn.debug_message = MagicMock()
    return conn


def _make_pipe_with_listeners(listeners):
    """Build a fake IServiceFilterPipe whose getListeners() returns the supplied set."""
    pipe = MagicMock()
    pipe.getListeners = MagicMock(return_value=set(listeners))
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
# _begin / _end — per-lane framing dispatch
# ---------------------------------------------------------------------------


def _make_pipe_conn(lane, mime_type='text/plain'):
    """Build a DataConnPipe stand-in with the bare attributes _begin/_end use."""
    pipe = MagicMock()
    return SimpleNamespace(pipe=pipe, lane=lane, mime_type=mime_type)


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
        pipe=None,
        pipe_id='p-1',
        size=None,
        written=0,
        has_failed=False,
        entry=None,
    )
    conn._cleanup_pipe(pipe_conn)
    conn._target.putPipe.assert_not_called()
