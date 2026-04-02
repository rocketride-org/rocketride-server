# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide
# =============================================================================

"""
Piper TTS loader for the RocketRide model server (ONNX via ``piper.PiperVoice`` in-process).

CPU-only: does not allocate GPU memory. Downloads preset voices via Hugging Face Hub on the server.
"""

from __future__ import annotations

import base64
import os
import tempfile
import threading
from typing import Any, Dict, List, Optional, Tuple

from ..base import BaseLoader
from .piper_native import load_piper_voice, write_piper_wav


class PiperLoader(BaseLoader):
    """Static loader: resolve ONNX path; inference uses ``PiperVoice`` in the model-server process."""

    LOADER_TYPE: str = 'piper'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_piper.txt')
    _DEFAULTS: dict = {'piper_bin': 'piper'}

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        piper_bin: str = 'piper',
        piper_voice_key: Optional[str] = None,
        onnx_path: Optional[str] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """
        Load Piper identity on the server (resolve ONNX path; ``PiperVoice`` is created lazily on first inference).

        Server mode does **not** call ``allocate_gpu`` — Piper stays on CPU (``gpu_index=-1``).
        """
        PiperLoader._ensure_dependencies()

        if piper_voice_key:
            from .piper_hub import ensure_piper_voice_cached

            resolved = ensure_piper_voice_cached(piper_voice_key)
        elif onnx_path:
            resolved = onnx_path
        else:
            raise ValueError('PiperLoader.load requires piper_voice_key or onnx_path')

        if not os.path.isfile(resolved):
            raise FileNotFoundError(f'Piper ONNX not found: {resolved}')

        bundle = {
            'onnx_path': resolved,
            'piper_bin': piper_bin or 'piper',
            '_lock': threading.Lock(),
            '_piper_voice_obj': None,
        }

        metadata = {
            'model_name': model_name,
            'loader': 'piper',
            'onnx_path': resolved,
            'piper_bin': piper_bin,
            'estimated_memory_gb': 0.05,
            'device': 'cpu',
        }

        return bundle, metadata, -1

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        texts: List[str] = []
        for item in inputs:
            if isinstance(item, str):
                texts.append(item)
            elif isinstance(item, dict) and 'text' in item:
                texts.append(str(item.get('text', '')))
            else:
                texts.append(str(item))
        return {'texts': texts, 'batch_size': len(texts)}

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        if hasattr(model, 'model_obj'):
            bundle = model.model_obj
        else:
            bundle = model

        texts = preprocessed.get('texts') or []
        onnx_path = bundle.get('onnx_path')
        lock = bundle.get('_lock')
        if not onnx_path:
            raise ValueError('Piper bundle missing onnx_path')

        items: List[Dict[str, str]] = []

        def _synth_one(voice: Any, text: str) -> bytes:
            fd, wav_path = tempfile.mkstemp(suffix='.wav')
            os.close(fd)
            try:
                write_piper_wav(voice, text, wav_path)
                with open(wav_path, 'rb') as f:
                    return f.read()
            finally:
                try:
                    os.remove(wav_path)
                except OSError:
                    pass

        ctx = lock if lock is not None else threading.Lock()
        with ctx:
            voice = bundle.get('_piper_voice_obj')
            if voice is None:
                voice = load_piper_voice(onnx_path)
                bundle['_piper_voice_obj'] = voice
            for t in texts:
                raw = _synth_one(voice, t)
                items.append(
                    {
                        'wav_base64': base64.b64encode(raw).decode('ascii'),
                        'mime_type': 'audio/wav',
                    }
                )

        return {'items': items}

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        items = raw_output.get('items') if isinstance(raw_output, dict) else None
        if not items:
            return [{} for _ in range(batch_size or 1)]

        results: List[Dict[str, Any]] = []
        for item in items:
            row = {k: item[k] for k in output_fields if k in item}
            results.append(row)
        return results
