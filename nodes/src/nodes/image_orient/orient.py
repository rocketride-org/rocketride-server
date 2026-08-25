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
The one seam between the node's stream plumbing and the imaging work.

``IInstance`` never imports cv2 or numpy; it calls the single callable built here and emits
whatever comes back. That keeps the node's unit tests runnable under an interpreter with neither
library, and confines the decoded array — hundreds of MB for a large scan — to one function that
releases it on return.
"""

import numpy as np
from ai.common.opencv import cv2
from ai.common.utils import source_quality
from rocketlib import debug, warning

from .detect import ROTATE_CODES, build_detector, detect_rotations
from .vote import NO_MODEL, ROTATIONS, UNENCODABLE, decide, score

# Mirrored from services.json, and clamped here too: a hand-edited pipeline bypasses the form.
_RANGES = {
    'minConfidence': (0.1, 0.99),
    'margin': (1.0, 10.0),
    'minFaces': (1, 10),
    'detectSize': (320, 4000),
    'confidenceWeight': (1.0, 16.0),
}

# Formats the node will re-encode. cv2 can encode more, but only JPEG carries its own quality in
# the file — for the rest, rotating would mean picking a compression level on the user's behalf.
_JPEG = ('image/jpeg', 'image/jpg')
_PNG = 'image/png'

_JPEG_FALLBACK_QUALITY = 92


def _number(config: dict, key: str, default, cast):
    """
    Read one numeric config value, clamped to its documented range.

    Args:
        config: The node's resolved config, keyed on bare field names.
        key: The field name.
        default: Value to use when absent or unparseable.
        cast: ``int`` or ``float``.

    Returns:
        The clamped value.
    """
    raw = config.get(key, default)
    try:
        value = cast(raw)
    except (TypeError, ValueError):
        warning(f'image_orient: config {key}={raw!r} is not a number; using {default}')
        return cast(default)
    low, high = _RANGES[key]
    return cast(max(low, min(high, value)))


def _encode(image, mime: str, source_bytes: bytes, quality_setting):
    """
    Re-encode a rotated image in the format it arrived in.

    Args:
        image: The rotated array.
        mime: The stream's mime type.
        source_bytes: The original encoded bytes, read for their JPEG quality.
        quality_setting: ``'auto'`` or an explicit 1..100.

    Returns:
        bytes | None: The encoded image, or None if cv2 declined to encode it.
    """
    if mime == _PNG:
        ok, buf = cv2.imencode('.png', image)
    else:
        quality = quality_setting
        if quality == 'auto':
            # Match the source, not matched_quality's uplift: that is for a first compression,
            # and these bytes have already been through JPEG once.
            found = source_quality(source_bytes)
            quality = int(found) if found else _JPEG_FALLBACK_QUALITY
            debug(f'image_orient: re-encoding at quality {quality}')
        ok, buf = cv2.imencode('.jpg', image, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
    return buf.tobytes() if ok else None


def build_orient(config: dict):
    """
    Bind the node's config into the single callable ``IInstance`` uses.

    Called once from ``IGlobal.beginGlobal`` so per-object work never re-parses config, and so the
    model is loaded and checksummed once rather than per image.

    Args:
        config: The node's resolved config, keyed on bare field names.

    Returns:
        Callable: ``orient(image_bytes, mime, want_image)``.
    """
    import threading

    min_conf = _number(config, 'minConfidence', 0.6, float)
    margin = _number(config, 'margin', 1.1, float)
    min_faces = _number(config, 'minFaces', 2, int)
    detect_size = _number(config, 'detectSize', 800, int)
    confidence_weight = _number(config, 'confidenceWeight', 1.0, float)
    quality_setting = _resolve_quality(config.get('quality', 'auto'))

    detector = build_detector(min_conf)
    lock = threading.Lock()

    def orient(image_bytes: bytes, mime: str, want_image: bool):
        """
        Decide which way up one image goes, and rotate it if the evidence is strong enough.

        Args:
            image_bytes: The image exactly as it arrived on the lane.
            mime: Its mime type.
            want_image: False when nothing downstream consumes the image lane, in which case the
                analysis still runs — the record is the point of that wiring — but nothing is
                rotated or encoded.

        Returns:
            tuple | None: ``(out_bytes, record)``, where ``out_bytes`` is None whenever the
            original should be forwarded unchanged. None instead of a tuple means the bytes could
            not be decoded at all.
        """
        if detector is None:
            # Nothing will look at the image, so do not spend the decode on it.
            return None, {'rotation': 0, 'confident': False, 'reason': NO_MODEL}

        if not image_bytes:
            return None
        flags = cv2.IMREAD_UNCHANGED if mime == _PNG else cv2.IMREAD_COLOR
        image = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), flags)
        if image is None:
            return None

        height, width = image.shape[:2]
        scale = min(1.0, detect_size / float(max(height, width)))
        # Floored at one pixel: a frame far longer than it is tall truncates its short side to
        # zero and cv2.resize raises, and this node answers what it cannot read with a reason,
        # not an exception. A 1px strip finds no faces and abstains through NO_FACES.
        small = cv2.resize(
            image,
            (max(1, int(width * scale)), max(1, int(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
        # The detector wants three channels; a PNG decoded UNCHANGED may carry alpha or be grey.
        if small.ndim == 2:
            small = cv2.cvtColor(small, cv2.COLOR_GRAY2BGR)
        elif small.shape[2] == 4:
            small = cv2.cvtColor(small, cv2.COLOR_BGRA2BGR)

        detections, areas = detect_rotations(detector, lock, small)
        small = None  # detection is done; the rotation below allocates a full-size array
        scores = [score(d, a, confidence_weight) for d, a in zip(detections, areas)]
        # The second reading decide() requires to agree with the area-weighted one.
        confidences = [max((c for c, _, _ in d), default=0.0) for d in detections]
        counts = [len(d) for d in detections]
        rotation, confident, reason, ratio, best = decide(scores, confidences, counts, margin, min_faces)

        record = {
            'decoded': True,
            'rotation': int(rotation),
            'confident': bool(confident),
            'scores': {str(r): round(float(s), 4) for r, s in zip(ROTATIONS, scores)},
            'faces': int(counts[best]),
            'ratio': None if ratio == float('inf') else round(float(ratio), 2),
            'reason': reason,
        }

        if rotation == 0:
            return None, record

        encodable = mime in _JPEG or mime == _PNG
        if not encodable:
            record['rotation'] = 0
            record['confident'] = False
            record['reason'] = UNENCODABLE
            return None, record

        if not want_image:
            return None, record

        # Peak memory: rotate holds two full-size arrays (~100 MB each on a 33 MP crop) and the
        # encoder adds a third. Kept as separate statements so the source can be dropped between
        # them — collapsing this back into one expression restores the peak.
        turned = cv2.rotate(image, ROTATE_CODES[ROTATIONS.index(rotation)])
        image = None
        out = _encode(turned, mime, image_bytes, quality_setting)
        turned = None
        if out is None:
            warning(f'image_orient: could not re-encode as {mime}; forwarding unchanged')
            record['rotation'] = 0
            record['confident'] = False
            record['reason'] = UNENCODABLE
            return None, record
        record['width'], record['height'] = _rotated_size(width, height, rotation)
        return out, record

    return orient


def _rotated_size(width: int, height: int, rotation: int):
    """
    Dimensions after the correction, since a quarter turn swaps them.

    Args:
        width: Source width.
        height: Source height.
        rotation: Correction in degrees clockwise.

    Returns:
        tuple: ``(width, height)`` of the rotated image.
    """
    return (int(height), int(width)) if rotation in (90, 270) else (int(width), int(height))


def _resolve_quality(value):
    """
    Normalise the ``quality`` field to ``'auto'`` or an int in 1..100.

    Args:
        value: Whatever the config held; a hand-edited pipeline can supply a JSON number.

    Returns:
        str | int: ``'auto'``, or a quality clamped to 1..100.
    """
    text = str(value).strip().lower()
    if text == 'auto':
        return 'auto'
    try:
        return max(1, min(100, int(float(text))))
    except (TypeError, ValueError):
        warning(f'image_orient: config quality={value!r} is neither "auto" nor a number; using auto')
        return 'auto'
