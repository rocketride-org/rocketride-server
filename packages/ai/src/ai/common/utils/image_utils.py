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

Deps are pulled in lazily (inside functions) so importing this module is cheap
and gpu_guard-safe. Pillow is sourced via ``ai.common.image`` (whose
``depends()`` guarantees it is installed); ``numpy`` is a base engine dep.
"""

from __future__ import annotations

import base64
import io
import zlib
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
    # A live PIL image means Pillow is already imported here, so use its methods
    # directly (no import needed); anything else is unsupported.
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
