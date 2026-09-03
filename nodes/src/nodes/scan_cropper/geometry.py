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
Rotated-rectangle geometry and the crop itself.

A detected photo is an OpenCV ``minAreaRect`` — ``((cx, cy), (w, h), angle)`` — and everything
here either keeps that representation sane or turns one into pixels.

Ported from the author's own work: the rectangle helpers and ``cut_out`` from ``autocrop``
(commit ``faf2942``), ``ratio_error`` and the standard print ratios from ``ScanCropper``
(commit ``120c81b``).
"""

from ai.common.opencv import cv2
import numpy as np

# Aspect ratios of the standard print sizes, long side over short: 1:1, 8x10, 4:3, 7:5,
# 3.5x5, 3:2, 8:5. Used only to arbitrate a seam cut — never to accept or reject a lone
# candidate, since a trimmed print or a panorama is a real photo at a non-standard ratio.
STD_RATIOS = (1.0, 1.25, 1.333, 1.4, 1.428, 1.5, 1.6)

# Below this angle a photo is already straight, so its pixels are copied rather than
# resampled. cut_out is exact only at angle 0; at a hundredth of a degree warpPerspective
# still rewrites every pixel of the crop for no visible gain.
DESKEW_MIN_ANGLE = 0.05


def normalise_rect(rect):
    """
    Keep a rotated rectangle in the orientation it was scanned in.

    ``minAreaRect`` is free to report a photo as e.g. 400x600 at -90 degrees instead of 600x400
    at 0; taken at face value that would silently rotate the saved crop by a quarter turn.
    Rotating the angle into +/-45 degrees and swapping the sides with it keeps the crop upright.

    Args:
        rect: A rectangle as ``((cx, cy), (w, h), angle)``.

    Returns:
        tuple: The same rectangle with ``angle`` in ``[-45, 45]``.
    """
    (cx, cy), (w, h), angle = rect
    while angle < -45:
        angle += 90
        w, h = h, w
    while angle > 45:
        angle -= 90
        w, h = h, w
    return ((cx, cy), (w, h), angle)


def rect_axes(rect):
    """
    Unit vectors along the rectangle's own width and height.

    Args:
        rect: A rectangle as ``((cx, cy), (w, h), angle)``.

    Returns:
        tuple: ``(u, v)`` as float arrays of shape (2,), where ``u`` runs along the width and
        ``v`` along the height.
    """
    angle = np.deg2rad(rect[2])
    return (
        np.array([np.cos(angle), np.sin(angle)]),
        np.array([-np.sin(angle), np.cos(angle)]),
    )


def rect_corners(rect):
    """
    Corners of a rectangle in its own order: top-left, top-right, bottom-right, bottom-left.

    Args:
        rect: A rectangle as ``((cx, cy), (w, h), angle)``.

    Returns:
        numpy.ndarray: A 4x2 float32 array of corner coordinates.
    """
    (cx, cy), (w, h), _angle = rect
    u, v = rect_axes(rect)
    c = np.array([cx, cy])
    return np.array(
        [
            c - w / 2 * u - h / 2 * v,
            c + w / 2 * u - h / 2 * v,
            c + w / 2 * u + h / 2 * v,
            c - w / 2 * u + h / 2 * v,
        ],
        dtype=np.float32,
    )


def cut_out(img, rect):
    """
    Deskew and cut one rectangle out of an image.

    ``rect_corners`` gives the rectangle's geometric corners, which sit on pixel edges, so they
    map to ``(0,0)..(w,h)`` and not to ``(0,0)..(w-1,h-1)``. Getting that wrong rescales the
    crop by ``(w-1)/w``, which is under a pixel but enough to put every output pixel between two
    input ones and blur the lot. With it right, a photo that was lying straight is copied out
    untouched.

    Args:
        img: The full-resolution source image as a BGR array.
        rect: The photo's rectangle in source coordinates.

    Returns:
        numpy.ndarray | None: The cropped, deskewed image, or ``None`` when the rectangle rounds
        to under 2 px on a side — the caller must treat that as a skipped crop, not an error.
    """
    rect = normalise_rect(rect)
    w, h = int(round(rect[1][0])), int(round(rect[1][1]))
    if w < 2 or h < 2:
        return None
    dst = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(rect_corners(rect), dst)
    return cv2.warpPerspective(img, matrix, (w, h), flags=cv2.INTER_CUBIC)


def bbox_crop(img, rect):
    """
    Cut the upright bounding box of a rectangle, without resampling.

    The deskew-off path: pixels are sliced straight out of the source, so nothing is
    interpolated, at the cost of leaving page background in the corners of a tilted photo.
    The box is clamped to the image, since a rectangle grown by ``snap_to_border`` can extend
    past the edge of the scan.

    Args:
        img: The full-resolution source image as a BGR array.
        rect: The photo's rectangle in source coordinates.

    Returns:
        numpy.ndarray | None: The cropped image, or ``None`` when the clamped box is under 2 px
        on a side.
    """
    height, width = img.shape[:2]
    corners = rect_corners(normalise_rect(rect))
    x0 = max(0, int(np.floor(corners[:, 0].min())))
    y0 = max(0, int(np.floor(corners[:, 1].min())))
    x1 = min(width, int(np.ceil(corners[:, 0].max())))
    y1 = min(height, int(np.ceil(corners[:, 1].max())))
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None
    return img[y0:y1, x0:x1]


def ratio_error(rect) -> float:
    """
    How far a rectangle is, in percent, from the nearest standard print ratio.

    Args:
        rect: A rectangle as ``((cx, cy), (w, h), angle)``.

    Returns:
        float: The smallest relative distance to any of :data:`STD_RATIOS`, as a percentage.
        A degenerate rectangle (a side under 1 px) returns 100.0, which no tolerance accepts.
    """
    cw, ch = rect[1]
    if min(cw, ch) < 1:
        return 100.0
    r = max(cw, ch) / min(cw, ch)
    return min(abs(r - s) / s * 100 for s in STD_RATIOS)
