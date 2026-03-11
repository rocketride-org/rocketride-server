"""
Whisper: Combined loader and user-facing API using faster-whisper.

This module provides:
- WhisperLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- Whisper: User-facing class with automatic local/remote mode detection
  (used by connectors)

Uses faster-whisper (CTranslate2) for efficient GPU inference with built-in
Silero VAD. No pyannote dependency - fully MIT licensed.

Binary Transfer:
    Audio is transferred as raw PCM int16 bytes (16kHz mono).
    This is the most efficient format - half the size of float32.
    Server converts: np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0

Note:
    This module does NOT support speaker diarization.
    For diarization, use the NeMo loader separately.
"""

import logging
import os
import threading
from typing import Any, Dict, List, Optional, Tuple

from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.whisper')


class WhisperLoader(BaseLoader):
    """
    Static loader for Whisper speech transcription models using faster-whisper.

    Used by:
    - Model server (directly calls static methods)
    - Whisper wrapper (for local mode)

    Features:
    - CTranslate2-based inference (fast, efficient)
    - Built-in Silero VAD (no pyannote needed)
    - MIT licensed - no restrictions

    Model Identity (for sharing):
        model_name + language + compute_type
        See _DEFAULTS for default values applied before hashing.

    Performance Note:
        - Typical throughput: ~8-15 req/s depending on model size and audio length
    """

    LOADER_TYPE: str = 'whisper'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_whisper.txt')

    # Per-model locks for thread safety (faster-whisper is NOT thread-safe)
    _model_locks: Dict[int, threading.Lock] = {}
    _locks_lock = threading.Lock()

    # Defaults applied before hashing (ensures consistent model IDs)
    _DEFAULTS = {
        'language': 'en',
        'compute_type': 'float16',
    }

    @classmethod
    def _get_model_lock(cls, model_id: int) -> threading.Lock:
        """Get or create a lock for a specific model instance."""
        with cls._locks_lock:
            if model_id not in cls._model_locks:
                cls._model_locks[model_id] = threading.Lock()
            return cls._model_locks[model_id]

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        language: str = 'en',
        compute_type: str = 'float16',
        **kwargs,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], int]:
        """
        Load faster-whisper model.

        Two modes:
        - Local mode (device specified): Load directly to device
        - Server mode (allocate_gpu provided): Estimate memory, allocate GPU, load

        Args:
            model_name: Whisper model size ('tiny', 'base', 'small', 'medium', 'large-v3')
            device: Device for local mode ('cuda:0', 'cuda', 'cpu')
            allocate_gpu: Callback for server mode (memory_gb, exclude_gpus) -> (gpu_index, device_str)
            exclude_gpus: GPUs to exclude (server mode)
            language: Language code for transcription (default: 'en')
            compute_type: Precision type (float16, int8, float32)
            **kwargs: Additional arguments (ignored for compatibility)

        Returns:
            Tuple of (model_bundle, metadata_dict, gpu_index)
        """
        WhisperLoader._ensure_dependencies()

        from faster_whisper import WhisperModel
        from ai.common.torch import torch

        # Strip 'whisper/' prefix if present (e.g., 'whisper/tiny' -> 'tiny')
        if model_name.startswith('whisper/'):
            model_name = model_name[8:]

        exclude_gpus = exclude_gpus or []

        if allocate_gpu:
            # === SERVER MODE: Estimate memory, allocate, then load ===
            memory_gb = WhisperLoader._estimate_memory(model_name)
            logger.debug(f'Estimated memory: {memory_gb:.2f} GB')

            gpu_index, torch_device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({torch_device}) for Whisper {model_name}')
            # CTranslate2 does not support float16 on CPU (Intel or ARM). Use int8 for speed;
            # use float32 in loader_options if you prefer max precision on CPU (slower, more RAM).
            # Refs: https://opennmt.net/CTranslate2/quantization.html (fallback table),
            #       https://github.com/SYSTRAN/faster-whisper/issues/65 (float16 on CPU).
            if torch_device == 'cpu' and compute_type == 'float16':
                compute_type = 'int8'
        else:
            # === LOCAL MODE: Use specified device ===
            if device is None:
                device = 'cuda' if torch.cuda.is_available() else 'cpu'

            if device == 'cpu':
                gpu_index = -1
                torch_device = 'cpu'
                # CTranslate2: no float16 on CPU (Intel or ARM). int8 = faster; float32 = max precision.
                # Refs: https://opennmt.net/CTranslate2/quantization.html, faster-whisper #65.
                if compute_type == 'float16':
                    compute_type = 'int8'
            elif ':' in device:
                gpu_index = int(device.split(':')[1])
                torch_device = device
            else:
                gpu_index = 0
                torch_device = 'cuda:0'

            memory_gb = WhisperLoader._estimate_memory(model_name)

        # Load faster-whisper model
        # faster-whisper uses device='cuda' + device_index, NOT 'cuda:0'
        logger.info(f'Loading Whisper model {model_name} on {torch_device}')

        try:
            if torch_device == 'cpu':
                model = WhisperModel(
                    model_name,
                    device='cpu',
                    compute_type=compute_type,
                )
            else:
                # Extract real device index from torch_device (e.g., 'cuda:0' -> 0)
                # In simulation mode, torch_device is always 'cuda:0' even for virtual GPUs 1,2,3
                real_device_index = int(torch_device.split(':')[1]) if ':' in torch_device else 0
                model = WhisperModel(
                    model_name,
                    device='cuda',
                    device_index=real_device_index,
                    compute_type=compute_type,
                )
        except Exception as e:
            logger.error(f'Failed to load whisper model: {e}')
            raise Exception(f'Failed to load whisper model {model_name}: {e}')

        # Bundle model
        model_bundle = {
            'model': model,
            'language': language,
        }

        # Build metadata
        metadata = {
            'model_name': model_name,
            'device': torch_device,
            'gpu_index': gpu_index,
            'language': language,
            'compute_type': compute_type,
            'loader': 'whisper',
            'estimated_memory_gb': memory_gb,
        }

        logger.info(f'Whisper loaded: {model_name} on {torch_device}')

        return model_bundle, metadata, gpu_index

    @staticmethod
    def preprocess(
        model: Any,
        inputs: List[Any],
        metadata: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """
        Preprocess audio inputs for Whisper.

        Expects raw PCM int16 bytes (16kHz mono).

        Args:
            model: The model bundle (or ModelInstance for server mode)
            inputs: List of audio inputs (raw PCM int16 bytes)
            metadata: Optional metadata dict

        Returns:
            Dict with preprocessed audio data
        """
        import numpy as np

        processed_audios = []

        for inp in inputs:
            if not isinstance(inp, (bytes, bytearray)):
                raise ValueError(f'Expected bytes (PCM int16), got {type(inp)}')

            # Convert PCM int16 bytes to float32 numpy array
            int16_audio = np.frombuffer(inp, dtype=np.int16)
            float32_audio = int16_audio.astype(np.float32) / 32768.0
            processed_audios.append(float32_audio)

        # Get language from metadata or model bundle
        language = 'en'
        if metadata:
            language = metadata.get('language', 'en')
        elif isinstance(model, dict):
            language = model.get('language', 'en')

        return {
            'audios': processed_audios,
            'batch_size': len(inputs),
            'language': language,
        }

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> List[Dict[str, Any]]:
        """
        Run Whisper transcription.

        Uses faster-whisper with built-in Silero VAD for voice activity detection.

        Args:
            model: Model bundle or ModelInstance
            preprocessed: Output from preprocess()
            metadata: Optional metadata dict
            stream: Optional CUDA stream (not used)

        Returns:
            List of transcription results with segments
        """
        # Handle both direct model bundle and ModelInstance (server mode)
        if hasattr(model, 'model_obj'):
            # Server mode - ModelInstance
            models = model.model_obj
        else:
            # Local mode - direct model bundle
            models = model

        whisper_model = models['model']
        language = preprocessed.get('language', models.get('language', 'en'))

        # Get lock for this model instance (faster-whisper is NOT thread-safe)
        model_lock = WhisperLoader._get_model_lock(id(whisper_model))

        results = []

        for audio in preprocessed['audios']:
            # Validate audio - must be at least 0.1 seconds (1600 samples at 16kHz)
            if len(audio) < 1600:
                logger.warning(f'Audio too short ({len(audio)} samples), skipping')
                results.append({'segments': [], 'language': language, 'text': ''})
                continue

            try:
                # Lock to prevent concurrent access to faster-whisper model
                with model_lock:
                    # Transcribe with Silero VAD
                    segments_gen, info = whisper_model.transcribe(
                        audio,
                        language=language,
                        beam_size=5,
                        vad_filter=True,
                        vad_parameters={
                            'threshold': 0.5,
                            'min_silence_duration_ms': 500,
                            'speech_pad_ms': 400,
                        },
                    )

                    # Convert generator to list and build result
                    segments = []
                    full_text_parts = []

                    for segment in segments_gen:
                        seg_dict = {
                            'start': segment.start,
                            'end': segment.end,
                            'text': segment.text.strip(),
                        }
                        # Include word-level info if available
                        if segment.words:
                            seg_dict['words'] = [
                                {
                                    'word': w.word,
                                    'start': w.start,
                                    'end': w.end,
                                    'probability': w.probability,
                                }
                                for w in segment.words
                            ]
                        segments.append(seg_dict)
                        full_text_parts.append(segment.text.strip())

                    result = {
                        'segments': segments,
                        'language': info.language,
                        'text': ' '.join(full_text_parts),
                    }

                results.append(result)

            except Exception as e:
                logger.error(f'Transcription failed: {e}')
                results.append({'segments': [], 'language': language, 'text': '', 'error': str(e)})

        return results

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: List[Dict[str, Any]],
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """
        Postprocess Whisper output - extract only requested fields.

        Args:
            model: Model bundle or ModelInstance
            raw_output: Output from inference()
            batch_size: Expected batch size
            output_fields: Fields to extract (e.g., ['$text', '$segments'])
            **kwargs: Additional parameters (ignored)

        Returns:
            List of dicts with requested fields only
        """
        from ..extract import extract_outputs

        # Get language from metadata
        if hasattr(model, 'metadata'):
            language = model.metadata.get('language', 'en')
        elif isinstance(model, dict):
            language = model.get('language', 'en')
        else:
            language = 'en'

        results = []
        for output in raw_output:
            output_with_lang = {**output, 'language': language}
            extracted = extract_outputs(output_with_lang, output_fields)
            results.append(extracted)

        # Pad to batch size if needed
        empty = extract_outputs({'segments': [], 'language': language, 'text': ''}, output_fields)
        while len(results) < batch_size:
            results.append(empty.copy())

        return results[:batch_size]

    @staticmethod
    def _estimate_memory(model_name: str, **kwargs) -> float:
        """
        Estimate GPU memory required.

        Args:
            model_name: Whisper model size

        Returns:
            Estimated memory in GB
        """
        whisper_memory = {
            'tiny': 0.5,
            'tiny.en': 0.5,
            'base': 0.7,
            'base.en': 0.7,
            'small': 1.5,
            'small.en': 1.5,
            'medium': 3.0,
            'medium.en': 3.0,
            'large': 5.0,
            'large-v1': 5.0,
            'large-v2': 5.0,
            'large-v3': 5.0,
            'large-v3-turbo': 4.0,
            'turbo': 4.0,
        }

        return whisper_memory.get(model_name, 3.0)

    @staticmethod
    def get_supported_models() -> List[str]:
        """Get list of supported Whisper model sizes."""
        return [
            'tiny',
            'tiny.en',
            'base',
            'base.en',
            'small',
            'small.en',
            'medium',
            'medium.en',
            'large',
            'large-v1',
            'large-v2',
            'large-v3',
            'large-v3-turbo',
            'turbo',
        ]


class Whisper:
    """
    User-facing Whisper API with automatic local/remote detection.

    Uses faster-whisper (CTranslate2) with built-in Silero VAD.
    No pyannote dependency - fully MIT licensed.

    Usage:
        from ai.common.models import Whisper

        # Basic transcription
        model = Whisper('base', output_fields=['$text'])
        result = model.transcribe(audio_bytes)
        print(result['text'])

        # With segments
        model = Whisper('base', output_fields=['$text', '$segments'])
        result = model.transcribe(audio_bytes)
        for seg in result['segments']:
            print(f"{seg['start']:.2f} - {seg['end']:.2f}: {seg['text']}")
    """

    def __init__(
        self,
        model_name: str = 'base',
        output_fields: Optional[List[str]] = None,
        device: Optional[str] = None,
        language: str = 'en',
        compute_type: str = 'float16',
        **kwargs,
    ):
        """
        Initialize Whisper.

        Args:
            model_name: Whisper model size ('tiny', 'base', 'small', 'medium', 'large-v3')
            output_fields: Fields to extract (default: ['$text'])
            device: Device ('server', 'cuda', 'cpu', 'cuda:N', or None for auto)
            language: Language code for transcription
            compute_type: Compute type ('float16', 'int8', etc.)
            **kwargs: Additional arguments (ignored for compatibility)
        """
        self.model_name = model_name
        self.output_fields = output_fields or ['$text']
        self.device = device
        self.language = language
        self.compute_type = compute_type
        self.kwargs = kwargs

        # Check if we should proxy to server
        server_addr = get_model_server_address()
        should_proxy = server_addr and (device is None or device == 'server')

        if should_proxy:
            # === REMOTE MODE ===
            self._proxy_mode = True
            host, port = server_addr
            self._client = ModelClient(port, host)
            self._model = None
            self._metadata = {}
            self._init_proxy()
        else:
            # === LOCAL MODE ===
            self._proxy_mode = False
            self._client = None

            # Use loader to load model
            self._model, self._metadata, _ = WhisperLoader.load(
                model_name,
                device=device if device != 'server' else None,
                language=language,
                compute_type=compute_type,
            )

    def _init_proxy(self) -> None:
        """Initialize proxy connection and load model on server."""
        loader_options = {
            'language': self.language,
            'compute_type': self.compute_type,
        }
        if self.kwargs:
            loader_options.update(self.kwargs)

        self._client.load_model(
            model_name=self.model_name,
            model_type='whisper',
            loader_options=loader_options,
        )
        self._metadata = self._client.metadata

    def transcribe(
        self,
        audio: bytes,
        beam_size: int = 5,
        vad_filter: bool = True,
        vad_parameters: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Transcribe audio to text with timestamps.

        Args:
            audio: Raw PCM int16 bytes (16kHz mono)
            beam_size: Beam size for decoding
            vad_filter: Enable voice activity detection (Silero VAD)
            vad_parameters: VAD parameters dict
            **kwargs: Additional transcription arguments

        Returns:
            Dict with requested output fields (e.g., 'text', 'segments')
        """
        if not isinstance(audio, bytes):
            raise TypeError(f'audio must be bytes (PCM int16), got {type(audio)}')

        if self._proxy_mode:
            return self._transcribe_remote(audio, beam_size, vad_filter, vad_parameters, **kwargs)
        else:
            return self._transcribe_local(audio, **kwargs)

    def _transcribe_local(self, audio: bytes, **kwargs) -> Dict[str, Any]:
        """Execute local transcription using loader methods."""
        preprocessed = WhisperLoader.preprocess(self._model, [audio], self._metadata)
        raw_output = WhisperLoader.inference(self._model, preprocessed, self._metadata)
        results = WhisperLoader.postprocess(self._model, raw_output, 1, self.output_fields)

        return results[0] if results else {}

    def _transcribe_remote(
        self,
        audio: bytes,
        beam_size: int,
        vad_filter: bool,
        vad_parameters: Optional[Dict[str, Any]],
        **kwargs,
    ) -> Dict[str, Any]:
        """Execute remote transcription via model server."""
        result = self._client.send_command(
            'inference',
            {
                'data': audio,
                'beam_size': beam_size,
                'vad_filter': vad_filter,
                'vad_parameters': vad_parameters,
                'output_fields': self.output_fields,
                **kwargs,
            },
        )

        results = result.get('result', [])
        if results and len(results) > 0:
            return results[0]
        return {}

    def disconnect(self) -> None:
        """Disconnect from model server (proxy mode only)."""
        if self._proxy_mode and self._client:
            self._client.disconnect()

    @property
    def is_proxy(self) -> bool:
        """Check if running in proxy mode."""
        return self._proxy_mode

    @property
    def metadata(self) -> Dict:
        """Get model metadata."""
        return self._metadata
