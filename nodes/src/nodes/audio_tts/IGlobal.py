# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

import os
import tempfile
import time
from typing import Any, Dict

from rocketlib import IGlobalBase, OPEN_MODE
from ai.common.config import Config
from ai.common.models.base import get_model_server_address


_CLEANUP_INTERVAL_SEC = 300  # run stale-file cleanup at most once every 5 minutes

_CANONICAL_TTS_ENGINES = frozenset({'piper', 'kokoro', 'bark', 'bak', 'openai', 'elevenlabs'})


def _normalize_engine_id(raw: Any) -> str:
    """Map UI or profile-style engine strings to canonical backend names.

    Preconfig uses short ids (``openai``, ``kokoro``). Some UIs or hand-edited
    configs may send compound ids (e.g. ``kokoro-default``, ``openai-tts``);
    we take a known prefix before the first ``-`` when the full string is not
    already canonical.
    """
    s = str(raw or 'piper').lower().strip()
    if s in _CANONICAL_TTS_ENGINES:
        return s
    if '-' in s:
        prefix = s.split('-', 1)[0]
        if prefix in _CANONICAL_TTS_ENGINES:
            return prefix
    return s


class IGlobal(IGlobalBase):
    _config: Dict[str, Any]
    _engine: Any
    _last_cleanup_ts: float = 0.0

    def _get_config(self) -> Dict[str, Any]:
        """Return the merged node config via the standard Config interface.

        Returns:
            Dict produced by ``Config.getNodeConfig`` for this node's logical
            type and connector config.
        """
        return Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

    def _resolve_tts_model(self, cfg: Dict[str, Any], engine: str) -> str:
        """Map per-engine config keys to the model id that TTSEngine expects.

        Args:
            cfg: Merged node config dict.
            engine: Canonical engine name (e.g. ``'bark'``, ``'openai'``).

        Returns:
            HuggingFace model id or API model name.  Falls back to a sensible
            default when no value is configured.
        """
        e = engine.lower()
        if e in ('bark', 'bak'):
            return str(cfg.get('bark_model') or cfg.get('model') or 'suno/bark-small').strip()
        if e == 'openai':
            return str(cfg.get('openai_model') or cfg.get('model') or 'gpt-4o-mini-tts').strip()
        if e == 'elevenlabs':
            return str(cfg.get('elevenlabs_model') or cfg.get('model') or 'eleven_multilingual_v2').strip()
        return str(cfg.get('model') or '').strip()

    def _resolve_tts_voice(self, cfg: Dict[str, Any], engine: str) -> str:
        """Resolve the voice identifier for the given engine.

        Args:
            cfg: Merged node config dict.
            engine: Canonical engine name.

        Returns:
            Voice identifier string.
        """
        e = engine.lower()
        if e == 'openai':
            return str(cfg.get('openai_voice') or cfg.get('voice') or 'alloy').strip()
        if e == 'elevenlabs':
            return str(cfg.get('elevenlabs_voice') or cfg.get('voice') or 'EXAVITQu4vr4xnSDxMaL').strip()
        return str(cfg.get('voice') or 'alloy').strip()

    def _build_tts_config_dict(self) -> Dict[str, Any]:
        """Build the TTS runtime config dict using the standard Config interface.

        Called on every synthesis so profile switches take effect without
        restarting the pipeline.  Downloads and caches the Piper ONNX voice
        file when running locally.

        Returns:
            Dict consumed by ``TTSEngine``.  Keys:

            - ``engine`` (str): Active backend name.
            - ``voice`` (str): Resolved voice identifier.
            - ``voice_model`` (str): Local ONNX path for Piper; empty otherwise.
            - ``piper_voice`` (str): Piper preset key.
            - ``piper_use_model_server`` (bool): Route Piper through model server.
            - ``kokoro_use_model_server`` (bool): Route Kokoro through model server.
            - ``model`` (str): HuggingFace or API model id.
            - ``kokoro_voice`` (str): Kokoro voice id.
            - ``kokoro_lang_code`` (str): Single-char language code derived from voice prefix.
            - ``api_key`` (str): Cloud API key; empty for local engines.
            - ``piper_bin`` (str): Piper binary name.
        """
        cfg = self._get_config()
        engine = _normalize_engine_id(cfg.get('engine'))

        api_key = str(cfg.get('api_key') or '').strip()
        if not api_key:
            if engine == 'openai':
                api_key = os.environ.get('OPENAI_API_KEY', '').strip()
            elif engine == 'elevenlabs':
                api_key = os.environ.get('ELEVENLABS_API_KEY', '').strip()

        piper_voice = str(cfg.get('piper_voice') or '').strip()
        kokoro_voice = str(cfg.get('kokoro_voice') or 'af_heart').strip() or 'af_heart'

        _ms = get_model_server_address() is not None
        piper_use_model_server = engine == 'piper' and _ms
        kokoro_use_model_server = engine == 'kokoro' and _ms

        voice_model = ''
        if engine == 'piper' and piper_voice and not piper_use_model_server:
            from . import piper_catalog

            voice_model = piper_catalog.ensure_voice_cached(piper_voice)

        return {
            'engine': engine,
            'voice': self._resolve_tts_voice(cfg, engine),
            'voice_model': voice_model,
            'piper_voice': piper_voice,
            'piper_use_model_server': piper_use_model_server,
            'kokoro_use_model_server': kokoro_use_model_server,
            'model': self._resolve_tts_model(cfg, engine),
            'kokoro_voice': kokoro_voice,
            'kokoro_lang_code': kokoro_voice[0],
            'api_key': api_key,
            'piper_bin': 'piper',
        }

    def beginGlobal(self):
        """Install pip dependencies and create the TTSEngine when the pipeline starts.

        Skipped in ``CONFIG`` open mode (UI validation pass).
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from depends import depends  # type: ignore

        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        from .tts_engine import TTSEngine

        self._config = self._build_tts_config_dict()
        self._engine = TTSEngine(self._config)

    def _cleanup_stale_outputs(self):
        """Remove old TTS temp files from the system temp dir to prevent unbounded growth.

        Runs at most once every ``_CLEANUP_INTERVAL_SEC`` seconds (5 minutes).
        Deletion errors are silently ignored (best-effort cleanup).
        """
        now = time.time()
        if now - self._last_cleanup_ts < _CLEANUP_INTERVAL_SEC:
            return
        self._last_cleanup_ts = now

        max_age_sec = int(self._config.get('temp_output_max_age_sec', 3600))
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
                if now - os.path.getmtime(full_path) > max_age_sec:
                    os.remove(full_path)
            except OSError:
                continue

    def validateConfig(self):
        """Validate the node configuration.

        Raises:
            Exception: If a cloud engine has no API key configured.
            Exception: If ``engine='piper'`` but no ``piper_voice`` is set.
            Exception: If ``engine='kokoro'`` but no ``kokoro_voice`` is set.
        """
        cfg = self._get_config()
        engine = _normalize_engine_id(cfg.get('engine'))

        if engine in ('openai', 'elevenlabs'):
            api_key = str(cfg.get('api_key') or '').strip()
            if not api_key:
                env_hint = 'OPENAI_API_KEY' if engine == 'openai' else 'ELEVENLABS_API_KEY'
                raise Exception(f'Engine "{engine}" requires api_key in node config or {env_hint} in the environment')

        if engine == 'piper' and not str(cfg.get('piper_voice') or '').strip():
            raise Exception('Piper: choose a voice preset from the list (downloads on first run)')

        if engine == 'kokoro' and not str(cfg.get('kokoro_voice') or '').strip():
            raise Exception('Kokoro: choose a voice from the list')

    def _tts_identity_signature(self, cfg: Dict[str, Any]) -> tuple:
        """Return a stable tuple identifying the current engine/voice/model combination.

        Used by ``synthesize`` to detect when ``TTSEngine`` must be recreated.

        Args:
            cfg: Config dict from ``_build_tts_config_dict``.

        Returns:
            Engine-specific tuple used for change detection.
        """
        if not cfg:
            return ('',)
        e = _normalize_engine_id(cfg.get('engine'))
        if e == 'piper':
            return ('piper', str(cfg.get('piper_voice') or '').strip(), bool(cfg.get('piper_use_model_server')))
        if e == 'kokoro':
            return ('kokoro', str(cfg.get('kokoro_voice') or '').strip(), bool(cfg.get('kokoro_use_model_server')))
        if e in ('bark', 'bak'):
            return (e, str(cfg.get('model') or '').strip())
        if e == 'openai':
            return ('openai', str(cfg.get('model') or '').strip(), str(cfg.get('voice') or '').strip())
        if e == 'elevenlabs':
            return ('elevenlabs', str(cfg.get('model') or '').strip(), str(cfg.get('voice') or '').strip())
        return (e,)

    def synthesize(self, text: str, output_format: str) -> Dict[str, Any]:
        """Synthesize text to audio, recreating TTSEngine if config changed.

        Args:
            text: Plain-text utterance to synthesize.
            output_format: ``'wav'`` or ``'mp3'``; any other value defaults to ``'wav'``.

        Returns:
            Dict with ``path`` (str) and ``mime_type`` (str).

        Raises:
            Exception: Propagates any synthesis failure after cleaning up the temp file.
        """
        new_cfg = self._build_tts_config_dict()

        def _eng(v: Any) -> str:
            return str(v or '').lower().strip()

        prev_cfg = getattr(self, '_config', None) or {}
        inst = getattr(self, '_engine', None)
        need_engine = inst is None or self._tts_identity_signature(new_cfg) != self._tts_identity_signature(prev_cfg) or (inst and _eng(getattr(inst, 'config', {}).get('engine')) != _eng(new_cfg.get('engine')))
        if need_engine:
            if inst is not None:
                inst.dispose()
            from .tts_engine import TTSEngine

            self._engine = TTSEngine(new_cfg)
        self._config = new_cfg

        self._cleanup_stale_outputs()
        ext = output_format if output_format in ('wav', 'mp3') else 'wav'
        fd, out_path = tempfile.mkstemp(prefix='tts_', suffix=f'.{ext}')
        os.close(fd)

        runtime_cfg = dict(self._config)
        runtime_cfg['output_path'] = out_path
        runtime_cfg['output_format'] = ext
        self._engine.config = runtime_cfg

        try:
            result = self._engine.synthesize(text)
        except Exception:
            try:
                os.remove(out_path)
            except OSError:
                pass
            raise

        return {'path': result['path'], 'mime_type': result.get('mime_type', 'audio/wav')}

    def endGlobal(self):
        """Dispose the TTSEngine and free all resources when the pipeline shuts down."""
        eng = getattr(self, '_engine', None)
        if eng is not None:
            eng.dispose()
            self._engine = None
