"""
Vision Models: Combined loader and user-facing API for CLIP and ViT.

This module provides:
- VisionLoader: Static methods for load/preprocess/inference/postprocess
  (used by model server and local mode)
- CLIPModel: User-facing class for CLIP image embeddings with auto local/remote
- ViTModel: User-facing class for ViT image embeddings with auto local/remote

Usage:
    from ai.common.models.vision import CLIPModel, ViTModel

    # CLIP - image feature extraction
    model = CLIPModel.from_pretrained(
        'openai/clip-vit-base-patch16',
        output_spec=[('image_embeds', None, None, None, True)],
    )
    embedding = model.get_image_features(pil_image)

    # ViT - CLS token extraction
    model = ViTModel.from_pretrained(
        'google/vit-base-patch16-224',
        output_spec=[('last_hidden_state', None, 0, None, True)],
    )
    embedding = model(pil_image)
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np

from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.vision')

_REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_vision.txt')


def _apply_output_spec(raw_output: Any, output_spec: List[tuple]) -> Any:
    """
    Apply output_spec extraction to raw model output.

    Each spec tuple: (field_name, dim1_slice, dim2_slice, dim3_slice, normalize)
    - field_name: attribute to extract from model output
    - dim1/2/3_slice: optional indexing into that dimension (int or slice)
    - normalize: whether to L2-normalize the result
    """
    from ai.common.torch import torch

    results = []
    for spec in output_spec:
        field_name, dim1, dim2, dim3, normalize = spec

        # Try attribute first, then dict key
        value = getattr(raw_output, field_name, None)
        if value is None and isinstance(raw_output, dict):
            value = raw_output.get(field_name)
        if value is None:
            results.append(None)
            continue

        # Apply dimensional slicing
        if dim1 is not None:
            value = value[dim1]
        if dim2 is not None:
            value = value[dim2]
        if dim3 is not None:
            value = value[dim3]

        # L2 normalize if requested
        if normalize and hasattr(value, 'float'):
            value = value.float()
            value = torch.nn.functional.normalize(value, p=2, dim=-1)

        results.append(value)

    if len(results) == 1:
        return results[0]
    return results


class VisionLoader(BaseLoader):
    """
    Static loader for vision models (CLIP, ViT).

    Used by:
    - Model server (directly calls static methods)
    - CLIPModel/ViTModel wrappers (for local mode)
    """

    LOADER_TYPE: str = 'vision'
    _REQUIREMENTS_FILE = _REQUIREMENTS_FILE
    _DEFAULTS: dict = {}

    @staticmethod
    def load(
        model_name: str,
        model_type: str = 'clip',
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """
        Load a vision model (CLIP or ViT).

        Args:
            model_name: HuggingFace model name (e.g. 'openai/clip-vit-base-patch16')
            model_type: 'clip' or 'vit'
            device: Device for local mode
            allocate_gpu: Callback for server mode
            exclude_gpus: GPUs to exclude
            **kwargs: Additional arguments

        Returns:
            Tuple of (model_dict, metadata, gpu_index)
        """
        VisionLoader._ensure_dependencies()

        from ai.common.torch import torch

        exclude_gpus = exclude_gpus or []

        if model_type == 'clip':
            model, processor = VisionLoader._load_clip(model_name, **kwargs)
        else:
            model, processor = VisionLoader._load_vit(model_name, **kwargs)

        if allocate_gpu:
            # === SERVER MODE: CPU-first for accurate memory measurement ===
            model.eval()
            memory_gb = VisionLoader._get_memory_footprint(model)
            gpu_index, device = allocate_gpu(memory_gb, exclude_gpus)
            model = model.to(device)
            model.eval()
        else:
            # === LOCAL MODE: Load directly to specified device ===
            if device is None:
                device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
            model = model.to(device)
            model.eval()
            gpu_index = int(device.split(':')[1]) if ':' in device else (0 if device == 'cuda' else -1)
            memory_gb = VisionLoader._get_memory_footprint(model)

        metadata = {
            'model_name': model_name,
            'model_type': model_type,
            'device': device,
            'loader': 'vision',
            'estimated_memory_gb': memory_gb,
        }

        return {'model': model, 'processor': processor}, metadata, gpu_index

    @staticmethod
    def _load_clip(model_name: str, **kwargs):
        """Load a CLIP model and processor."""
        from transformers import CLIPModel as HFCLIPModel, CLIPProcessor

        model = HFCLIPModel.from_pretrained(model_name, **kwargs)
        processor = CLIPProcessor.from_pretrained(model_name)
        return model, processor

    @staticmethod
    def _load_vit(model_name: str, **kwargs):
        """Load a ViT model and processor."""
        from transformers import ViTModel as HFViTModel, ViTImageProcessor

        model = HFViTModel.from_pretrained(model_name, **kwargs)
        processor = ViTImageProcessor.from_pretrained(model_name)
        return model, processor

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Preprocess images using the model's processor."""
        # Handle ModelInstanceWrapper (server mode)
        if hasattr(model, 'model_obj'):
            actual = model.model_obj
        else:
            actual = model

        processor = actual['processor']
        encoded = processor(images=inputs, return_tensors='pt')

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
        """Run vision model inference."""
        from ai.common.torch import torch

        if hasattr(model, 'model_obj'):
            actual_model = model.model_obj['model']
            device = model.metadata.get('device', 'cuda:0')
        elif isinstance(model, dict):
            actual_model = model['model']
            device = metadata.get('device', 'cpu') if metadata else 'cpu'
        else:
            actual_model = model
            device = metadata.get('device', 'cpu') if metadata else 'cpu'

        encoded = preprocessed['encoded']

        with torch.no_grad():
            inputs_gpu = {k: v.to(device) for k, v in encoded.items()}
            output = actual_model(**inputs_gpu)

        return output

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Postprocess vision model output."""
        from ..extract import extract_outputs

        results = []
        for i in range(batch_size):
            extracted = extract_outputs(raw_output, output_fields)
            results.append(extracted)

        return results

    @staticmethod
    def _get_memory_footprint(model: Any) -> float:
        """Get actual GPU memory footprint."""
        try:
            total_params = sum(p.numel() for p in model.parameters())
            total_bytes = total_params * 4 * 1.3
            return round(total_bytes / 1073741824, 2)
        except Exception:
            return 1.0


class _VisionModelBase:
    """Shared base for CLIPModel and ViTModel user-facing wrappers."""

    _MODEL_TYPE: str = 'clip'

    def __init__(
        self,
        model_name: str,
        output_spec: Optional[List[tuple]] = None,
        device: Optional[str] = None,
        **kwargs,
    ):
        self.model_name = model_name
        self.output_spec = output_spec or []
        self.device = device
        self.kwargs = kwargs

        server_addr = get_model_server_address()
        should_proxy = server_addr and (device is None or device == 'server')

        if should_proxy:
            self._proxy_mode = True
            host, port = server_addr
            self._client = ModelClient(port, host)
            self._model = None
            self._metadata = {}
            self._init_proxy()
        else:
            self._proxy_mode = False
            self._client = None
            self._model, self._metadata, _ = VisionLoader.load(
                model_name,
                model_type=self._MODEL_TYPE,
                device=device if device != 'server' else None,
                **kwargs,
            )

    def _init_proxy(self) -> None:
        """Initialize proxy connection and load model on server."""
        loader_options = {'model_type': self._MODEL_TYPE}
        if self.kwargs:
            loader_options.update(self.kwargs)
        self._client.load_model(
            model_name=self.model_name,
            model_type='vision',
            loader_options=loader_options,
        )
        self._metadata = self._client.metadata

    def _run_inference(self, image) -> Any:
        """Run inference on a single image, returning raw model output."""
        from ai.common.torch import torch

        if self._proxy_mode:
            # === REMOTE MODE ===
            result = self._client.send_command(
                'inference',
                {
                    'command': 'vision_inference',
                    'inputs': [_image_to_base64(image)],
                    'output_spec': [list(s) for s in self.output_spec],
                },
            )
            raw = result.get('result', [None])[0]
            if isinstance(raw, list):
                return np.array(raw)
            return raw

        # === LOCAL MODE ===
        processor = self._model['processor']
        model = self._model['model']
        device = self._metadata.get('device', 'cpu')

        encoded = processor(images=image, return_tensors='pt')
        with torch.no_grad():
            inputs_gpu = {k: v.to(device) for k, v in encoded.items()}

            if self._MODEL_TYPE == 'clip':
                # CLIP: extract image features and L2-normalize
                features = model.get_image_features(
                    pixel_values=inputs_gpu['pixel_values'],
                )
                # L2 normalize
                features = torch.nn.functional.normalize(features, p=2, dim=-1)
                return features.cpu().numpy()
            else:
                # ViT: run full forward pass, apply output_spec
                output = model(**inputs_gpu)

        if self.output_spec:
            extracted = _apply_output_spec(output, self.output_spec)
            if hasattr(extracted, 'cpu'):
                return extracted.cpu().numpy()
            return extracted

        return output

    @classmethod
    def from_pretrained(
        cls,
        model_name: str,
        output_spec: Optional[List[tuple]] = None,
        device: Optional[str] = None,
        **kwargs,
    ):
        """Load a pretrained vision model."""
        return cls(model_name, output_spec=output_spec, device=device, **kwargs)

    @property
    def metadata(self) -> Dict:
        return self._metadata


class CLIPModel(_VisionModelBase):
    """
    User-facing CLIP model API with automatic local/remote detection.

    Usage:
        model = CLIPModel.from_pretrained(
            'openai/clip-vit-base-patch16',
            output_spec=[('image_embeds', None, None, None, True)],
        )
        embedding = model.get_image_features(pil_image)
    """

    _MODEL_TYPE = 'clip'

    def get_image_features(self, image) -> Union[np.ndarray, List[float]]:
        """Extract image features from a PIL image."""
        return self._run_inference(image)

    def __call__(self, image) -> Any:
        """Run CLIP inference on a PIL image."""
        return self._run_inference(image)


class ViTModel(_VisionModelBase):
    """
    User-facing ViT model API with automatic local/remote detection.

    Usage:
        model = ViTModel.from_pretrained(
            'google/vit-base-patch16-224',
            output_spec=[('last_hidden_state', None, 0, None, True)],
        )
        embedding = model(pil_image)
    """

    _MODEL_TYPE = 'vit'

    def __call__(self, image) -> Any:
        """Run ViT inference on a PIL image."""
        return self._run_inference(image)


def _image_to_base64(image) -> str:
    """Convert a PIL Image to a base64 string for remote transport."""
    import base64
    import io

    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return base64.b64encode(buffer.getvalue()).decode('utf-8')
