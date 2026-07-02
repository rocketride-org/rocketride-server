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
Pose: top-down human pose estimation loader + facade (vision family).

- PoseEstimatorLoader: load/preprocess/inference/postprocess for rtmlib
  (RTMDet-nano + RTMPose, ONNX Runtime). Returns canonical person dicts
  (box + 17 COCO keypoints), JSON-friendly.
- PoseEstimator: user-facing facade. Uses the model server when --modelserver
  is set, else local. ``mode`` is model identity; ``threshold`` + ``max_persons``
  are per-request filters.

This loader is **non-torch** (onnxruntime + rtmlib): copied from the WhisperLoader
shape, not the transformers vision loaders. It must not import torch — device is
selected from onnxruntime's available execution providers.
"""

import io
import logging
import os
from typing import Any, Dict, List, Optional, Tuple

from ai.web.metrics import metrics
from ai.common.utils.image_utils import image_to_bytes
from ..base import BaseLoader, get_model_server_address, ModelClient

logger = logging.getLogger('rocketlib.models.pose')

DEFAULT_MODE = 'balanced'
DEFAULT_MODEL = 'rtmlib-body'
DEFAULT_THRESHOLD = 0.3
DEFAULT_MAX_PERSONS = 20

# Long-edge (px) the input is downscaled to before inference. Bounds cost on huge
# images while keeping enough resolution for the person detector + per-person crops;
# keypoints/boxes come back in this space and are mapped back to original coords.
INFER_MAX_EDGE = 1333

# Node profile key -> rtmlib ``mode`` (selects bundled RTMDet-nano + RTMPose sizes).
PROFILE_TO_MODE: Dict[str, str] = {
    'rtmpose-tiny': 'lightweight',
    'rtmpose-medium': 'balanced',
    'rtmpose-large': 'performance',
}
MODES = frozenset(PROFILE_TO_MODE.values())

# COCO 17 keypoint names, in the order RTMPose emits with ``to_openpose=False``.
COCO_17_KEYPOINTS: List[str] = [
    'nose',
    'left_eye',
    'right_eye',
    'left_ear',
    'right_ear',
    'left_shoulder',
    'right_shoulder',
    'left_elbow',
    'right_elbow',
    'left_wrist',
    'right_wrist',
    'left_hip',
    'right_hip',
    'left_knee',
    'right_knee',
    'left_ankle',
    'right_ankle',
]

# COCO 17 skeleton edges (keypoint index pairs) — used node-side for rendering.
COCO_17_EDGES: List[Tuple[int, int]] = [
    (0, 1),
    (0, 2),
    (1, 3),
    (2, 4),
    (5, 6),
    (5, 7),
    (7, 9),
    (6, 8),
    (8, 10),
    (5, 11),
    (6, 12),
    (11, 12),
    (11, 13),
    (13, 15),
    (12, 14),
    (14, 16),
]


def _pick_ort_device() -> str:
    """Pick a device from onnxruntime's providers: CUDA > CoreML(mps) > CPU.

    Returns:
        'cuda', 'mps', or 'cpu' (falls back to 'cpu' if onnxruntime can't be probed).
    """
    try:
        import onnxruntime as ort

        providers = ort.get_available_providers()
    except Exception:
        return 'cpu'
    if 'CUDAExecutionProvider' in providers:
        return 'cuda'
    if 'CoreMLExecutionProvider' in providers:
        return 'mps'
    return 'cpu'


def _build_body(mode: str, device: str):
    """Construct the rtmlib ``Body`` wrapper, falling back to CPU if the device fails.

    Args:
        mode: rtmlib mode ('lightweight'/'balanced'/'performance').
        device: 'cuda', 'mps', or 'cpu'.

    Returns:
        An rtmlib ``Body`` instance (COCO-17 keypoint order).
    """
    from rtmlib import Body

    try:
        return Body(mode=mode, to_openpose=False, backend='onnxruntime', device=device)
    except Exception as exc:
        # CoreML / CUDA providers can fail to load on some onnxruntime builds —
        # fall back to CPU so the node still works.
        if device != 'cpu':
            logger.warning(f'pose: device "{device}" failed ({exc.__class__.__name__}: {exc}); falling back to CPU.')
            return Body(mode=mode, to_openpose=False, backend='onnxruntime', device='cpu')
        raise


def _build_persons(keypoints_arr, scores_arr, threshold: float, max_persons: int) -> List[Dict[str, Any]]:
    """Turn rtmlib's (keypoints, scores) arrays into canonical person dicts.

    Args:
        keypoints_arr: ndarray of shape (N, K, 2) — per-person keypoint xy.
        scores_arr: ndarray of shape (N, K) — per-keypoint confidence.
        threshold: Per-keypoint confidence used to bound the person bbox.
        max_persons: Cap on persons retained (sorted by mean keypoint score); 0 = no cap.

    Returns:
        List of {label, box, keypoints:[{name,x,y,score}]} dicts.
    """
    import numpy as np

    keypoints_arr = np.asarray(keypoints_arr)
    scores_arr = np.asarray(scores_arr)
    if keypoints_arr.ndim != 3 or keypoints_arr.shape[0] == 0:
        return []
    if scores_arr.ndim != 2 or scores_arr.shape[0] != keypoints_arr.shape[0]:
        return []

    # Clamp against score columns and the label count so neither can IndexError.
    n_kpts = min(keypoints_arr.shape[1], scores_arr.shape[1], len(COCO_17_KEYPOINTS))
    if n_kpts == 0:
        return []

    person_scores = scores_arr[:, :n_kpts].mean(axis=1)
    order = np.argsort(-person_scores)
    if max_persons > 0:
        order = order[:max_persons]

    results: List[Dict[str, Any]] = []
    for idx in order:
        kpts = keypoints_arr[idx, :n_kpts]
        scs = scores_arr[idx, :n_kpts]

        visible = scs >= threshold
        src = kpts[visible] if visible.any() else kpts
        x1, y1 = float(src[:, 0].min()), float(src[:, 1].min())
        x2, y2 = float(src[:, 0].max()), float(src[:, 1].max())

        keypoints_list = [
            {
                'name': COCO_17_KEYPOINTS[k],
                'x': float(kpts[k, 0]),
                'y': float(kpts[k, 1]),
                'score': float(scs[k]),
            }
            for k in range(n_kpts)
        ]
        results.append(
            {
                'label': 'person',
                'box': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
                'keypoints': keypoints_list,
            }
        )
    return results


class PoseEstimatorLoader(BaseLoader):
    """Static loader for rtmlib top-down pose estimation (RTMDet + RTMPose, onnxruntime)."""

    LOADER_TYPE: str = 'pose'
    _REQUIREMENTS_FILE = os.path.join(os.path.dirname(__file__), 'requirements_pose.txt')
    _DEFAULTS: dict = {'mode': DEFAULT_MODE}

    @staticmethod
    def load(
        model_name: str = DEFAULT_MODEL,
        mode: str = DEFAULT_MODE,
        device: Optional[str] = None,
        allocate_gpu: Optional[callable] = None,
        exclude_gpus: Optional[List[int]] = None,
        **kwargs,
    ) -> Tuple[Any, Dict[str, Any], int]:
        """Build the rtmlib Body for the chosen mode (onnxruntime; no torch).

        Args:
            model_name: Synthetic id (rtmlib self-downloads its ONNX bundles by mode).
            mode: rtmlib mode (part of model identity).
            device: Local device hint ('cuda'/'mps'/'cpu'); ignored when allocate_gpu is set.
            allocate_gpu: Server callable (memory_gb, exclude_gpus) -> (gpu_index, device).
            exclude_gpus: GPU indices the allocator must avoid.
            **kwargs: Ignored extra loader options.

        Returns:
            Tuple (bundle {'body','mode','device'}, metadata dict, gpu_index) — -1 on CPU.
        """
        PoseEstimatorLoader._ensure_dependencies()

        if allocate_gpu:
            gpu_index, alloc_device = allocate_gpu(1.0, exclude_gpus or [])
            # rtmlib's high-level Body(device='cuda') does not expose a device_id and
            # may default to GPU 0; honor the allocation as best-effort and log it.
            ort_device = 'cuda' if str(alloc_device).startswith('cuda') else str(alloc_device)
            logger.info(f'Allocated GPU {gpu_index} ({alloc_device}) for pose {mode} (rtmlib uses GPU0 if unset)')
        else:
            ort_device = device or _pick_ort_device()
            gpu_index = int(device.split(':')[1]) if str(device or '').startswith('cuda:') else -1

        # Normalize 'cuda:N' -> 'cuda' for rtmlib.
        if ort_device.startswith('cuda'):
            ort_device = 'cuda'

        body = _build_body(mode, ort_device)
        metadata = {'device': str(ort_device), 'mode': mode, 'model_name': model_name, 'loader': 'pose'}
        return {'body': body, 'mode': mode, 'device': ort_device}, metadata, gpu_index

    @staticmethod
    def preprocess(model: Any, inputs: List[Any], metadata: Optional[Dict] = None) -> Dict[str, Any]:
        """Decode inputs to OpenCV-style BGR uint8 ndarrays (rtmlib's expected format).

        Args:
            model: Loaded bundle (unused; kept for the loader interface).
            inputs: List of image bytes, PIL images, or BGR ndarrays.
            metadata: Loader metadata (unused).

        Returns:
            Dict with 'images' (list of HxWx3 BGR ndarrays) and 'batch_size'.
        """
        import numpy as np
        from PIL import Image

        images = []
        for inp in inputs:
            if isinstance(inp, (bytes, bytearray)):
                rgb = np.asarray(Image.open(io.BytesIO(inp)).convert('RGB'))
                images.append(rgb[:, :, ::-1].copy())  # RGB -> BGR
            elif hasattr(inp, 'convert'):  # PIL image
                rgb = np.asarray(inp.convert('RGB'))
                images.append(rgb[:, :, ::-1].copy())
            elif hasattr(inp, 'shape'):  # assume already a BGR ndarray
                images.append(np.asarray(inp))
            else:
                raise TypeError(f'Expected bytes, PIL Image, or ndarray, got {type(inp)}')
        return {'images': images, 'batch_size': len(images)}

    @staticmethod
    def inference(
        model: Any,
        preprocessed: Dict[str, Any],
        metadata: Optional[Dict] = None,
        stream: Optional[Any] = None,
        threshold: float = DEFAULT_THRESHOLD,
        max_persons: int = DEFAULT_MAX_PERSONS,
    ) -> Any:
        """Run rtmlib per image and build canonical person dicts.

        Args:
            model: Loaded bundle (or an object exposing model_obj).
            preprocessed: Output of preprocess (expects 'images').
            metadata: Loader metadata (unused).
            stream: Unused streaming handle.
            threshold: Per-request keypoint-visibility threshold for bbox bounds.
            max_persons: Per-request cap on persons per frame (0 = no cap).

        Returns:
            List of per-image person-dict lists.
        """
        bundle = model if isinstance(model, dict) else getattr(model, 'model_obj', model)
        body = bundle['body']
        thr = DEFAULT_THRESHOLD if threshold is None else float(threshold)
        cap = DEFAULT_MAX_PERSONS if max_persons is None else int(max_persons)

        out: List[List[Dict[str, Any]]] = []
        for image_bgr in preprocessed['images']:
            if image_bgr is None or getattr(image_bgr, 'size', 0) == 0:
                out.append([])
                continue
            keypoints_arr, scores_arr = body(image_bgr)
            out.append(_build_persons(keypoints_arr, scores_arr, thr, cap))
        return out

    @staticmethod
    def postprocess(
        model: Any, raw_output: Any, batch_size: int, output_fields: List[str], **kwargs
    ) -> List[Dict[str, Any]]:
        """Wrap each per-image person list under the 'poses' field.

        Args:
            model: Loaded bundle (unused).
            raw_output: List of per-image person-dict lists.
            batch_size: Number of images (unused; arity kept for the interface).
            output_fields: Requested output fields (unused; always emits poses).
            **kwargs: Ignored extra options.

        Returns:
            List of dicts, each {'poses': [...], '$poses': [...]}.
        """
        return [{'poses': persons, '$poses': persons} for persons in raw_output]


class PoseEstimator:
    """User-facing pose estimator. Model server when --modelserver is set, else local."""

    def __init__(
        self,
        mode: str = DEFAULT_MODE,
        model_name: str = DEFAULT_MODEL,
        device: Optional[str] = None,
        threshold: float = DEFAULT_THRESHOLD,
        max_persons: int = DEFAULT_MAX_PERSONS,
        **kwargs,
    ):
        """Set up the estimator in proxy (model server) or local mode.

        Args:
            mode: rtmlib mode (model identity).
            model_name: Synthetic model id (identity; rtmlib self-downloads by mode).
            device: None/'server' → model server when --modelserver is set; else local.
            threshold: Default keypoint threshold (per-request; not part of identity).
            max_persons: Default person cap (per-request; not part of identity).
            **kwargs: Extra identity-only loader options forwarded to load/load_model.
        """
        self.mode = mode if mode in MODES else DEFAULT_MODE
        self.model_name = model_name
        self.threshold = float(threshold)
        self.max_persons = int(max_persons)

        server_addr = get_model_server_address()
        self._proxy_mode = bool(server_addr) and (device is None or device == 'server')

        if self._proxy_mode:
            self._client = ModelClient(server_addr)
            loader_options = {k: v for k, v in {'mode': self.mode, **kwargs}.items() if v is not None}
            self._client.load_model(model_name=model_name, model_type='pose', loader_options=loader_options or None)
            self._bundle = None
            self._metadata = self._client.metadata
        else:
            self._client = None
            self._bundle, self._metadata, _ = PoseEstimatorLoader.load(
                model_name, mode=self.mode, device=device if device != 'server' else None, **kwargs
            )

    def estimate(
        self, image: Any, threshold: Optional[float] = None, max_persons: Optional[int] = None
    ) -> List[Dict[str, Any]]:
        """Return canonical person dicts for one image.

        Args:
            image: PIL Image, encoded image bytes, or a BGR ndarray.
            threshold: Override the default keypoint threshold for this call.
            max_persons: Override the default person cap for this call.

        Returns:
            List of {label:'person', box, keypoints:[{name,x,y,score}]} dicts.
        """
        if image is None:
            raise ValueError('Image must not be None')

        threshold = self.threshold if threshold is None else threshold
        max_persons = self.max_persons if max_persons is None else max_persons
        metrics.counter('gpu_inference_count', 1)

        from PIL import Image
        from ai.common.image.dense_resize import resize_for_inference

        # Downscale for inference; poses come back in the fed-image space and are mapped
        # back to original coords below. Unknown inputs (e.g. BGR ndarray) run unscaled.
        rescale = None
        if hasattr(image, 'size') and hasattr(image, 'mode'):
            pil = image
        elif isinstance(image, (bytes, bytearray)):
            pil = Image.open(io.BytesIO(image)).convert('RGB')
        else:
            pil = None
        if pil is not None:
            small, (orig_w, orig_h) = resize_for_inference(pil, INFER_MAX_EDGE)
            image = small
            rescale = (small.size, orig_w, orig_h)

        if self._proxy_mode:
            result = self._client.send_command(
                'rrext_ms_inference',
                {
                    'data': image_to_bytes(image),
                    'output_fields': ['poses'],
                    'threshold': threshold,
                    'max_persons': max_persons,
                },
            )
            items = result.get('result', [])
            poses = items[0].get('poses', []) if items else []
        else:
            pre = PoseEstimatorLoader.preprocess(self._bundle, [image], self._metadata)
            raw = PoseEstimatorLoader.inference(
                self._bundle, pre, self._metadata, threshold=threshold, max_persons=max_persons
            )
            out = PoseEstimatorLoader.postprocess(self._bundle, raw, 1, ['poses'], metadata=self._metadata)
            poses = out[0]['poses']

        return poses if rescale is None else self._rescale_to_original(poses, *rescale)

    @staticmethod
    def _rescale_to_original(
        poses: List[Dict[str, Any]], small_size: Tuple[int, int], orig_w: int, orig_h: int
    ) -> List[Dict[str, Any]]:
        """Map box + keypoint coordinates from the downscaled image back to original size.

        Args:
            poses: Canonical person dicts with coords in the downscaled (inference) image space.
            small_size: (width, height) of the downscaled image inference ran on.
            orig_w: Original image width in pixels.
            orig_h: Original image height in pixels.

        Returns:
            The same list with box + keypoint coords scaled to the original image
            (mutated in place; returned unchanged when the sizes already match).
        """
        from ai.common.utils.image_utils import inference_scale, scale_box, scale_point

        factors = inference_scale(small_size, (orig_w, orig_h))
        if not poses or factors is None:
            return poses
        fx, fy = factors
        for p in poses:
            box = p.get('box')
            if box:
                scale_box(box, fx, fy)
            for kp in p.get('keypoints', []):
                scale_point(kp, fx, fy)
        return poses

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
