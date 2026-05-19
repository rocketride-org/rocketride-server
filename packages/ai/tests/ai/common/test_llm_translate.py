# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Per-provider-shape attachment translator tests (TDD §7.2, §7.3)."""

import base64
from unittest.mock import MagicMock

import pytest

from ai.common.schema import Attachment
from ai.common.llm_translate import translate_openai_shape, AttachmentDropReport


def _att(mime: str, name: str = 'x', size: int = 10) -> Attachment:
    return Attachment(
        attachment_id='11111111-1111-1111-1111-111111111111',
        mime=mime,
        filename=name,
        size_bytes=size,
        path=f'.chats/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/11111111-1111-1111-1111-111111111111.{name}',
    )


def _file_store(by_path):
    fs = MagicMock()
    fs.read_bytes.side_effect = lambda p: by_path[p]
    return fs


class TestOpenAIShape:
    def test_image_becomes_image_url_block(self):
        att = _att('image/png')
        fs = _file_store({att.path: b'\x89PNG\r\n'})
        blocks, dropped = translate_openai_shape('describe', [att], fs, 'openai')
        assert blocks[-1] == {'type': 'text', 'text': 'describe'}
        assert blocks[0]['type'] == 'image_url'
        assert blocks[0]['image_url']['url'].startswith('data:image/png;base64,')
        decoded = base64.b64decode(blocks[0]['image_url']['url'].split(',', 1)[1])
        assert decoded == b'\x89PNG\r\n'
        assert dropped == []

    def test_pdf_becomes_file_block(self):
        att = _att('application/pdf', name='r.pdf')
        fs = _file_store({att.path: b'%PDF-1.7'})
        blocks, dropped = translate_openai_shape('text', [att], fs, 'openai')
        assert any(b.get('type') == 'file' for b in blocks)
        assert dropped == []

    def test_audio_becomes_input_audio_block(self):
        att = _att('audio/mpeg', name='clip.mp3')
        fs = _file_store({att.path: b'ID3'})
        blocks, dropped = translate_openai_shape('text', [att], fs, 'openai')
        ia = next(b for b in blocks if b.get('type') == 'input_audio')
        assert ia['input_audio']['format'] == 'mp3'
        assert dropped == []

    def test_video_falls_through_drop_and_warn(self):
        att = _att('video/mp4', name='clip.mp4')
        fs = _file_store({att.path: b'\x00\x00\x00\x18ftypmp42'})
        blocks, dropped = translate_openai_shape('text', [att], fs, 'openai')
        assert all(b.get('type') != 'video' for b in blocks)
        assert dropped == [AttachmentDropReport(provider='openai', mime='video/mp4', reason='unsupported')]

    def test_text_only_emits_single_text_block(self):
        blocks, dropped = translate_openai_shape('hello', [], _file_store({}), 'openai')
        assert blocks == [{'type': 'text', 'text': 'hello'}]
        assert dropped == []

    def test_file_store_read_failure_raises(self):
        att = _att('image/png')
        fs = MagicMock()
        fs.read_bytes.side_effect = FileNotFoundError(att.path)
        with pytest.raises(FileNotFoundError):
            translate_openai_shape('text', [att], fs, 'openai')


def test_drop_report_carries_provider_and_mime():
    rep = AttachmentDropReport(provider='openai', mime='video/mp4', reason='unsupported')
    assert rep.provider == 'openai'
    assert rep.mime == 'video/mp4'
