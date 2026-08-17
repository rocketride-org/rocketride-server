# =============================================================================
# MIT License
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
Face detection at all four rotations, and the model that does it.

Which way up a photograph goes is decided by where faces are found: a detector trained on upright
faces largely fails to fire on a sideways one, so the orientation it fires at *is* the answer. That
is a tendency rather than a rule — it also fires, more weakly, on rotated faces — which is why the
scores are compared with a margin rather than taken at face value.
"""

import hashlib
import os
import tempfile
import urllib.request

from ai.common.opencv import cv2
from rocketlib import debug, warning

# YuNet, MIT licensed (Copyright 2020 Shiqi Yu). Pinned and checksummed so the engine cannot be
# re-pointed at a different model. Note the media host: raw.githubusercontent serves an LFS
# pointer, not the model.
MODEL_URL = (
    'https://media.githubusercontent.com/media/opencv/opencv_zoo/main/'
    'models/face_detection_yunet/face_detection_yunet_2023mar.onnx'
)
MODEL_SHA256 = '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
MODEL_FILE = 'face_detection_yunet_2023mar.onnx'

# Rotation code per entry in vote.ROTATIONS. None means "as it arrived".
ROTATE_CODES = (None, cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE)

_NMS_THRESHOLD = 0.3
_TOP_K = 5000


def resolve_model() -> str:
    """
    Return a local path to the detector model, downloading it once if needed.

    Returns:
        str: Path to the verified ``.onnx`` file.

    Raises:
        OSError: If the download fails or the checksum does not match.
    """
    from depends import model_cache_dir

    cache = model_cache_dir('image_orient')
    path = os.path.join(cache, MODEL_FILE)
    if os.path.exists(path):
        return path

    os.makedirs(cache, exist_ok=True)
    debug(f'image_orient: fetching {MODEL_FILE}')
    handle, tmp = tempfile.mkstemp(suffix='.onnx', dir=cache)
    os.close(handle)
    try:
        urllib.request.urlretrieve(MODEL_URL, tmp)  # noqa: S310 — fixed https URL, checksummed below
        with open(tmp, 'rb') as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
        if digest != MODEL_SHA256:
            raise OSError(f'{MODEL_FILE} checksum mismatch: expected {MODEL_SHA256}, got {digest}')
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return path


def build_detector(min_confidence: float):
    """
    Create the YuNet detector.

    Args:
        min_confidence: Score below which a detection is discarded by the model itself, so a weak
            face never reaches the vote.

    Returns:
        The detector, or None if the model could not be obtained — the node then abstains on
        everything rather than failing the task.
    """
    try:
        return cv2.FaceDetectorYN.create(resolve_model(), '', (320, 320), min_confidence, _NMS_THRESHOLD, _TOP_K)
    except Exception as e:
        warning(f'image_orient: no face model available, every image will pass through unchanged: {e}')
        return None


def detect_rotations(detector, lock, image):
    """
    Run the detector on all four rotations of one image.

    Args:
        detector: The YuNet detector.
        lock: Guards the detector, which is shared across concurrently processed objects.
        image: The downscaled BGR array to analyse.

    Returns:
        tuple: ``(detections, areas)``, each a list of four entries parallel to
        ``vote.ROTATIONS``. Detections are ``(confidence, width, height)`` triples.
    """
    detections, areas = [], []
    for code in ROTATE_CODES:
        frame = image if code is None else cv2.rotate(image, code)
        height, width = frame.shape[:2]
        found = []
        # setInputSize is per-frame, not per-detector: 90 and 270 swap the dimensions. It also
        # mutates state shared between concurrent objects, hence the lock.
        with lock:
            detector.setInputSize((width, height))
            _, faces = detector.detect(frame)
        if faces is not None:
            found = [(float(f[14]), float(f[2]), float(f[3])) for f in faces]
        detections.append(found)
        areas.append(float(width * height))
    return detections, areas
