# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import base64
import json
import os
import shutil
import tempfile
import time
from typing import Any, Dict

from rocketlib import IGlobalBase, OPEN_MODE, warning
from ai.common.config import Config


class IGlobal(IGlobalBase):
    _config: Dict[str, Any]
    _engine: Any

    def _read_cfg(self, config: Dict[str, Any], key: str, default: Any) -> Any:
        if key in config:
            return config.get(key, default)
        params = config.get('parameters') if isinstance(config.get('parameters'), dict) else {}
        return params.get(key, default)

    def beginGlobal(self):
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        from .tts_engine import TTSEngine

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
        output_format = str(self._read_cfg(cfg, 'output_format', 'wav')).lower()
        engine = str(self._read_cfg(cfg, 'engine', 'piper')).lower()

        self._config = {
            'engine': engine,
            'voice': self._read_cfg(cfg, 'voice', 'alloy'),
            'voice_model': self._read_cfg(cfg, 'voice_model', ''),
            'model': self._read_cfg(cfg, 'model', 'gpt-4o-mini-tts'),
            'api_key': self._read_cfg(cfg, 'api_key', ''),
            'output_mode': str(self._read_cfg(cfg, 'output_mode', 'path')).lower(),
            'output_format': output_format if output_format in ('wav', 'mp3') else 'wav',
            'piper_bin': self._read_cfg(cfg, 'piper_bin', 'piper'),
            'ffmpeg_bin': self._read_cfg(cfg, 'ffmpeg_bin', 'ffmpeg'),
            'use_model_server': bool(self._read_cfg(cfg, 'use_model_server', False)),
            'ws_enabled': bool(self._read_cfg(cfg, 'ws_enabled', False)),
            'ws_host': self._read_cfg(cfg, 'ws_host', 'localhost'),
            'ws_port': int(self._read_cfg(cfg, 'ws_port', 5565)),
            'ws_route': self._read_cfg(cfg, 'ws_route', '/audio/tts'),
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
        if engine == 'piper' and not self._read_cfg(cfg, 'voice_model', ''):
            raise Exception('Engine "piper" requires voice_model (.onnx path)')
        if engine in ('coqui', 'kokoro', 'bark', 'bak') and not self._read_cfg(cfg, 'model', ''):
            raise Exception(f'Engine "{engine}" requires model')
        output_format = str(self._read_cfg(cfg, 'output_format', 'wav')).lower()
        ffmpeg_bin = str(self._read_cfg(cfg, 'ffmpeg_bin', 'ffmpeg'))
        # Local/model-based engines generate wav first; mp3 requires ffmpeg conversion.
        if output_format == 'mp3' and engine in ('piper', 'coqui', 'kokoro', 'bark', 'bak'):
            if shutil.which(ffmpeg_bin) is None:
                raise Exception(f'Engine "{engine}" with output_format "mp3" requires ffmpeg. Binary not found: {ffmpeg_bin}')

    def synthesize(self, text: str) -> Dict[str, Any]:
        self._cleanup_stale_outputs()
        ext = self._config.get('output_format', 'wav')
        filename = f'tts_{int(time.time() * 1000)}.{ext}'
        out_path = os.path.join(tempfile.gettempdir(), filename)

        runtime_cfg = dict(self._config)
        runtime_cfg['output_path'] = out_path
        self._engine.config = runtime_cfg

        result = self._engine.synthesize(text)
        path = result['path']

        payload = {'path': path, 'mime_type': result.get('mime_type', 'audio/wav')}
        if self._config.get('output_mode') == 'base64':
            with open(path, 'rb') as fin:
                payload['base64'] = base64.b64encode(fin.read()).decode('ascii')
        return payload

    def notify_ws(self, payload: Dict[str, Any]):
        if not self._config.get('ws_enabled'):
            return
        try:
            from websockets.sync.client import connect

            host = self._config.get('ws_host', 'localhost')
            port = self._config.get('ws_port', 5565)
            route = self._config.get('ws_route', '/audio/tts')
            url = f'ws://{host}:{port}{route}'
            with connect(url, open_timeout=5, close_timeout=3) as ws:
                ws.send(json.dumps(payload))
        except Exception as e:
            warning(f'WebSocket notification failed: {e}')

    def endGlobal(self):
        self._engine = None
