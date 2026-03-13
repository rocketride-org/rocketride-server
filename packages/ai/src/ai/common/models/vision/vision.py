"""
Vision: CLIP and ViT image embedding loaders and facades.

- VisionLoader: load/preprocess/inference/postprocess for CLIP or ViT (variant).
- CLIPModel / ViTModel: user-facing facades with from_pretrained, get_image_features / __call__.
  Use model server when --modelserver is set, else local.
"""

import io
import logging
import os
from types import MappingProxyType
from typing import Any, Dict, List, Optional, Tuple

from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.vision')


class VisionLoader(BaseLoader):
    """
    Static loader for vision image embedding models (CLIP or ViT).

    variant: 'clip' | 'vit' determines which HuggingFace model/processor to use.
    output_spec: list of (attr, _, index, _, normalize) for postprocess extraction.
    """

    LOADER_TYPE: str = 'vision'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_vision.txt')
    _DEFAULTS = MappingProxyType({'variant': 'clip'})
    _SERVER_PARAMS = frozenset({'allocate_gpu', 'exclude_gpus', 'device'})

    @staticmethod
    def load(
        model_name: str,
        variant: str = 'clip',
        output_spec: Optional[List[Tuple]] = None,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """
        Load CLIP or ViT model for image embedding.

        Args:
            model_name: HuggingFace model id (e.g. openai/clip-vit-base-patch16).
            variant: 'clip' or 'vit'.
            output_spec: List of (attr, _, index, _, normalize) for extraction.
            device: Device for local mode.
            allocate_gpu: Callback for server mode.
            exclude_gpus: GPUs to exclude.
            **kwargs: Passed to from_pretrained.

        Returns:
            (bundle, metadata, gpu_index)
        """
        VisionLoader._ensure_dependencies()

        from ai.common.torch import torch

        variant = (variant or 'clip').lower()
        if variant not in ('clip', 'vit'):
            raise ValueError(f"variant must be 'clip' or 'vit', got: {variant!r}")
        exclude_gpus = exclude_gpus or []
        output_spec = output_spec or []

        # Estimate memory (CLIP/ViT base models ~1-2 GB)
        memory_gb = 1.5

        if allocate_gpu:
            gpu_index, torch_device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({torch_device}) for vision {variant} {model_name}')
            device = torch_device
        else:
            if device is None:
                device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
            gpu_index = int(device.split(':')[1]) if ':' in str(device) else (0 if device == 'cuda' else -1)

        if variant == 'clip':
            from transformers import CLIPModel as HFCLIPModel, AutoProcessor
            model = HFCLIPModel.from_pretrained(model_name, **kwargs)
            processor = AutoProcessor.from_pretrained(model_name)
            bundle = {'model': model, 'processor': processor, 'variant': 'clip'}
            # Default output_spec for CLIP image features
            if not output_spec:
                output_spec = [('image_features', None, None, None, True)]
        else:
            from transformers import ViTModel as HFViTModel, AutoImageProcessor
            model = HFViTModel.from_pretrained(model_name, **kwargs)
            processor = AutoImageProcessor.from_pretrained(model_name)
            bundle = {'model': model, 'processor': processor, 'variant': 'vit'}
            if not output_spec:
                output_spec = [('last_hidden_state', None, 0, None, True)]

        model = bundle['model']
        model.to(device)
        model.eval()

        # Embedding dimension from first output_spec (we'll get it after one forward or from config)
        if variant == 'clip':
            emb_dim = model.config.projection_dim
        else:
            emb_dim = model.config.hidden_size

        metadata = {
            'device': device,
            'model_name': model_name,
            'loader': 'vision',
            'variant': variant,
            'output_spec': output_spec,
            'embedding_dimension': emb_dim,
        }

        return bundle, metadata, gpu_index

    @staticmethod
    def preprocess(
        model: Any,
        inputs: List[Any],
        metadata: Optional[Dict] = None,
    ) -> Dict[str, Any]:
        """Prepare images for inference. inputs: list of image bytes or PIL Images."""
        import numpy as np
        from PIL import Image

        # Server passes ModelInstanceWrapper (model.model_obj = bundle); local uses bundle dict
        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        processor = bundle['processor']
        variant = bundle.get('variant', 'clip')

        images = []
        for inp in inputs:
            if isinstance(inp, bytes):
                img = Image.open(io.BytesIO(inp)).convert('RGB')
            elif hasattr(inp, 'convert'):
                img = inp.convert('RGB') if inp.mode != 'RGB' else inp
            else:
                raise TypeError(f'Expected bytes or PIL Image, got {type(inp)}')
            images.append(img)

        if variant == 'clip':
            out = processor(images=images, return_tensors='pt')
        else:
            out = processor(images=images, return_tensors='pt')

        return {
            'pixel_values': out['pixel_values'],
            'batch_size': len(images),
        }

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
    ) -> Any:
        """Run vision model forward."""
        from ai.common.torch import torch

        # Server passes ModelInstanceWrapper (model.model_obj = bundle); local uses bundle dict
        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        net = bundle['model']
        variant = bundle.get('variant', 'clip')
        # Server: metadata is on the wrapper (inference_fn is not passed metadata)
        meta = metadata if isinstance(metadata, dict) else getattr(model, 'metadata', None) or {}
        device = meta.get('device', 'cpu')

        pixel_values = preprocessed['pixel_values'].to(device)

        with torch.no_grad():
            if variant == 'clip':
                outputs = net.get_image_features(pixel_values=pixel_values)
            else:
                outputs = net(pixel_values=pixel_values)
                # CLS token at index 0
                outputs = outputs.last_hidden_state[:, 0, :]

        return outputs

    @staticmethod
    def postprocess(
        model: Any,
        raw_output: Any,
        batch_size: int,
        output_fields: List[str],
        metadata: Optional[Dict] = None,
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Normalize and return list of { 'embedding': [...] }."""
        from ai.common.torch import torch

        # L2 normalize
        emb = torch.nn.functional.normalize(raw_output, p=2, dim=1)
        emb = emb.cpu().numpy()

        results = []
        for i in range(emb.shape[0]):
            vec = emb[i].tolist()
            results.append({'embedding': vec, '$embedding': vec})

        return results


def _image_to_bytes(image: Any) -> bytes:
    """Convert PIL Image or bytes to PNG bytes for sending to model server."""
    if isinstance(image, bytes):
        return image
    if hasattr(image, 'save'):
        buf = io.BytesIO()
        image.convert('RGB').save(buf, format='PNG')
        return buf.getvalue()
    raise TypeError(f'Expected PIL Image or bytes, got {type(image)}')


def _extract_embedding_from_bundle(bundle: Any, image: Any, metadata: Dict) -> List[float]:
    """Run loader pipeline for a single image (local facade helper)."""
    preprocessed = VisionLoader.preprocess(bundle, [image], metadata)
    raw = VisionLoader.inference(bundle, preprocessed, metadata)
    results = VisionLoader.postprocess(bundle, raw, 1, ['embedding'], metadata)
    return results[0].get('embedding') or results[0].get('$embedding') or []


class CLIPModel:
    """User-facing CLIP model. Uses model server when --modelserver is set, else local."""

    def __init__(self, bundle: Any, metadata: Dict, output_spec: List, proxy_mode: bool = False, client: Any = None):
        self._bundle = bundle
        self._metadata = metadata
        self._output_spec = output_spec
        self._proxy_mode = proxy_mode
        self._client = client

    @classmethod
    def from_pretrained(
        cls,
        model_name: str,
        output_spec: Optional[List] = None,
        device: Optional[str] = None,
        **kwargs,
    ) -> 'CLIPModel':
        output_spec = output_spec or [('image_features', None, None, None, True)]
        server_addr = get_model_server_address()
        should_proxy = server_addr and (device is None or device == 'server')

        if should_proxy:
            host, port = server_addr
            client = ModelClient(port, host)
            loader_options = {'variant': 'clip', 'output_spec': output_spec, **kwargs}
            client.load_model(
                model_name=model_name,
                model_type='vision',
                loader_options=loader_options,
            )
            return cls(None, client.metadata, output_spec, proxy_mode=True, client=client)

        bundle, metadata, _ = VisionLoader.load(
            model_name,
            variant='clip',
            output_spec=output_spec,
            device=device,
            **kwargs,
        )
        return cls(bundle, metadata, output_spec)

    def get_image_features(self, image: Any) -> List[float]:
        """Expects PIL Image or image bytes. Returns normalized embedding list."""
        if self._proxy_mode:
            image_bytes = _image_to_bytes(image)
            result = self._client.send_command(
                'inference',
                {'data': image_bytes, 'output_fields': ['embedding']},
            )
            results = result.get('result', [])
            if results and isinstance(results[0], dict):
                return results[0].get('embedding') or results[0].get('$embedding') or []
            return list(results[0]) if results else []
        return _extract_embedding_from_bundle(self._bundle, image, self._metadata)


class ViTModel:
    """User-facing ViT model. Uses model server when --modelserver is set, else local."""

    def __init__(self, bundle: Any, metadata: Dict, output_spec: List, proxy_mode: bool = False, client: Any = None):
        self._bundle = bundle
        self._metadata = metadata
        self._output_spec = output_spec
        self._proxy_mode = proxy_mode
        self._client = client

    @classmethod
    def from_pretrained(
        cls,
        model_name: str,
        output_spec: Optional[List] = None,
        device: Optional[str] = None,
        **kwargs,
    ) -> 'ViTModel':
        output_spec = output_spec or [('last_hidden_state', None, 0, None, True)]
        server_addr = get_model_server_address()
        should_proxy = server_addr and (device is None or device == 'server')

        if should_proxy:
            host, port = server_addr
            client = ModelClient(port, host)
            loader_options = {'variant': 'vit', 'output_spec': output_spec, **kwargs}
            client.load_model(
                model_name=model_name,
                model_type='vision',
                loader_options=loader_options,
            )
            return cls(None, client.metadata, output_spec, proxy_mode=True, client=client)

        bundle, metadata, _ = VisionLoader.load(
            model_name,
            variant='vit',
            output_spec=output_spec,
            device=device,
            **kwargs,
        )
        return cls(bundle, metadata, output_spec)

    def __call__(self, image: Any) -> List[float]:
        """Expects PIL Image or image bytes. Returns normalized embedding list."""
        if self._proxy_mode:
            image_bytes = _image_to_bytes(image)
            result = self._client.send_command(
                'inference',
                {'data': image_bytes, 'output_fields': ['embedding']},
            )
            results = result.get('result', [])
            if results and isinstance(results[0], dict):
                return results[0].get('embedding') or results[0].get('$embedding') or []
            return list(results[0]) if results else []
        return _extract_embedding_from_bundle(self._bundle, image, self._metadata)
