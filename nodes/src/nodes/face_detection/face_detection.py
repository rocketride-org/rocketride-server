# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
#
# Face Detection node — MediaPipe BlazeFace (Apache-2.0).
#
# Produces axis-aligned bounding boxes plus (optionally) 6 coarse
# alignment-grade keypoints per detected face.
#
# Runs locally (not on the model server): mediapipe runs on CPU, not GPU.
# =============================================================================

import os
from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from typing import Any, Dict, List

from ai.common.config import Config


# -----------------------------------------------------------------------------
# Profile keys -> .task model bundle URLs (Google CDN, Apache-2.0).
#
# MediaPipe Tasks Python auto-downloads from these URLs on first use and
# caches under ~/.cache/mediapipe/. Pinning here so the engine cannot be
# silently re-routed at runtime.
#
# Note: MediaPipe Tasks Vision currently ships only short-range as a Tasks
# bundle. The legacy MediaPipe Solutions full-range tflite uses a different
# metadata format and is not loadable via the Tasks FaceDetector. If/when a
# full-range Tasks bundle is published, add it to MODEL_URLS and surface it
# as a second preconfig profile.
# -----------------------------------------------------------------------------

MODEL_URLS: Dict[str, str] = {
    # Short-range: ~2m subject distance, faster, optimized for selfies.
    'short': (
        'https://storage.googleapis.com/mediapipe-models/face_detector/'
        'blaze_face_short_range/float16/latest/blaze_face_short_range.tflite'
    ),
}

# BlazeFace returns exactly 6 keypoints per face, in this order. These are
# coarse alignment-grade points, suitable for cropping / rotating a face
# thumbnail before downstream tasks.
KEYPOINT_NAMES: List[str] = [
    'right_eye',
    'left_eye',
    'nose_tip',
    'mouth_center',
    'right_ear_tragion',
    'left_ear_tragion',
]


class FaceDetector:
    """
    Wrapper over MediaPipe Tasks BlazeFace face detector.

    Emits axis-aligned bounding boxes and, optionally, 6 coarse alignment
    keypoints per face.

    Attributes:
        profile (str): Selected profile key (currently always 'short').
        model_url (str): Resolved .task bundle URL.
        threshold (float): Minimum detection confidence.
        emit_landmarks (bool): Whether to include 6 keypoints per face.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        config = Config.getNodeConfig(provider, connConfig)

        self.profile = 'short'
        self.model_url = MODEL_URLS['short']
        self.threshold = float(config.get('threshold', 0.5))
        self.emit_landmarks = bool(config.get('emit_landmarks', True))

        self.model_name = f'blazeface-{self.profile}'
        self._detector = self._build_detector()

    # -------------------------------------------------------------------------
    # Setup
    # -------------------------------------------------------------------------

    def _resolve_model_path(self) -> str:
        """Download the .task bundle (cached) and return a local file path."""
        import hashlib
        import shutil
        import tempfile
        import urllib.request

        cache_dir = os.path.join(os.path.expanduser('~'), '.cache', 'mediapipe', 'face_detector')
        os.makedirs(cache_dir, exist_ok=True)

        digest = hashlib.sha1(self.model_url.encode('utf-8')).hexdigest()[:16]
        fname = f'{digest}_{os.path.basename(self.model_url) or "model.tflite"}'
        local_path = os.path.join(cache_dir, fname)

        if not os.path.exists(local_path):
            tmp_fd, tmp_path = tempfile.mkstemp(suffix='.tflite', dir=cache_dir)
            os.close(tmp_fd)
            try:
                # Explicit timeout so a stalled CDN/socket can't hang global init indefinitely.
                with urllib.request.urlopen(self.model_url, timeout=60) as resp, open(tmp_path, 'wb') as out:
                    shutil.copyfileobj(resp, out)
                os.replace(tmp_path, local_path)
            except Exception:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
                raise

        return local_path

    def _build_detector(self):
        """Construct the MediaPipe Tasks FaceDetector."""
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        model_path = self._resolve_model_path()
        base_options = mp_python.BaseOptions(model_asset_path=model_path)
        options = mp_vision.FaceDetectorOptions(
            base_options=base_options,
            min_detection_confidence=self.threshold,
            running_mode=mp_vision.RunningMode.IMAGE,
        )
        return mp_vision.FaceDetector.create_from_options(options)

    # -------------------------------------------------------------------------
    # Inference
    # -------------------------------------------------------------------------

    def detect(self, image: Any) -> List[Dict[str, Any]]:
        """
        Run face detection on a PIL Image.

        Args:
            image: PIL Image (RGB).

        Returns:
            List of dicts of the form::

                {
                    'label': 'face',
                    'score': float,
                    'box': {'x1', 'y1', 'x2', 'y2'},
                    'centroid': {'x', 'y'},
                    'landmarks': [{'name', 'x', 'y'}, ...],  # optional
                }
        """
        if image is None:
            raise ValueError('Image must not be None')

        import numpy as np
        import mediapipe as mp

        rgb = np.array(image.convert('RGB'))
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        result = self._detector.detect(mp_image)
        return self._format(result, image.width, image.height)

    def _format(self, result: Any, img_w: int, img_h: int) -> List[Dict[str, Any]]:
        """Convert a MediaPipe FaceDetectorResult to canonical dicts."""
        out: List[Dict[str, Any]] = []
        detections = getattr(result, 'detections', None) or []

        for det in detections:
            bbox = det.bounding_box
            x1 = float(max(0, bbox.origin_x))
            y1 = float(max(0, bbox.origin_y))
            x2 = float(min(img_w, bbox.origin_x + bbox.width))
            y2 = float(min(img_h, bbox.origin_y + bbox.height))

            score = 0.0
            categories = getattr(det, 'categories', None) or []
            if categories:
                score = float(getattr(categories[0], 'score', 0.0) or 0.0)

            entry: Dict[str, Any] = {
                'label': 'face',
                'score': score,
                'box': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
                'centroid': {'x': (x1 + x2) / 2.0, 'y': (y1 + y2) / 2.0},
            }

            if self.emit_landmarks:
                kps = getattr(det, 'keypoints', None) or []
                landmarks: List[Dict[str, Any]] = []
                for idx, kp in enumerate(kps):
                    name = KEYPOINT_NAMES[idx] if idx < len(KEYPOINT_NAMES) else f'kp_{idx}'
                    # MediaPipe keypoint coords are normalized to [0, 1].
                    x = float(getattr(kp, 'x', 0.0)) * img_w
                    y = float(getattr(kp, 'y', 0.0)) * img_h
                    landmarks.append({'name': name, 'x': x, 'y': y})
                if landmarks:
                    entry['landmarks'] = landmarks

            out.append(entry)

        return out

    def close(self) -> None:
        """Release the underlying MediaPipe resource."""
        detector = getattr(self, '_detector', None)
        if detector is not None:
            try:
                detector.close()
            except Exception:
                pass
            self._detector = None
