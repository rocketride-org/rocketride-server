# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
import tempfile
import time
from typing import Any, Dict

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config
from ai.common.models.base import get_model_server_address


class IGlobal(IGlobalBase):
    _config: Dict[str, Any]
    _engine: Any

    def _read_cfg(self, config: Dict[str, Any], key: str, default: Any) -> Any:
        if key in config:
            return config.get(key, default)
        params = config.get('parameters') if isinstance(config.get('parameters'), dict) else {}
        return params.get(key, default)

    def _resolve_tts_model(self, cfg: Dict[str, Any], engine: str) -> str:
        """Map profile-specific keys (+ legacy ``model``) to the HF/API id TTSEngine expects."""
        e = engine.lower()
        if e in ('bark', 'bak'):
            v = self._read_cfg(cfg, 'bark_model', '') or self._read_cfg(cfg, 'model', '')
            return str(v or 'suno/bark-small').strip()
        if e == 'openai':
            v = self._read_cfg(cfg, 'openai_model', '') or self._read_cfg(cfg, 'model', '')
            return str(v or 'gpt-4o-mini-tts').strip()
        if e == 'elevenlabs':
            v = self._read_cfg(cfg, 'elevenlabs_model', '') or self._read_cfg(cfg, 'model', '')
            return str(v or 'eleven_multilingual_v2').strip()
        return str(self._read_cfg(cfg, 'model', '') or '').strip()

    def _resolve_tts_voice(self, cfg: Dict[str, Any], engine: str) -> str:
        e = engine.lower()
        if e == 'openai':
            v = self._read_cfg(cfg, 'openai_voice', '') or self._read_cfg(cfg, 'voice', '')
            return str(v or 'alloy').strip()
        if e == 'elevenlabs':
            v = self._read_cfg(cfg, 'elevenlabs_voice', '') or self._read_cfg(cfg, 'voice', '')
            return str(v or 'EXAVITQu4vr4xnSDxMaL').strip()
        return str(self._read_cfg(cfg, 'voice', '') or 'alloy').strip()

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends  # type: ignore

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        from .tts_engine import TTSEngine

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        engine = str(self._read_cfg(cfg, 'engine', 'piper')).lower()

        piper_voice = str(self._read_cfg(cfg, 'piper_voice', '') or '').strip()
        voice_model = ''
        # Model placement: without a model-server address, the engine runs locally and each
        # engine uses CPU/GPU on the engine host. With --modelserver (address set), Piper /
        # Bark / Kokoro (and cloud loaders) use the model server where implemented.
        _ms = get_model_server_address() is not None
        piper_use_model_server = engine == 'piper' and _ms
        kokoro_use_model_server = engine == 'kokoro' and _ms
        openai_use_model_server = engine == 'openai' and _ms
        elevenlabs_use_model_server = engine == 'elevenlabs' and _ms

        if engine == 'piper' and piper_voice:
            if not piper_use_model_server:
                from . import piper_catalog

                voice_model = piper_catalog.ensure_voice_cached(piper_voice)
            else:
                voice_model = ''

        self._config = {
            'engine': engine,
            'voice': self._resolve_tts_voice(cfg, engine),
            'voice_model': voice_model,
            'piper_voice': piper_voice,
            'piper_use_model_server': piper_use_model_server,
            'kokoro_use_model_server': kokoro_use_model_server,
            'openai_use_model_server': openai_use_model_server,
            'elevenlabs_use_model_server': elevenlabs_use_model_server,
            'model': self._resolve_tts_model(cfg, engine),
            'kokoro_lang_code': str(self._read_cfg(cfg, 'kokoro_lang_code', 'a') or 'a').strip(),
            'kokoro_voice': str(self._read_cfg(cfg, 'kokoro_voice', 'af_heart') or 'af_heart').strip(),
            'api_key': self._read_cfg(cfg, 'api_key', ''),
            # Retained for model-server load options / identity; local Piper uses ``PiperVoice`` in-process.
            'piper_bin': 'piper',
            # MP3: ``lameenc`` in-process first; ffmpeg (``imageio-ffmpeg`` / PATH) as fallback in tts_engine.
            'ffmpeg_bin': 'ffmpeg',
        }
        self._engine = TTSEngine(self._config)

    def _cleanup_stale_outputs(self):
        # Keep current output behavior but prevent unbounded temp directory growth.
        if not self._read_cfg(self._config, 'cleanup_temp_outputs', True):
            return

        max_age_sec = int(self._read_cfg(self._config, 'temp_output_max_age_sec', 3600))
        if max_age_sec <= 0:
            return

        now = time.time()
        temp_dir = tempfile.gettempdir()
        for name in os.listdir(temp_dir):
            if not name.startswith('tts_'):
                continue
            if not (name.endswith('.wav') or name.endswith('.mp3')):
                continue

            full_path = os.path.join(temp_dir, name)
            try:
                if not os.path.isfile(full_path):
                    continue
                age = now - os.path.getmtime(full_path)
                if age > max_age_sec:
                    os.remove(full_path)
            except OSError:
                # Best-effort cleanup only.
                continue

    def validateConfig(self):
        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        engine = str(self._read_cfg(cfg, 'engine', 'piper')).lower()
        if engine in ('elevenlabs', 'openai') and not self._read_cfg(cfg, 'api_key', ''):
            raise Exception(f'Engine "{engine}" requires api_key')
        if engine == 'piper':
            pv = str(self._read_cfg(cfg, 'piper_voice', '') or '').strip()
            if not pv:
                raise Exception('Piper: choose a voice preset from the list (downloads on first run)')
        if engine == 'kokoro':
            kv = str(self._read_cfg(cfg, 'kokoro_voice', '') or '').strip()
            if not kv:
                raise Exception('Kokoro: choose a voice from the list')

    def synthesize(self, text: str, output_format: str) -> Dict[str, Any]:
        self._cleanup_stale_outputs()
        ext = output_format if output_format in ('wav', 'mp3') else 'wav'
        filename = f'tts_{int(time.time() * 1000)}.{ext}'
        out_path = os.path.join(tempfile.gettempdir(), filename)

        runtime_cfg = dict(self._config)
        runtime_cfg['output_path'] = out_path
        runtime_cfg['output_format'] = ext
        self._engine.config = runtime_cfg

        result = self._engine.synthesize(text)
        path = result['path']

        return {'path': path, 'mime_type': result.get('mime_type', 'audio/wav')}

    def endGlobal(self):
        eng = getattr(self, '_engine', None)
        if eng is not None:
            eng.dispose()
            self._engine = None
