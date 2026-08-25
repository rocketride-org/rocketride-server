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

``IInstance`` never imports cv2 or numpy; it calls the single function built here and emits
whatever comes back. Two things follow from keeping the boundary this narrow: the node's unit
test can stub one method and stay free of the imaging libraries, and there is exactly one place
in the node where a 143 MP array exists — inside ``split_scan``, released when it returns.

Everything crossing the boundary is a plain Python type. The geometry arrives as numpy scalars
from cv2 arithmetic, and those serialise to nothing: ``json.dumps`` raises
``TypeError: Object of type float32 is not JSON serializable`` at runtime, on the first
successful detection, in a module that by design cannot import numpy to work around it. So the
region dicts are built with explicit casts rather than by handing values through.
"""

import math

from ai.common.opencv import cv2
import numpy as np
from rocketlib import debug, warning

from .detect import DetectParams, find_photos
from .geometry import DESKEW_MIN_ANGLE, bbox_crop, cut_out, normalise_rect, ratio_error
from .ordering import reading_order
from ai.common.utils import matched_quality, source_quality

# Field ranges, mirrored from services.json. Clamping here as well as in the UI keeps a
# hand-edited pipeline config from reaching the algorithm with a value it was never tried at —
# and in `skew`'s case, with a value that would divide by zero inside the seam search.
_RANGES = {
    'detectSize': (800, 8000),
    'texture': (0.5, 50.0),
    'minArea': (0.0001, 0.5),
    'maxArea': (0.5, 1.0),
    'maxAspect': (1.0, 20.0),
    'minRelative': (0.0, 1.0),
    'maxDepth': (0, 8),
    'skew': (0.1, 10.0),
    'ratioTolerance': (0.0, 50.0),
    'qualityTolerance': (0.2, 1.5),
}


def _number(config: dict, key: str, default, cast):
    """
    Read one numeric config value, clamped to its documented range.

    The config arrives flat. services.json groups these fields under the selected Scan type
    and behind that type's "Show advanced settings" switch, but ``Config.getNodeConfig``
    unwraps the group — it takes the user's settings from ``connConfig[profile]`` — so what
    lands here is a plain mapping of bare field names.

    Args:
        config: The node's resolved config, keyed on bare field names.
        key: The field name.
        default: Value to use when absent or unparseable.
        cast: ``int`` or ``float``.

    Returns:
        The clamped value, or ``default`` when the config holds something non-numeric.
    """
    raw = config.get(key, default)
    if isinstance(raw, bool):
        # bool is a subclass of int, so `true` would cast to 1 without complaint.
        warning(f'scan_cropper: config {key}={raw!r} is not a number; using {default}')
        return default
    try:
        value = cast(raw)
    except (TypeError, ValueError, OverflowError):
        # OverflowError is not a ValueError: `int(float('inf'))` raises it.
        warning(f'scan_cropper: config {key}={raw!r} is not a number; using {default}')
        return default
    if not math.isfinite(value):
        # Clamping cannot rescue these: every comparison against nan is false, so it would
        # travel on into DetectParams and turn each threshold that reads it into a no-op.
        warning(f'scan_cropper: config {key}={raw!r} is not a finite number; using {default}')
        return default
    low, high = _RANGES[key]
    return cast(max(low, min(high, value)))


def resolve_quality(value):
    """
    Normalise the ``quality`` field to either the string 'auto' or an int in 1..100.

    The field is free text, but it does not always arrive as text: a hand-edited config or a
    profile can carry ``"quality": 95`` as a JSON number, and calling ``.strip()`` on an int
    raises. Anything unrecognisable falls back to 'auto' rather than raising — a bad config
    value must not kill the pipeline.

    Args:
        value: Whatever the config held.

    Returns:
        str | int: ``'auto'``, or a quality clamped to 1..100.
    """
    text = str(value).strip().lower()
    if text == 'auto':
        return 'auto'
    try:
        return max(1, min(100, int(float(text))))
    except (TypeError, ValueError, OverflowError):
        # OverflowError is not a ValueError: `float('inf')` parses, and `int()` on it raises.
        warning(f'scan_cropper: config quality={value!r} is neither "auto" nor a number; using auto')
        return 'auto'


def _params_from_config(config: dict) -> DetectParams:
    """
    Build the frozen detection tunables from the node's resolved config.

    Args:
        config: The node's config, keyed on bare field names (the ``scan_cropper.`` prefix in
            services.json is UI-schema only and never reaches here).

    Returns:
        DetectParams: The tunables, clamped to their documented ranges.
    """
    return DetectParams(
        detect_size=_number(config, 'detectSize', 3000, int),
        texture=_number(config, 'texture', 4.0, float),
        min_area=_number(config, 'minArea', 0.005, float),
        max_area=_number(config, 'maxArea', 0.95, float),
        max_aspect=_number(config, 'maxAspect', 5.0, float),
        min_relative=_number(config, 'minRelative', 0.40, float),
        max_depth=_number(config, 'maxDepth', 4, int),
        skew=_number(config, 'skew', 1.5, float),
        ratio_tolerance=_number(config, 'ratioTolerance', 8.0, float),
    )


def _region(rect, page_area: float) -> dict:
    """
    Describe one detected photo as plain, JSON-safe Python.

    Geometry is rounded to a tenth of a pixel: a ``cx`` of ``4788.000000000001`` in the audit
    output is noise, and the numbers are there to be read.

    Args:
        rect: The photo's rectangle in full-resolution source coordinates.
        page_area: Area of the whole scan, in pixels.

    Returns:
        dict: ``{cx, cy, w, h, angle, area_pct, ratio_error, cropped}``, every value a builtin.
    """
    (cx, cy), (w, h), angle = rect
    return {
        'cx': round(float(cx), 1),
        'cy': round(float(cy), 1),
        'w': round(float(w), 1),
        'h': round(float(h), 1),
        'angle': round(float(angle), 2),
        'area_pct': round(float(w) * float(h) / page_area * 100.0, 2) if page_area else 0.0,
        'ratio_error': round(float(ratio_error(rect)), 1),
        # Here, not in the crop loop: that loop runs only when the image lane is listening,
        # and the record must not change shape with the wiring.
        'cropped': False,
    }


def build_split_scan(config: dict):
    """
    Bind the node's config into the single callable ``IInstance`` uses.

    Called once from ``IGlobal.beginGlobal``, so per-object work never re-parses config. The
    ``quality`` decision is deliberately *not* frozen here: when it is 'auto' the answer depends
    on the bytes of each individual scan, so it is resolved per input, inside ``split_scan``,
    where those bytes are in hand.

    Args:
        config: The node's resolved config, keyed on bare field names.

    Returns:
        Callable: ``split_scan(image_bytes, want_images)``.
    """
    params = _params_from_config(config)
    deskew = bool(config.get('deskew', True))
    quality_setting = resolve_quality(config.get('quality', 'auto'))
    quality_tolerance = _number(config, 'qualityTolerance', 0.5, float)

    def split_scan(image_bytes: bytes, want_images: bool):
        """
        Split one scan into its separate photos.

        Args:
            image_bytes: The scan exactly as it arrived on the lane.
            want_images: False when nothing downstream consumes the ``image`` lane, in which
                case detection still runs (the audit output is still wanted) but no pixels are
                cropped or encoded — that is the expensive half.

        Returns:
            tuple | None: ``(crops, regions)`` on success, or ``None`` when the bytes could not
            be decoded at all. ``regions`` is the complete record of what detection found, in
            reading order; ``crops`` is a subset, each entry carrying the index of the region it
            came from. They are deliberately not parallel: a crop can fail where its region is
            perfectly valid, and the reported count must not depend on who was listening.
        """
        # imdecode returns None for bytes it cannot make sense of, but *raises* on an empty
        # buffer (`!buf.empty()` assertion), so the empty case has to be caught before the call
        # rather than by the None check after it. An image stream that opened and closed
        # without a chunk is a real thing to receive, not a programming error.
        if not image_bytes:
            return None
        img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return None

        height, width = img.shape[:2]
        page_area = float(height) * float(width)

        rects = reading_order(find_photos(img, params))
        regions = [_region(r, page_area) for r in rects]

        if not want_images:
            return [], regions

        quality = quality_setting
        if quality == 'auto':
            found = source_quality(image_bytes)
            quality = matched_quality(found, quality_tolerance)
            debug(
                f'scan_cropper: source quality {found if found is not None else "not a lossy JPEG"}, '
                f'writing crops at {quality}'
            )

        crops = []
        for index, rect in enumerate(rects):
            straight = abs(normalise_rect(rect)[2]) < DESKEW_MIN_ANGLE
            crop = cut_out(img, rect) if (deskew and not straight) else bbox_crop(img, rect)
            if crop is None:
                warning(f'scan_cropper: region {index} is too small to crop ({regions[index]})')
                continue
            ok, buffer = cv2.imencode('.jpg', crop, [int(cv2.IMWRITE_JPEG_QUALITY), int(quality)])
            if not ok:
                warning(f'scan_cropper: region {index} failed to encode as JPEG')
                continue
            crop_height, crop_width = crop.shape[:2]
            crops.append(
                {
                    'data': buffer.tobytes(),
                    'width': int(crop_width),
                    'height': int(crop_height),
                    'region': int(index),
                }
            )
            regions[index]['cropped'] = True

        return crops, regions

    return split_scan
