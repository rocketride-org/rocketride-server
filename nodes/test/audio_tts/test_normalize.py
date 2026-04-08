# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for pure helper functions: _normalize_engine_id,
_infer_output_format, and _mime_from_format.
"""

import pytest

from audio_tts.IGlobal import _normalize_engine_id
from audio_tts.IInstance import _infer_output_format


# ── _normalize_engine_id ────────────────────────────────────────────────────


class TestNormalizeEngineId:
    """Verify canonical mapping, compound-ID stripping, and rejection of
    unrecognized engine strings.
    """

    @pytest.mark.parametrize(
        'raw,expected',
        [
            ('piper', 'piper'),
            ('kokoro', 'kokoro'),
            ('bark', 'bark'),
            ('bak', 'bak'),
            ('openai', 'openai'),
            ('elevenlabs', 'elevenlabs'),
        ],
    )
    def test_canonical_values_pass_through(self, raw, expected):
        assert _normalize_engine_id(raw) == expected

    @pytest.mark.parametrize(
        'raw,expected',
        [
            ('PIPER', 'piper'),
            ('Kokoro', 'kokoro'),
            ('OPENAI', 'openai'),
            ('  bark  ', 'bark'),
            ('ElevenLabs', 'elevenlabs'),
        ],
    )
    def test_case_and_whitespace_normalization(self, raw, expected):
        assert _normalize_engine_id(raw) == expected

    @pytest.mark.parametrize(
        'raw,expected',
        [
            ('kokoro-default', 'kokoro'),
            ('bark-default', 'bark'),
            ('openai-tts', 'openai'),
            ('elevenlabs-default', 'elevenlabs'),
            ('piper-fast', 'piper'),
            ('bak-v2', 'bak'),
        ],
    )
    def test_compound_ids_canonicalized(self, raw, expected):
        assert _normalize_engine_id(raw) == expected

    def test_none_defaults_to_piper(self):
        assert _normalize_engine_id(None) == 'piper'

    def test_empty_string_defaults_to_piper(self):
        assert _normalize_engine_id('') == 'piper'

    def test_whitespace_only_defaults_to_piper(self):
        assert _normalize_engine_id('   ') == 'piper'

    @pytest.mark.parametrize(
        'raw',
        [
            'unknown',
            'mytts',
            'polly',
            'coqui',
        ],
    )
    def test_unrecognized_engine_raises_value_error(self, raw):
        with pytest.raises(ValueError, match='Unrecognized TTS engine'):
            _normalize_engine_id(raw)

    def test_compound_id_with_unknown_prefix_raises(self):
        with pytest.raises(ValueError, match='Unrecognized TTS engine'):
            _normalize_engine_id('google-default')

    def test_error_message_lists_valid_engines(self):
        with pytest.raises(ValueError) as exc_info:
            _normalize_engine_id('invalid')
        msg = str(exc_info.value)
        for engine in ('bark', 'kokoro', 'openai', 'piper', 'elevenlabs'):
            assert engine in msg

    def test_numeric_input_raises(self):
        with pytest.raises(ValueError, match='Unrecognized TTS engine'):
            _normalize_engine_id(42)


# ── _infer_output_format ────────────────────────────────────────────────────


class TestInferOutputFormat:
    """Verify that ElevenLabs produces MP3 and everything else produces WAV."""

    def test_elevenlabs_returns_mp3(self):
        assert _infer_output_format('elevenlabs') == 'mp3'

    def test_elevenlabs_case_insensitive(self):
        assert _infer_output_format('ElevenLabs') == 'mp3'

    def test_elevenlabs_with_whitespace(self):
        assert _infer_output_format('  elevenlabs  ') == 'mp3'

    @pytest.mark.parametrize('engine', ['piper', 'kokoro', 'bark', 'openai'])
    def test_non_elevenlabs_returns_wav(self, engine):
        assert _infer_output_format(engine) == 'wav'

    def test_empty_string_returns_wav(self):
        assert _infer_output_format('') == 'wav'

    def test_none_returns_wav(self):
        assert _infer_output_format(None) == 'wav'


# ── _mime_from_format (tested in test_tts_engine.py — requires numpy) ───────
