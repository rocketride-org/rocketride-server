"""
Surya: Combined loader and user-facing API for Surya OCR.

This module provides:
- SuryaLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- Surya: User-facing class with automatic local/remote mode detection
  (used by connectors)

Surya is a multilingual document OCR toolkit with line-level detection
and recognition. It supports 90+ languages and uses PyTorch.

Features:
- Intelligent transparency/alpha handling
- Line-level detection (native - no grouping needed)
- 90+ language support with auto-detection
- Layout analysis capabilities

Binary Transfer:
    Images are transferred as PNG/JPEG bytes in the DAP 'data' field.
"""

import io
import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

from ..base import BaseLoader, get_model_server_address, ModelClient
from .utils import preprocess_image_transparency

logger = logging.getLogger('rocketlib.models.surya')


class SuryaLoader(BaseLoader):
    """Static loader for Surya OCR models."""

    LOADER_TYPE: str = 'surya'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_surya.txt')

    _DEFAULTS = {
        'languages': ['en'],
    }

    @staticmethod
    def load(
        model_name: str = 'surya',
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        languages: Optional[List[str]] = None,
        **kwargs,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], int]:
        """Load Surya OCR models (detection + recognition).

        Surya 0.17.0+ uses a new class-based API:
        - FoundationPredictor: Base foundation model
        - DetectionPredictor: Text line detection
        - RecognitionPredictor: Text recognition (requires FoundationPredictor)
        """
        SuryaLoader._ensure_dependencies()

        # Import opencv first to ensure correct version (may be used by surya)
        from ai.common.opencv import cv2  # noqa: F401

        from surya.foundation import FoundationPredictor
        from surya.recognition import RecognitionPredictor
        from surya.detection import DetectionPredictor
        from ai.common.torch import torch

        languages = languages or ['en']
        exclude_gpus = exclude_gpus or []
        memory_gb = 3.0  # Detection + recognition models

        if allocate_gpu:
            gpu_index, torch_device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({torch_device}) for Surya')
        else:
            if device is None:
                device = 'cuda' if torch.cuda.is_available() else 'cpu'

            if device == 'cpu':
                gpu_index = -1
                torch_device = 'cpu'
            elif ':' in device:
                gpu_index = int(device.split(':')[1])
                torch_device = device
            else:
                gpu_index = 0
                torch_device = 'cuda:0'

        logger.info(f'Loading Surya OCR on {torch_device}')

        try:
            # New Surya 0.17.0+ API uses predictor classes
            # FoundationPredictor is shared between recognition and layout
            foundation_predictor = FoundationPredictor(device=torch_device)

            # DetectionPredictor handles text line detection
            detection_predictor = DetectionPredictor(device=torch_device)

            # RecognitionPredictor needs the foundation predictor
            recognition_predictor = RecognitionPredictor(foundation_predictor)

        except Exception as e:
            logger.error(f'Failed to load Surya: {e}')
            raise

        model_bundle = {
            'foundation_predictor': foundation_predictor,
            'detection_predictor': detection_predictor,
            'recognition_predictor': recognition_predictor,
            'languages': languages,
            'device': torch_device,
        }

        metadata = {
            'model_name': 'surya',
            'languages': languages,
            'device': torch_device,
            'gpu_index': gpu_index,
            'loader': 'surya',
            'estimated_memory_gb': memory_gb,
        }

        logger.info('Surya OCR loaded successfully')
        return model_bundle, metadata, gpu_index

    @staticmethod
    def preprocess(
        model: Any,
        inputs: List[Any],
        metadata: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Preprocess images for Surya with transparency handling."""
        from PIL import Image

        images = []
        for inp in inputs:
            if isinstance(inp, (bytes, bytearray)):
                # Handle transparency and convert to RGB
                processed_bytes = preprocess_image_transparency(inp)
                img = Image.open(io.BytesIO(processed_bytes))
                images.append(img)
            elif isinstance(inp, Image.Image):
                if inp.mode != 'RGB':
                    inp = inp.convert('RGB')
                images.append(inp)
            else:
                raise ValueError(f'Unsupported input type: {type(inp)}')

        return {'images': images, 'batch_size': len(inputs)}

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> List[Dict[str, Any]]:
        """Run Surya inference using the new predictor API (0.17.0+).

        The new API uses:
        - detection_predictor([images]) -> detection results
        - recognition_predictor([images], det_predictor=detection_predictor) -> OCR results
        """
        if hasattr(model, 'model_obj'):
            models = model.model_obj
        else:
            models = model

        detection_predictor = models['detection_predictor']
        recognition_predictor = models['recognition_predictor']
        images = preprocessed['images']

        results = []

        try:
            # New API: recognition_predictor accepts det_predictor parameter
            # and handles both detection and recognition in one call
            predictions = recognition_predictor(images, det_predictor=detection_predictor)

            # Format results - Surya returns line-level results
            for prediction in predictions:
                boxes = []
                text_lines = []

                # predictions contain text_lines with text, bbox, confidence, etc.
                for line_idx, line in enumerate(prediction.text_lines):
                    boxes.append(
                        {
                            'text': line.text,
                            'bbox': list(line.bbox) if hasattr(line.bbox, '__iter__') else line.bbox,
                            'confidence': line.confidence,
                            'line': line_idx,
                        }
                    )
                    text_lines.append(line.text)

                # Join lines with newlines
                results.append(
                    {
                        'text': '\n'.join(text_lines),
                        'boxes': boxes,
                    }
                )

        except Exception as e:
            logger.error(f'Surya inference failed: {e}')
            for _ in images:
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
        """Postprocess OCR results."""
        from ..extract import extract_outputs

        return [extract_outputs(item, output_fields) for item in raw_output]


class Surya:
    """User-facing Surya class with automatic local/remote mode detection."""

    def __init__(
        self,
        languages: Optional[List[str]] = None,
        output_fields: Optional[List[str]] = None,
        **kwargs,
    ):
        """Initialize Surya with specified languages."""
        self.languages = languages or ['en']
        self.output_fields = output_fields or ['$text', '$boxes']
        self._kwargs = kwargs

        server_addr = get_model_server_address()
        if server_addr:
            self._proxy_mode = True
            self._init_proxy(server_addr)
        else:
            self._proxy_mode = False
            self._init_local()

    def _init_local(self) -> None:
        """Initialize local Surya model."""
        self._model, self._metadata, _ = SuryaLoader.load(
            languages=self.languages,
            **self._kwargs,
        )

    def _init_proxy(self, server_addr: tuple) -> None:
        """Initialize proxy to model server."""
        host, port = server_addr
        self._client = ModelClient(port=port, host=host)
        self._client.load_model(
            model_name='surya',
            model_type='surya',
            loader_options={
                'languages': self.languages,
                **self._kwargs,
            },
        )
        self._metadata = self._client.metadata

    def read(self, images: Union[bytes, List[bytes]]) -> Union[Dict, List[Dict]]:
        """Read text from images."""
        single_input = not isinstance(images, list)
        if single_input:
            images = [images]

        if self._proxy_mode:
            results = self._read_remote(images)
        else:
            results = self._read_local(images)

        return results[0] if single_input else results

    def _read_local(self, images: List[bytes]) -> List[Dict]:
        """Execute local OCR."""
        preprocessed = SuryaLoader.preprocess(self._model, images, self._metadata)
        raw_output = SuryaLoader.inference(self._model, preprocessed, self._metadata)
        results = SuryaLoader.postprocess(self._model, raw_output, len(images), self.output_fields)
        return [self._format_result(r) for r in results]

    def _read_remote(self, images: List[bytes]) -> List[Dict]:
        """Execute remote OCR via model server."""
        all_results = []
        for image_bytes in images:
            result = self._client.send_command(
                'inference',
                {
                    'output_fields': self.output_fields,
                    'data': image_bytes,
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
