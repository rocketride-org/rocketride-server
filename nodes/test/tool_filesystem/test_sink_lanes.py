# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Lane-handler tests for the tool_filesystem sink."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from test_sink_naming import _fs, _sink_instance


# ---------------------------------------------------------------------------
# documents lane
# ---------------------------------------------------------------------------


def test_documents_lane_stores_txt_even_for_named_object():
    # page_content is parsed text, so a parsed report.pdf stores as report.txt.
    fs = _fs()
    inst = _sink_instance(fs, name='report.pdf', object_id='obj-123')
    inst.writeDocuments([MagicMock(page_content='parsed text')])
    (path_arg, data_arg), _ = fs.write.await_args
    assert path_arg == 'output/report.txt' and data_arg == b'parsed text'


def test_documents_nameless_uses_object_id_txt():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='d7')
    inst.writeDocuments([MagicMock(page_content='x')])
    (path_arg, _d), _ = fs.write.await_args
    assert path_arg == 'output/d7.txt'


def test_documents_multi_doc_emits_one_json_ref_per_file():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', object_id='obj-x')
    result = inst.writeDocuments([MagicMock(page_content='one'), MagicMock(page_content='two')])
    assert result == 'PREVENT_DEFAULT'
    paths = [c.args[0] for c in fs.write.await_args_list]
    assert paths == ['output/a_0.txt', 'output/a_1.txt']
    payloads = [c.args[0] for c in inst.instance.writeJson.call_args_list]
    assert payloads == [{'path': 'output/a_0.txt'}, {'path': 'output/a_1.txt'}]


def test_documents_single_doc_has_no_index_suffix():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', object_id='obj-x')
    inst.writeDocuments([MagicMock(page_content='only')])
    (path_arg, _d), _ = fs.write.await_args
    assert path_arg == 'output/a.txt'


def test_documents_persists_without_listener_but_does_not_emit():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', listeners=())
    inst.writeDocuments([MagicMock(page_content='hello')])
    fs.write.assert_awaited_once()  # still persisted
    inst.instance.writeJson.assert_not_called()  # nothing to emit to


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
    assert path_arg == 'output/report.md' and data_arg == b'# heading'


def test_table_lane_forces_md_even_for_named_object():
    fs = _fs()
    inst = _sink_instance(fs, name='sheet.xlsx', object_id='obj-7')
    result = inst.writeTable('| a | b |')
    assert result == 'PREVENT_DEFAULT'
    (path_arg, _d), _ = fs.write.await_args
    assert path_arg == 'output/sheet.md'


def test_text_lane_nameless_uses_object_id():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='t1')
    inst.writeText('some text')
    (path_arg, data_arg), _ = fs.write.await_args
    assert path_arg == 'output/t1.md' and data_arg == b'some text'


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
    assert stream['path'] == 'output/img1.png'
    assert b''.join(stream['chunks']) == b'\x89PNGrest'
    (payload,), _ = inst.instance.writeJson.call_args
    assert payload == {'path': 'output/img1.png'}


def test_audio_uses_mime_extension():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='a1')
    from rocketlib import AVI_ACTION

    inst.writeAudio(AVI_ACTION.BEGIN, 'audio/wav', b'')
    inst.writeAudio(AVI_ACTION.WRITE, 'audio/wav', b'RIFF')
    inst.writeAudio(AVI_ACTION.END, 'audio/wav', b'')
    ((_handle, stream),) = fs.streams.items()
    assert stream['path'] == 'output/a1.wav'
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
    assert stream['path'] == 'output/v1.mp4'
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
    inst.instance.writeJson.assert_not_called()


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


def test_open_discards_stream_the_previous_object_left_unfinished():
    fs = _fs()
    inst = _sink_instance(fs, name='track.wav', object_id='a1')
    from rocketlib import AVI_ACTION

    inst.writeAudio(AVI_ACTION.BEGIN, 'audio/wav', b'')
    inst.writeAudio(AVI_ACTION.WRITE, 'audio/wav', b'RIFF')  # aborted: no END
    inst.open(MagicMock())  # engine opens the next object
    fs.close_write.assert_awaited_once()  # stale handle released
    fs.delete.assert_awaited_once_with('output/track.wav')  # partial removed
    inst.instance.writeJson.assert_not_called()


def test_closing_discards_a_stream_no_later_object_would_sweep():
    """The last object of a run gets no following open(), so closing() is the only sweep."""
    fs = _fs()
    inst = _sink_instance(fs, name='track.wav', object_id='a9')
    from rocketlib import AVI_ACTION

    inst.writeAudio(AVI_ACTION.BEGIN, 'audio/wav', b'')
    inst.writeAudio(AVI_ACTION.WRITE, 'audio/wav', b'RIFF')  # cut off: no END
    inst.closing()
    fs.close_write.assert_awaited_once()
    fs.delete.assert_awaited_once_with('output/track.wav')
    inst.instance.writeJson.assert_not_called()  # nothing was completed, so nothing is claimed


def test_closing_removes_the_staging_file_not_the_operators_own():
    """Under overwrite the destination must survive a run that ended mid-stream."""
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='o9', on_conflict='overwrite')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'\x89PNG')
    inst.closing()
    # once, and with the staging path: the destination is never a delete target
    fs.delete.assert_awaited_once_with('output/o9.png.part-o9')


def test_closing_without_any_stream_is_a_noop():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt')
    inst.closing()
    fs.close_write.assert_not_awaited()
    fs.delete.assert_not_awaited()


def test_open_does_not_leak_state_between_objects():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt', object_id='obj-a')
    inst.writeText('one')
    inst.open(MagicMock())  # engine opens the next object
    inst.writeText('two')
    payloads = [c.args[0]['path'] for c in inst.instance.writeJson.call_args_list]
    # _fs() reports no existing paths, so both writes resolve the same name.
    assert payloads == ['output/a.md', 'output/a.md']


def test_media_blank_mime_falls_back_to_source_extension():
    fs = _fs()
    inst = _sink_instance(fs, name='clip.mov', object_id='v9')
    from rocketlib import AVI_ACTION

    inst.writeVideo(AVI_ACTION.BEGIN, '', b'')
    inst.writeVideo(AVI_ACTION.WRITE, '', b'ftyp')
    inst.writeVideo(AVI_ACTION.END, '', b'')
    ((_handle, stream),) = fs.streams.items()
    assert stream['path'] == 'output/clip.mov'


def test_media_unmappable_mime_nameless_falls_back_to_bin():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='v1')
    from rocketlib import AVI_ACTION

    mime = 'application/vnd.acme.report'
    inst.writeVideo(AVI_ACTION.BEGIN, mime, b'')
    inst.writeVideo(AVI_ACTION.WRITE, mime, b'x')
    inst.writeVideo(AVI_ACTION.END, mime, b'')
    ((_handle, stream),) = fs.streams.items()
    assert stream['path'] == 'output/v1.bin'


def test_named_source_with_conflicting_mime_mime_wins():
    fs = _fs()
    # Source named photo.jpg but the stream is declared image/png: the stored
    # extension must match the actual bytes, not the stale source name.
    inst = _sink_instance(fs, name='photo.jpg', object_id='p1')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'\x89PNG')
    inst.writeImage(AVI_ACTION.END, 'image/png', b'')
    ((_handle, stream),) = fs.streams.items()
    assert stream['path'] == 'output/photo.png'


# ---------------------------------------------------------------------------
# emitUrl end to end
# ---------------------------------------------------------------------------


def test_emit_url_lands_in_json_payload():
    fs = _fs()
    inst = _sink_instance(fs, name='report.pdf', object_id='obj-1', emit_url=True)
    inst.writeText('# heading')
    (payload,), _ = inst.instance.writeJson.call_args
    assert payload == {'path': 'output/report.md', 'url': 'https://x/task/fetch?token=t'}


def test_no_url_key_when_emit_url_off():
    fs = _fs()
    inst = _sink_instance(fs, name='report.pdf', object_id='obj-1', emit_url=False)
    inst.writeText('# heading')
    (payload,), _ = inst.instance.writeJson.call_args
    assert 'url' not in payload


def test_media_stream_ops_share_one_live_event_loop():
    # aiofiles write handles bind to the loop that opened them: open_write,
    # every write_chunk, and close_write MUST run on the same still-running
    # loop, or the real store raises 'Event loop is closed' mid-stream and
    # leaves a 0-byte file (live bug: image drop via parse -> filestore).
    import asyncio

    fs = _fs()
    seen = []

    async def _open_write(path):
        seen.append(('open', asyncio.get_running_loop()))
        fs.streams['h1'] = {'path': path, 'chunks': []}
        return 'h1'

    async def _write_chunk(handle, data):
        seen.append(('chunk', asyncio.get_running_loop()))
        fs.streams[handle]['chunks'].append(bytes(data))
        return len(data)

    async def _close_write(handle):
        seen.append(('close', asyncio.get_running_loop()))
        return None

    fs.open_write.side_effect = _open_write
    fs.write_chunk.side_effect = _write_chunk
    fs.close_write.side_effect = _close_write

    inst = _sink_instance(fs, has_name=False, object_id='loop1')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'\x89PNG')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'\xde\xad')
    inst.writeImage(AVI_ACTION.END, 'image/png', b'')

    loops = {loop for _op, loop in seen}
    assert len(seen) == 4  # open, chunk, chunk, close
    assert len(loops) == 1, f'handle ops crossed {len(loops)} loops: {[op for op, _ in seen]}'
    assert all(not loop.is_closed() for loop in loops)


def test_abort_deletes_partial_even_when_close_fails():
    # A failed close on an aborted stream must not strand the partial file.
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='s2')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'partial')
    fs.close_write.side_effect = RuntimeError('close boom')
    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')  # abort path
    fs.delete.assert_awaited_once_with('output/s2.png')


def test_end_close_failure_deletes_partial_and_raises():
    # On END, a failed commit leaves an incomplete file: delete it, propagate
    # the error (engine marks the object failed), and emit no reference.
    import pytest

    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='s3')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'partial')
    fs.close_write.side_effect = RuntimeError('close boom')
    with pytest.raises(RuntimeError, match='close boom'):
        inst.writeImage(AVI_ACTION.END, 'image/png', b'')
    fs.delete.assert_awaited_once_with('output/s3.png')
    inst.instance.writeJson.assert_not_called()


# ---------------------------------------------------------------------------
# overwrite stages the stream and swaps it in only when it is complete
#
# open_write is itself destructive, so writing straight to the destination would leave a
# failed stream's file neither old nor new.
# ---------------------------------------------------------------------------


def test_overwrite_streams_to_a_sibling_and_renames_on_success():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='o1', on_conflict='overwrite')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'bytes')
    inst.writeImage(AVI_ACTION.END, 'image/png', b'')

    (opened,), _ = fs.open_write.await_args
    assert opened == 'output/o1.png.part-o1', 'the destination must not be opened directly'
    (src, dst), kwargs = fs.rename.await_args
    assert (src, dst) == ('output/o1.png.part-o1', 'output/o1.png') and kwargs == {'overwrite': True}


def test_overwrite_leaves_the_destination_alone_when_the_stream_fails():
    """The whole point: a failed replacement must not damage what was already there."""
    fs = _fs()
    fs.close_write.side_effect = RuntimeError('commit failed')
    inst = _sink_instance(fs, has_name=False, object_id='o2', on_conflict='overwrite')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'bytes')
    with pytest.raises(RuntimeError, match='commit failed'):
        inst.writeImage(AVI_ACTION.END, 'image/png', b'')

    fs.rename.assert_not_awaited()  # nothing was swapped in
    (deleted,), _ = fs.delete.await_args
    assert deleted == 'output/o2.png.part-o2', 'only the staging file may be removed'


def test_overwrite_abort_removes_only_the_staging_file():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='o3', on_conflict='overwrite')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'partial')
    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')  # abort the first stream

    (deleted,), _ = fs.delete.await_args
    assert deleted == 'output/o3.png.part-o3'
    fs.rename.assert_not_awaited()


def test_unique_writes_straight_to_the_destination():
    """No staging where the path was probed free — there is nothing to protect."""
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='o4')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'bytes')
    inst.writeImage(AVI_ACTION.END, 'image/png', b'')

    (opened,), _ = fs.open_write.await_args
    assert opened == 'output/o4.png'
    fs.rename.assert_not_awaited()


def test_unique_abort_still_deletes_its_own_partial():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='o5')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'partial')
    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')

    (deleted,), _ = fs.delete.await_args
    assert deleted == 'output/o5.png'


def test_whitelist_rejecting_the_sibling_falls_back_to_writing_in_place():
    """A tight whitelist must not fail a pipeline that worked before staging existed."""
    import re

    fs = _fs()
    inst = _sink_instance(
        fs,
        has_name=False,
        object_id='o6',
        on_conflict='overwrite',
        path_patterns=[re.compile(r'^output/o6\.png$')],
    )
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'bytes')
    inst.writeImage(AVI_ACTION.END, 'image/png', b'')

    (opened,), _ = fs.open_write.await_args
    assert opened == 'output/o6.png'
    fs.rename.assert_not_awaited()


def test_chunk_write_failure_discards_the_stream():
    """A failed chunk must not leave the handle open and the file behind."""
    fs = _fs()
    fs.write_chunk.side_effect = RuntimeError('chunk failed')
    order = []
    for name in ('close_write', 'delete'):
        getattr(fs, name).side_effect = (lambda n: lambda *a, **k: order.append((n, a)))(name)
    inst = _sink_instance(fs, has_name=False, object_id='o7')
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    with pytest.raises(RuntimeError, match='chunk failed'):
        inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'bytes')

    # Order matters, not just occurrence: FileStore.delete refuses a path whose write handle
    # is still open, so a cleanup that deleted before closing would fail against a real store
    # while passing against mocks that accept either.
    assert [c[0] for c in order] == ['close_write', 'delete'], order
    (deleted,), _ = fs.delete.await_args
    assert deleted == 'output/o7.png'
    assert not inst._media_streams.get('image'), 'the stream must not stay pending'


def test_failed_cleanup_is_reported_not_swallowed():
    """An undeletable leftover must at least be named, or it is only found by hand."""
    import tool_filesystem.IInstance as mod

    fs = _fs()
    fs.close_write.side_effect = RuntimeError('close failed')
    fs.delete.side_effect = RuntimeError('still open')
    inst = _sink_instance(fs, has_name=False, object_id='o8', on_conflict='overwrite')
    from rocketlib import AVI_ACTION

    said = []
    original = mod.warning
    mod.warning = lambda msg: said.append(msg)
    try:
        inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
        inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'bytes')
        with pytest.raises(RuntimeError, match='close failed'):
            inst.writeImage(AVI_ACTION.END, 'image/png', b'')
    finally:
        mod.warning = original

    (attempted,), _ = fs.delete.await_args
    assert attempted == 'output/o8.png.part-o8', 'the staging path is what cleanup must try to remove'
    assert any('o8.png.part-o8' in m for m in said), f'the leftover path must be named: {said}'
