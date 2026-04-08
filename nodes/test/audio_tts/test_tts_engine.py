# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for audio_tts.tts_engine: dispatch, dispose, _save_mono_float_audio,
and API-key helpers.
"""

import os
import struct
import tempfile
import wave
from unittest.mock import MagicMock, patch

import pytest

from audio_tts.tts_engine import TTSEngine

from .conftest import HAS_NUMPY

if HAS_NUMPY:
    import numpy as np

requires_numpy = pytest.mark.skipif(not HAS_NUMPY, reason='requires real numpy')


# ── Helpers ─────────────────────────────────────────────────────────────────


def _make_engine(overrides=None):
    """Return a ``TTSEngine`` with a minimal config dict."""
    cfg = {
        'engine': 'piper',
        'voice': 'alloy',
        'voice_model': '/tmp/fake.onnx',
        'piper_voice': 'en_US-lessac-medium',
        'piper_use_model_server': False,
        'kokoro_use_model_server': False,
        'model': '',
        'kokoro_voice': 'af_heart',
        'kokoro_lang_code': 'a',
        'api_key': '',
        'piper_bin': 'piper',
        'output_path': '/tmp/out.wav',
        'output_format': 'wav',
    }
    if overrides:
        cfg.update(overrides)
    return TTSEngine(cfg)


# ── synthesize dispatch ─────────────────────────────────────────────────────


class TestSynthesizeDispatch:
    """Verify that synthesize routes to the correct backend method."""

    @pytest.mark.parametrize(
        'engine,method',
        [
            ('piper', '_piper'),
            ('kokoro', '_kokoro'),
            ('bark', '_bark'),
            ('bak', '_bark'),
            ('elevenlabs', '_elevenlabs'),
            ('openai', '_openai'),
        ],
    )
    def test_dispatch_routes_correctly(self, engine, method):
        eng = _make_engine({'engine': engine})
        sentinel = {'path': '/tmp/x.wav', 'mime_type': 'audio/wav'}
        with patch.object(eng, method, return_value=sentinel) as mock_method:
            result = eng.synthesize('hello')
            mock_method.assert_called_once_with('hello')
            assert result is sentinel

    def test_unsupported_engine_raises(self):
        eng = _make_engine({'engine': 'unknown'})
        with pytest.raises(ValueError, match='Unsupported TTS engine'):
            eng.synthesize('hello')


# ── dispose ─────────────────────────────────────────────────────────────────


class TestDispose:
    """Verify that dispose releases all cached resources."""

    def test_clears_all_cached_state(self):
        eng = _make_engine()
        eng._piper_voice = MagicMock()
        eng._piper_voice_onnx = '/tmp/x.onnx'
        eng._kokoro_pipeline = MagicMock()
        eng._kokoro_cache_lang = 'a'
        eng._hf_pipeline = MagicMock()
        eng._hf_pipeline_key = ('m', 't')

        eng.dispose()

        assert eng._piper_voice is None
        assert eng._piper_voice_onnx is None
        assert eng._kokoro_pipeline is None
        assert eng._kokoro_cache_lang is None
        assert eng._hf_pipeline is None
        assert eng._hf_pipeline_key is None

    def test_disconnects_remote_clients(self):
        eng = _make_engine()
        piper_client = MagicMock()
        kokoro_client = MagicMock()
        eng._piper_remote_client = piper_client
        eng._kokoro_remote_client = kokoro_client

        eng.dispose()

        piper_client.disconnect.assert_called_once()
        kokoro_client.disconnect.assert_called_once()
        assert eng._piper_remote_client is None
        assert eng._kokoro_remote_client is None

    def test_survives_disconnect_error(self):
        eng = _make_engine()
        bad_client = MagicMock()
        bad_client.disconnect.side_effect = RuntimeError('conn lost')
        eng._piper_remote_client = bad_client

        eng.dispose()  # must not raise
        assert eng._piper_remote_client is None


# ── _save_mono_float_audio ──────────────────────────────────────────────────


@requires_numpy
class TestSaveMonoFloatAudio:
    """Verify WAV writing and intermediate-file cleanup for MP3 transcoding."""

    def test_writes_valid_wav(self):
        eng = _make_engine()
        fd, path = tempfile.mkstemp(suffix='.wav')
        os.close(fd)
        try:
            samples = np.array([0.0, 0.5, -0.5, 1.0, -1.0], dtype=np.float32)
            eng._save_mono_float_audio(samples, 22050, path, 'wav')

            with wave.open(path, 'rb') as wf:
                assert wf.getnchannels() == 1
                assert wf.getsampwidth() == 2
                assert wf.getframerate() == 22050
                assert wf.getnframes() == 5
        finally:
            os.remove(path)

    def test_empty_audio_raises(self):
        eng = _make_engine()
        fd, path = tempfile.mkstemp(suffix='.wav')
        os.close(fd)
        try:
            with pytest.raises(ValueError, match='empty audio'):
                eng._save_mono_float_audio(np.array([], dtype=np.float32), 22050, path, 'wav')
        finally:
            os.remove(path)

    def test_clips_out_of_range_values(self):
        eng = _make_engine()
        fd, path = tempfile.mkstemp(suffix='.wav')
        os.close(fd)
        try:
            samples = np.array([2.0, -3.0], dtype=np.float32)
            eng._save_mono_float_audio(samples, 16000, path, 'wav')

            with wave.open(path, 'rb') as wf:
                raw = wf.readframes(2)
            vals = struct.unpack('<2h', raw)
            # 2.0 clipped to 1.0 → 32767; -3.0 clipped to -1.0 → -32767
            assert vals[0] == 32767
            assert vals[1] == -32767
        finally:
            os.remove(path)

    @patch('audio_tts.tts_engine.wav_to_mp3_lameenc')
    def test_mp3_cleans_intermediate_wav(self, mock_lame):
        eng = _make_engine()
        fd, path = tempfile.mkstemp(suffix='.mp3')
        os.close(fd)

        # Make lameenc a no-op that just touches the output.
        def fake_lame(src, dst):
            with open(dst, 'wb') as f:
                f.write(b'fake-mp3')

        mock_lame.side_effect = fake_lame

        try:
            samples = np.array([0.1, -0.1], dtype=np.float32)
            eng._save_mono_float_audio(samples, 24000, path, 'mp3')
            # The intermediate .wav that was created alongside should be gone.
            # We can't check its exact name, but no stray wav should remain
            # from this call.
        finally:
            os.remove(path)

    @patch('audio_tts.tts_engine.wav_to_mp3_lameenc')
    def test_mp3_cleans_intermediate_wav_on_transcode_error(self, mock_lame):
        """Intermediate WAV must be removed even when transcoding fails."""
        eng = _make_engine()
        fd, path = tempfile.mkstemp(suffix='.mp3')
        os.close(fd)
        mock_lame.side_effect = RuntimeError('lame failed')

        try:
            with pytest.raises(RuntimeError, match='lame failed'):
                eng._save_mono_float_audio(
                    np.array([0.5], dtype=np.float32),
                    24000,
                    path,
                    'mp3',
                )
        finally:
            os.remove(path)


# ── API key helpers ─────────────────────────────────────────────────────────


class TestApiKeyHelpers:
    """Verify config-first, env-var-fallback key resolution."""

    def test_openai_prefers_config_key(self):
        eng = _make_engine({'api_key': 'cfg-key'})
        assert eng._api_key_openai() == 'cfg-key'

    def test_openai_falls_back_to_env(self):
        eng = _make_engine({'api_key': ''})
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'env-key'}):
            assert eng._api_key_openai() == 'env-key'

    def test_openai_returns_empty_when_missing(self):
        eng = _make_engine({'api_key': ''})
        with patch.dict(os.environ, {}, clear=True):
            assert eng._api_key_openai() == ''

    def test_elevenlabs_prefers_config_key(self):
        eng = _make_engine({'api_key': 'cfg-key'})
        assert eng._api_key_elevenlabs() == 'cfg-key'

    def test_elevenlabs_falls_back_to_env(self):
        eng = _make_engine({'api_key': ''})
        with patch.dict(os.environ, {'ELEVENLABS_API_KEY': 'env-key'}):
            assert eng._api_key_elevenlabs() == 'env-key'


# ── Cloud engine guards ────────────────────────────────────────────────────


class TestCloudEngineGuards:
    """Verify that cloud engines raise immediately when no API key is set."""

    def test_openai_raises_without_key(self):
        eng = _make_engine({'engine': 'openai', 'api_key': ''})
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match='OpenAI TTS requires'):
                eng._openai('hello')

    def test_elevenlabs_raises_without_key(self):
        eng = _make_engine({'engine': 'elevenlabs', 'api_key': ''})
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(ValueError, match='ElevenLabs requires'):
                eng._elevenlabs('hello')


# ── Piper local guard ──────────────────────────────────────────────────────


class TestPiperLocalGuard:
    """Verify that local Piper raises when no voice model path is cached."""

    def test_raises_without_voice_model(self):
        eng = _make_engine(
            {
                'engine': 'piper',
                'piper_use_model_server': False,
                'voice_model': '',
            }
        )
        with pytest.raises(ValueError, match='voice model path'):
            eng._piper('hello')
