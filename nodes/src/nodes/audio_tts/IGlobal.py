# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
import tempfile
import time
from typing import Any, Dict

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.models.base import get_model_server_address
from .config_resolver import resolve_cloud_api_key, resolve_merged_config

# ``services.json`` profile id → canonical ``engine`` (fallback if merged ``cfg`` lacks ``engine``).
_PROFILE_TO_ENGINE: Dict[str, str] = {
    'piper': 'piper',
    'kokoro-default': 'kokoro',
    'bark-default': 'bark',
    'openai-tts': 'openai',
    'elevenlabs-default': 'elevenlabs',
}


class IGlobal(IGlobalBase):
    _config: Dict[str, Any]
    _engine: Any

    def _resolve_cloud_api_key(self, cfg: Dict[str, Any], raw: Any, engine: str) -> str:
        """Form / merged config, then optional ``OPENAI_API_KEY`` / ``ELEVENLABS_API_KEY`` (runtime)."""
        return resolve_cloud_api_key(cfg, raw, engine, self._read_cfg)

    def _read_cfg(self, config: Dict[str, Any], key: str, default: Any) -> Any:
        if key in config:
            return config.get(key, default)
        params = config.get('parameters') if isinstance(config.get('parameters'), dict) else {}
        return params.get(key, default)

    def _resolve_merged_config(self) -> tuple[Any, Dict[str, Any]]:
        raw = self.glb.connConfig
        return resolve_merged_config(self.glb.logicalType, raw)

    @staticmethod
    def _engine_from_merged_cfg(cfg: Dict[str, Any]) -> str:
        """``engine`` from ``getNodeConfig`` merge; optional fallback from ``profile``."""
        e = str(cfg.get('engine') or '').lower().strip()
        if e:
            return e
        prof = cfg.get('profile')
        if isinstance(prof, str) and prof.strip() in _PROFILE_TO_ENGINE:
            return _PROFILE_TO_ENGINE[prof.strip()]
        return 'piper'

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

    def _build_tts_config_dict(self) -> Dict[str, Any]:
        """Build TTS runtime options: ``glb.connConfig`` + ``Config.getNodeConfig`` (same pattern as other filter nodes)."""
        raw, cfg = self._resolve_merged_config()
        engine = self._engine_from_merged_cfg(cfg)

        piper_voice = str(self._read_cfg(cfg, 'piper_voice', '') or '').strip()

        voice_model = ''
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

        return {
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
            'api_key': self._resolve_cloud_api_key(cfg, raw, engine),
            'piper_bin': 'piper',
            'ffmpeg_bin': 'ffmpeg',
        }

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends  # type: ignore

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        from .tts_engine import TTSEngine

        self._config = self._build_tts_config_dict()
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
        raw, cfg = self._resolve_merged_config()
        engine = self._engine_from_merged_cfg(cfg)
        api_key = self._resolve_cloud_api_key(cfg, raw, engine)
        if engine in ('elevenlabs', 'openai') and not api_key:
            env_hint = 'OPENAI_API_KEY' if engine == 'openai' else 'ELEVENLABS_API_KEY'
            raise Exception(f'Engine "{engine}" requires api_key in node config or {env_hint} in the engine environment')
        if engine == 'piper':
            pv = str(self._read_cfg(cfg, 'piper_voice', '') or '').strip()
            if not pv:
                raise Exception('Piper: choose a voice preset from the list (downloads on first run)')
        if engine == 'kokoro':
            kv = str(self._read_cfg(cfg, 'kokoro_voice', '') or '').strip()
            if not kv:
                raise Exception('Kokoro: choose a voice from the list')

    def _tts_identity_signature(self, cfg: Dict[str, Any]) -> tuple:
        """Stable tuple for when ``TTSEngine`` must be recreated: engine switch **or** voice/model change (same engine)."""
        if not cfg:
            return ('',)
        e = str(cfg.get('engine') or '').lower().strip()
        if e == 'piper':
            return (
                'piper',
                str(cfg.get('piper_voice', '') or '').strip(),
                bool(cfg.get('piper_use_model_server')),
            )
        if e == 'kokoro':
            return (
                'kokoro',
                str(cfg.get('kokoro_voice', '') or '').strip(),
                str(cfg.get('kokoro_lang_code', '') or '').strip(),
                bool(cfg.get('kokoro_use_model_server')),
            )
        if e in ('bark', 'bak'):
            return (e, str(cfg.get('model', '') or '').strip())
        if e == 'openai':
            return (
                'openai',
                str(cfg.get('model', '') or '').strip(),
                str(cfg.get('voice', '') or '').strip(),
                bool(cfg.get('openai_use_model_server')),
            )
        if e == 'elevenlabs':
            return (
                'elevenlabs',
                str(cfg.get('model', '') or '').strip(),
                str(cfg.get('voice', '') or '').strip(),
                bool(cfg.get('elevenlabs_use_model_server')),
            )
        return (e,)

    def synthesize(self, text: str, output_format: str) -> Dict[str, Any]:
        # Re-read connector config each utterance: the same IGlobal can outlive a profile change
        # (e.g. OpenAI → Kokoro) and would otherwise keep the old engine in ``self._config``.
        new_cfg = self._build_tts_config_dict()

        def _norm_eng(v: Any) -> str:
            return str(v or '').lower().strip()

        new_eng = _norm_eng(new_cfg.get('engine'))
        prev_cfg = getattr(self, '_config', None) or {}
        new_sig = self._tts_identity_signature(new_cfg)
        prev_sig = self._tts_identity_signature(prev_cfg) if prev_cfg else None
        inst = getattr(self, '_engine', None)
        inst_eng = ''
        if inst is not None and getattr(inst, 'config', None):
            inst_eng = _norm_eng(inst.config.get('engine'))
        # Recreate on engine/voice/model change, first run, or stray instance engine mismatch.
        need_engine = inst is None or new_sig != prev_sig or (inst_eng and inst_eng != new_eng)
        if need_engine:
            if inst is not None:
                self._engine.dispose()
            from .tts_engine import TTSEngine

            self._engine = TTSEngine(new_cfg)
        self._config = new_cfg

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
