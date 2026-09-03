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

- DepthEstimatorLoader: load/preprocess/inference/postprocess for Depth-Anything
  style HF depth models (direct AutoModel; the ``depth-estimation`` pipeline
  wrapper forced a CPU round-trip at source resolution). The node colorizes +
  computes stats.
- DepthEstimator: user-facing facade. Uses the model server when --modelserver
  is set, else local. ``estimate(image)`` returns an HxW float32 numpy array
  (depth at the input image's resolution).

Wire format: relative depth is quantized to uint16 (65535 steps over the frame's
own min..max — far below the model's noise floor) and shipped at the SMALLER of
the model's native grid (~518px long edge) and the source resolution, with
``depth_min``/``depth_step`` scale factors alongside the base64+zlib array.
The facade dequantizes to float32 and restores the input image's resolution, so
callers see the same contract as before; it also still accepts the legacy plain
float32 payload from older servers. This cuts the dominant cost of this loader —
payload size scaled with source pixels (2.8MB float32 at 1024px), while the
forward itself is ~10ms at a fixed internal size.

Compute: fp32 weights with both TF32 flags enabled scope-locally on CUDA
(~1.2x; drift <0.4% of the depth range). ``dtype='float32'`` restores strict
fp32. Autocast bf16 would be ~2.3x but drifts up to 4% of range — not worth it
for a stats/visualization node; revisit if a metric-depth use case appears.
"""

import io
import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

from ai.web.metrics import metrics
from ai.common.utils.image_utils import image_to_bytes, encode_ndarray, decode_ndarray
from ai.common.utils.cuda_utils import resolve_pipeline_device, model_gpu_gb
from ..base import BaseLoader, get_model_server_address, ModelClient, tf32_context as _tf32

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
        dtype: Optional[str] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Load the depth model + processor in fp32 (tiny model; avoids MPS/CPU dtype issues).

        Args:
            model_name: HF model id for the depth model.
            device: Local torch device; ignored when allocate_gpu is provided.
            allocate_gpu: Server callable (memory_gb, exclude_gpus) -> (gpu_index, device).
            exclude_gpus: GPU indices the allocator must avoid.
            revision: Optional pinned model revision.
            dtype: 'float32' disables the TF32 fast path (bit-exact fp32); None/'auto'
                enables it on CUDA. Weights are fp32 either way. The TF32 flags are
                process-global, so on the model server strict fp32 is only guaranteed
                when no concurrent TF32-enabled model shares the process (see
                ``tf32_context``).
            **kwargs: Ignored extra loader options.

        Returns:
            Tuple (bundle {'model','processor','device','tf32'}, metadata dict, gpu_index) — -1 on CPU.
        """
        DepthEstimatorLoader._ensure_dependencies()

        from ai.common.torch import torch
        from transformers import AutoImageProcessor, AutoModelForDepthEstimation

        exclude_gpus = exclude_gpus or []
        memory_gb = 1.0  # Depth-Anything V2 Small is ~100 MB fp32; small headroom.

        if allocate_gpu:
            gpu_index, device = allocate_gpu(memory_gb, exclude_gpus)
            logger.info(f'Allocated GPU {gpu_index} ({device}) for depth {model_name}')
        else:
            pipe_device, device = resolve_pipeline_device(device)
            gpu_index = pipe_device if isinstance(pipe_device, int) and pipe_device >= 0 else -1

        processor = AutoImageProcessor.from_pretrained(model_name, revision=revision)
        model = AutoModelForDepthEstimation.from_pretrained(model_name, revision=revision, dtype=torch.float32)
        model.to(device)
        model.eval()

        tf32 = str(device).startswith('cuda') and dtype not in ('float32', 'highest')
        metadata = {'device': str(device), 'model_name': model_name, 'loader': 'depth'}
        return {'model': model, 'processor': processor, 'device': device, 'tf32': tf32}, metadata, gpu_index

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
        """Run the model per image; return quantized relative depth + scale factors.

        The depth grid is downsampled on-device to the source resolution when the
        source is smaller than the model's native output grid, so tiny frames ship
        tiny payloads; larger sources keep the native grid (all real detail).

        Args:
            model: Loaded bundle (or an object exposing model_obj).
            preprocessed: Output of preprocess (expects 'images').
            metadata: Loader metadata (unused).
            stream: Unused streaming handle.

        Returns:
            List of dicts {'q': HxW uint16 ndarray, 'lo': float, 'step': float}
            (depth ≈ lo + q * step).
        """
        import numpy as np
        from ai.common.torch import torch

        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        mdl, processor, device = bundle['model'], bundle['processor'], bundle['device']
        on_cuda = str(device).startswith('cuda')

        results: List[Dict[str, Any]] = []
        for image in preprocessed['images']:
            src_w, src_h = image.size
            pix = processor(images=image, return_tensors='pt')['pixel_values'].to(device)

            with torch.inference_mode():
                with _tf32(bundle.get('tf32', False)):
                    pred = mdl(pixel_values=pix).predicted_depth  # (1, H', W')
                p = pred.float().unsqueeze(1)
                grid_h, grid_w = p.shape[-2], p.shape[-1]
                if src_h <= grid_h and src_w <= grid_w and (src_h, src_w) != (grid_h, grid_w):
                    p = torch.nn.functional.interpolate(p, size=(src_h, src_w), mode='bilinear', align_corners=False)

                lo = p.min()
                step = ((p.max() - lo) / 65535.0).clamp_min(1e-12)
                q = ((p - lo) / step).round().clamp_(0, 65535).squeeze(0).squeeze(0)
                if on_cuda:
                    # Quantize before the device→host copy: 2 bytes/px instead of 4.
                    q_np = q.to(torch.uint16).cpu().numpy()
                else:
                    # uint16 casts aren't supported on all non-CUDA backends (MPS).
                    q_np = q.cpu().numpy().astype(np.uint16)
                results.append({'q': q_np, 'lo': float(lo), 'step': float(step)})
        return results

    @staticmethod
    def postprocess(
        model: Any, raw_output: Any, batch_size: int, output_fields: List[str], **kwargs
    ) -> List[Dict[str, Any]]:
        """Encode each quantized depth grid as a base64+zlib uint16 array + scale.

        Args:
            model: Loaded bundle (unused).
            raw_output: List of inference dicts {'q','lo','step'}.
            batch_size: Number of images (unused; arity kept for the interface).
            output_fields: Requested output fields (unused; always emits depth).
            **kwargs: Ignored extra options.

        Returns:
            List of dicts {'depth': encoded, 'depth_min', 'depth_step', '$depth': encoded};
            depth ≈ depth_min + array * depth_step.
        """
        results = []
        for item in raw_output:
            encoded = encode_ndarray(item['q'])
            results.append({'depth': encoded, 'depth_min': item['lo'], 'depth_step': item['step'], '$depth': encoded})
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
            **kwargs: Extra identity-only loader options forwarded to load/load_model
                (e.g. ``dtype='float32'`` to disable the CUDA TF32 fast path).
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
            return self._decode_item(items[0], image)

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
        return self._decode_item(out[0], image)

    @staticmethod
    def _decode_item(item: Dict[str, Any], image: Any) -> Any:
        """Dequantize a wire payload to float32 and restore the input image's resolution.

        Accepts both the current uint16+scale format and the legacy plain float32
        payload (older servers), so mixed engine/server versions keep working.

        Args:
            item: One result dict from the server/postprocess.
            image: The original estimate() input (PIL or bytes), for target resolution.

        Returns:
            HxW float32 numpy depth array at the input image's resolution.
        """
        import numpy as np

        depth = decode_ndarray(item['depth'])
        step = item.get('depth_step')
        if step is not None:
            depth = depth.astype(np.float32) * float(step) + float(item.get('depth_min', 0.0))
        else:
            depth = depth.astype(np.float32, copy=False)

        # Restore to the input's resolution when the grid differs (facade contract).
        size = None
        try:
            if hasattr(image, 'size'):
                size = image.size
            elif isinstance(image, (bytes, bytearray)):
                from PIL import Image

                size = Image.open(io.BytesIO(image)).size  # header-only read
        except Exception:
            size = None
        if size is not None and depth.shape != (size[1], size[0]):
            from ai.common.image.dense_resize import restore_dense_output

            depth = restore_dense_output(depth, size, mode='bilinear')
        return depth

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
