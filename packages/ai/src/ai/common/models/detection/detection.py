"""
Detection: SAM3 grounded segmentation loader and facade.

- DetectionLoader: load/preprocess/inference/postprocess for SAM3.
- Sam3Model: user-facing facade with from_pretrained and detect.
  Uses model server when --modelserver is set, else local.
"""

import io
import logging
import os
from types import MappingProxyType
from typing import Any, Dict, List, Optional, Tuple

from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.detection')


class DetectionLoader(BaseLoader):
    """
    Static loader for SAM3 grounded image segmentation.

    Accepts a text prompt and image; returns bounding boxes, centroids,
    and confidence scores for detected objects matching the prompt.
    """

    LOADER_TYPE: str = 'detection'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_detection.txt')
    _DEFAULTS = MappingProxyType({'threshold': 0.5})
    _SERVER_PARAMS = frozenset({'allocate_gpu', 'exclude_gpus', 'device'})

    @staticmethod
    def load(
        model_name: str,
        threshold: float = 0.5,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        DetectionLoader._ensure_dependencies()

        from ai.common.torch import torch
        import huggingface_hub

        hf_token = os.environ.get('HF_TOKEN')
        if not hf_token:
            raise EnvironmentError('HF_TOKEN is required for facebook/sam3.1 (gated model). Request access at https://huggingface.co/facebook/sam3.1 then set HF_TOKEN.')
        huggingface_hub.login(token=hf_token, add_to_git_credential=False)

        if not torch.cuda.is_available():
            raise RuntimeError('SAM3 requires a CUDA-compatible GPU (CUDA 12.6+). CPU inference is not supported.')

        memory_gb = 4.0
        exclude_gpus = exclude_gpus or []

        if allocate_gpu:
            gpu_index, torch_device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({torch_device}) for SAM3 {model_name}')
            device = torch_device
        else:
            if device is None:
                device = 'cuda:0'
            gpu_index = int(device.split(':')[1]) if ':' in str(device) else 0

        try:
            from sam3.model_builder import build_sam3_image_model
            from sam3.model.sam3_image_processor import Sam3Processor
        except ImportError:
            raise ImportError('sam3 is not installed. Install from GitHub:\n  git clone https://github.com/facebookresearch/sam3.git\n  cd sam3 && pip install -e .\nRequires CUDA 12.6+, Python 3.12+, PyTorch 2.10.')

        # build_sam3_image_model places the model on device internally
        model = build_sam3_image_model(device=device, load_from_HF=True)

        # Guard against BFloat16/Float32 dtype mismatch on some CUDA hardware
        if torch.cuda.is_available():
            model = model.to(torch.float32)

        model.eval()
        processor = Sam3Processor(model, device=device, confidence_threshold=threshold)

        bundle = {'model': model, 'processor': processor}
        metadata = {
            'device': device,
            'model_name': model_name,
            'loader': 'detection',
            'threshold': threshold,
        }

        return bundle, metadata, gpu_index

    @staticmethod
    def preprocess(
        model: Any,
        inputs: List[Any],
        metadata: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Decode images and pair with prompts. inputs: list of (image, prompt) tuples."""
        from PIL import Image

        pairs = []
        for inp in inputs:
            if isinstance(inp, tuple) and len(inp) == 2:
                img, prompt = inp
            else:
                img, prompt = inp, ''

            if isinstance(img, bytes):
                img = Image.open(io.BytesIO(img)).convert('RGB')
            elif hasattr(img, 'convert'):
                img = img.convert('RGB') if img.mode != 'RGB' else img
            else:
                raise TypeError(f'Expected bytes or PIL Image, got {type(img)}')

            pairs.append((img, str(prompt)))

        return {'pairs': pairs, 'batch_size': len(pairs)}

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        """Run SAM3 set_image + set_text_prompt for each (image, prompt) pair."""
        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        processor = bundle['processor']

        results = []
        for img, prompt in preprocessed['pairs']:
            state = processor.set_image(img)
            output = processor.set_text_prompt(state=state, prompt=prompt)
            # Carry prompt through so postprocess can set label
            output['_prompt'] = prompt
            results.append(output)

        return results

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        metadata: Optional[Dict] = None,
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Convert SAM3 tensor outputs to lists of detection dicts."""
        threshold = (metadata or {}).get('threshold', 0.5)
        results = []

        for output in raw_output:
            boxes = output.get('boxes')
            scores = output.get('scores')
            prompt = output.get('_prompt', '')

            if boxes is None or scores is None or scores.shape[0] == 0:
                results.append({'detections': []})
                continue

            boxes_np = boxes.cpu().numpy()
            scores_np = scores.cpu().numpy()

            detections = []
            for i in range(scores_np.shape[0]):
                score = float(scores_np[i])
                if score < threshold:
                    continue
                x1, y1, x2, y2 = [float(v) for v in boxes_np[i]]
                detections.append(
                    {
                        'label': prompt,
                        'score': score,
                        'box': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
                        'centroid': {'x': (x1 + x2) / 2.0, 'y': (y1 + y2) / 2.0},
                    }
                )

            results.append({'detections': detections})

        return results


def _image_to_bytes(image: Any) -> bytes:
    """Convert PIL Image or bytes to PNG bytes for model server transport."""
    if isinstance(image, bytes):
        return image
    if hasattr(image, 'save'):
        buf = io.BytesIO()
        image.convert('RGB').save(buf, format='PNG')
        return buf.getvalue()
    raise TypeError(f'Expected PIL Image or bytes, got {type(image)}')


def _run_detection(bundle: Any, image: Any, prompt: str, metadata: Dict) -> List[Dict]:
    """Run the full loader pipeline for a single (image, prompt) pair."""
    preprocessed = DetectionLoader.preprocess(bundle, [(image, prompt)], metadata)
    raw = DetectionLoader.inference(bundle, preprocessed, metadata)
    results = DetectionLoader.postprocess(bundle, raw, 1, ['detections'], metadata)
    return results[0].get('detections', [])


class Sam3Model:
    """User-facing SAM3 detection facade. Uses model server when --modelserver is set, else local."""

    def __init__(
        self,
        bundle: Any,
        metadata: Dict,
        proxy_mode: bool = False,
        client: Any = None,
    ):
        """Initialize with model bundle and inference configuration."""
        self._bundle = bundle
        self._metadata = metadata
        self._proxy_mode = proxy_mode
        self._client = client

    @classmethod
    def from_pretrained(
        cls,
        model_name: str = 'facebook/sam3.1',
        threshold: float = 0.5,
        device: Optional[str] = None,
        **kwargs,
    ) -> 'Sam3Model':
        server_addr = get_model_server_address()
        should_proxy = server_addr and (device is None or device == 'server')

        if should_proxy:
            host, port = server_addr
            client = ModelClient(port, host)
            client.load_model(
                model_name=model_name,
                model_type='detection',
                loader_options={'threshold': threshold, **kwargs},
            )
            return cls(None, client.metadata, proxy_mode=True, client=client)

        bundle, metadata, _ = DetectionLoader.load(
            model_name,
            threshold=threshold,
            device=device,
            **kwargs,
        )
        return cls(bundle, metadata)

    def detect(self, image: Any, prompt: str = '') -> List[Dict]:
        """
        Detect objects matching prompt in image.

        Args:
            image: PIL Image or image bytes.
            prompt: Text describing what to detect (e.g. 'person . car . dog').

        Returns:
            List of {label, score, box: {x1,y1,x2,y2}, centroid: {x,y}} dicts.
        """
        if self._proxy_mode:
            image_bytes = _image_to_bytes(image)
            result = self._client.send_command(
                'inference',
                {'data': image_bytes, 'prompt': prompt, 'output_fields': ['detections']},
            )
            results = result.get('result', [])
            if results and isinstance(results[0], dict):
                return results[0].get('detections', [])
            return []

        return _run_detection(self._bundle, image, prompt, self._metadata)
