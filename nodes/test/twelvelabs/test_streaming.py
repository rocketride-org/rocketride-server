# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Regression test: twelvelabs streams incoming video straight to a temp file
instead of buffering the whole video in a Python list first.

``IInstance`` is driven directly through its ``writeVideo`` AVI callbacks,
bypassing the engine entirely. ``twelvelabs_driver.process_video`` is
monkeypatched so the test never calls the real TwelveLabs API.
"""

import os
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from rocketlib import AVI_ACTION

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from twelvelabs.IInstance import IInstance  # noqa: E402


class _Capture:
    """Stand-in for the engine binding (``self.instance``)."""

    def __init__(self, listeners=('text',)):
        self.texts = []
        self._listeners = listeners

    def hasListener(self, lane):  # noqa: N802 (engine method name)
        return lane in self._listeners

    def writeText(self, text):  # noqa: N802 (engine method name)
        self.texts.append(text)


def _instance(monkeypatch, *, response='fake response', listeners=('text',)):
    """A twelvelabs node wired to a fake driver that records every call."""
    import twelvelabs.twelvelabs_driver as driver_module

    calls = []

    def _fake_process_video(api_key, video_path, instructions):
        # Read the file now, while it still exists, to prove the bytes already
        # landed on disk at submission time (not held only in a Python list).
        with open(video_path, 'rb') as f:
            data = f.read()
        calls.append({'api_key': api_key, 'path': video_path, 'instructions': instructions, 'data': data})
        return response

    monkeypatch.setattr(driver_module, 'process_video', _fake_process_video)

    inst = IInstance()
    inst.beginInstance()
    inst.instance = _Capture(listeners)
    inst.IGlobal = SimpleNamespace(api_key='fake-key', instructions=['Describe this video.'])
    inst.driver_calls = calls
    return inst


def test_video_is_streamed_to_disk_not_buffered_in_a_list(monkeypatch):
    """The fix: chunks land on disk as they arrive, not in an in-memory list."""
    inst = _instance(monkeypatch)

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    # A small chunk would pass even with the old in-memory-list bug, since
    # it never gets flushed to disk either way - it has to clear the file
    # object's own write buffer to prove anything. 2 MB reliably does.
    big_chunk = b'x' * (2 * 1024 * 1024)
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', big_chunk)
    assert os.path.getsize(inst._tmp_path) >= len(big_chunk), 'bytes should already be on disk before END'
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'chunk-two')
    inst.writeVideo(AVI_ACTION.END, 'video/mp4', b'')

    assert inst.driver_calls[0]['data'] == big_chunk + b'chunk-two'
    assert inst.instance.texts == ['fake response']


def test_temp_file_is_deleted_after_submission(monkeypatch):
    inst = _instance(monkeypatch)

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'data')
    inst.writeVideo(AVI_ACTION.END, 'video/mp4', b'')

    tmp_path = inst.driver_calls[0]['path']
    assert not os.path.exists(tmp_path), 'temp file must be deleted after submission'


def test_empty_response_falls_back_to_placeholder_text(monkeypatch):
    inst = _instance(monkeypatch, response='')

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'data')
    inst.writeVideo(AVI_ACTION.END, 'video/mp4', b'')

    assert inst.instance.texts == ['No data from TwelveLabs']


def test_no_listener_skips_writing_text(monkeypatch):
    inst = _instance(monkeypatch, listeners=())

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'data')
    inst.writeVideo(AVI_ACTION.END, 'video/mp4', b'')

    assert inst.instance.texts == []


def test_a_fresh_begin_discards_a_dangling_stream(monkeypatch):
    """BEGIN with no prior END (a displaced stream) must not leak a temp file."""
    inst = _instance(monkeypatch)

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'orphaned-data')
    first_tmp = inst._tmp_path
    assert os.path.exists(first_tmp)

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')  # displaced, no END arrived
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'second-stream')
    inst.writeVideo(AVI_ACTION.END, 'video/mp4', b'')

    assert not os.path.exists(first_tmp), "the orphaned first stream's temp file must be cleaned up"
    assert inst.driver_calls[0]['data'] == b'second-stream'


def test_closing_releases_a_stream_that_never_got_an_end(monkeypatch):
    """``closing()`` is the last chance to release a held resource (IInstanceBase contract)."""
    inst = _instance(monkeypatch)

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'never-finishes')
    tmp_path = inst._tmp_path
    assert os.path.exists(tmp_path)

    inst.closing()

    assert not os.path.exists(tmp_path)
    assert inst.driver_calls == []  # never submitted


def test_a_driver_error_propagates_and_still_deletes_the_temp_file(monkeypatch):
    """The README promises cleanup even when process_video fails - nothing pinned that before."""
    inst = _instance(monkeypatch)

    import twelvelabs.twelvelabs_driver as driver_module

    def _raise(api_key, video_path, instructions):
        raise RuntimeError('boom')

    monkeypatch.setattr(driver_module, 'process_video', _raise)

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'data')
    tmp_path = inst._tmp_path

    with pytest.raises(RuntimeError, match='boom'):
        inst.writeVideo(AVI_ACTION.END, 'video/mp4', b'')

    assert not os.path.exists(tmp_path), 'temp file must be deleted even when the driver call fails'
