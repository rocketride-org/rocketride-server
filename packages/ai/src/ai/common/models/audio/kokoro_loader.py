# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide
# =============================================================================

"""
Kokoro TTS loader for the RocketRide model server (``kokoro.KPipeline`` / Kokoro-82M).

Weights download from Hugging Face on first use on the **server** when this loader
is used; GPU placement follows ``allocate_gpu`` like Whisper/transformers loaders.
"""

from __future__ import annotations

import base64
import os
import tempfile
import threading
import wave
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from ..base import BaseLoader


class KokoroLoader(BaseLoader):
    """Static loader: one ``KPipeline`` per (lang_code, repo_id); voice is per inference."""

    LOADER_TYPE: str = 'kokoro'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_kokoro.txt')
    _DEFAULTS: dict = {'lang_code': 'a', 'repo_id': 'hexgrad/Kokoro-82M'}

    @staticmethod
    def _estimate_memory_gb() -> float:
        """Return a conservative GPU memory estimate (GB) for Kokoro-82M plus activations."""
        # Kokoro-82M + activations; keep conservative for placement
        return 0.55

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        lang_code: str = 'a',
        repo_id: str = 'hexgrad/Kokoro-82M',
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """
        Load ``KPipeline`` for Kokoro-82M.

        Server mode: estimate memory, ``allocate_gpu``, then build pipeline on CPU or CUDA
        (sets ``torch.cuda.set_device`` when device name is ``cuda:N``).
        """
        KokoroLoader._ensure_dependencies()

        from kokoro import KPipeline

        exclude_gpus = exclude_gpus or []
        memory_gb = KokoroLoader._estimate_memory_gb()
        gpu_index = -1
        kp_dev: Optional[str] = None

        if allocate_gpu:
            gpu_index, torch_device = allocate_gpu(memory_gb, exclude_gpus)
            if torch_device == 'cpu' or gpu_index < 0:
                kp_dev = 'cpu'
                gpu_index = -1
            elif isinstance(torch_device, str) and torch_device.startswith('cuda'):
                from ai.common.torch import torch

                idx = int(torch_device.split(':')[1]) if ':' in torch_device else 0
                if torch.cuda.is_available():
                    torch.cuda.set_device(idx)
                kp_dev = 'cuda'
            elif torch_device == 'mps':
                kp_dev = 'mps'
            else:
                kp_dev = 'cpu'
                gpu_index = -1
        else:
            if device is None:
                kp_dev = None
            elif isinstance(device, str) and device.startswith('cuda'):
                from ai.common.torch import torch

                idx = int(device.split(':')[1]) if ':' in device else 0
                if torch.cuda.is_available():
                    torch.cuda.set_device(idx)
                kp_dev = 'cuda'
            else:
                kp_dev = device

        lang = str(lang_code or 'a').strip().lower()
        rid = str(repo_id or 'hexgrad/Kokoro-82M').strip()

        pipeline = KPipeline(lang_code=lang, repo_id=rid, device=kp_dev)

        bundle = {
            'pipeline': pipeline,
            '_lock': threading.Lock(),
        }

        metadata = {
            'model_name': model_name,
            'loader': KokoroLoader.LOADER_TYPE,
            'lang_code': lang,
            'repo_id': rid,
            'estimated_memory_gb': memory_gb,
            'device': kp_dev or 'auto',
        }

        return bundle, metadata, gpu_index

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Normalize raw inputs into a list of dicts with text, voice, and speed fields."""
        items: List[Dict[str, Any]] = []
        for item in inputs:
            if isinstance(item, dict):
                items.append(
                    {
                        'text': str(item.get('text', '')),
                        'voice': str(item.get('voice', '') or 'af_heart').strip(),
                        'speed': float(item.get('speed', 1) or 1),
                    }
                )
            else:
                items.append({'text': str(item), 'voice': 'af_heart', 'speed': 1.0})
        return {'items': items, 'batch_size': len(items)}

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        """Run Kokoro TTS synthesis for each item and return base64-encoded WAV audio."""
        if hasattr(model, 'model_obj'):
            bundle = model.model_obj
        else:
            bundle = model

        pipeline = bundle.get('pipeline')
        lock = bundle.get('_lock')
        if pipeline is None:
            raise ValueError('Kokoro bundle missing pipeline')

        items_out: List[Dict[str, str]] = []
        ctx = lock if lock is not None else threading.Lock()

        with ctx:
            for row in preprocessed.get('items') or []:
                text = row.get('text') or ''
                voice = row.get('voice') or 'af_heart'
                speed = float(row.get('speed', 1) or 1)
                chunks: List[np.ndarray] = []
                for _gs, _ps, audio in pipeline(text, voice=voice, speed=speed):
                    if audio is None:
                        continue
                    if hasattr(audio, 'detach'):
                        arr = audio.detach().cpu().numpy().astype(np.float32)
                    else:
                        arr = np.asarray(audio, dtype=np.float32)
                    if arr.size == 0:
                        continue
                    if arr.ndim > 1:
                        arr = arr.reshape(-1)
                    chunks.append(arr)
                if not chunks:
                    raise ValueError('Kokoro returned no audio samples')
                audio_arr = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
                audio_arr = np.clip(audio_arr, -1.0, 1.0)

                fd, wav_path = tempfile.mkstemp(suffix='.wav')
                os.close(fd)
                try:
                    with wave.open(wav_path, 'wb') as wavf:
                        wavf.setnchannels(1)
                        wavf.setsampwidth(2)
                        wavf.setframerate(24000)
                        wavf.writeframes((audio_arr * 32767).astype(np.int16).tobytes())
                    with open(wav_path, 'rb') as f:
                        raw = f.read()
                finally:
                    try:
                        os.remove(wav_path)
                    except OSError:
                        pass

                items_out.append(
                    {
                        'wav_base64': base64.b64encode(raw).decode('ascii'),
                        'mime_type': 'audio/wav',
                    }
                )

        return {'items': items_out}

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Filter each inference item to only the requested output_fields."""
        items = raw_output.get('items') if isinstance(raw_output, dict) else None
        if not items:
            return [{} for _ in range(batch_size or 1)]

        results: List[Dict[str, Any]] = []
        for item in items:
            row = {k: item[k] for k in output_fields if k in item}
            results.append(row)
        return results
