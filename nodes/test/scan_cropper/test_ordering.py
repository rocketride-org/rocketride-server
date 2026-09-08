# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Unit test: scan_cropper sorts detected photos into page reading order.

``reading_order`` decides the index that becomes each crop's filename, so a regression here
renames every output rather than failing loudly. It is also the only detection-side logic
reachable from this suite: the nodes/test environment carries the engine's core deps but not
cv2 or Pillow, and ``ordering.py`` is deliberately stdlib-only so it can be driven directly.

Rectangles are OpenCV ``minAreaRect`` tuples — ``((cx, cy), (w, h), angle)`` — already
normalised to an angle within +/-45 degrees, which is what reaches the sort in the node.
"""

import sys
from pathlib import Path

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from scan_cropper.ordering import reading_order  # noqa: E402


def _rect(cx, cy, w=400.0, h=500.0, angle=0.0):
    """
    Build a minAreaRect tuple for a photo centred at (cx, cy).

    Args:
        cx: Centre x, in pixels.
        cy: Centre y, in pixels.
        w: Photo width, in pixels. Defaults to a portrait 400x500 print.
        h: Photo height, in pixels.
        angle: Rotation in degrees, normalised to +/-45.

    Returns:
        tuple: ``((cx, cy), (w, h), angle)``.
    """
    return ((cx, cy), (w, h), angle)


def _centres(rects):
    """Centre coordinates of each rect, for readable assertions."""
    return [(r[0][0], r[0][1]) for r in rects]


class TestReadingOrder:
    """Ordering behaviour across the page layouts an album scan actually produces."""

    def test_three_across_sorts_left_to_right(self):
        """A single row comes back left-to-right regardless of the order found."""
        found = [_rect(2000, 800), _rect(400, 800), _rect(1200, 800)]
        assert _centres(reading_order(found)) == [(400, 800), (1200, 800), (2000, 800)]

    def test_three_stacked_sorts_top_to_bottom(self):
        """A single column comes back top-to-bottom."""
        found = [_rect(600, 1800), _rect(600, 300), _rect(600, 1050)]
        assert _centres(reading_order(found)) == [(600, 300), (600, 1050), (600, 1800)]

    def test_grid_sorts_by_row_then_column(self):
        """A 2x2 grid reads across the top row first, then the bottom."""
        found = [
            _rect(1200, 1400),  # bottom-right
            _rect(400, 400),  # top-left
            _rect(1200, 400),  # top-right
            _rect(400, 1400),  # bottom-left
        ]
        assert _centres(reading_order(found)) == [(400, 400), (1200, 400), (400, 1400), (1200, 1400)]

    def test_slightly_lower_neighbour_stays_in_the_same_row(self):
        """
        A neighbour sitting a little lower is still the same row.

        This is the case the band exists for: photos laid on a page by hand are never aligned
        to the pixel. 60 px against a 500 px median height is well inside ROW_BAND_FRAC, so the
        pair must sort left-to-right rather than as two rows.
        """
        found = [_rect(1200, 460), _rect(400, 400)]
        assert _centres(reading_order(found)) == [(400, 400), (1200, 460)]

    def test_clearly_lower_neighbour_starts_a_new_row(self):
        """A full photo height down is a new row, and sorts after everything above it."""
        found = [_rect(400, 900), _rect(1200, 400)]
        assert _centres(reading_order(found)) == [(1200, 400), (400, 900)]

    def test_row_break_is_measured_from_the_row_top_not_the_previous_photo(self):
        """
        A row does not creep downward one small step at a time.

        Three photos each 40 px below the last span 80 px in total. Measured pairwise every gap
        looks like the same row, and measured from the row's first member it still is — but the
        distinction matters, because a staircase of many small steps would otherwise swallow a
        genuine row break. Asserted here so the banding stays anchored to the row top.
        """
        found = [_rect(400, 400), _rect(1200, 440), _rect(2000, 480)]
        assert _centres(reading_order(found)) == [(400, 400), (1200, 440), (2000, 480)]


class TestReadingOrderEdgeCases:
    """Degenerate inputs the node can hand the sort."""

    def test_empty_input(self):
        """No detections sorts to an empty list rather than raising."""
        assert reading_order([]) == []

    def test_single_rect(self):
        """One detection is returned unchanged."""
        found = [_rect(400, 400)]
        assert reading_order(found) == found

    def test_identical_centres_do_not_raise(self):
        """
        Two rects sharing a centre must not fall through to comparing the tuples themselves.

        Sorting on a (y, x) key alone would tie here and, in a naive implementation that put the
        rect in the key, Python would go on to compare ``(w, h)`` and then the angle. Indices
        break the tie instead, so the sort is total and order-stable.
        """
        found = [_rect(400, 400, w=300.0), _rect(400, 400, w=800.0)]
        assert len(reading_order(found)) == 2

    def test_input_is_not_mutated(self):
        """The caller's list is left alone — the node reuses it to build the regions payload."""
        found = [_rect(2000, 800), _rect(400, 800)]
        before = list(found)
        reading_order(found)
        assert found == before
