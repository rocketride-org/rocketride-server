"""
TrOCR: Combined loader and user-facing API for TrOCR OCR.

This module provides:
- TrOCRLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- TrOCR: User-facing class with automatic local/remote mode detection
  (used by connectors)

TrOCR uses a two-stage pipeline:
1. CRAFT (text detection) - finds text regions in the image
2. TrOCR (text recognition) - reads text from each detected region

Features:
- Intelligent transparency/alpha handling
- Line grouping (words grouped into lines by y-coordinate)
- High accuracy transformer-based recognition
- Multiple model sizes (base, small, large; printed, handwritten)

Binary Transfer:
    Images are transferred as PNG/JPEG bytes in the DAP 'data' field.
"""

import io
import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

from ..base import BaseLoader, get_model_server_address, ModelClient
from .utils import preprocess_image_transparency, group_words_into_lines

logger = logging.getLogger('rocketlib.models.trocr')


class TrOCRLoader(BaseLoader):
    """
    Static loader for TrOCR models (CRAFT detector + TrOCR recognizer).

    Used by:
    - Model server (directly calls static methods)
    - TrOCR wrapper (for local mode)

    Pipeline:
        Image -> CRAFT (detect boxes) -> Crop regions -> TrOCR (recognize) -> Text

    Model Identity (for sharing):
        recognition_model determines model identity
    """

    LOADER_TYPE: str = 'trocr'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_trocr.txt')

    # Defaults applied before hashing (ensures consistent model IDs)
    _DEFAULTS = {
        'recognition_model': 'microsoft/trocr-base-printed',
    }

    @staticmethod
    def load(
        model_name: str = 'trocr',
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        recognition_model: str = 'microsoft/trocr-base-printed',
        **kwargs,
    ) -> Tuple[Dict[str, Any], Dict[str, Any], int]:
        """
        Load CRAFT detector and TrOCR recognizer.

        Args:
            model_name: Ignored (uses recognition_model)
            device: Device for local mode ('cuda:0', 'cpu')
            allocate_gpu: Callback for server mode
            exclude_gpus: GPUs to exclude
            recognition_model: HuggingFace TrOCR model (default: microsoft/trocr-base-printed)
            **kwargs: Additional arguments

        Returns:
            Tuple of (model_bundle, metadata_dict, gpu_index)
        """
        TrOCRLoader._ensure_dependencies()

        # Import opencv BEFORE craft - this ensures opencv-contrib-python-headless
        # is installed and any conflicting opencv packages are removed
        from ai.common.opencv import cv2  # noqa: F401

        from craft_text_detector import Craft
        from transformers import TrOCRProcessor, VisionEncoderDecoderModel
        from ai.common.torch import torch

        exclude_gpus = exclude_gpus or []

        # Estimate memory (~2GB for CRAFT + TrOCR)
        memory_gb = 2.5

        if allocate_gpu:
            gpu_index, torch_device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({torch_device}) for TrOCR')
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

        logger.info(f'Loading TrOCR pipeline on {torch_device}')

        try:
            # Load CRAFT text detector
            use_cuda = torch_device != 'cpu'
            craft = Craft(
                output_dir=None,
                crop_type='poly',
                cuda=use_cuda,
            )

            # Load TrOCR processor and model
            processor = TrOCRProcessor.from_pretrained(recognition_model)
            trocr_model = VisionEncoderDecoderModel.from_pretrained(recognition_model)

            if torch_device != 'cpu':
                trocr_model = trocr_model.to(torch_device)

            trocr_model.eval()

        except Exception as e:
            logger.error(f'Failed to load TrOCR: {e}')
            raise

        model_bundle = {
            'craft': craft,
            'processor': processor,
            'trocr_model': trocr_model,
            'device': torch_device,
        }

        metadata = {
            'model_name': recognition_model,
            'recognition_model': recognition_model,
            'device': torch_device,
            'gpu_index': gpu_index,
            'loader': 'trocr',
            'estimated_memory_gb': memory_gb,
        }

        logger.info(f'TrOCR loaded successfully: {recognition_model}')
        return model_bundle, metadata, gpu_index

    @staticmethod
    def preprocess(
        model: Any,
        inputs: List[Any],
        metadata: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Preprocess images for TrOCR with transparency handling."""
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

        return {'images': images, 'dimensions': dimensions, 'batch_size': len(inputs)}

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> List[Dict[str, Any]]:
        """Run TrOCR inference (detect + recognize) with line grouping."""
        from PIL import Image
        from ai.common.torch import torch

        if hasattr(model, 'model_obj'):
            models = model.model_obj
        else:
            models = model

        craft = models['craft']
        processor = models['processor']
        trocr_model = models['trocr_model']
        device = models['device']
        images = preprocessed['images']
        dimensions = preprocessed.get('dimensions', [])

        results = []

        for idx, img_np in enumerate(images):
            try:
                # Step 1: Detect text regions with CRAFT
                prediction_result = craft.detect_text(img_np)
                boxes = prediction_result['boxes']

                all_boxes = []

                if len(boxes) > 0:
                    # Convert numpy image to PIL for cropping
                    pil_image = Image.fromarray(img_np)

                    # Step 2: Process each detected region
                    for box in boxes:
                        # Get bounding box coordinates
                        x_coords = [p[0] for p in box]
                        y_coords = [p[1] for p in box]
                        x1, y1 = int(min(x_coords)), int(min(y_coords))
                        x2, y2 = int(max(x_coords)), int(max(y_coords))

                        # Ensure valid crop region
                        x1 = max(0, x1)
                        y1 = max(0, y1)
                        x2 = min(pil_image.width, x2)
                        y2 = min(pil_image.height, y2)

                        if x2 <= x1 or y2 <= y1:
                            continue

                        # Crop the text region
                        cropped = pil_image.crop((x1, y1, x2, y2))

                        # Step 3: Recognize text with TrOCR
                        pixel_values = processor(
                            images=cropped,
                            return_tensors='pt',
                        ).pixel_values

                        if device != 'cpu':
                            pixel_values = pixel_values.to(device)

                        with torch.no_grad():
                            generated_ids = trocr_model.generate(pixel_values)

                        text = processor.batch_decode(
                            generated_ids,
                            skip_special_tokens=True,
                        )[0]

                        all_boxes.append(
                            {
                                'text': text,
                                'bbox': [x1, y1, x2, y2],
                                'confidence': 1.0,  # TrOCR doesn't provide confidence
                            }
                        )

                # Group words into lines
                image_height = dimensions[idx][0] if idx < len(dimensions) else None
                grouped_text, grouped_boxes = group_words_into_lines(all_boxes, image_height)

                results.append(
                    {
                        'text': grouped_text,
                        'boxes': grouped_boxes,
                    }
                )

            except Exception as e:
                logger.error(f'TrOCR inference failed: {e}')
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


class TrOCR:
    """
    User-facing TrOCR class with automatic local/remote mode detection.

    Uses CRAFT for text detection + TrOCR for recognition.

    Usage:
        # Local mode (no model server)
        ocr = TrOCR()
        result = ocr.read(image_bytes)

        # Remote mode (with model server on port 5590)
        ocr = TrOCR()
        result = ocr.read(image_bytes)

    Args:
        recognition_model: HuggingFace TrOCR model (default: microsoft/trocr-base-printed)
        output_fields: Fields to extract (['$text', '$boxes'])
        **kwargs: Additional arguments
    """

    def __init__(
        self,
        recognition_model: str = 'microsoft/trocr-base-printed',
        output_fields: Optional[List[str]] = None,
        **kwargs,
    ):
        """Initialize TrOCR with specified model."""
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
        """Initialize local TrOCR model."""
        self._model, self._metadata, _ = TrOCRLoader.load(
            recognition_model=self.recognition_model,
            **self._kwargs,
        )

    def _init_proxy(self, server_addr: tuple) -> None:
        """Initialize proxy to model server."""
        host, port = server_addr
        self._client = ModelClient(port=port, host=host)
        self._client.load_model(
            model_name='trocr',
            model_type='trocr',
            loader_options={
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
        preprocessed = TrOCRLoader.preprocess(self._model, images, self._metadata)
        raw_output = TrOCRLoader.inference(self._model, preprocessed, self._metadata)
        results = TrOCRLoader.postprocess(self._model, raw_output, len(images), self.output_fields)
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
