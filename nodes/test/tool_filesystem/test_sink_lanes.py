# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Lane-handler tests for the tool_filesystem sink."""

from __future__ import annotations

from unittest.mock import MagicMock

from test_sink_naming import _fs, _sink_instance


def test_write_documents_persists_and_emits():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt')
    inst.instance.getListeners = MagicMock(return_value={'documents'})
    doc = MagicMock(page_content='hello', metadata=MagicMock())
    inst.writeDocuments([doc])
    fs.write.assert_awaited_once()
    inst.instance.writeDocuments.assert_called_once()
    (emitted,), _ = inst.instance.writeDocuments.call_args
    assert emitted and emitted[0].page_content == 'output/a.txt'
    # Regression: metadata must be built explicitly (a fresh Doc's metadata is None).
    assert emitted[0].metadata is not None and emitted[0].metadata.parent == 'output/a.txt'


def test_write_documents_persists_without_listener():
    fs = _fs()
    inst = _sink_instance(fs, name='a.txt')
    inst.instance.getListeners = MagicMock(return_value=set())
    doc = MagicMock(page_content='hello', metadata=MagicMock())
    inst.writeDocuments([doc])
    fs.write.assert_awaited_once()  # still persisted
    inst.instance.writeDocuments.assert_not_called()  # nothing to emit to


def test_write_text_persists_md():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='t1')
    inst.instance.getListeners = MagicMock(return_value={'documents'})
    inst.writeText('some text')
    (path_arg, data_arg), _ = fs.write.await_args
    assert path_arg == 'output/t1.md' and data_arg == b'some text'


def test_write_table_persists_md():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='t2')
    inst.instance.getListeners = MagicMock(return_value={'documents'})
    inst.writeTable('| a | b |')
    (path_arg, _data), _ = fs.write.await_args
    assert path_arg == 'output/t2.md'


def test_write_image_accumulates_and_persists_on_end():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='img1')
    inst.instance.getListeners = MagicMock(return_value={'documents'})
    from rocketlib import AVI_ACTION

    inst.writeImage(AVI_ACTION.BEGIN, 'image/png', b'')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'\x89PNG')
    inst.writeImage(AVI_ACTION.WRITE, 'image/png', b'rest')
    fs.write.assert_not_awaited()  # nothing written until END
    inst.writeImage(AVI_ACTION.END, 'image/png', b'')
    (path_arg, data_arg), _ = fs.write.await_args
    assert path_arg == 'output/img1.png' and data_arg == b'\x89PNGrest'


def test_write_audio_uses_mime_extension():
    fs = _fs()
    inst = _sink_instance(fs, has_name=False, object_id='a1')
    inst.instance.getListeners = MagicMock(return_value=set())
    from rocketlib import AVI_ACTION

    inst.writeAudio(AVI_ACTION.BEGIN, 'audio/wav', b'')
    inst.writeAudio(AVI_ACTION.WRITE, 'audio/wav', b'RIFF')
    inst.writeAudio(AVI_ACTION.END, 'audio/wav', b'')
    (path_arg, data_arg), _ = fs.write.await_args
    assert data_arg == b'RIFF'
    assert path_arg == 'output/a1.wav'
