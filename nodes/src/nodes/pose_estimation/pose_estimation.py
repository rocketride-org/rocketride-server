# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict, List, Tuple

import numpy as np

from rocketlib import warning, debug
from ai.common.config import Config


# COCO 17 keypoint names, in canonical order. The COCO order is what RTMPose
# emits when ``to_openpose=False`` is set on the ``rtmlib.Body`` wrapper.
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

# COCO 17 skeleton edges (pairs of keypoint indices). Drawn as green lines.
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

# Profile → rtmlib ``mode`` mapping. rtmlib's three modes select bundled
# RTMDet-nano + RTMPose model checkpoints of increasing size/accuracy.
PROFILE_TO_MODE: Dict[str, str] = {
    'rtmpose-tiny': 'lightweight',
    'rtmpose-medium': 'balanced',
    'rtmpose-large': 'performance',
}


def _resolve_device(requested: str) -> str:
    """
    Resolve the requested device to a string rtmlib accepts.

    Preference order: CUDA → MPS → CPU. ONNX Runtime maps these to
    CUDAExecutionProvider / CoreMLExecutionProvider / CPUExecutionProvider
    internally. If CoreML fails to load (common on older macOS builds of
    onnxruntime), we silently fall back to CPU when the actual inference runs.
    """
    req = (requested or 'auto').lower().strip()

    # If user explicitly requested a device, honor it (with a CPU fallback for
    # mps if rtmlib doesn't support it at runtime — handled in PoseEstimator).
    if req in ('cuda', 'mps', 'cpu'):
        return req

    # auto: probe in order CUDA → MPS → CPU.
    try:
        import torch  # noqa: F401

        if torch.cuda.is_available():
            return 'cuda'
        if getattr(torch.backends, 'mps', None) and torch.backends.mps.is_available():
            return 'mps'
    except Exception:
        pass
    return 'cpu'


class PoseEstimator:
    """
    Top-down human pose estimator built on rtmlib (Apache-2.0).

    Uses RTMDet-nano for person detection followed by RTMPose for COCO 17
    keypoint inference per person crop. All bundled by ``rtmlib.Body``.

    Profiles:
        - ``rtmpose-tiny``   → rtmlib mode ``lightweight``  (small / fast)
        - ``rtmpose-medium`` → rtmlib mode ``balanced``     (default)
        - ``rtmpose-large``  → rtmlib mode ``performance``  (highest accuracy)
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        config = Config.getNodeConfig(provider, connConfig)

        self.profile = str(config.get('profile', 'rtmpose-medium')).lower().strip()
        self.threshold = float(config.get('threshold', 0.3))
        self.max_persons = int(config.get('max_persons', 20))

        requested_device = str(config.get('device', 'auto') or 'auto')
        self.device = _resolve_device(requested_device)

        # rtmlib's Body() picks ONNX models internally for the chosen mode.
        # Fall back to 'balanced' if an unknown profile slips through.
        mode = PROFILE_TO_MODE.get(self.profile, 'balanced')
        self.mode = mode

        self.body = self._build_body(mode)
        self.model_name = f'rtmpose:{mode}'

    def _build_body(self, mode: str):
        """Construct the rtmlib ``Body`` wrapper with a CPU fallback for MPS."""
        from rtmlib import Body

        device = self.device

        # First attempt with the resolved device.
        try:
            return Body(
                mode=mode,
                to_openpose=False,  # keep COCO 17 keypoint order
                backend='onnxruntime',
                device=device,
            )
        except Exception as exc:
            # MPS / CoreMLExecutionProvider can fail to load on older
            # onnxruntime builds — silently fall back to CPU so the node
            # still works on Apple Silicon.
            if device != 'cpu':
                warning(
                    f'pose_estimation: device "{device}" failed ({exc.__class__.__name__}: {exc}); falling back to CPU.'
                )
                self.device = 'cpu'
                return Body(
                    mode=mode,
                    to_openpose=False,
                    backend='onnxruntime',
                    device='cpu',
                )
            raise

    # -------------------------------------------------------------------------
    # Inference
    # -------------------------------------------------------------------------

    def estimate(self, image_bgr: np.ndarray) -> List[Dict[str, Any]]:
        """
        Run top-down pose estimation on a single BGR numpy image.

        Args:
            image_bgr: OpenCV-format ``(H, W, 3)`` uint8 BGR image.

        Returns:
            A list of person dicts, capped at ``self.max_persons``. Each dict::

                {
                    'label': 'person',
                    'box': {'x1': float, 'y1': float, 'x2': float, 'y2': float},
                    'keypoints': [
                        {'name': 'nose', 'x': float, 'y': float, 'score': float},
                        ...,  # 17 COCO keypoints
                    ],
                }
        """
        if image_bgr is None or image_bgr.size == 0:
            return []

        try:
            keypoints_arr, scores_arr = self.body(image_bgr)
        except Exception as exc:
            warning(f'pose_estimation: inference failed ({exc.__class__.__name__}: {exc})')
            return []

        keypoints_arr = np.asarray(keypoints_arr)
        scores_arr = np.asarray(scores_arr)

        # rtmlib returns shape (N, K, 2) for keypoints and (N, K) for scores
        # where N is persons and K is 17 for COCO. Bail out gracefully on
        # unexpected shapes.
        if keypoints_arr.ndim != 3 or keypoints_arr.shape[0] == 0:
            return []
        if scores_arr.ndim != 2 or scores_arr.shape[0] != keypoints_arr.shape[0]:
            return []

        n_persons = keypoints_arr.shape[0]
        # Clamp against score columns and the COCO label count so neither
        # scs[k_idx] nor COCO_17_KEYPOINTS[k_idx] can raise IndexError.
        n_kpts = min(keypoints_arr.shape[1], scores_arr.shape[1], len(COCO_17_KEYPOINTS))
        if n_kpts == 0:
            return []
        if keypoints_arr.shape[1] != len(COCO_17_KEYPOINTS):
            warning(
                f'pose_estimation: unexpected keypoint count {keypoints_arr.shape[1]}, expected {len(COCO_17_KEYPOINTS)}'
            )

        # Per-person mean keypoint score, used both as a detection-quality
        # proxy for sorting and as the bbox confidence in the emitted JSON.
        person_scores = scores_arr[:, :n_kpts].mean(axis=1)

        # Sort persons by score descending and cap at max_persons.
        order = np.argsort(-person_scores)
        if self.max_persons > 0:
            order = order[: self.max_persons]

        results: List[Dict[str, Any]] = []
        for idx in order:
            kpts = keypoints_arr[idx, :n_kpts]
            scs = scores_arr[idx, :n_kpts]

            # Derive a tight bbox from keypoints that pass the threshold.
            visible = scs >= self.threshold
            if visible.any():
                vis_kpts = kpts[visible]
                x1 = float(vis_kpts[:, 0].min())
                y1 = float(vis_kpts[:, 1].min())
                x2 = float(vis_kpts[:, 0].max())
                y2 = float(vis_kpts[:, 1].max())
            else:
                # No keypoints clear the threshold — fall back to the full
                # keypoint extent so we still emit something sensible.
                x1 = float(kpts[:, 0].min())
                y1 = float(kpts[:, 1].min())
                x2 = float(kpts[:, 0].max())
                y2 = float(kpts[:, 1].max())

            keypoints_list: List[Dict[str, Any]] = []
            for k_idx in range(n_kpts):
                keypoints_list.append(
                    {
                        'name': COCO_17_KEYPOINTS[k_idx],
                        'x': float(kpts[k_idx, 0]),
                        'y': float(kpts[k_idx, 1]),
                        'score': float(scs[k_idx]),
                    }
                )

            results.append(
                {
                    'label': 'person',
                    'box': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
                    'keypoints': keypoints_list,
                }
            )

        debug(f'pose_estimation: {len(results)} persons (of {n_persons})')
        return results
