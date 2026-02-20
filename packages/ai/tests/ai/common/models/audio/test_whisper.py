"""
Unit tests for ai.common.models.audio.whisper (Whisper and WhisperLoader).

Tests loader preprocess/postprocess and Whisper API contracts without
loading a real model. For integration tests with a real model, see
packages/model_server/tests/test_models.py (TestWhisper).

Run this module from project root (with ai on PYTHONPATH, e.g. from dist/server):
  engine -m pytest ../../packages/ai/tests/ai/common/models/audio/test_whisper.py -v
  PYTHONPATH=packages/ai/src python -m pytest packages/ai/tests/ai/common/models/audio/test_whisper.py -v
Run all ai package tests: pytest packages/ai/tests -v (see packages/ai/tests/__init__.py).
"""

import pytest

from ai.common.models.audio.whisper import WhisperLoader, Whisper


# -----------------------------------------------------------------------------
# WhisperLoader.preprocess
# -----------------------------------------------------------------------------


def test_preprocess_accepts_pcm_int16_bytes():
    """Preprocess accepts raw PCM int16 bytes and returns audios + batch_size."""
    # 0.1s at 16kHz mono = 3200 bytes
    pcm_bytes = b'\x00' * 3200
    result = WhisperLoader.preprocess(None, [pcm_bytes], None)
    assert 'audios' in result
    assert 'batch_size' in result
    assert result['batch_size'] == 1
    assert len(result['audios']) == 1
    assert result['audios'][0].dtype.name == 'float32'
    assert len(result['audios'][0]) == 1600  # 3200 / 2 samples


def test_preprocess_rejects_non_bytes():
    """Preprocess raises ValueError for non-bytes input."""
    with pytest.raises(ValueError, match='Expected bytes'):
        WhisperLoader.preprocess(None, [b'ok', 'not bytes'], None)


def test_preprocess_uses_metadata_language():
    """Preprocess passes language from metadata."""
    pcm_bytes = b'\x00' * 3200
    result = WhisperLoader.preprocess(None, [pcm_bytes], {'language': 'de'})
    assert result.get('language') == 'de'


# -----------------------------------------------------------------------------
# WhisperLoader.postprocess
# -----------------------------------------------------------------------------


def test_postprocess_extracts_text_and_segments():
    """Postprocess returns list of dicts with $text and $segments."""
    raw_output = [
        {
            'segments': [
                {'start': 0.0, 'end': 1.0, 'text': 'Hello'},
                {'start': 1.0, 'end': 2.0, 'text': 'world'},
            ],
            'language': 'en',
            'text': 'Hello world',
        }
    ]
    out = WhisperLoader.postprocess(
        None,
        raw_output,
        batch_size=1,
        output_fields=['$text', '$segments'],
    )
    assert len(out) == 1
    assert out[0]['$text'] == 'Hello world'
    assert len(out[0]['$segments']) == 2
    assert out[0]['$segments'][0]['text'] == 'Hello'
    assert out[0]['$segments'][0]['start'] == 0.0
    assert out[0]['$segments'][1]['text'] == 'world'


def test_postprocess_pads_to_batch_size():
    """Postprocess pads with empty results when raw_output is shorter than batch_size."""
    raw_output = [{'segments': [], 'language': 'en', 'text': ''}]
    out = WhisperLoader.postprocess(
        None,
        raw_output,
        batch_size=3,
        output_fields=['$text', '$segments'],
    )
    assert len(out) == 3
    assert out[0]['$text'] == ''
    assert out[1]['$text'] is None or out[1]['$text'] == ''
    assert out[2]['$text'] is None or out[2]['$text'] == ''


# -----------------------------------------------------------------------------
# WhisperLoader static helpers
# -----------------------------------------------------------------------------


def test_estimate_memory_known_models():
    """_estimate_memory returns expected GB for known model names."""
    assert WhisperLoader._estimate_memory('tiny') == 0.5
    assert WhisperLoader._estimate_memory('base') == 0.7
    assert WhisperLoader._estimate_memory('large-v3') == 5.0


def test_get_supported_models():
    """get_supported_models returns non-empty list of model names."""
    models = WhisperLoader.get_supported_models()
    assert 'tiny' in models
    assert 'base' in models
    assert 'large-v3' in models


# -----------------------------------------------------------------------------
# Whisper.transcribe contract (no model load)
# -----------------------------------------------------------------------------


def test_transcribe_requires_bytes():
    """Whisper.transcribe raises TypeError when audio is not bytes."""
    # Create Whisper in local mode would load model; use proxy mode via patch
    # to avoid loading. We only test the type check at the start of transcribe().
    from unittest.mock import patch, MagicMock

    with patch('ai.common.models.audio.whisper.get_model_server_address', return_value=('localhost', 5590)):
        with patch('ai.common.models.audio.whisper.ModelClient') as MockClient:
            mock_client = MagicMock()
            MockClient.return_value = mock_client
            w = Whisper('tiny', output_fields=['$text'])
            assert w._proxy_mode is True
    # Type check is first in transcribe()
    with pytest.raises(TypeError, match='audio must be bytes'):
        w.transcribe([1, 2, 3])  # type: ignore
    with pytest.raises(TypeError, match='audio must be bytes'):
        w.transcribe('string')
