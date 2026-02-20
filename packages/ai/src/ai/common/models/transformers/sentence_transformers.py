"""
SentenceTransformer: Combined loader and user-facing API.

This module provides:
- SentenceTransformerLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- SentenceTransformer: User-facing class with automatic local/remote mode detection
  (used by connectors)
"""

import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

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

        with torch.no_grad():
            inputs_gpu = {k: v.to(device) for k, v in encoded.items()}
            outputs = transformer_model(**inputs_gpu)

            # Mean pooling
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

        if self._proxy_mode:
            return self._encode_remote(sentences, batch_size, **kwargs)
        else:
            return self._encode_local(sentences, batch_size, **kwargs)

    def _encode_local(self, sentences: List[str], batch_size: int, **kwargs) -> np.ndarray:
        """Execute local encoding using loader methods."""
        all_embeddings = []

        # Process in batches
        for i in range(0, len(sentences), batch_size):
            batch = sentences[i : i + batch_size]

            # Use loader pipeline
            preprocessed = SentenceTransformerLoader.preprocess(self._model, batch, self._metadata)
            raw_output = SentenceTransformerLoader.inference(self._model, preprocessed, self._metadata)
            results = SentenceTransformerLoader.postprocess(self._model, raw_output, len(batch), self.output_fields)

            # Extract embeddings from results (handles both 'embeddings' and '$embeddings')
            for result in results:
                emb = result.get('$embeddings') or result.get('embeddings') or result
                all_embeddings.append(emb)

        return np.array(all_embeddings)

    def _encode_remote(self, sentences: List[str], batch_size: int, **kwargs) -> np.ndarray:
        """Execute remote encoding via model server."""
        result = self._client.send_command(
            'inference',
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
