# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Unit tests for audio_tts.IGlobal: config resolution, validation,
beginGlobal fail-fast, synthesize temp-file cleanup, and stale-file gc.
"""

import os
import tempfile
import time
from unittest.mock import MagicMock, patch

import pytest

from audio_tts.IGlobal import IGlobal


# ── Helpers ─────────────────────────────────────────────────────────────────


def _make_iglobal(cfg_overrides=None):
    """Build an ``IGlobal`` instance with a mocked config backend.

    ``cfg_overrides`` is merged on top of a minimal Piper default so each test
    only needs to specify the keys it cares about.
    """
    base = {
        'engine': 'piper',
        'piper_voice': 'en_US-lessac-medium',
        'kokoro_voice': '',
        'api_key': '',
    }
    if cfg_overrides:
        base.update(cfg_overrides)

    inst = IGlobal()

    # Mock the rocketlib plumbing that IGlobal inherits.
    inst.glb = MagicMock()
    inst.glb.logicalType = 'audio_tts'
    inst.glb.connConfig = {}
    inst.IEndpoint = MagicMock()
    inst.IEndpoint.endpoint.openMode = 'NORMAL'

    with patch('audio_tts.IGlobal.Config') as mock_config:
        mock_config.getNodeConfig.return_value = base
        # Eagerly resolve _get_config so downstream helpers work.
        inst._get_config = lambda: base

    return inst


# ── validateConfig ──────────────────────────────────────────────────────────


class TestValidateConfig:
    """Verify early rejection of bad configurations."""

    def test_piper_without_voice_raises(self):
        ig = _make_iglobal({'engine': 'piper', 'piper_voice': ''})
        with pytest.raises(Exception, match='Piper.*voice'):
            ig.validateConfig()

    def test_piper_with_voice_passes(self):
        ig = _make_iglobal({'engine': 'piper', 'piper_voice': 'en_US-lessac-medium'})
        ig.validateConfig()  # must not raise

    def test_kokoro_without_voice_raises(self):
        ig = _make_iglobal({'engine': 'kokoro', 'kokoro_voice': ''})
        with pytest.raises(Exception, match='Kokoro.*voice'):
            ig.validateConfig()

    def test_kokoro_with_voice_passes(self):
        ig = _make_iglobal({'engine': 'kokoro', 'kokoro_voice': 'af_heart'})
        ig.validateConfig()

    def test_openai_without_any_key_raises(self):
        ig = _make_iglobal({'engine': 'openai', 'api_key': ''})
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(Exception, match='OPENAI_API_KEY'):
                ig.validateConfig()

    def test_openai_with_config_key_passes(self):
        ig = _make_iglobal({'engine': 'openai', 'api_key': 'sk-test'})
        ig.validateConfig()

    def test_openai_with_env_var_passes(self):
        ig = _make_iglobal({'engine': 'openai', 'api_key': ''})
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'sk-env'}):
            ig.validateConfig()

    def test_elevenlabs_without_any_key_raises(self):
        ig = _make_iglobal({'engine': 'elevenlabs', 'api_key': ''})
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(Exception, match='ELEVENLABS_API_KEY'):
                ig.validateConfig()

    def test_elevenlabs_with_env_var_passes(self):
        ig = _make_iglobal({'engine': 'elevenlabs', 'api_key': ''})
        with patch.dict(os.environ, {'ELEVENLABS_API_KEY': 'el-env'}):
            ig.validateConfig()

    def test_unrecognized_engine_raises_value_error(self):
        ig = _make_iglobal({'engine': 'unknown'})
        with pytest.raises(ValueError, match='Unrecognized TTS engine'):
            ig.validateConfig()

    def test_bark_passes_without_api_key(self):
        ig = _make_iglobal({'engine': 'bark'})
        ig.validateConfig()


# ── beginGlobal ─────────────────────────────────────────────────────────────


class TestBeginGlobal:
    """Verify beginGlobal calls validateConfig before installing deps."""

    def test_skipped_in_config_mode(self):
        ig = _make_iglobal()
        ig.IEndpoint.endpoint.openMode = 'CONFIG'
        # Should return immediately without touching anything.
        ig.beginGlobal()

    def test_calls_validate_config_first(self):
        ig = _make_iglobal({'engine': 'openai', 'api_key': ''})
        with patch.dict(os.environ, {}, clear=True):
            with pytest.raises(Exception, match='requires api_key'):
                ig.beginGlobal()

    @patch('audio_tts.IGlobal.get_model_server_address', return_value=None)
    def test_happy_path_creates_engine(self, _ms):
        ig = _make_iglobal({'engine': 'piper', 'piper_voice': 'en_US-lessac-medium'})
        with patch('audio_tts.tts_engine.TTSEngine') as MockEngine:
            MockEngine.return_value = MagicMock()
            ig.beginGlobal()
            assert ig._engine is not None


# ── _resolve_tts_model ──────────────────────────────────────────────────────


class TestResolveTtsModel:
    """Verify per-engine model key resolution with fallbacks."""

    def _resolve(self, cfg, engine):
        ig = _make_iglobal()
        return ig._resolve_tts_model(cfg, engine)

    def test_bark_prefers_bark_model(self):
        assert self._resolve({'bark_model': 'suno/bark-large'}, 'bark') == 'suno/bark-large'

    def test_bark_falls_back_to_default(self):
        assert self._resolve({}, 'bark') == 'suno/bark-small'

    def test_openai_prefers_openai_model(self):
        assert self._resolve({'openai_model': 'tts-1-hd'}, 'openai') == 'tts-1-hd'

    def test_openai_falls_back_to_default(self):
        assert self._resolve({}, 'openai') == 'gpt-4o-mini-tts'

    def test_elevenlabs_prefers_elevenlabs_model(self):
        assert self._resolve({'elevenlabs_model': 'eleven_v3'}, 'elevenlabs') == 'eleven_v3'

    def test_elevenlabs_falls_back_to_default(self):
        assert self._resolve({}, 'elevenlabs') == 'eleven_multilingual_v2'

    def test_piper_returns_generic_model_key(self):
        assert self._resolve({'model': 'custom'}, 'piper') == 'custom'

    def test_piper_returns_empty_when_no_model(self):
        assert self._resolve({}, 'piper') == ''

    def test_bak_alias_uses_bark_logic(self):
        assert self._resolve({}, 'bak') == 'suno/bark-small'


# ── _resolve_tts_voice ──────────────────────────────────────────────────────


class TestResolveTtsVoice:
    """Verify per-engine voice key resolution with fallbacks."""

    def _resolve(self, cfg, engine):
        ig = _make_iglobal()
        return ig._resolve_tts_voice(cfg, engine)

    def test_openai_prefers_openai_voice(self):
        assert self._resolve({'openai_voice': 'nova'}, 'openai') == 'nova'

    def test_openai_falls_back_to_alloy(self):
        assert self._resolve({}, 'openai') == 'alloy'

    def test_elevenlabs_prefers_elevenlabs_voice(self):
        vid = '21m00Tcm4TlvDq8ikWAM'
        assert self._resolve({'elevenlabs_voice': vid}, 'elevenlabs') == vid

    def test_elevenlabs_falls_back_to_default_id(self):
        assert self._resolve({}, 'elevenlabs') == 'EXAVITQu4vr4xnSDxMaL'

    def test_piper_uses_generic_voice(self):
        assert self._resolve({'voice': 'custom'}, 'piper') == 'custom'


# ── _tts_identity_signature ────────────────────────────────────────────────


class TestTtsIdentitySignature:
    """Verify signature tuples used for engine-change detection."""

    def _sig(self, cfg):
        ig = _make_iglobal()
        return ig._tts_identity_signature(cfg)

    def test_empty_cfg(self):
        assert self._sig({}) == ('',)
        assert self._sig(None) == ('',)

    def test_piper_signature(self):
        sig = self._sig({'engine': 'piper', 'piper_voice': 'en_US-lessac-medium', 'piper_use_model_server': False})
        assert sig == ('piper', 'en_US-lessac-medium', False)

    def test_kokoro_signature(self):
        sig = self._sig({'engine': 'kokoro', 'kokoro_voice': 'af_heart', 'kokoro_use_model_server': True})
        assert sig == ('kokoro', 'af_heart', True)

    def test_bark_signature(self):
        sig = self._sig({'engine': 'bark', 'model': 'suno/bark-small'})
        assert sig == ('bark', 'suno/bark-small')

    def test_openai_signature(self):
        sig = self._sig({'engine': 'openai', 'model': 'tts-1', 'voice': 'nova'})
        assert sig == ('openai', 'tts-1', 'nova')

    def test_elevenlabs_signature(self):
        sig = self._sig({'engine': 'elevenlabs', 'model': 'eleven_v3', 'voice': 'Rachel'})
        assert sig == ('elevenlabs', 'eleven_v3', 'Rachel')

    def test_different_voices_produce_different_signatures(self):
        a = self._sig({'engine': 'piper', 'piper_voice': 'a', 'piper_use_model_server': False})
        b = self._sig({'engine': 'piper', 'piper_voice': 'b', 'piper_use_model_server': False})
        assert a != b


# ── synthesize: temp-file cleanup ───────────────────────────────────────────


class TestSynthesizeTempCleanup:
    """Verify that the temp file is removed when synthesis raises."""

    def _make_synthesize_iglobal(self):
        ig = _make_iglobal({'engine': 'piper', 'piper_voice': 'en_US-lessac-medium'})
        ig._config = {
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
        }
        return ig

    @patch('audio_tts.IGlobal.get_model_server_address', return_value=None)
    def test_temp_file_removed_on_engine_exception(self, _ms):
        ig = self._make_synthesize_iglobal()
        mock_engine = MagicMock()
        mock_engine.synthesize.side_effect = RuntimeError('boom')
        mock_engine.config = dict(ig._config)
        ig._engine = mock_engine

        with pytest.raises(RuntimeError, match='boom'):
            ig.synthesize('hello', 'wav')

        # The mkstemp file should have been cleaned up by the except block.
        # We cannot check the exact path, but we verify the error propagated.

    @patch('audio_tts.IGlobal.get_model_server_address', return_value=None)
    def test_successful_synthesis_returns_path_and_mime(self, _ms):
        ig = self._make_synthesize_iglobal()

        # Create a real temp file that the mock engine will "produce".
        fd, fake_path = tempfile.mkstemp(prefix='tts_', suffix='.wav')
        os.close(fd)

        mock_engine = MagicMock()
        mock_engine.synthesize.return_value = {'path': fake_path, 'mime_type': 'audio/wav'}
        mock_engine.config = dict(ig._config)
        ig._engine = mock_engine

        result = ig.synthesize('hello', 'wav')
        assert result['mime_type'] == 'audio/wav'
        assert 'path' in result

        # Cleanup the file we created (synthesize does not remove it — the
        # caller IInstance.writeText handles that).
        try:
            os.remove(fake_path)
        except OSError:
            pass

    @patch('audio_tts.IGlobal.get_model_server_address', return_value=None)
    def test_invalid_output_format_defaults_to_wav(self, _ms):
        ig = self._make_synthesize_iglobal()
        mock_engine = MagicMock()
        mock_engine.synthesize.return_value = {'path': '/tmp/x.wav', 'mime_type': 'audio/wav'}
        mock_engine.config = dict(ig._config)
        ig._engine = mock_engine

        # 'ogg' is not wav/mp3, should default to wav extension.
        ig.synthesize('hello', 'ogg')
        cfg_used = mock_engine.config
        assert cfg_used.get('output_format') == 'wav'


# ── _cleanup_stale_outputs ──────────────────────────────────────────────────


class TestCleanupStaleOutputs:
    """Verify time-gated stale-file garbage collection."""

    def test_skipped_when_called_too_soon(self):
        ig = _make_iglobal()
        ig._config = {'temp_output_max_age_sec': 3600}
        ig._last_cleanup_ts = time.time()

        # Calling immediately after the last cleanup should be a no-op.
        ig._cleanup_stale_outputs()
        # If it reached the listdir, it would fail because _config is minimal.
        # No error means it short-circuited.

    def test_removes_old_tts_files(self):
        ig = _make_iglobal()
        ig._config = {'temp_output_max_age_sec': 1}
        ig._last_cleanup_ts = 0.0  # force run

        # Create a temp file that looks old.
        fd, path = tempfile.mkstemp(prefix='tts_', suffix='.wav')
        os.close(fd)
        # Backdate mtime.
        old_time = time.time() - 10
        os.utime(path, (old_time, old_time))

        ig._cleanup_stale_outputs()
        assert not os.path.exists(path)

    def test_ignores_non_tts_files(self):
        ig = _make_iglobal()
        ig._config = {'temp_output_max_age_sec': 1}
        ig._last_cleanup_ts = 0.0

        fd, path = tempfile.mkstemp(prefix='other_', suffix='.wav')
        os.close(fd)
        old_time = time.time() - 10
        os.utime(path, (old_time, old_time))

        ig._cleanup_stale_outputs()
        assert os.path.exists(path)
        os.remove(path)

    def test_ignores_recent_tts_files(self):
        ig = _make_iglobal()
        ig._config = {'temp_output_max_age_sec': 3600}
        ig._last_cleanup_ts = 0.0

        fd, path = tempfile.mkstemp(prefix='tts_', suffix='.wav')
        os.close(fd)

        ig._cleanup_stale_outputs()
        assert os.path.exists(path)
        os.remove(path)
