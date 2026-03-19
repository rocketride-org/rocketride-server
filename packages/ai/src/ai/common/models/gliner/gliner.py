"""
GLiNER: Combined loader and user-facing API for zero-shot NER.

This module provides:
- GLiNERLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- GLiNER: User-facing class with automatic local/remote mode detection
  (used by connectors like anonymize)
"""

import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.gliner')


class GLiNERLoader(BaseLoader):
    """
    Static loader for GLiNER models (zero-shot NER).

    Used by:
    - Model server (directly calls static methods)
    - GLiNER wrapper (for local mode)

    Key characteristics:
    - Supports dynamic labels at inference time
    - GPU-accelerated entity recognition
    - Stateless after loading (thread-safe)
    """

    LOADER_TYPE: str = 'gliner'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_gliner.txt')
    _DEFAULTS: dict = {
        'threshold': 0.5,
        'flat_ner': True,
        'multi_label': False,
    }

    @staticmethod
    def load(
        model_name: str,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """
        Load a GLiNER model.

        Two modes:
        - Local mode (device specified): Load directly to device
        - Server mode (allocate_gpu provided): CPU-first, measure, allocate, move

        Args:
            model_name: Model name or path (e.g., 'urchade/gliner_small-v2.1')
            device: Device for local mode ('cuda:0', 'cpu', etc.)
            allocate_gpu: Callback for server mode (memory_gb, exclude_gpus) -> (gpu_index, device_str)
            exclude_gpus: GPUs to exclude (server mode)
            **kwargs: Additional arguments for GLiNER

        Returns:
            Tuple of (model_object, metadata_dict, gpu_index)
        """
        GLiNERLoader._ensure_dependencies()
        GLiNERLoader._patch_mecab()

        from gliner import GLiNER as GLiNERModel

        exclude_gpus = exclude_gpus or []

        if allocate_gpu:
            # === SERVER MODE: CPU-first for accurate memory measurement ===
            logger.info(f'Loading GLiNER {model_name} to CPU...')
            model = GLiNERModel.from_pretrained(model_name)
            model.to('cpu')
            model.eval()

            memory_gb = GLiNERLoader._get_memory_footprint(model)
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

            logger.info(f'Loading GLiNER {model_name} to {device}')
            model = GLiNERModel.from_pretrained(model_name)
            model.to(device)
            model.eval()

            gpu_index = int(device.split(':')[1]) if ':' in device else (0 if device == 'cuda' else -1)
            memory_gb = GLiNERLoader._get_memory_footprint(model)

        metadata = {
            'device': device,
            'model_name': model_name,
            'loader': 'gliner',
            'estimated_memory_gb': memory_gb,
        }

        return model, metadata, gpu_index

    @staticmethod
    def _patch_mecab() -> None:
        """
        Patch python-mecab-ko to avoid pybind11::stop_iteration crash on Python 3.12 / Linux.

        python-mecab-ko 1.3.7 iterates over the MeCab lattice via `for span, node in lattice`,
        which triggers a pybind11::stop_iteration C++ exception that escapes and terminates
        the process on Python 3.12/Linux. The fix replaces the iteration with bos_node().next
        traversal that computes spans from node.rlength / node.length directly.
        """
        import sys

        if sys.platform == 'win32':
            return  # Windows is not affected; its MSVC C++ runtime handles this correctly

        # On Linux and macOS, python-mecab-ko 1.3.7 crashes with:
        #   libc++abi: terminating due to uncaught exception of type pybind11::stop_iteration
        # The culprit is `for span, node in lattice` in mecab/mecab.py — pybind11's stop_iteration
        # C++ exception escapes to the runtime and calls std::terminate() instead of being
        # translated to Python StopIteration. Replace it with bos_node()+.next traversal.
        try:
            import mecab as _mecab_pkg
            from mecab.types import Morpheme

            def _patched_parse(self, sentence: str):
                from mecab.utils import create_lattice
                from mecab.mecab import MeCabError

                lattice = create_lattice(sentence)
                if not self._tagger.parse(lattice):
                    raise MeCabError(self._tagger.what())
                morphemes = []
                node = lattice.bos_node()
                pos = 0
                while node is not None:
                    rl = node.rlength
                    if node.surface:
                        start = pos + (rl - node.length)
                        morphemes.append(Morpheme._from_node((start, pos + rl), node))
                    pos += rl
                    node = node.next
                return morphemes

            _mecab_pkg.MeCab.parse = _patched_parse
        except Exception:
            pass  # mecab not installed; gliner_ko won't work but won't crash

    @staticmethod
    def preprocess(model: Any, inputs: List[Dict], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """
        Preprocess inputs for GLiNER.

        Args:
            model: The GLiNER model or ModelInstanceWrapper
            inputs: List of dicts with 'text' and 'labels' keys
            metadata: Optional metadata dict

        Returns:
            Dict with preprocessed data
        """
        # GLiNER doesn't need much preprocessing - just validate inputs
        texts = []
        labels_list = []

        for item in inputs:
            texts.append(item.get('text', ''))
            labels_list.append(item.get('labels', []))

        return {
            'texts': texts,
            'labels_list': labels_list,
            'batch_size': len(inputs),
        }

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
        threshold: float = 0.5,
        flat_ner: bool = True,
        multi_label: bool = False,
    ) -> Any:
        """
        Run GLiNER inference.

        Args:
            model: The GLiNER model or ModelInstanceWrapper
            preprocessed: Output from preprocess()
            metadata: Optional metadata dict
            stream: Optional CUDA stream (unused)
            threshold: Confidence threshold for entity detection
            flat_ner: Whether to use flat NER (no nested entities)
            multi_label: Whether to allow multiple labels per span

        Returns:
            List of entity results per input
        """
        from ai.common.torch import torch

        # Handle ModelInstanceWrapper (server mode)
        if hasattr(model, 'model_obj'):
            actual_model = model.model_obj
        else:
            actual_model = model

        texts = preprocessed['texts']
        labels_list = preprocessed['labels_list']
        results = []

        with torch.no_grad():
            for text, labels in zip(texts, labels_list):
                if not text or not labels:
                    results.append([])
                    continue

                # GLiNER's predict_entities returns list of dicts
                entities = actual_model.predict_entities(
                    text,
                    labels,
                    threshold=threshold,
                    flat_ner=flat_ner,
                    multi_label=multi_label,
                )
                results.append(entities)

        return results

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """
        Postprocess GLiNER output.

        Args:
            model: The GLiNER model (unused but kept for API consistency)
            raw_output: List of entity lists from inference()
            batch_size: Expected batch size
            output_fields: Fields to extract (e.g., ['entities'])
            **kwargs: Additional parameters (ignored)

        Returns:
            List of dicts with entity results
        """
        from ..extract import extract_outputs

        results = []
        for i in range(batch_size):
            entities = raw_output[i] if i < len(raw_output) else []
            item_output = {'entities': entities}
            extracted = extract_outputs(item_output, output_fields)
            results.append(extracted)

        return results

    @staticmethod
    def _get_memory_footprint(model: Any) -> float:
        """Get actual GPU memory footprint from a loaded model."""
        try:
            # GLiNER model has a .model attribute that's the underlying transformer
            if hasattr(model, 'model'):
                total_params = sum(p.numel() for p in model.model.parameters())
            else:
                total_params = sum(p.numel() for p in model.parameters())
            bytes_per_param = 4
            total_bytes = total_params * bytes_per_param * 1.2  # 20% overhead
            return total_bytes / (1024**3)
        except Exception:
            return 0.5


class GLiNER:
    """
    User-facing GLiNER API with automatic local/remote detection.

    Used by connectors like anonymize. Automatically routes to model server
    if available, otherwise runs locally using GLiNERLoader.

    Usage:
        from ai.common.models import GLiNER

        # Auto-detection
        model = GLiNER('urchade/gliner_small-v2.1')
        entities = model.predict_entities('John works at Google', ['person', 'organization'])

        # Force local
        model = GLiNER('urchade/gliner_small-v2.1', device='cuda:0')
    """

    def __init__(
        self,
        model_name_or_path: str,
        device: Optional[str] = None,
        threshold: float = 0.5,
        flat_ner: bool = True,
        multi_label: bool = False,
        **kwargs,
    ):
        """
        Initialize GLiNER.

        Args:
            model_name_or_path: Model name or path
            device: Device ('server', 'cuda', 'cpu', 'cuda:N', or None for auto)
            threshold: Confidence threshold for entity detection
            flat_ner: Whether to use flat NER (no nested entities)
            multi_label: Whether to allow multiple labels per span
            **kwargs: Additional arguments for model loading
        """
        self.model_name = model_name_or_path
        self.device = device
        self.threshold = threshold
        self.flat_ner = flat_ner
        self.multi_label = multi_label
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
            self._model, self._metadata, _ = GLiNERLoader.load(
                model_name_or_path,
                device=device if device != 'server' else None,
                **kwargs,
            )

    def _init_proxy(self) -> None:
        """Initialize proxy connection and load model on server."""
        loader_options = {
            'threshold': self.threshold,
            'flat_ner': self.flat_ner,
            'multi_label': self.multi_label,
            **self.kwargs,
        }
        self._client.load_model(
            model_name=self.model_name,
            model_type='gliner',
            loader_options=loader_options if loader_options else None,
        )
        self._metadata = self._client.metadata

    def predict_entities(
        self,
        text: str,
        labels: List[str],
        threshold: Optional[float] = None,
        flat_ner: Optional[bool] = None,
        multi_label: Optional[bool] = None,
    ) -> List[Dict[str, Any]]:
        """
        Predict entities in text.

        Args:
            text: Input text
            labels: List of entity labels to detect
            threshold: Override default threshold
            flat_ner: Override default flat_ner
            multi_label: Override default multi_label

        Returns:
            List of entity dicts with 'start', 'end', 'text', 'label', 'score' keys
        """
        if self._proxy_mode:
            return self._predict_remote(text, labels, threshold, flat_ner, multi_label)
        else:
            return self._predict_local(text, labels, threshold, flat_ner, multi_label)

    def _predict_local(
        self,
        text: str,
        labels: List[str],
        threshold: Optional[float],
        flat_ner: Optional[bool],
        multi_label: Optional[bool],
    ) -> List[Dict[str, Any]]:
        """Execute local prediction using loader methods."""
        # Use provided values or defaults
        threshold = threshold if threshold is not None else self.threshold
        flat_ner = flat_ner if flat_ner is not None else self.flat_ner
        multi_label = multi_label if multi_label is not None else self.multi_label

        # Use loader pipeline
        preprocessed = GLiNERLoader.preprocess(
            self._model,
            [{'text': text, 'labels': labels}],
            self._metadata,
        )
        raw_output = GLiNERLoader.inference(
            self._model,
            preprocessed,
            self._metadata,
            threshold=threshold,
            flat_ner=flat_ner,
            multi_label=multi_label,
        )

        # Return the first (and only) result
        return raw_output[0] if raw_output else []

    def _predict_remote(
        self,
        text: str,
        labels: List[str],
        threshold: Optional[float],
        flat_ner: Optional[bool],
        multi_label: Optional[bool],
    ) -> List[Dict[str, Any]]:
        """Execute remote prediction via model server."""
        # Use provided values or defaults
        threshold = threshold if threshold is not None else self.threshold
        flat_ner = flat_ner if flat_ner is not None else self.flat_ner
        multi_label = multi_label if multi_label is not None else self.multi_label

        result = self._client.send_command(
            'inference',
            {
                'command': 'predict_entities',
                'inputs': [{'text': text, 'labels': labels}],
                'threshold': threshold,
                'flat_ner': flat_ner,
                'multi_label': multi_label,
                'output_fields': ['entities'],
            },
        )

        # Server returns list of results
        results = result.get('result', [])
        if results and isinstance(results[0], dict):
            return results[0].get('entities', [])
        return results[0] if results else []

    def to(self, device: str) -> 'GLiNER':
        """
        Move model to device (local mode only).

        Args:
            device: Target device

        Returns:
            self for chaining
        """
        if not self._proxy_mode and self._model is not None:
            self._model.to(device)
            self._metadata['device'] = device
        return self

    @property
    def metadata(self) -> Dict:
        """Get model metadata."""
        return self._metadata
