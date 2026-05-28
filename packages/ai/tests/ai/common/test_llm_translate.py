# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Per-provider-shape attachment translator tests."""

import base64
from unittest.mock import MagicMock

import pytest

from ai.common.schema import Attachment
from ai.common.llm_translate import (
    AttachmentDropReport,
    translate_anthropic_shape,
    translate_bedrock_shape,
    translate_gemini_shape,
    translate_openai_shape,
)


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


class TestAnthropicShape:
    def test_image_becomes_base64_image_block(self):
        att = _att('image/png', 'shot.png')
        fs = _file_store({att.path: b'\x89PNG'})
        blocks, dropped = translate_anthropic_shape('describe', [att], fs, 'anthropic')
        img = next(b for b in blocks if b.get('type') == 'image')
        assert img['source']['type'] == 'base64'
        assert img['source']['media_type'] == 'image/png'
        assert base64.b64decode(img['source']['data']) == b'\x89PNG'
        assert dropped == []

    def test_pdf_becomes_document_block(self):
        att = _att('application/pdf', 'r.pdf')
        fs = _file_store({att.path: b'%PDF'})
        blocks, dropped = translate_anthropic_shape('text', [att], fs, 'anthropic')
        doc = next(b for b in blocks if b.get('type') == 'document')
        assert doc['source']['media_type'] == 'application/pdf'
        assert dropped == []

    def test_audio_is_dropped_anthropic_has_no_audio(self):
        att = _att('audio/mpeg', 'clip.mp3')
        fs = _file_store({att.path: b'ID3'})
        blocks, dropped = translate_anthropic_shape('text', [att], fs, 'anthropic')
        assert all(b.get('type') != 'input_audio' for b in blocks)
        assert dropped == [AttachmentDropReport(provider='anthropic', mime='audio/mpeg', reason='unsupported')]

    def test_text_only_emits_single_text_block(self):
        blocks, dropped = translate_anthropic_shape('hello', [], _file_store({}), 'anthropic')
        assert blocks == [{'type': 'text', 'text': 'hello'}]
        assert dropped == []


class TestGeminiShape:
    def test_image_becomes_inline_data_part(self):
        att = _att('image/jpeg', 'shot.jpg')
        fs = _file_store({att.path: b'\xff\xd8\xff'})
        parts, dropped = translate_gemini_shape('describe', [att], fs, 'gemini')
        img = next(p for p in parts if 'inlineData' in p)
        assert img['inlineData']['mimeType'] == 'image/jpeg'
        assert base64.b64decode(img['inlineData']['data']) == b'\xff\xd8\xff'
        assert dropped == []

    def test_pdf_is_supported(self):
        att = _att('application/pdf', 'r.pdf')
        fs = _file_store({att.path: b'%PDF'})
        parts, dropped = translate_gemini_shape('text', [att], fs, 'gemini')
        assert any(p.get('inlineData', {}).get('mimeType') == 'application/pdf' for p in parts)
        assert dropped == []

    def test_audio_is_supported(self):
        att = _att('audio/mpeg', 'clip.mp3')
        fs = _file_store({att.path: b'ID3'})
        parts, dropped = translate_gemini_shape('text', [att], fs, 'gemini')
        assert any(p.get('inlineData', {}).get('mimeType') == 'audio/mpeg' for p in parts)
        assert dropped == []

    def test_video_is_supported(self):
        att = _att('video/mp4', 'clip.mp4')
        fs = _file_store({att.path: b'\x00\x00\x00\x18ftypmp42'})
        parts, dropped = translate_gemini_shape('text', [att], fs, 'gemini')
        assert any(p.get('inlineData', {}).get('mimeType') == 'video/mp4' for p in parts)
        assert dropped == []

    def test_text_only_emits_single_text_part(self):
        parts, dropped = translate_gemini_shape('hello', [], _file_store({}), 'gemini')
        assert parts == [{'text': 'hello'}]
        assert dropped == []


class TestBedrockShape:
    def test_image_becomes_converse_image_block(self):
        att = _att('image/png', 'shot.png')
        fs = _file_store({att.path: b'\x89PNG'})
        blocks, dropped = translate_bedrock_shape('describe', [att], fs, 'bedrock')
        img = next(b for b in blocks if 'image' in b)
        assert img['image']['format'] == 'png'
        assert img['image']['source']['bytes'] == b'\x89PNG'
        assert dropped == []

    def test_pdf_becomes_document_block(self):
        att = _att('application/pdf', 'r.pdf')
        fs = _file_store({att.path: b'%PDF'})
        blocks, dropped = translate_bedrock_shape('text', [att], fs, 'bedrock')
        assert any('document' in b for b in blocks)
        assert dropped == []

    def test_video_becomes_video_block(self):
        att = _att('video/mp4', 'clip.mp4')
        fs = _file_store({att.path: b'\x00\x00\x00\x18ftypmp42'})
        blocks, dropped = translate_bedrock_shape('text', [att], fs, 'bedrock')
        assert any('video' in b for b in blocks)
        assert dropped == []

    def test_audio_is_dropped(self):
        att = _att('audio/mpeg', 'clip.mp3')
        fs = _file_store({att.path: b'ID3'})
        _, dropped = translate_bedrock_shape('text', [att], fs, 'bedrock')
        assert dropped == [AttachmentDropReport(provider='bedrock', mime='audio/mpeg', reason='unsupported')]

    def test_text_only_emits_single_text_block(self):
        blocks, dropped = translate_bedrock_shape('hello', [], _file_store({}), 'bedrock')
        assert blocks == [{'text': 'hello'}]
        assert dropped == []


def test_drop_report_carries_provider_and_mime():
    rep = AttachmentDropReport(provider='openai', mime='video/mp4', reason='unsupported')
    assert rep.provider == 'openai'
    assert rep.mime == 'video/mp4'
