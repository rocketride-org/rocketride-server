"""
docTR: Combined loader and user-facing API for docTR OCR.

This module provides:
- DocTRLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- DocTR: User-facing class with automatic local/remote mode detection
  (used by connectors)

docTR is a document text recognition library by Mindee that provides
both text detection and recognition with PyTorch backend.

Features:
- Intelligent transparency/alpha handling
- Hierarchical document structure (page -> block -> line -> word)
- Multiple detection architectures (db_resnet50, linknet, fast_*)
- Multiple recognition architectures (crnn, sar, master, vitstr, parseq)

Binary Transfer:
    Images are transferred as PNG/JPEG bytes in the DAP 'data' field.
"""

import io
import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

from ..base import BaseLoader, get_model_server_address, ModelClient
from .utils import preprocess_image_transparency

logger = logging.getLogger('rocketlib.models.doctr')


class DocTRLoader(BaseLoader):
    """Static loader for docTR models."""

    LOADER_TYPE: str = 'doctr'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_doctr.txt')

    _DEFAULTS = {
        'detection_model': 'db_resnet50',
        'recognition_model': 'crnn_vgg16_bn',
        'pretrained': True,
    }

    @staticmethod
    def load(
        model_name: str = 'doctr',
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        detection_model: str = 'db_resnet50',
        recognition_model: str = 'crnn_vgg16_bn',
        pretrained: bool = True,
        **kwargs,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], int]:
        """Load docTR OCR predictor."""
        DocTRLoader._ensure_dependencies()

        # Import opencv BEFORE doctr - this ensures opencv-contrib-python-headless
        # is installed and any conflicting opencv packages are removed
        from ai.common.opencv import cv2  # noqa: F401

        from doctr.models import ocr_predictor
        from ai.common.torch import torch

        exclude_gpus = exclude_gpus or []
        memory_gb = 2.0

        if allocate_gpu:
            gpu_index, torch_device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({torch_device}) for docTR')
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

        logger.info(f'Loading docTR with det={detection_model}, rec={recognition_model}')

        try:
            predictor = ocr_predictor(
                det_arch=detection_model,
                reco_arch=recognition_model,
                pretrained=pretrained,
            )
            if torch_device != 'cpu':
                predictor = predictor.cuda()
        except Exception as e:
            logger.error(f'Failed to load docTR: {e}')
            raise

        model_bundle = {'predictor': predictor, 'device': torch_device}
        metadata = {
            'model_name': 'doctr',
            'detection_model': detection_model,
            'recognition_model': recognition_model,
            'device': torch_device,
            'gpu_index': gpu_index,
            'loader': 'doctr',
            'estimated_memory_gb': memory_gb,
        }

        return model_bundle, metadata, gpu_index

    @staticmethod
    def preprocess(
        model: Any,
        inputs: List[Any],
        metadata: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Preprocess images for docTR with transparency handling."""
        from PIL import Image
        import numpy as np

        images = []
        for inp in inputs:
            if isinstance(inp, (bytes, bytearray)):
                # Handle transparency and convert to RGB
                processed_bytes = preprocess_image_transparency(inp)
                img = Image.open(io.BytesIO(processed_bytes))
                images.append(np.array(img))
            elif isinstance(inp, np.ndarray):
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
        """Run docTR inference with hierarchical line structure."""
        if hasattr(model, 'model_obj'):
            models = model.model_obj
        else:
            models = model

        predictor = models['predictor']
        images = preprocessed['images']
        results = []

        for img_np in images:
            try:
                doc = predictor([img_np])
                boxes = []
                text_lines = []
                line_idx = 0

                for page in doc.pages:
                    h, w = page.dimensions
                    for block in page.blocks:
                        for line in block.lines:
                            line_words = []
                            for word in line.words:
                                x1, y1 = word.geometry[0]
                                x2, y2 = word.geometry[1]
                                boxes.append(
                                    {
                                        'text': word.value,
                                        'bbox': [x1 * w, y1 * h, x2 * w, y2 * h],
                                        'confidence': word.confidence,
                                        'line': line_idx,
                                    }
                                )
                                line_words.append(word.value)
                            # Join words in this line
                            if line_words:
                                text_lines.append(' '.join(line_words))
                                line_idx += 1

                # Join lines with newlines
                full_text = '\n'.join(text_lines)
                results.append({'text': full_text, 'boxes': boxes})

            except Exception as e:
                logger.error(f'docTR inference failed: {e}')
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


class DocTR:
    """User-facing docTR class with automatic local/remote mode detection."""

    def __init__(
        self,
        detection_model: str = 'db_resnet50',
        recognition_model: str = 'crnn_vgg16_bn',
        output_fields: Optional[List[str]] = None,
        **kwargs,
    ):
        """Initialize docTR with specified models."""
        self.detection_model = detection_model
        self.recognition_model = recognition_model
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
        """Initialize local docTR model."""
        self._model, self._metadata, _ = DocTRLoader.load(
            detection_model=self.detection_model,
            recognition_model=self.recognition_model,
            **self._kwargs,
        )

    def _init_proxy(self, server_addr: tuple) -> None:
        """Initialize proxy to model server."""
        host, port = server_addr
        self._client = ModelClient(port=port, host=host)
        self._client.load_model(
            model_name='doctr',
            model_type='doctr',
            loader_options={
                'detection_model': self.detection_model,
                'recognition_model': self.recognition_model,
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
        preprocessed = DocTRLoader.preprocess(self._model, images, self._metadata)
        raw_output = DocTRLoader.inference(self._model, preprocessed, self._metadata)
        results = DocTRLoader.postprocess(self._model, raw_output, len(images), self.output_fields)
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
