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
#
# Face Detection node — MediaPipe BlazeFace (Apache-2.0).
#
# Produces axis-aligned bounding boxes plus (optionally) 6 coarse
# alignment-grade keypoints per detected face.
#
# Runs locally (not on the model server): mediapipe runs on CPU, not GPU.
# =============================================================================

import os
from depends import load_depends, model_cache_dir

load_depends(__file__)

from typing import Any, Dict, List

from ai.common.config import Config


# -----------------------------------------------------------------------------
# Profile keys -> .task model bundle URLs (Google CDN, Apache-2.0).
#
# MediaPipe Tasks Python auto-downloads from these URLs on first use; we cache
# the bundle under the engine cache dir. Pinning here so the engine cannot be
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
    # Pinned to the immutable '/1/' revision (not '/latest/') for reproducibility.
    'short': (
        'https://storage.googleapis.com/mediapipe-models/face_detector/'
        'blaze_face_short_range/float16/1/blaze_face_short_range.tflite'
    ),
}

# sha256 of each pinned model artifact, verified after download.
MODEL_SHA256: Dict[str, str] = {
    'short': 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f',
}

# System sonames MediaPipe dlopens at runtime -> how to install them (Debian/Ubuntu).
_LIB_INSTALL_HINTS: Dict[str, str] = {
    'libGLESv2.so.2': "install it with 'apt-get install -y libgles2'",
    'libEGL.so.1': "install it with 'apt-get install -y libegl1'",
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

# Long-edge (px) the input is downscaled to before detection; boxes/landmarks come back
# in this space and are mapped to original coords. Bounds cost on huge frames.
INFER_MAX_EDGE = 1333


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

        cache_dir = model_cache_dir('face_detector')

        digest = hashlib.sha1(self.model_url.encode('utf-8')).hexdigest()[:16]
        base = os.path.basename(self.model_url) or 'model.tflite'
        fname = f'{digest}_{base}'
        local_path = os.path.join(cache_dir, fname)

        if not os.path.exists(local_path):
            tmp_fd, tmp_path = tempfile.mkstemp(suffix='.tflite', dir=cache_dir)
            os.close(tmp_fd)
            try:
                # Explicit timeout so a stalled CDN/socket can't hang global init indefinitely.
                with urllib.request.urlopen(self.model_url, timeout=60) as resp, open(tmp_path, 'wb') as out:
                    shutil.copyfileobj(resp, out)
                expected = MODEL_SHA256.get(self.profile)
                if expected:
                    with open(tmp_path, 'rb') as f:
                        actual = hashlib.sha256(f.read()).hexdigest()
                    if actual != expected:
                        raise RuntimeError(
                            f'face_detection: model checksum mismatch for {self.model_url} '
                            f'(expected {expected}, got {actual})'
                        )
                os.replace(tmp_path, local_path)
            except Exception:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
                raise

        return local_path

    def _build_detector(self):
        """Construct the MediaPipe Tasks FaceDetector."""
        # MediaPipe's vision package imports drawing_utils -> matplotlib.pyplot at
        # import time, which aborts the embedded engine (SIGABRT, pybind11 error on
        # matplotlib.ft2font). pyplot is only used by a plotting helper we never
        # call, so stub it before importing mediapipe.
        import sys
        import types

        sys.modules.setdefault('matplotlib.pyplot', types.ModuleType('matplotlib.pyplot'))

        try:
            # mediapipe pulls matplotlib, which aborts the engine's FreeType when the
            # contract-check env imports it directly (no pyplot stub there) — so ignore.
            from mediapipe.tasks import python as mp_python  # contract-check: ignore
            from mediapipe.tasks.python import vision as mp_vision  # contract-check: ignore

            model_path = self._resolve_model_path()
            base_options = mp_python.BaseOptions(model_asset_path=model_path)
            options = mp_vision.FaceDetectorOptions(
                base_options=base_options,
                min_detection_confidence=self.threshold,
                running_mode=mp_vision.RunningMode.IMAGE,
            )
            return mp_vision.FaceDetector.create_from_options(options)
        except OSError as exc:
            # MediaPipe's native lib dlopens system deps (e.g. libGLESv2.so.2);
            # re-raise a missing-library failure with an install hint.
            raise self._missing_lib_error(exc) from exc

    @staticmethod
    def _missing_lib_error(exc: OSError) -> Exception:
        """Map a 'cannot open shared object file' load failure to actionable guidance."""
        msg = str(exc)
        if 'cannot open shared object file' not in msg:
            return exc
        soname = msg.split(':', 1)[0].strip()
        hint = _LIB_INSTALL_HINTS.get(soname, f'install the system package that provides {soname}')
        return RuntimeError(
            f'Face detection could not load required system library {soname}. MediaPipe needs it at runtime; {hint}.'
        )

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
        import mediapipe as mp  # contract-check: ignore — see _build_detector

        from ai.common.image.dense_resize import resize_for_inference

        # Downscale for inference; boxes/landmarks come back in the fed-image space and
        # are mapped back to original coords so callers get input-resolution coordinates.
        small, (orig_w, orig_h) = resize_for_inference(image.convert('RGB'), INFER_MAX_EDGE)
        rgb = np.array(small)
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        result = self._detector.detect(mp_image)
        faces = self._format(result, small.width, small.height)
        return self._rescale_to_original(faces, small.size, orig_w, orig_h)

    @staticmethod
    def _rescale_to_original(
        faces: List[Dict[str, Any]], small_size: Any, orig_w: int, orig_h: int
    ) -> List[Dict[str, Any]]:
        """Map box/centroid/landmark coords from the downscaled image back to original size.

        Args:
            faces: Canonical face dicts with coords in the downscaled (inference) image space.
            small_size: (width, height) of the downscaled image the detector ran on.
            orig_w: Original image width in pixels.
            orig_h: Original image height in pixels.

        Returns:
            The same list with box/centroid/landmark coords scaled to the original image
            (mutated in place; returned unchanged when the sizes already match).
        """
        from ai.common.utils.image_utils import inference_scale, scale_box, scale_point

        factors = inference_scale(small_size, (orig_w, orig_h))
        if not faces or factors is None:
            return faces
        fx, fy = factors
        for f in faces:
            box = f.get('box')
            if box:
                scale_box(box, fx, fy)
            c = f.get('centroid')
            if c:
                scale_point(c, fx, fy)
            for kp in f.get('landmarks', []):
                scale_point(kp, fx, fy)
        return faces

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
