# =============================================================================
# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Background removal: foreground/alpha-matte loader + facade (vision family).

- BackgroundRemoverLoader: load/preprocess/inference/postprocess for BiRefNet
  (``trust_remote_code``). Returns the alpha matte as a base64+zlib uint8 array
  (JSON-friendly), at the input image's resolution; the node composites RGBA.
- BackgroundRemover: user-facing facade. Uses the model server when
  --modelserver is set, else local. ``remove(image)`` returns an HxW uint8 alpha
  array. ``model_name`` is the model identity; ``max_edge`` is client-side.

BiRefNet runs in **float32** on all devices: its deformable convolution kernel
(``deformable_im2col``) has no bfloat16 implementation, so half precision crashes.
"""

import io
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from ai.web.metrics import metrics
from ai.common.utils.image_utils import image_to_bytes, encode_ndarray, decode_ndarray
from ai.common.utils.cuda_utils import pick_torch_device, model_gpu_gb
from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.background')

DEFAULT_MODEL = 'ZhengPeng7/BiRefNet'

# ImageNet normalization — BiRefNet follows the standard timm/torchvision convention.
_IMAGENET_MEAN = (0.485, 0.456, 0.406)
_IMAGENET_STD = (0.229, 0.224, 0.225)

# BiRefNet's square input edge. The standard checkpoint trains at 1024, the HR at 2048.
_INPUT_SIZE = {
    'ZhengPeng7/BiRefNet': 1024,
    'ZhengPeng7/BiRefNet_HR': 2048,
}
_INPUT_SIZE_DEFAULT = 1024


class BackgroundRemoverLoader(BaseLoader):
    """Static loader for BiRefNet background removal (``trust_remote_code``, float32)."""

    LOADER_TYPE: str = 'background_removal'
    _REQUIREMENTS_FILE = [
        os.path.join(os.path.dirname(__file__), 'requirements_vision.txt'),
        os.path.join(os.path.dirname(__file__), 'requirements_background.txt'),
    ]
    _DEFAULTS: dict = {}

    @staticmethod
    def load(
        model_name: str = DEFAULT_MODEL,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        revision: Optional[str] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Load BiRefNet in float32 (its deformable conv has no bf16/fp16 kernel).

        Args:
            model_name: HF model id for the matting model.
            device: Local torch device; ignored when allocate_gpu is provided.
            allocate_gpu: Server callable (memory_gb, exclude_gpus) -> (gpu_index, device).
            exclude_gpus: GPU indices the allocator must avoid.
            revision: Optional pinned model revision.
            **kwargs: Ignored extra loader options.

        Returns:
            Tuple (bundle {'model','device','input_size'}, metadata dict, gpu_index) — -1 on CPU.
        """
        BackgroundRemoverLoader._ensure_dependencies()

        from ai.common.torch import torch
        from transformers import AutoModelForImageSegmentation

        if allocate_gpu:
            gpu_index, device = allocate_gpu(3.0, exclude_gpus or [])
            logger.info(f'Allocated GPU {gpu_index} ({device}) for background_removal {model_name}')
        else:
            device = device or pick_torch_device()
            gpu_index = int(device.split(':')[1]) if str(device).startswith('cuda:') else -1

        model = AutoModelForImageSegmentation.from_pretrained(model_name, trust_remote_code=True, revision=revision)
        model.to(device, dtype=torch.float32)
        model.eval()

        input_size = _INPUT_SIZE.get(model_name, _INPUT_SIZE_DEFAULT)
        metadata = {'device': str(device), 'model_name': model_name, 'loader': 'background_removal'}
        return {'model': model, 'device': device, 'input_size': input_size}, metadata, gpu_index

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Decode image bytes (or accept PIL) to RGB PIL images.

        Args:
            model: Loaded bundle (unused; kept for the loader interface).
            inputs: List of image bytes and/or PIL images.
            metadata: Loader metadata (unused).

        Returns:
            Dict with 'images' (list of RGB PIL images) and 'batch_size'.
        """
        from PIL import Image

        images = []
        for inp in inputs:
            if isinstance(inp, (bytes, bytearray)):
                images.append(Image.open(io.BytesIO(inp)).convert('RGB'))
            elif hasattr(inp, 'convert'):
                images.append(inp.convert('RGB') if inp.mode != 'RGB' else inp)
            else:
                raise TypeError(f'Expected bytes or PIL Image, got {type(inp)}')
        return {'images': images, 'batch_size': len(images)}

    @staticmethod
    def inference(
        model: Any, preprocessed: Dict[str, Any], metadata: Optional[Dict] = None, stream: Optional[Any] = None
    ) -> Any:
        """Run BiRefNet per image; return an HxW uint8 alpha matte at the input resolution.

        Args:
            model: Loaded bundle (or an object exposing model_obj).
            preprocessed: Output of preprocess (expects 'images').
            metadata: Loader metadata (unused).
            stream: Unused streaming handle.

        Returns:
            List of HxW uint8 numpy alpha mattes (one per image).
        """
        import numpy as np
        from PIL import Image
        from ai.common.torch import torch
        from ai.common.image.dense_resize import restore_dense_output

        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        mdl, device, input_size = bundle['model'], bundle['device'], bundle['input_size']
        mean = np.array(_IMAGENET_MEAN, dtype=np.float32)
        std = np.array(_IMAGENET_STD, dtype=np.float32)

        alphas: List[Any] = []
        for image in preprocessed['images']:
            src_w, src_h = image.size
            square = image.resize((input_size, input_size), resample=Image.BILINEAR)

            arr = np.asarray(square, dtype=np.float32) / 255.0
            arr = (arr - mean) / std
            tensor = torch.from_numpy(arr.transpose(2, 0, 1)).unsqueeze(0).to(device, dtype=torch.float32)

            with torch.no_grad():
                preds = mdl(tensor)

            # BiRefNet returns a list/tuple of multi-scale logits (last = highest-res),
            # sometimes nested once more; a single tensor on some forks.
            logit = preds
            while isinstance(logit, (list, tuple)):
                logit = logit[-1]

            alpha = torch.sigmoid(logit).float().squeeze(0).squeeze(0).detach().cpu().numpy()
            alpha_u8 = (np.clip(alpha, 0.0, 1.0) * 255.0).astype(np.uint8)
            # Upsample the square alpha back to the input image's resolution.
            alphas.append(restore_dense_output(alpha_u8, (src_w, src_h), mode='bilinear'))
        return alphas

    @staticmethod
    def postprocess(
        model: Any, raw_output: Any, batch_size: int, output_fields: List[str], **kwargs
    ) -> List[Dict[str, Any]]:
        """Encode each alpha matte as a base64+zlib uint8 array.

        Args:
            model: Loaded bundle (unused).
            raw_output: List of HxW uint8 alpha mattes.
            batch_size: Number of images (unused; arity kept for the interface).
            output_fields: Requested output fields (unused; always emits alpha).
            **kwargs: Ignored extra options.

        Returns:
            List of dicts, each {'alpha': encoded, '$alpha': encoded}.
        """
        results = []
        for alpha in raw_output:
            encoded = encode_ndarray(alpha)
            results.append({'alpha': encoded, '$alpha': encoded})
        return results


class BackgroundRemover:
    """User-facing background remover. Model server when --modelserver is set, else local."""

    def __init__(
        self, model_name: str = DEFAULT_MODEL, device: Optional[str] = None, revision: Optional[str] = None, **kwargs
    ):
        """Set up the remover in proxy (model server) or local mode.

        Args:
            model_name: HF model id to load.
            device: None/'server' → model server when --modelserver is set; else a local torch device.
            revision: Optional pinned model revision (part of model identity).
            **kwargs: Extra identity-only loader options forwarded to load/load_model.
        """
        self.model_name = model_name
        self._revision = revision

        server_addr = get_model_server_address()
        self._proxy_mode = bool(server_addr) and (device is None or device == 'server')

        if self._proxy_mode:
            self._client = ModelClient(server_addr)
            loader_options = {k: v for k, v in {'revision': revision, **kwargs}.items() if v is not None}
            self._client.load_model(
                model_name=model_name, model_type='background_removal', loader_options=loader_options or None
            )
            self._bundle = None
            self._metadata = self._client.metadata
        else:
            self._client = None
            self._bundle, self._metadata, _ = BackgroundRemoverLoader.load(
                model_name, device=device if device != 'server' else None, revision=revision, **kwargs
            )

    def remove(self, image: Any) -> Any:
        """Return an HxW uint8 alpha matte for one image (at the image's resolution).

        Args:
            image: PIL Image or encoded image bytes.

        Returns:
            HxW uint8 numpy alpha matte (0 = background, 255 = foreground).
        """
        if image is None:
            raise ValueError('Image must not be None')

        metrics.counter('gpu_inference_count', 1)

        if self._proxy_mode:
            result = self._client.send_command(
                'rrext_ms_inference',
                {'data': image_to_bytes(image), 'output_fields': ['alpha']},
            )
            items = result.get('result', [])
            if not items:
                raise RuntimeError('background_removal: model server returned no result')
            return decode_ndarray(items[0]['alpha'])

        t0 = time.perf_counter()
        pre = BackgroundRemoverLoader.preprocess(self._bundle, [image], self._metadata)
        t_pre = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        raw = BackgroundRemoverLoader.inference(self._bundle, pre, self._metadata)
        t_gpu = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        out = BackgroundRemoverLoader.postprocess(self._bundle, raw, 1, ['alpha'], metadata=self._metadata)
        t_post = (time.perf_counter() - t0) * 1000
        inference_sec = (t_pre + t_gpu + t_post) / 1000.0
        metrics.add_time(
            {
                'gpu_preprocess': t_pre,
                'gpu_compute': t_gpu,
                'gpu_postprocess': t_post,
                'gpu_queue_wait': 0,
                'gpu_memory': model_gpu_gb(self._bundle) * inference_sec,
            }
        )
        return decode_ndarray(out[0]['alpha'])

    def disconnect(self) -> None:
        """Release the model-server connection (proxy mode only); no-op locally.

        Returns:
            None.
        """
        if self._client is not None:
            try:
                self._client.disconnect()
            except Exception:
                pass
