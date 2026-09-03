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
Reading order for the photos found on one scanned page.

Detection returns rectangles in whatever order the contour walk reached them, which is
stable across runs but arbitrary against the page. The emitted index becomes part of the
output filename (``<scan>.crop<N>.jpg``), so it is sorted here into the order a person
reads the page: top row left-to-right, then the next row down.

Deliberately free of cv2 and numpy — this is arithmetic over rectangle tuples, and keeping
it dependency-free is what lets the node's unit tests reach it under the engine's bundled
Python, where the imaging libraries are not installed.
"""

from statistics import median

# Two photos count as the same row when their centres sit within this share of the median
# photo height. Half a photo is forgiving enough for a hand-laid album page (neighbours are
# rarely aligned to the pixel) without merging genuinely separate rows, which are a whole
# photo height apart.
ROW_BAND_FRAC = 0.5


def _rect_centre_and_height(rect):
    """
    Centre and upright height of one rotated rectangle.

    Args:
        rect: A rectangle as ``((cx, cy), (w, h), angle)`` — OpenCV's ``minAreaRect`` shape.

    Returns:
        tuple: ``(cx, cy, h)`` as floats. Rectangles reach here normalised (angle within
        +/-45 degrees), so ``h`` is already the extent along the page's vertical axis and needs
        no further projection.
    """
    (cx, cy), (_w, h), _angle = rect
    return float(cx), float(cy), float(h)


def reading_order(rects):
    """
    Sort rectangles into page reading order: top row left-to-right, then downward.

    Rows are found by banding the vertical centres rather than by clustering: photos are
    walked top-down and a new row is started whenever the next centre falls more than
    ``ROW_BAND_FRAC`` of a median photo height below the current row's first member. That
    handles a neighbour sitting a few pixels lower — the common case on a hand-laid page —
    without needing a tolerance tuned per scan.

    Args:
        rects: An iterable of rectangles as ``((cx, cy), (w, h), angle)``.

    Returns:
        list: The same rectangle objects, reordered. The input is not mutated. An empty or
        single-element input is returned as a plain list unchanged.
    """
    items = list(rects)
    if len(items) < 2:
        return items

    metrics = [_rect_centre_and_height(r) for r in items]
    band = median(m[2] for m in metrics) * ROW_BAND_FRAC

    # Index alongside the rect so the sort never has to compare rect tuples themselves,
    # which would raise once two share a centre.
    order = sorted(range(len(items)), key=lambda i: (metrics[i][1], metrics[i][0]))

    rows = []
    current = [order[0]]
    row_top = metrics[order[0]][1]
    for i in order[1:]:
        if metrics[i][1] - row_top > band:
            rows.append(current)
            current = [i]
            row_top = metrics[i][1]
        else:
            current.append(i)
    rows.append(current)

    result = []
    for row in rows:
        for i in sorted(row, key=lambda i: metrics[i][0]):
            result.append(items[i])
    return result
