# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Lane-handler tests for the tool_filesystem sink."""

from __future__ import annotations

from unittest.mock import MagicMock

from test_sink_naming import _fs, _sink_instance


# ---------------------------------------------------------------------------
# documents lane
# ---------------------------------------------------------------------------


def test_documents_lane_keeps_source_extension():
    fs = _fs()
    inst = _sink_instance(fs, name='report.pdf', object_id='obj-123')
    inst.writeDocuments([MagicMock(page_content='bytes')])
    (path_arg, data_arg), _ = fs.write.await_args
    assert path_arg == 'output/obj-123/report.pdf' and data_arg == b'bytes'


def test_documents_multi_doc_index_disambiguates_and_chunkids_increment():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', object_id='obj-x')
    result = inst.writeDocuments([MagicMock(page_content='one'), MagicMock(page_content='two')])
    assert result == 'PREVENT_DEFAULT'
    paths = [c.args[0] for c in fs.write.await_args_list]
    assert paths == ['output/obj-x/a_0.txt', 'output/obj-x/a_1.txt']
    (emitted,), _ = inst.instance.writeDocuments.call_args
    assert [d.page_content for d in emitted] == ['output/obj-x/a_0.txt', 'output/obj-x/a_1.txt']
    # Distinct chunkIds so vector stores keyed on (objectId, chunkId) don't overwrite.
    assert [d.metadata.chunkId for d in emitted] == [0, 1]
    assert all(d.metadata.objectId == 'obj-x' for d in emitted)
    assert emitted[0].metadata.parent == 'output/obj-x/a_0.txt'


def test_documents_single_doc_has_no_index_suffix():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', object_id='obj-x')
    inst.writeDocuments([MagicMock(page_content='only')])
    (path_arg, _d), _ = fs.write.await_args
    assert path_arg == 'output/obj-x/a.txt'


def test_documents_persists_without_listener_but_does_not_emit():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', listeners=())
    inst.writeDocuments([MagicMock(page_content='hello')])
    fs.write.assert_awaited_once()  # still persisted
    inst.instance.writeDocuments.assert_not_called()  # nothing to emit to


# ---------------------------------------------------------------------------
# text / table lanes — content is markdown, so .md wins over the source ext
# ---------------------------------------------------------------------------


def test_text_lane_forces_md_even_for_named_object():
    # A report.pdf routed through the TEXT lane must be saved as .md because the
    # content is now markdown. The old code let the source .pdf extension win.
    fs = _fs()
    inst = _sink_instance(fs, name='report.pdf', object_id='obj-123')
    result = inst.writeText('# heading')
    assert result == 'PREVENT_DEFAULT'
    (path_arg, data_arg), _ = fs.write.await_args
    assert path_arg == 'output/obj-123/report.md' and data_arg == b'# heading'


def test_table_lane_forces_md_even_for_named_object():
    fs = _fs()
    inst = _sink_instance(fs, name='sheet.xlsx', object_id='obj-7')
    result = inst.writeTable('| a | b |')
    assert result == 'PREVENT_DEFAULT'
    (path_arg, _d), _ = fs.write.await_args
    assert path_arg == 'output/obj-7/sheet.md'


def test_text_lane_nameless_uses_object_id():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='t1')
    inst.writeText('some text')
    (path_arg, data_arg), _ = fs.write.await_args
    assert path_arg == 'output/t1/t1.md' and data_arg == b'some text'


# ---------------------------------------------------------------------------
# media lanes — streamed to the store, extension from mime
# ---------------------------------------------------------------------------


def test_image_streams_to_store_and_emits_on_end():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='img1')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'\x89PNG')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'rest')
    fs.open_write.assert_awaited_once()  # opened lazily on first non-empty chunk
    fs.write.assert_not_awaited()  # streamed, never one-shot
    result = inst.writeImage(AVI_ACTION.END, 'image/png', b'')
    assert result == 'PREVENT_DEFAULT'
    fs.close_write.assert_awaited_once()
    ((_handle, stream),) = fs.streams.items()
    assert stream['path'] == 'output/img1/img1.png'
    assert b''.join(stream['chunks']) == b'\x89PNGrest'
    (emitted,), _ = inst.instance.writeDocuments.call_args
    assert emitted[0].page_content == 'output/img1/img1.png'


def test_audio_uses_mime_extension():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='a1')
    from rocketlib import AVI_ACTION

    inst.writeAudio(AVI_ACTION.BEGIN, 'audio/wav', b'')
    inst.writeAudio(AVI_ACTION.WRITE, 'audio/wav', b'RIFF')
    inst.writeAudio(AVI_ACTION.END, 'audio/wav', b'')
    ((_handle, stream),) = fs.streams.items()
    assert stream['path'] == 'output/a1/a1.wav'
    assert b''.join(stream['chunks']) == b'RIFF'


def test_video_streams_with_mime_extension():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='v1')
    from rocketlib import AVI_ACTION

    inst.writeVideo(AVI_ACTION.BEGIN, 'video/mp4', b'')
    inst.writeVideo(AVI_ACTION.WRITE, 'video/mp4', b'ftyp')
    result = inst.writeVideo(AVI_ACTION.END, 'video/mp4', b'')
    assert result == 'PREVENT_DEFAULT'
    ((_handle, stream),) = fs.streams.items()
    assert stream['path'] == 'output/v1/v1.mp4'
    assert b''.join(stream['chunks']) == b'ftyp'


def test_empty_media_stream_writes_no_file():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='e1')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'')  # empty chunk
    inst.writeImage(AVI_ACTION.END, 'image/png', b'')
    fs.open_write.assert_not_awaited()  # nothing was ever opened
    fs.close_write.assert_not_awaited()
    inst.instance.writeDocuments.assert_not_called()


def test_new_begin_discards_half_written_prior_stream():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='s1')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'partial')
    # A fresh BEGIN before END must discard the aborted stream and its file.
    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    fs.close_write.assert_awaited()  # stale handle committed/closed
    fs.delete.assert_awaited()  # partial file removed
