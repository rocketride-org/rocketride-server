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
Shared image + image-derived-array helpers for model loaders/facades.

Single home for converting images to wire bytes and for the base64+zlib codec
used to ship numpy arrays (depth maps, alpha mattes) over JSON.

Also home to the JPEG quality helpers: recovering the quality an image was saved
at, and choosing one to re-encode at. Those are pure standard library — no numpy,
no Pillow — because the nodes that use them (``scan_cropper``, ``image_orient``)
have unit tests that run under an interpreter carrying neither.

Deps are pulled in lazily (inside functions) so importing this module is cheap
and gpu_guard-safe. Pillow is sourced via ``ai.common.image`` (whose
``depends()`` guarantees it is installed); ``numpy`` is a base engine dep.
"""

from __future__ import annotations

import base64
import io
import struct
import zlib
from statistics import median
from typing import Any, Dict, Optional, Tuple


def image_to_bytes(image: Any) -> bytes:
    """Convert an image to PNG bytes for transport to the model server.

    Args:
        image: A PIL ``Image`` (converted to RGB then PNG-encoded) or raw
            ``bytes``/``bytearray`` (returned unchanged).

    Returns:
        PNG-encoded image bytes.

    Raises:
        TypeError: If ``image`` is neither bytes nor a PIL Image.
    """
    if isinstance(image, (bytes, bytearray)):
        return bytes(image)
    # A live PIL image means Pillow is already imported; anything else is unsupported.
    if type(image).__module__.startswith('PIL.'):
        buf = io.BytesIO()
        image.convert('RGB').save(buf, format='PNG')
        return buf.getvalue()
    raise TypeError(f'Expected PIL Image or bytes, got {type(image)}')


def encode_ndarray(arr: Any) -> Dict[str, Any]:
    """Encode a numpy array as a JSON-friendly base64+zlib payload.

    Args:
        arr: Any array-like; made C-contiguous before encoding.

    Returns:
        Dict with ``data`` (base64 of zlib-compressed raw bytes), ``shape`` (list
        of ints), ``dtype`` (str), and ``encoding`` ('zlib+base64').
    """
    import numpy as np

    a = np.ascontiguousarray(arr)
    return {
        'data': base64.b64encode(zlib.compress(a.tobytes())).decode('ascii'),
        'shape': [int(s) for s in a.shape],
        'dtype': str(a.dtype),
        'encoding': 'zlib+base64',
    }


def decode_ndarray(encoded: Dict[str, Any]) -> Any:
    """Decode an :func:`encode_ndarray` payload back into a numpy array.

    Args:
        encoded: A payload dict from encode_ndarray (``data``/``shape``/``dtype``).

    Returns:
        A writable numpy array with the original shape and dtype.
    """
    import numpy as np

    raw = zlib.decompress(base64.b64decode(encoded['data']))
    return np.frombuffer(raw, dtype=np.dtype(encoded['dtype'])).reshape(encoded['shape']).copy()


def colorize_depth(depth: Any) -> Any:
    """Render a 2D depth array as an RGB image for visualization.

    Values are min-max normalized and mapped near = red, mid = green, far = blue.

    Args:
        depth: 2D numpy array of depth values.

    Returns:
        A PIL RGB ``Image`` with the same height/width as ``depth``.
    """
    import numpy as np

    # Source Image via ai.common.image so its depends() guarantees Pillow,
    # mirroring how cuda_utils sources torch via ai.common.torch.
    from ai.common.image import Image

    d_min, d_max = depth.min(), depth.max()
    norm = ((depth - d_min) / (d_max - d_min + 1e-8) * 255).astype(np.uint8)

    r = norm
    g = (255 - np.abs(norm.astype(np.int16) - 128) * 2).clip(0, 255).astype(np.uint8)
    b = (255 - norm).astype(np.uint8)

    return Image.fromarray(np.stack([r, g, b], axis=-1))


def inference_scale(small_size: Tuple[int, int], original_size: Tuple[int, int]) -> Optional[Tuple[float, float]]:
    """(fx, fy) to map coords from a downscaled inference image back to the original.

    Sparse counterpart to ``dense_resize.restore_dense_output``: detection / pose / face
    run inference on a downscaled image, then scale their box / keypoint / centroid
    coords by these factors. PIL-free, so node unit tests can use it without Pillow.

    Returns None when the sizes already match (no rescale needed).
    """
    sw, sh = int(small_size[0]), int(small_size[1])
    ow, oh = int(original_size[0]), int(original_size[1])
    if sw == ow and sh == oh:
        return None
    return ow / sw, oh / sh


def scale_box(box: Dict[str, float], fx: float, fy: float) -> None:
    """Scale an ``{x1, y1, x2, y2}`` box in place by (fx, fy)."""
    box['x1'] *= fx
    box['x2'] *= fx
    box['y1'] *= fy
    box['y2'] *= fy


def scale_point(point: Dict[str, float], fx: float, fy: float) -> None:
    """Scale an ``{x, y}`` point (keypoint / centroid / landmark) in place by (fx, fy)."""
    point['x'] *= fx
    point['y'] *= fy


# The standard JPEG luminance quantisation table, which every encoder scales to hit a
# requested quality. Recovering the scale it was multiplied by recovers the quality.
STD_LUMA_QUANT = (
    16,
    11,
    10,
    16,
    24,
    40,
    51,
    61,
    12,
    12,
    14,
    19,
    26,
    58,
    60,
    55,
    14,
    13,
    16,
    24,
    40,
    57,
    69,
    56,
    14,
    17,
    22,
    29,
    51,
    87,
    80,
    62,
    18,
    22,
    37,
    56,
    68,
    109,
    103,
    77,
    24,
    35,
    55,
    64,
    81,
    104,
    113,
    92,
    49,
    64,
    78,
    87,
    103,
    121,
    120,
    101,
    72,
    92,
    95,
    98,
    112,
    100,
    103,
    99,
)

# What "auto" writes at, against the quality the input was saved at. Each row was measured by
# pushing photos through the crop and the deskew at every input quality, then taking the
# cheapest output setting whose end result is still within TOLERANCE dB of the best obtainable
# from that input. Tighten the tolerance and files grow for little visible gain; loosen it and
# they shrink quickly. On a 33-page album scanned at quality 75 the whole run comes to 657 MB
# at 0.2 dB, 463 MB at 0.5 and 330 MB at 1.0.
QUALITY_TOLERANCE = 0.5
TOLERANCE_STEPS = (0.2, 0.5, 1.0, 1.5)
SOURCE_QUALITY = (10, 20, 30, 40, 50, 60, 70, 75, 80, 90, 100)
MATCHED_QUALITY = (
    (28, 61, 77, 84, 88, 90, 93, 94, 95, 97, 98),  # 0.2 dB
    (20, 41, 60, 70, 77, 81, 86, 88, 90, 95, 96),  # 0.5 dB
    (20, 27, 37, 49, 57, 66, 74, 78, 83, 90, 92),  # 1.0 dB
    (20, 20, 27, 34, 42, 52, 63, 68, 74, 86, 88),  # 1.5 dB
)

# What to write when the input was not a lossy JPEG (a PNG or TIFF scan, or a page rendered
# from a PDF): there was no lossy step to match, so pick a high fixed point.
LOSSLESS_INPUT_QUALITY = 95


def _interp(x, xs, ys):
    """
    Linear interpolation over a table, clamping at both ends.

    Stands in for ``numpy.interp`` so this module stays dependency-free. End-clamping is not
    incidental — it is what makes an out-of-range tolerance resolve to the nearest calibrated
    row instead of extrapolating off the table into nonsense.

    Args:
        x: The point to evaluate at.
        xs: Strictly increasing sample positions.
        ys: Sample values, same length as ``xs``.

    Returns:
        float: The interpolated value, clamped to ``ys[0]`` / ``ys[-1]`` outside ``xs``.
    """
    if x <= xs[0]:
        return float(ys[0])
    if x >= xs[-1]:
        return float(ys[-1])
    for i in range(1, len(xs)):
        if x <= xs[i]:
            span = xs[i] - xs[i - 1]
            t = (x - xs[i - 1]) / span if span else 0.0
            return float(ys[i - 1]) + t * (float(ys[i]) - float(ys[i - 1]))
    return float(ys[-1])


def source_quality(data: bytes):
    """
    Recover the quality a JPEG was saved at, by reading it back out of the bytes.

    JPEG never records the quality number. What it records is the table the encoder divided
    its DCT coefficients by, and libjpeg builds that table by scaling a standard one — so the
    scale, and with it the quality, can be recovered. Both tables are sorted before comparing,
    which makes the result independent of the zigzag order the table happens to be stored in.

    Every failure path returns ``None`` rather than raising, so a caller can hand it arbitrary
    bytes. Note that ``None`` is also the honest answer for PNG and TIFF, where there was no
    lossy step to match in the first place.

    Args:
        data: The raw image bytes, as they arrived on the lane.

    Returns:
        float | None: The recovered quality in 1..100, or ``None`` when the bytes are not a
        JPEG, carry no luminance quantisation table, or the table is unusable.
    """
    if not data or len(data) < 4 or data[0] != 0xFF or data[1] != 0xD8:
        return None  # not a JPEG

    i = 2
    while i < len(data) - 3:
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker == 0xFF:
            i += 1  # fill byte: legal padding before the marker code, not a code itself
            continue
        if marker == 0xD8 or marker == 0x01 or 0xD0 <= marker <= 0xD7:  # no payload
            i += 2
            continue
        if marker in (0xDA, 0xD9):  # pixel data starts
            break
        length = struct.unpack('>H', data[i + 2 : i + 4])[0]
        segment = data[i + 4 : i + 2 + length]
        if marker == 0xDB:  # quantisation table
            p = 0
            while p + 65 <= len(segment):
                precision, table_id = segment[p] >> 4, segment[p] & 15
                p += 1
                if precision == 0 and table_id == 0:
                    table = list(segment[p : p + 64])
                    if min(table) <= 0:
                        return None
                    scale = median(a / b for a, b in zip(sorted(table), sorted(STD_LUMA_QUANT))) * 100.0
                    if scale <= 0:
                        return None
                    q = (200.0 - scale) / 2.0 if scale <= 100 else 5000.0 / scale
                    return max(1.0, min(100.0, q))
                p += 64 * (2 if precision else 1)
        i += 2 + length
    return None


def matched_quality(quality_in, tolerance: float = QUALITY_TOLERANCE) -> int:
    """
    Pick the output quality, given how good the input was and how much end quality to trade.

    Reads each calibrated row at the input quality, then interpolates across the rows at the
    requested tolerance — so a tolerance between two measured steps lands between their curves
    rather than snapping to one.

    Args:
        quality_in: The source quality from :func:`source_quality`, or ``None`` when the input
            was not a lossy JPEG.
        tolerance: dB of end quality to give up against the best obtainable. Values outside
            :data:`TOLERANCE_STEPS` clamp to the nearest calibrated row.

    Returns:
        int: The JPEG quality to encode crops at, or :data:`LOSSLESS_INPUT_QUALITY` when there
        was no lossy source to match.
    """
    if quality_in is None:
        return LOSSLESS_INPUT_QUALITY
    per_row = [_interp(quality_in, SOURCE_QUALITY, row) for row in MATCHED_QUALITY]
    return int(round(_interp(tolerance, TOLERANCE_STEPS, per_row)))
