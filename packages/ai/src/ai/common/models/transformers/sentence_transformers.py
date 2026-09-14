"""
SentenceTransformer: Combined loader and user-facing API.

This module provides:
- SentenceTransformerLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- SentenceTransformer: User-facing class with automatic local/remote mode detection
  (used by connectors)
"""

from __future__ import annotations

import logging
import os
import threading
import time
import weakref
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple, Union

if TYPE_CHECKING:
    import numpy as np

from ai.web.metrics import metrics
from ai.common.utils.cuda_utils import model_gpu_gb
from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.sentence_transformers')


class SentenceTransformerLoader(BaseLoader):
    """
    Static loader for sentence_transformers models.

    Used by:
    - Model server (directly calls static methods)
    - SentenceTransformer wrapper (for local mode)

    Key characteristics:
    - Stateless after loading (thread-safe)
    - Batch processing via tokenizer
    - GPU-accelerated embedding generation
    - Supports CPU-first loading for accurate memory measurement
    """

    LOADER_TYPE: str = 'sentence_transformer'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_sentence_transformers.txt')
    _DEFAULTS: dict = {}  # SentenceTransformers typically only vary by model_name

    # Per-model locks for thread safety. A single torch module cannot run
    # concurrent forward passes safely, so the forward call in inference() is
    # serialized per model instance. Tokenization, tensor transfer, pooling and
    # postprocess all stay outside the lock and are free to overlap.
    _model_locks: Dict[int, threading.Lock] = {}
    _locks_lock = threading.Lock()

    # Per-thread carrier for time spent waiting on a model lock. inference()
    # records it here so the local encode path can bill contention as queue
    # wait instead of GPU compute, without changing the loader's signature
    # (the model server calls these static methods directly).
    _lock_wait = threading.local()

    @classmethod
    def _get_model_lock(cls, model: Any) -> threading.Lock:
        """Get or create the forward-pass lock for a model instance.

        The registry is keyed on ``id(model)`` to match ``WhisperLoader``, and a
        finalizer drops the entry once the model is collected. Without that, the
        dict would grow for the process lifetime and a later object reusing a
        freed id could inherit an unrelated model's lock.
        """
        model_id = id(model)
        with cls._locks_lock:
            lock = cls._model_locks.get(model_id)
            if lock is None:
                lock = threading.Lock()
                cls._model_locks[model_id] = lock
                try:
                    weakref.finalize(model, cls._drop_model_lock, model_id)
                except TypeError:
                    # Not weak-referenceable. Keep the entry rather than fail
                    # the forward pass; correctness never depends on eviction.
                    pass
            return lock

    @classmethod
    def _drop_model_lock(cls, model_id: int) -> None:
        """Remove a retired model's lock entry."""
        with cls._locks_lock:
            cls._model_locks.pop(model_id, None)

    @classmethod
    def _add_lock_wait(cls, wait_ms: float) -> None:
        """Accumulate lock wait (ms) for the current thread's encode call."""
        cls._lock_wait.value = getattr(cls._lock_wait, 'value', 0.0) + wait_ms

    @classmethod
    def take_lock_wait(cls) -> float:
        """Return and reset the lock wait (ms) accumulated on this thread."""
        wait_ms = getattr(cls._lock_wait, 'value', 0.0)
        cls._lock_wait.value = 0.0
        return wait_ms

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """
        Load a sentence_transformers model.

        Two modes:
        - Local mode (device specified): Load directly to device
        - Server mode (allocate_gpu provided): CPU-first, measure, allocate, move

        Args:
            model_name: Model name or path (e.g., 'all-MiniLM-L6-v2')
            device: Device for local mode ('cuda:0', 'cpu', etc.)
            allocate_gpu: Callback for server mode (memory_gb, exclude_gpus) -> (gpu_index, device_str)
            exclude_gpus: GPUs to exclude (server mode)
            **kwargs: Additional arguments for SentenceTransformer

        Returns:
            Tuple of (model_object, metadata_dict, gpu_index)
        """
        SentenceTransformerLoader._ensure_dependencies()

        from sentence_transformers import SentenceTransformer as ST

        # Strip 'sentence-transformer/' prefix if present
        if model_name.startswith('sentence-transformer/'):
            model_name = model_name[21:]

        # Enable trust_remote_code by default (can be overridden via kwargs)
        kwargs.setdefault('trust_remote_code', True)

        exclude_gpus = exclude_gpus or []

        if allocate_gpu:
            # === SERVER MODE: CPU-first for accurate memory measurement ===
            logger.info(f'Loading SentenceTransformer {model_name} to CPU...')
            model = ST(model_name_or_path=model_name, device='cpu', **kwargs)
            model.eval()

            memory_gb = SentenceTransformerLoader._get_memory_footprint(model)
            logger.debug(f'Measured memory footprint: {memory_gb:.2f} GB')

            gpu_index, device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({device}) for {model_name}')

            model.to(device)
            model.eval()
        else:
            # === LOCAL MODE: Load directly to specified device ===
            if device is None:
                # Auto-detect
                from ai.common.torch import torch

                device = 'cuda:0' if torch.cuda.is_available() else 'cpu'

            logger.info(f'Loading SentenceTransformer {model_name} to {device}')
            model = ST(model_name_or_path=model_name, device=device, **kwargs)
            model.eval()

            gpu_index = int(device.split(':')[1]) if ':' in device else (0 if device == 'cuda' else -1)
            memory_gb = SentenceTransformerLoader._get_memory_footprint(model)

        metadata = {
            'embedding_dimension': model.get_sentence_embedding_dimension(),
            'max_seq_length': model.max_seq_length,
            'device': device,
            'model_name': model_name,
            'loader': 'sentence_transformer',
            'estimated_memory_gb': memory_gb,
        }

        return model, metadata, gpu_index

    @staticmethod
    def preprocess(model: Any, inputs: List[str], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """
        Preprocess inputs for sentence transformer.

        Args:
            model: The SentenceTransformer model or ModelInstanceWrapper
            inputs: List of text strings
            metadata: Optional metadata dict

        Returns:
            Dict with 'encoded' key containing tokenized tensors
        """
        # Handle ModelInstanceWrapper (server mode)
        if hasattr(model, 'model_obj'):
            actual_model = model.model_obj
        else:
            actual_model = model

        tokenizer = actual_model.tokenizer
        encoded = tokenizer(
            inputs,
            padding=True,
            truncation=True,
            return_tensors='pt',
            max_length=actual_model.max_seq_length,
        )

        return {
            'encoded': encoded,
            'batch_size': len(inputs),
        }

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        """
        Run inference on GPU.

        Args:
            model: The SentenceTransformer model or ModelInstanceWrapper
            preprocessed: Output from preprocess()
            metadata: Optional metadata dict
            stream: Optional CUDA stream

        Returns:
            Embedding tensor
        """
        from ai.common.torch import torch

        # Handle ModelInstanceWrapper (server mode)
        if hasattr(model, 'model_obj'):
            actual_model = model.model_obj
            device = model.metadata.get('device', 'cuda:0')
        else:
            actual_model = model
            device = metadata.get('device', 'cuda:0') if metadata else str(actual_model.device)

        encoded = preprocessed['encoded']
        transformer_model = actual_model[0].auto_model

        # Serialize the forward pass per model instance. Callers that share one
        # model across threads (local wrapper and model server alike) would
        # otherwise interleave forward passes on the same module and read back
        # embeddings computed for another thread's batch.
        model_lock = SentenceTransformerLoader._get_model_lock(actual_model)

        with torch.no_grad():
            # Transfer touches only this thread's tensors, so it stays unlocked.
            inputs_gpu = {k: v.to(device) for k, v in encoded.items()}

            # Only the forward call shares mutable module state.
            t_wait = time.perf_counter()
            model_lock.acquire()
            wait_ms = (time.perf_counter() - t_wait) * 1000
            try:
                outputs = transformer_model(**inputs_gpu)
            finally:
                model_lock.release()

            SentenceTransformerLoader._add_lock_wait(wait_ms)

            # Pooling and normalization read this thread's own output tensors
            # and are safe to overlap with another thread's forward pass.
            token_embeddings = outputs.last_hidden_state
            attention_mask = inputs_gpu['attention_mask']
            mask_expanded = attention_mask.unsqueeze(-1).expand(token_embeddings.size()).float()
            sum_embeddings = torch.sum(token_embeddings * mask_expanded, dim=1)
            sum_mask = torch.clamp(mask_expanded.sum(dim=1), min=1e-9)
            embeddings = sum_embeddings / sum_mask

            # L2 normalize
            embeddings = torch.nn.functional.normalize(embeddings, p=2, dim=1)

        return embeddings

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """
        Postprocess embedding output.

        Args:
            model: The SentenceTransformer model (unused but kept for API consistency)
            raw_output: Embedding tensor from inference() [batch_size, embedding_dim]
            batch_size: Expected batch size
            output_fields: Fields to extract (e.g., ['embeddings'] or ['$embeddings'])
            **kwargs: Additional parameters (ignored)

        Returns:
            List of dicts with requested fields

        Supported output_fields:
            embeddings  - Raw embedding tensor slice (auto-serialized for JSON)
            $embeddings - Explicit conversion to list (same result, clearer intent)
        """
        from ..extract import extract_outputs

        results = []
        for i in range(batch_size):
            # Pass raw tensor slice - let extract_outputs handle conversion
            item_output = {'embeddings': raw_output[i]}
            extracted = extract_outputs(item_output, output_fields)
            results.append(extracted)

        return results

    @staticmethod
    def _get_memory_footprint(model: Any) -> float:
        """Get actual GPU memory footprint from a loaded model."""
        try:
            total_params = sum(p.numel() for p in model.parameters())
            bytes_per_param = 4
            total_bytes = total_params * bytes_per_param * 1.2  # 20% overhead
            return total_bytes / (1024**3)
        except Exception:
            return 0.5


class SentenceTransformer:
    """
    User-facing SentenceTransformer API with automatic local/remote detection.

    Used by connectors. Automatically routes to model server if available,
    otherwise runs locally using SentenceTransformerLoader.

    Usage:
        from ai.common.models import SentenceTransformer

        # Auto-detection (default: $embeddings for JSON-serialized output)
        model = SentenceTransformer('all-MiniLM-L6-v2')
        embeddings = model.encode(['hello world'])

        # Force local with explicit output fields
        model = SentenceTransformer('all-MiniLM-L6-v2', output_fields=['$embeddings'], device='cuda:0')

    Output fields:
        $embeddings - Embedding vectors as JSON-serializable lists (default)
        embeddings  - Same result (auto-serialized for JSON transport)
    """

    def __init__(
        self,
        model_name_or_path: str,
        output_fields: Optional[List[str]] = None,
        device: Optional[str] = None,
        **kwargs,
    ):
        """
        Initialize SentenceTransformer.

        Args:
            model_name_or_path: Model name or path
            output_fields: Fields to extract (default: ['embeddings'])
            device: Device ('server', 'cuda', 'cpu', 'cuda:N', or None for auto)
            **kwargs: Additional arguments for model loading
        """
        self.model_name = model_name_or_path
        self.output_fields = output_fields or ['$embeddings']
        self.device = device
        self.kwargs = kwargs

        # Check if we should proxy to server
        server_addr = get_model_server_address()
        should_proxy = server_addr and (device is None or device == 'server')

        if should_proxy:
            # === REMOTE MODE ===
            self._proxy_mode = True
            self._client = ModelClient(server_addr)
            self._model = None
            self._metadata = {}
            self._init_proxy()
        else:
            # === LOCAL MODE ===
            self._proxy_mode = False
            self._client = None

            # Use loader to load model
            self._model, self._metadata, _ = SentenceTransformerLoader.load(
                model_name_or_path,
                device=device if device != 'server' else None,
                **kwargs,
            )

    def _init_proxy(self) -> None:
        """Initialize proxy connection and load model on server."""
        # Note: output_fields is NOT passed during load - it's per-request
        self._client.load_model(
            model_name=self.model_name,
            model_type='sentence_transformer',
            loader_options=self.kwargs if self.kwargs else None,
        )
        self._metadata = self._client.metadata

    def encode(
        self,
        sentences: Union[str, List[str]],
        batch_size: int = 32,
        show_progress_bar: bool = False,
        **kwargs,
    ) -> np.ndarray:
        """
        Encode sentences into embeddings.

        Args:
            sentences: Single sentence or list of sentences
            batch_size: Batch size for encoding
            show_progress_bar: Whether to show progress bar (local only)
            **kwargs: Additional encoding arguments

        Returns:
            numpy array of embeddings
        """
        if isinstance(sentences, str):
            sentences = [sentences]

        # Count inference call — perf timing handled per-mode below
        metrics.counter('gpu_inference_count', 1)

        if self._proxy_mode:
            # Model server mode — ModelClient.send_command handles perf timing
            return self._encode_remote(sentences, batch_size, **kwargs)
        else:
            # Local mode — time each phase across all batch iterations
            return self._encode_local(sentences, batch_size, **kwargs)

    def _encode_local(self, sentences: List[str], batch_size: int, **kwargs) -> np.ndarray:
        """
        Execute local encoding using loader methods.

        Times each phase (preprocess/inference/postprocess) per batch
        iteration and accumulates totals for billing.
        """
        import numpy as np

        all_embeddings = []

        # Accumulate timing across all batch iterations
        t_pre = 0.0
        t_gpu = 0.0
        t_post = 0.0
        t_queue = 0.0

        # Drop any wait left on this thread by an earlier call so the first
        # batch below does not inherit it.
        SentenceTransformerLoader.take_lock_wait()

        # Process in batches. Serialization of the shared model happens inside
        # SentenceTransformerLoader.inference(), so tokenization and postprocess
        # here stay concurrent across threads.
        for i in range(0, len(sentences), batch_size):
            batch = sentences[i : i + batch_size]

            # Preprocess phase
            t0 = time.perf_counter()
            preprocessed = SentenceTransformerLoader.preprocess(self._model, batch, self._metadata)
            t_pre += (time.perf_counter() - t0) * 1000

            # GPU inference phase. Time spent blocked on another thread's
            # forward pass is contention, not compute, so it is billed as
            # queue wait instead of inflating gpu_compute.
            t0 = time.perf_counter()
            raw_output = SentenceTransformerLoader.inference(self._model, preprocessed, self._metadata)
            elapsed = (time.perf_counter() - t0) * 1000
            wait = SentenceTransformerLoader.take_lock_wait()
            t_gpu += max(elapsed - wait, 0.0)
            t_queue += wait

            # Postprocess phase
            t0 = time.perf_counter()
            results = SentenceTransformerLoader.postprocess(self._model, raw_output, len(batch), self.output_fields)
            t_post += (time.perf_counter() - t0) * 1000

            # Extract embeddings from results (handles both 'embeddings' and '$embeddings')
            for result in results:
                emb = result.get('$embeddings') or result.get('embeddings') or result
                all_embeddings.append(emb)

        # Report all perf counters — same keys as model server response.
        # Queue wait stays inside inference_sec: the model still occupies GPU
        # memory while a thread waits, so GB-seconds are unchanged.
        inference_sec = (t_pre + t_gpu + t_queue + t_post) / 1000.0
        metrics.add_time(
            {
                'gpu_preprocess': t_pre,
                'gpu_compute': t_gpu,
                'gpu_postprocess': t_post,
                'gpu_queue_wait': t_queue,
                'gpu_memory': model_gpu_gb(self._model) * inference_sec,
            }
        )

        return np.array(all_embeddings)

    def _encode_remote(self, sentences: List[str], batch_size: int, **kwargs) -> np.ndarray:
        """Execute remote encoding via model server."""
        import numpy as np

        result = self._client.send_command(
            'rrext_ms_inference',
            {
                'command': 'encode',
                'inputs': sentences,
                'batch_size': batch_size,
                'output_fields': self.output_fields,
                **kwargs,
            },
        )

        # Server returns list of dicts with extracted fields
        results = result.get('result', [])

        # Extract embeddings (handles both 'embeddings' and '$embeddings')
        embeddings = []
        for r in results:
            if isinstance(r, dict):
                emb = r.get('$embeddings') or r.get('embeddings') or r
            else:
                emb = r
            embeddings.append(emb)

        return np.array(embeddings)

    def get_sentence_embedding_dimension(self) -> int:
        """Get embedding dimension."""
        if self._proxy_mode:
            return self._metadata.get('embedding_dimension', 384)
        return self._model.get_sentence_embedding_dimension()

    @property
    def max_seq_length(self) -> int:
        """Get maximum sequence length."""
        if self._proxy_mode:
            return self._metadata.get('max_seq_length', 512)
        return self._model.max_seq_length

    @property
    def metadata(self) -> Dict:
        """Get model metadata."""
        return self._metadata
