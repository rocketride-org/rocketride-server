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
Depth: monocular depth-estimation loader + facade (vision family).

- DepthEstimatorLoader: load/preprocess/inference/postprocess for the HF
  ``depth-estimation`` pipeline. Returns the raw depth array as a base64+zlib
  payload (JSON-friendly); the node colorizes + computes stats.
- DepthEstimator: user-facing facade. Uses the model server when --modelserver
  is set, else local. ``estimate(image)`` returns an HxW float32 numpy array
  (depth at the input image's resolution).
"""

import io
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from ai.web.metrics import metrics
from ai.common.utils.image_utils import image_to_bytes, encode_ndarray, decode_ndarray
from ai.common.utils.cuda_utils import resolve_pipeline_device, model_gpu_gb
from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.depth')

DEFAULT_MODEL = 'depth-anything/Depth-Anything-V2-Small-hf'


class DepthEstimatorLoader(BaseLoader):
    """Static loader for HF depth-estimation pipelines (e.g. Depth-Anything V2)."""

    LOADER_TYPE: str = 'depth'
    _REQUIREMENTS_FILE = [
        os.path.join(os.path.dirname(__file__), 'requirements_vision.txt'),
        os.path.join(os.path.dirname(__file__), 'requirements_depth.txt'),
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
        """Load the depth-estimation pipeline in fp32 (tiny model; avoids MPS/CPU dtype issues).

        Args:
            model_name: HF model id for the depth pipeline.
            device: Local torch device; ignored when allocate_gpu is provided.
            allocate_gpu: Server callable (memory_gb, exclude_gpus) -> (gpu_index, device).
            exclude_gpus: GPU indices the allocator must avoid.
            revision: Optional pinned model revision.
            **kwargs: Ignored extra loader options.

        Returns:
            Tuple (bundle {'pipe'}, metadata dict, gpu_index) — gpu_index is -1 on CPU.
        """
        DepthEstimatorLoader._ensure_dependencies()

        from ai.common.torch import torch
        from transformers import pipeline as hf_pipeline

        exclude_gpus = exclude_gpus or []
        memory_gb = 1.0  # Depth-Anything V2 Small is ~50 MB; small headroom.

        if allocate_gpu:
            gpu_index, device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({device}) for depth {model_name}')
            pipe_device = gpu_index
        else:
            pipe_device, device = resolve_pipeline_device(device)
            gpu_index = pipe_device if isinstance(pipe_device, int) and pipe_device >= 0 else -1

        pipe = hf_pipeline(
            task='depth-estimation',
            model=model_name,
            device=pipe_device,
            torch_dtype=torch.float32,
            revision=revision,
        )
        if hasattr(pipe, 'model'):
            pipe.model.eval()

        metadata = {'device': str(device), 'model_name': model_name, 'loader': 'depth'}
        return {'pipe': pipe}, metadata, gpu_index

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
                img = Image.open(io.BytesIO(inp)).convert('RGB')
            elif hasattr(inp, 'convert'):
                img = inp.convert('RGB') if inp.mode != 'RGB' else inp
            else:
                raise TypeError(f'Expected bytes or PIL Image, got {type(inp)}')
            images.append(img)
        return {'images': images, 'batch_size': len(images)}

    @staticmethod
    def inference(
        model: Any, preprocessed: Dict[str, Any], metadata: Optional[Dict] = None, stream: Optional[Any] = None
    ) -> Any:
        """Run the pipeline on the preprocessed images.

        Args:
            model: Loaded bundle (or an object exposing model_obj).
            preprocessed: Output of preprocess (expects 'images').
            metadata: Loader metadata (unused).
            stream: Unused streaming handle.

        Returns:
            List of per-image pipeline results (each a dict with 'predicted_depth').
        """
        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        pipe = bundle['pipe']
        out = pipe(preprocessed['images'])
        return out if isinstance(out, list) else [out]

    @staticmethod
    def postprocess(
        model: Any, raw_output: Any, batch_size: int, output_fields: List[str], **kwargs
    ) -> List[Dict[str, Any]]:
        """Encode each predicted depth tensor as a base64+zlib float32 array.

        Args:
            model: Loaded bundle (unused).
            raw_output: List of per-image pipeline results.
            batch_size: Number of images (unused; arity kept for the interface).
            output_fields: Requested output fields (unused; always emits depth).
            **kwargs: Ignored extra options.

        Returns:
            List of dicts, each {'depth': encoded, '$depth': encoded}.
        """
        import numpy as np

        results = []
        for item in raw_output:
            depth = item['predicted_depth']
            arr = depth.squeeze().detach().cpu().float().numpy().astype(np.float32)
            encoded = encode_ndarray(arr)
            results.append({'depth': encoded, '$depth': encoded})
        return results


class DepthEstimator:
    """User-facing depth estimator. Model server when --modelserver is set, else local."""

    def __init__(
        self, model_name: str = DEFAULT_MODEL, device: Optional[str] = None, revision: Optional[str] = None, **kwargs
    ):
        """Set up the estimator in proxy (model server) or local mode.

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
            self._client.load_model(model_name=model_name, model_type='depth', loader_options=loader_options or None)
            self._bundle = None
            self._metadata = self._client.metadata
        else:
            self._client = None
            self._bundle, self._metadata, _ = DepthEstimatorLoader.load(
                model_name, device=device if device != 'server' else None, revision=revision, **kwargs
            )

    def estimate(self, image: Any) -> Any:
        """Return an HxW float32 depth array for one image.

        Args:
            image: PIL Image or encoded image bytes.

        Returns:
            HxW float32 numpy array at the input image's resolution.
        """
        metrics.counter('gpu_inference_count', 1)

        if self._proxy_mode:
            result = self._client.send_command(
                'rrext_ms_inference',
                {'data': image_to_bytes(image), 'output_fields': ['depth']},
            )
            items = result.get('result', [])
            if not items:
                raise RuntimeError('depth: model server returned no result')
            return decode_ndarray(items[0]['depth'])

        # Local mode — time each phase for billing parity with the server.
        t0 = time.perf_counter()
        pre = DepthEstimatorLoader.preprocess(self._bundle, [image], self._metadata)
        t_pre = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        raw = DepthEstimatorLoader.inference(self._bundle, pre, self._metadata)
        t_gpu = (time.perf_counter() - t0) * 1000
        t0 = time.perf_counter()
        out = DepthEstimatorLoader.postprocess(self._bundle, raw, 1, ['depth'], metadata=self._metadata)
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
        return decode_ndarray(out[0]['depth'])

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
