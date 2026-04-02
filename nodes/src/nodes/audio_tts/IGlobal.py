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
from ai.common.models.base import get_model_server_address
from .config_resolver import resolve_cloud_api_key, resolve_merged_config

# ``services.json`` profile id → canonical ``engine`` (fallback if merged ``cfg`` lacks ``engine``).
_PROFILE_TO_ENGINE: Dict[str, str] = {
    'piper': 'piper',
    'kokoro': 'kokoro',
    'bark': 'bark',
    'openai': 'openai',
    'elevenlabs': 'elevenlabs',
}


_CLEANUP_INTERVAL_SEC = 300  # run stale-file cleanup at most once every 5 minutes


class IGlobal(IGlobalBase):
    _config: Dict[str, Any]
    _engine: Any
    _last_cleanup_ts: float = 0.0

    def _resolve_cloud_api_key(self, cfg: Dict[str, Any], raw: Any, engine: str) -> str:
        """Resolve the API key for cloud TTS engines from config or environment.

        Delegates to ``resolve_cloud_api_key`` in ``config_resolver``, passing
        ``_read_cfg`` as the config-reader callable.  Falls back to
        ``OPENAI_API_KEY`` or ``ELEVENLABS_API_KEY`` environment variables when
        the key is absent from the merged config.

        Args:
            cfg: Merged node config dict (output of ``Config.getNodeConfig``).
            raw: Raw connector config object (``IJson``-like) from
                ``glb.connConfig``.
            engine: Canonical engine name (e.g. ``'openai'``, ``'elevenlabs'``).

        Returns:
            API key string, or empty string if not found.
        """
        return resolve_cloud_api_key(cfg, raw, engine, self._read_cfg)

    def _read_cfg(self, config: Dict[str, Any], key: str, default: Any) -> Any:
        """Read a key from a config dict or its nested ``parameters`` sub-dict, with a default.

        Checks the top-level dict first; if the key is absent, checks
        ``config['parameters']`` (present when ``getNodeConfig`` wraps values
        under a ``parameters`` sub-key).

        Args:
            config: Config dict to search.
            key: Key to look up.
            default: Value to return when the key is not found in either dict.

        Returns:
            The value associated with ``key``, or ``default``.
        """
        if key in config:
            return config.get(key, default)
        params = config.get('parameters') if isinstance(config.get('parameters'), dict) else {}
        return params.get(key, default)

    def _resolve_merged_config(self) -> tuple[Any, Dict[str, Any]]:
        """Delegate to ``resolve_merged_config`` using the current connector config and logical type.

        Returns:
            Tuple of ``(raw, cfg)`` where ``raw`` is the ``IJson``-like
            connector config object and ``cfg`` is the merged, normalised
            config dict ready for ``_build_tts_config_dict``.
        """
        raw = self.glb.connConfig
        return resolve_merged_config(self.glb.logicalType, raw)

    @staticmethod
    def _engine_from_merged_cfg(cfg: Dict[str, Any]) -> str:
        """Resolve the canonical engine name from a merged config dict.

        Reads ``cfg['engine']`` first.  If absent or empty, falls back to
        ``cfg['profile']`` looked up in ``_PROFILE_TO_ENGINE``.  Defaults to
        ``'piper'`` when neither is present.

        Args:
            cfg: Merged node config dict.

        Returns:
            Lowercase engine name: ``'piper'``, ``'kokoro'``, ``'bark'``,
            ``'openai'``, or ``'elevenlabs'``.
        """
        e = str(cfg.get('engine') or '').lower().strip()
        if e:
            return e
        prof = cfg.get('profile')
        if isinstance(prof, str) and prof.strip() in _PROFILE_TO_ENGINE:
            return _PROFILE_TO_ENGINE[prof.strip()]
        return 'piper'

    def _resolve_tts_model(self, cfg: Dict[str, Any], engine: str) -> str:
        """Map profile-specific config keys to the model id that TTSEngine expects.

        Each engine has a preferred key (e.g. ``bark_model``, ``openai_model``)
        with a legacy ``model`` fallback for configs created before the
        per-engine keys were introduced.

        Args:
            cfg: Merged node config dict.
            engine: Canonical engine name (e.g. ``'bark'``, ``'openai'``).

        Returns:
            HuggingFace model id or API model name string.  Falls back to a
            sensible default when no value is configured:
            ``'suno/bark-small'`` (Bark), ``'gpt-4o-mini-tts'`` (OpenAI),
            ``'eleven_multilingual_v2'`` (ElevenLabs).
        """
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
        """Resolve the voice identifier for the given engine from merged config keys.

        Each cloud engine has a preferred key (``openai_voice``,
        ``elevenlabs_voice``) with a legacy ``voice`` fallback.  Local
        engines read the generic ``voice`` key.

        Args:
            cfg: Merged node config dict.
            engine: Canonical engine name.

        Returns:
            Voice identifier string.  Defaults: ``'alloy'`` (OpenAI and
            generic), ``'EXAVITQu4vr4xnSDxMaL'`` (ElevenLabs "Bella").
        """
        e = engine.lower()
        if e == 'openai':
            v = self._read_cfg(cfg, 'openai_voice', '') or self._read_cfg(cfg, 'voice', '')
            return str(v or 'alloy').strip()
        if e == 'elevenlabs':
            v = self._read_cfg(cfg, 'elevenlabs_voice', '') or self._read_cfg(cfg, 'voice', '')
            return str(v or 'EXAVITQu4vr4xnSDxMaL').strip()
        return str(self._read_cfg(cfg, 'voice', '') or 'alloy').strip()

    def _build_tts_config_dict(self) -> Dict[str, Any]:
        """Build the TTS runtime config dict from merged connector and node config.

        Calls ``_resolve_merged_config`` on every invocation so that profile
        switches (e.g. OpenAI → Kokoro) are always reflected without restarting
        the pipeline.  Downloads and caches the Piper ONNX voice file when
        running locally (non-model-server) and the engine is ``'piper'``.

        Returns:
            Dict consumed by ``TTSEngine.__init__`` and ``IGlobal.synthesize``.
            Keys:

            - ``engine`` (str): Active backend name.
            - ``voice`` (str): Resolved voice identifier for the engine.
            - ``voice_model`` (str): Local ONNX path for Piper; empty otherwise.
            - ``piper_voice`` (str): Piper preset key (e.g. ``'en_US-lessac-medium'``).
            - ``piper_use_model_server`` (bool): Route Piper through model server.
            - ``kokoro_use_model_server`` (bool): Route Kokoro through model server.
            - ``model`` (str): HuggingFace or API model id.
            - ``kokoro_voice`` (str): Kokoro voice id (e.g. ``'af_heart'``).
            - ``kokoro_lang_code`` (str): Single-char language code derived from
              the Kokoro voice prefix (e.g. ``'a'`` for American English).
            - ``api_key`` (str): Cloud API key; empty for local engines.
            - ``piper_bin`` (str): Piper binary name (``'piper'``).
            - ``ffmpeg_bin`` (str): ffmpeg binary name (``'ffmpeg'``).
        """
        raw, cfg = self._resolve_merged_config()
        engine = self._engine_from_merged_cfg(cfg)

        piper_voice = str(self._read_cfg(cfg, 'piper_voice', '') or '').strip()

        voice_model = ''
        _ms = get_model_server_address() is not None
        piper_use_model_server = engine == 'piper' and _ms
        kokoro_use_model_server = engine == 'kokoro' and _ms

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
            'model': self._resolve_tts_model(cfg, engine),
            'kokoro_voice': str(self._read_cfg(cfg, 'kokoro_voice', 'af_heart') or 'af_heart').strip(),
            'kokoro_lang_code': (str(self._read_cfg(cfg, 'kokoro_voice', 'af_heart') or 'af_heart').strip() or 'a')[0],
            'api_key': self._resolve_cloud_api_key(cfg, raw, engine),
            'piper_bin': 'piper',
            'ffmpeg_bin': 'ffmpeg',
        }

    def beginGlobal(self):
        """Install pip dependencies and create the TTSEngine when the pipeline starts.

        Skipped in ``CONFIG`` open mode (UI validation pass).  Calls
        ``depends(requirements.txt)`` to install all declared packages, then
        builds the initial config dict and constructs a ``TTSEngine`` instance
        that is reused across utterances (and recreated on engine/voice change
        inside ``synthesize``).
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
        Scans ``tempfile.gettempdir()`` for files whose names start with
        ``tts_`` and end with ``.wav`` or ``.mp3`` and deletes those older
        than ``temp_output_max_age_sec`` seconds (default 3600 = 1 hour).

        Can be disabled by setting ``cleanup_temp_outputs`` to ``False`` in the
        node config, or by setting ``temp_output_max_age_sec`` to ``0``.
        Deletion errors are silently ignored (best-effort cleanup).
        """
        now = time.time()
        if now - self._last_cleanup_ts < _CLEANUP_INTERVAL_SEC:
            return
        self._last_cleanup_ts = now
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
        """Validate the node configuration, raising on missing required values.

        Called by the engine during the ``CONFIG`` open-mode pass (before the
        pipeline starts) so that misconfiguration surfaces as a clear error in
        the UI rather than a cryptic runtime failure.

        Raises:
            Exception: If a cloud engine (``openai`` / ``elevenlabs``) has no
                API key configured.
            Exception: If ``engine='piper'`` but no ``piper_voice`` is set.
            Exception: If ``engine='kokoro'`` but no ``kokoro_voice`` is set.
        """
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
        """Return a stable tuple that identifies the current engine/voice/model combination.

        Used by ``synthesize`` to detect when the ``TTSEngine`` must be
        disposed and recreated (engine switch, voice change, model change, or
        model-server flag change).

        Args:
            cfg: Config dict to build the signature from.  Typically the
                output of ``_build_tts_config_dict``.

        Returns:
            A tuple whose first element is the engine name, followed by
            engine-specific discriminators:

            - Piper: ``('piper', piper_voice, piper_use_model_server)``
            - Kokoro: ``('kokoro', kokoro_voice, kokoro_use_model_server)``
            - Bark: ``(engine, model)``
            - OpenAI: ``('openai', model, voice)``
            - ElevenLabs: ``('elevenlabs', model, voice)``
            - Empty/unknown: ``('',)``
        """
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
                bool(cfg.get('kokoro_use_model_server')),
            )
        if e in ('bark', 'bak'):
            return (e, str(cfg.get('model', '') or '').strip())
        if e == 'openai':
            return (
                'openai',
                str(cfg.get('model', '') or '').strip(),
                str(cfg.get('voice', '') or '').strip(),
            )
        if e == 'elevenlabs':
            return (
                'elevenlabs',
                str(cfg.get('model', '') or '').strip(),
                str(cfg.get('voice', '') or '').strip(),
            )
        return (e,)

    def synthesize(self, text: str, output_format: str) -> Dict[str, Any]:
        """Synthesize text to audio, recreating the TTSEngine if the engine/voice config changed.

        Re-reads the connector config on every call so that runtime profile
        switches (e.g. OpenAI → Kokoro) take effect without restarting the
        pipeline.  Compares identity signatures to decide whether to dispose
        the old engine and construct a new one.

        Reserves a unique temp file via ``tempfile.mkstemp`` before calling
        ``TTSEngine.synthesize``, and deletes it if synthesis raises an
        exception.

        Args:
            text: Plain-text utterance to synthesize.
            output_format: Requested audio format — ``'wav'`` or ``'mp3'``.
                Any other value is treated as ``'wav'``.

        Returns:
            Dict with keys:
                - ``path`` (str): Absolute path to the generated audio file.
                  The caller (``IInstance``) is responsible for reading and
                  deleting this file.
                - ``mime_type`` (str): MIME type of the audio file.

        Raises:
            Exception: Propagates any exception raised by ``TTSEngine.synthesize``,
                after cleaning up the reserved output file.
        """
        # Re-read connector config each utterance: the same IGlobal can outlive a profile change
        # (e.g. OpenAI → Kokoro) and would otherwise keep the old engine in ``self._config``.
        new_cfg = self._build_tts_config_dict()

        def _norm_eng(v: Any) -> str:
            """Normalize an engine name to a lowercase stripped string."""
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

        path = result['path']

        return {'path': path, 'mime_type': result.get('mime_type', 'audio/wav')}

    def endGlobal(self):
        """Dispose the TTSEngine and free all resources when the pipeline shuts down.

        Calls ``TTSEngine.dispose()`` to release cached models, ONNX runtimes,
        and any open WebSocket connections to the model server.
        """
        eng = getattr(self, '_engine', None)
        if eng is not None:
            eng.dispose()
            self._engine = None
