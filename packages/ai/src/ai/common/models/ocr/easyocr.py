"""
EasyOCR: Combined loader and user-facing API for EasyOCR.

This module provides:
- EasyOCRLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- EasyOCR: User-facing class with automatic local/remote mode detection
  (used by connectors)

EasyOCR is a general-purpose OCR library supporting 80+ languages.
It uses PyTorch under the hood and supports GPU acceleration.

Features:
- Intelligent transparency/alpha handling
- Line grouping (words grouped into lines by y-coordinate)
- 80+ language support
- GPU acceleration

Binary Transfer:
    Images are transferred as PNG/JPEG bytes in the DAP 'data' field.

Output Format:
    {
        'text': 'Line oneCRLine twoCRLine three',
        'boxes': [
            {'text': 'Hello', 'bbox': [x1, y1, x2, y2], 'confidence': 0.98, 'line': 0},
            ...
        ]
    }
"""

import io
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple, Union

from ai.web.metrics import metrics
from ai.common.utils.cuda_utils import model_gpu_gb
from ..base import BaseLoader, get_model_server_address, ModelClient
from .utils import preprocess_image_transparency, group_words_into_lines

logger = logging.getLogger('rocketlib.models.easyocr')


class EasyOCRLoader(BaseLoader):
    """
    Static loader for EasyOCR models.

    Used by:
    - Model server (directly calls static methods)
    - EasyOCR wrapper (for local mode)

    Features:
    - 80+ language support
    - GPU acceleration (PyTorch)
    - Text detection + recognition

    Model Identity (for sharing):
        languages list determines model identity
    """

    LOADER_TYPE: str = 'easyocr'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_easyocr.txt')

    # Defaults applied before hashing (ensures consistent model IDs)
    _DEFAULTS = {
        'languages': ['en'],
    }

    @staticmethod
    def load(
        model_name: str = 'easyocr',
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        languages: Optional[List[str]] = None,
        **kwargs,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], int]:
        """
        Load EasyOCR reader.

        Args:
            model_name: Ignored (EasyOCR doesn't use model names)
            device: Device for local mode ('cuda:0', 'cpu')
            allocate_gpu: Callback for server mode
            exclude_gpus: GPUs to exclude
            languages: Languages to support (default: ['en'])
            **kwargs: Additional EasyOCR arguments

        Returns:
            Tuple of (model_bundle, metadata_dict, gpu_index)
        """
        EasyOCRLoader._ensure_dependencies()

        # Import opencv BEFORE easyocr - this ensures opencv-contrib-python-headless
        # is installed and any conflicting opencv packages are removed
        from ai.common.opencv import cv2  # noqa: F401

        import easyocr
        from ai.common.torch import torch

        languages = languages or ['en']
        exclude_gpus = exclude_gpus or []

        # Estimate memory (~1.5GB for detection + recognition models)
        memory_gb = 1.5

        if allocate_gpu:
            gpu_index, torch_device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({torch_device}) for EasyOCR')
            use_gpu = torch_device != 'cpu'
        else:
            if device is None:
                device = 'cuda' if torch.cuda.is_available() else 'cpu'

            if device == 'cpu':
                gpu_index = -1
                torch_device = 'cpu'
                use_gpu = False
            elif ':' in device:
                gpu_index = int(device.split(':')[1])
                torch_device = device
                use_gpu = True
            else:
                gpu_index = 0
                torch_device = 'cuda:0'
                use_gpu = True

        logger.info(f'Loading EasyOCR with languages {languages} on {torch_device}')

        try:
            reader = easyocr.Reader(
                languages,
                gpu=use_gpu,
                verbose=False,
            )
        except Exception as e:
            logger.error(f'Failed to load EasyOCR: {e}')
            raise Exception(f'Failed to load EasyOCR: {e}')

        # EasyOCR wraps its detector and recognizer in DataParallel, which
        # scatters every batch across ALL visible GPUs via parallel_apply().
        # Under concurrent server load this causes CUDA heap corruption and
        # a FATAL crash (SIGABRT from parallel_apply worker threads). Pin both
        # sub-models to the single allocated GPU by unwrapping DataParallel.
        if use_gpu and gpu_index >= 0:
            target = torch.device(f'cuda:{gpu_index}')
            for attr in ('detector', 'recognizer'):
                module = getattr(reader, attr, None)
                if module is None:
                    logger.info(f'EasyOCR reader has no {attr} attribute — skipping device pinning')
                elif isinstance(module, torch.nn.DataParallel):
                    setattr(reader, attr, module.module.to(target))
                    logger.debug(f'EasyOCR {attr}: unwrapped DataParallel → cuda:{gpu_index}')
                else:
                    if isinstance(module, torch.nn.Module):
                        setattr(reader, attr, module.to(target))
                    first_param = (
                        next(module.parameters(), None) if callable(getattr(module, 'parameters', None)) else None
                    )
                    device = first_param.device if first_param is not None else 'unknown'
                    logger.info(
                        f'EasyOCR {attr}: not wrapped in DataParallel (type={type(module).__name__}, device={device})'
                    )
            # Align reader.device so EasyOCR's internal img.to(self.device) calls
            # send inputs to the same GPU as the pinned model weights. Without this,
            # reader.device stays 'cuda' (→ cuda:0) regardless of which GPU was
            # allocated, causing a device mismatch on any non-0 allocation.
            reader.device = str(target)
            logger.debug(f'EasyOCR reader.device aligned to {target}')

        model_bundle = {
            'reader': reader,
            'languages': languages,
            'device': torch_device,
        }

        metadata = {
            'model_name': 'easyocr',
            'languages': languages,
            'device': torch_device,
            'gpu_index': gpu_index,
            'loader': 'easyocr',
            'estimated_memory_gb': memory_gb,
        }

        logger.info(f'EasyOCR loaded successfully with languages: {languages}')
        return model_bundle, metadata, gpu_index

    @staticmethod
    def preprocess(
        model: Any,
        inputs: List[Any],
        metadata: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """
        Preprocess images for OCR with transparency handling.

        Args:
            model: Model bundle
            inputs: List of images (bytes)
            metadata: Optional metadata

        Returns:
            Dict with preprocessed images and dimensions
        """
        from PIL import Image
        import numpy as np

        images = []
        dimensions = []

        for inp in inputs:
            if isinstance(inp, (bytes, bytearray)):
                # Handle transparency and convert to RGB
                processed_bytes = preprocess_image_transparency(inp)
                img = Image.open(io.BytesIO(processed_bytes))
                img_np = np.array(img)
                images.append(img_np)
                dimensions.append((img_np.shape[0], img_np.shape[1]))  # height, width
            elif isinstance(inp, np.ndarray):
                images.append(inp)
                dimensions.append((inp.shape[0], inp.shape[1]))
            else:
                raise ValueError(f'Unsupported input type: {type(inp)}')

        return {
            'images': images,
            'dimensions': dimensions,
            'batch_size': len(inputs),
        }

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> List[Dict[str, Any]]:
        """
        Run EasyOCR inference with line grouping.

        Args:
            model: Model bundle or ModelInstance
            preprocessed: Preprocessed images with dimensions
            metadata: Optional metadata
            stream: Optional CUDA stream (not used)

        Returns:
            List of OCR results with line-grouped text
        """
        # Handle ModelInstance wrapper
        if hasattr(model, 'model_obj'):
            models = model.model_obj
        else:
            models = model

        reader = models['reader']
        images = preprocessed['images']
        dimensions = preprocessed.get('dimensions', [])
        device = models.get('device', 'cpu')

        # Set the active CUDA device so tensors created inside readtext
        # (e.g. input preprocessing, workspace buffers) land on the same GPU
        # as the model weights that were pinned during load.
        import contextlib
        from ai.common.torch import torch

        if device.startswith('cuda'):
            gpu_id = int(device.split(':')[1]) if ':' in device else 0
            cuda_ctx = torch.cuda.device(gpu_id)
        else:
            cuda_ctx = contextlib.nullcontext()

        results = []

        for idx, img_np in enumerate(images):
            try:
                with cuda_ctx:
                    raw_results = reader.readtext(img_np)

                # Convert EasyOCR format to standard box format
                boxes = []
                for bbox, text, conf in raw_results:
                    # EasyOCR returns [[x1,y1], [x2,y1], [x2,y2], [x1,y2]]
                    # Convert to [x1, y1, x2, y2]
                    x_coords = [p[0] for p in bbox]
                    y_coords = [p[1] for p in bbox]
                    boxes.append(
                        {
                            'text': text,
                            'bbox': [min(x_coords), min(y_coords), max(x_coords), max(y_coords)],
                            'confidence': conf,
                        }
                    )

                # Group words into lines
                image_height = dimensions[idx][0] if idx < len(dimensions) else None
                grouped_text, grouped_boxes = group_words_into_lines(boxes, image_height)

                results.append(
                    {
                        'text': grouped_text,
                        'boxes': grouped_boxes,
                    }
                )

            except Exception as e:
                logger.error(f'EasyOCR inference failed: {e}')
                results.append({'text': '', 'boxes': [], 'error': str(e)})

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
        Postprocess OCR results with field extraction.

        Args:
            model: Model bundle
            raw_output: List of raw OCR results
            batch_size: Number of items in batch
            output_fields: Fields to extract (e.g., ['$text', '$boxes'])

        Returns:
            List of dicts with requested fields
        """
        from ..extract import extract_outputs

        return [extract_outputs(item, output_fields) for item in raw_output]


class EasyOCR:
    """
    User-facing EasyOCR class with automatic local/remote mode detection.

    Usage:
        # Local mode (no model server)
        ocr = EasyOCR(languages=['en'])
        result = ocr.read(image_bytes)

        # Remote mode (with model server on port 5590)
        # Automatically detected via --modelserver=5590 CLI arg
        ocr = EasyOCR(languages=['en'])
        result = ocr.read(image_bytes)

    Args:
        languages: Languages to support (default: ['en'])
        output_fields: Fields to extract (['$text', '$boxes'])
        **kwargs: Additional EasyOCR arguments
    """

    def __init__(
        self,
        languages: Optional[List[str]] = None,
        output_fields: Optional[List[str]] = None,
        **kwargs,
    ):
        """Initialize EasyOCR with specified languages."""
        self.languages = languages or ['en']
        self.output_fields = output_fields or ['$text', '$boxes']
        self._kwargs = kwargs

        # Check for model server
        server_addr = get_model_server_address()

        if server_addr:
            self._proxy_mode = True
            self._init_proxy(server_addr)
        else:
            self._proxy_mode = False
            self._init_local()

    def _init_local(self) -> None:
        """Initialize local EasyOCR model."""
        self._model, self._metadata, _ = EasyOCRLoader.load(
            languages=self.languages,
            **self._kwargs,
        )

    def _init_proxy(self, server_addr: str) -> None:
        """Initialize proxy to model server."""
        self._client = ModelClient(server_addr)
        self._client.load_model(
            model_name='easyocr',
            model_type='easyocr',
            loader_options={
                'languages': self.languages,
                **self._kwargs,
            },
        )
        self._metadata = self._client.metadata

    def read(self, images: Union[bytes, List[bytes]]) -> Union[Dict, List[Dict]]:
        """
        Read text from images.

        Args:
            images: Single image or list of images (as bytes)

        Returns:
            Dict with 'text' and 'boxes', or list of dicts for multiple images
        """
        single_input = not isinstance(images, list)
        if single_input:
            images = [images]

        # Count inference call — perf timing handled per-mode below
        metrics.counter('gpu_inference_count', 1)

        if self._proxy_mode:
            # Model server mode — ModelClient.send_command handles perf timing
            results = self._read_remote(images)
        else:
            # Local mode — time each phase
            results = self._read_local(images)

        return results[0] if single_input else results

    def _read_local(self, images: List[bytes]) -> List[Dict]:
        """Execute local OCR with perf timing."""
        # Preprocess phase — decode images and prepare for model
        t0 = time.perf_counter()
        preprocessed = EasyOCRLoader.preprocess(self._model, images, self._metadata)
        t_pre = (time.perf_counter() - t0) * 1000

        # GPU inference phase — run OCR detection and recognition
        t0 = time.perf_counter()
        raw_output = EasyOCRLoader.inference(self._model, preprocessed, self._metadata)
        t_gpu = (time.perf_counter() - t0) * 1000

        # Postprocess phase — extract text and bounding boxes
        t0 = time.perf_counter()
        results = EasyOCRLoader.postprocess(self._model, raw_output, len(images), self.output_fields)
        t_post = (time.perf_counter() - t0) * 1000

        # Report all perf counters — same keys as model server response
        inference_sec = (t_pre + t_gpu + t_post) / 1000.0
        metrics.add_time(
            {
                'gpu_preprocess': t_pre,
                'gpu_compute': t_gpu,
                'gpu_postprocess': t_post,
                'gpu_queue_wait': 0,
                'gpu_memory': model_gpu_gb(self._model) * inference_sec,
            }
        )

        return [self._format_result(r) for r in results]

    def _read_remote(self, images: List[bytes]) -> List[Dict]:
        """Execute remote OCR via model server."""
        # Send each image as binary in the data field
        all_results = []

        for image_bytes in images:
            result = self._client.send_command(
                'rrext_ms_inference',
                {
                    'output_fields': self.output_fields,
                    'data': image_bytes,  # Binary transfer via DAP data field
                },
            )

            results = result.get('result', [{}])
            all_results.append(self._format_result(results[0] if results else {}))

        return all_results

    def _format_result(self, result: Dict) -> Dict:
        """Format result to consistent output."""
        return {
            'text': result.get('$text') or result.get('text', ''),
            'boxes': result.get('$boxes') or result.get('boxes', []),
        }

    def __del__(self):
        """Cleanup on deletion."""
        if hasattr(self, '_client') and self._client:
            try:
                self._client.disconnect()
            except Exception:
                pass
