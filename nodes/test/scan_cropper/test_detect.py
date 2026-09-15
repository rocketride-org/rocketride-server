# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Detector-core tests: the part of scan_cropper that actually looks at pixels.

The rest of the suite stubs `split_scan` out, so nothing there reaches `find_photos`,
the seam search, or `dedupe` — a regression in the separation logic would pass. These
drive the real functions over synthetic scans: a plain page with noise-filled boxes on
it, which is what the detector's own rules describe (plain, dominant-coloured, reaching
the edge is background; textured is not).

Synthetic rather than fixture-backed on purpose. A scan on disk pins one photograph of
one album; a generated page states the property being tested — that two prints mounted
edge to edge come apart, and that turning the seam search off leaves them joined.
"""

import sys
from pathlib import Path

import numpy as np

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from scan_cropper.detect import DetectParams, dedupe, find_photos, snap_to_border  # noqa: E402

PAGE_H, PAGE_W = 900, 1200
PAGE_TONE = 248  # plain, dominant, and reaching the edge: background by all three rules


def _page():
    """An empty scan: uniform paper, no texture anywhere."""
    return np.full((PAGE_H, PAGE_W, 3), PAGE_TONE, np.uint8)


def _photo(img, x, y, w, h, lo=0, hi=120, seed=7):
    """Paint one photograph: noise, so it reads as textured content rather than paper."""
    rng = np.random.default_rng(seed)
    img[y : y + h, x : x + w] = rng.integers(lo, hi, (h, w, 3), dtype=np.uint8)


def _sizes(rects):
    """The rectangles' dimensions, rounded and ordered, so a test can name them."""
    return sorted((round(s[0]), round(s[1])) for _c, s, _a in rects)


class TestFindPhotos:
    """What comes back from a whole scan."""

    def test_separated_photos_are_found_one_by_one(self):
        """The ordinary album page: three prints with paper between them."""
        img = _page()
        for index, (x, y) in enumerate(((80, 80), (560, 80), (80, 480))):
            _photo(img, x, y, 380, 350, seed=index)

        assert len(find_photos(img, DetectParams())) == 3

    def test_photos_mounted_edge_to_edge_are_cut_apart(self):
        """No paper between them — only a tonal step where one print ends.

        This is the case the seam search exists for: the two prints are one connected
        blob, and nothing but a straight border running the height of it says there are
        two photographs here.
        """
        img = _page()
        _photo(img, 120, 150, 400, 500, lo=0, hi=70, seed=1)
        _photo(img, 520, 150, 400, 500, lo=150, hi=220, seed=2)

        assert len(find_photos(img, DetectParams())) == 2

    def test_a_hairline_of_paper_between_prints_is_enough(self):
        """One pixel of page showing between two prints of the same tone."""
        img = _page()
        _photo(img, 120, 150, 400, 500, seed=1)
        _photo(img, 521, 150, 399, 500, seed=2)
        img[150:650, 520:521] = PAGE_TONE

        assert len(find_photos(img, DetectParams())) == 2

    def test_disabling_the_seam_search_leaves_them_joined(self):
        """`maxDepth 0` is documented as the speed lever for prints that never touch.

        Paired with the case above: the same scan, the same code, and the only thing
        deciding whether two photographs come out of it is this setting.
        """
        img = _page()
        _photo(img, 120, 150, 400, 500, lo=0, hi=70, seed=1)
        _photo(img, 520, 150, 400, 500, lo=150, hi=220, seed=2)

        assert len(find_photos(img, DetectParams(max_depth=0))) == 1

    def test_a_blank_page_yields_nothing(self):
        """Finding nothing is a normal outcome, not an error."""
        assert find_photos(_page(), DetectParams()) == []

    def test_specks_below_the_minimum_are_ignored(self):
        """Dust and scanner grit are smaller than any photograph."""
        img = _page()
        _photo(img, 80, 80, 380, 350, seed=1)
        _photo(img, 700, 600, 25, 25, seed=2)

        assert len(find_photos(img, DetectParams())) == 1

    def test_a_shape_too_long_to_be_a_photo_is_rejected(self):
        """`maxAspect` keeps a scanner-edge strip from being read as a panorama."""
        img = _page()
        _photo(img, 60, 400, 1080, 60, seed=1)

        assert find_photos(img, DetectParams()) == []

    def test_rectangles_come_back_in_full_resolution_coordinates(self):
        """Detection runs downscaled; the crops are cut at full size, so these scale back.

        Losing the scale-up would crop a corner of every photograph at the detection
        scale's fraction of the real size, which is why it is asserted against a run
        that did not downscale at all.
        """
        img = _page()
        _photo(img, 120, 150, 400, 500, seed=1)

        full = _sizes(find_photos(img, DetectParams()))[0]
        downscaled = _sizes(find_photos(img, DetectParams(detect_size=400)))[0]

        # Compared with a tolerance, never pixel for pixel: where exactly an edge lands
        # depends on the noise that painted the photograph.
        assert abs(full[0] - 400) <= 3 and abs(full[1] - 500) <= 3
        assert abs(downscaled[0] - full[0]) <= 5 and abs(downscaled[1] - full[1]) <= 5


class TestDedupe:
    """`snap_to_border` grows rectangles, which can push two onto the same photograph."""

    def test_an_overlapping_pair_keeps_the_larger(self):
        larger = ((300.0, 300.0), (400.0, 500.0), 0.0)
        smaller = ((320.0, 310.0), (380.0, 480.0), 0.0)

        kept = dedupe([smaller, larger])

        assert len(kept) == 1
        assert kept[0][1] == (400.0, 500.0)

    def test_rectangles_on_different_photos_are_both_kept(self):
        one = ((300.0, 300.0), (400.0, 500.0), 0.0)
        other = ((900.0, 700.0), (300.0, 300.0), 0.0)

        assert len(dedupe([one, other])) == 2


class TestSnapToBorder:
    """Refinement declines rather than guessing."""

    def test_a_rectangle_too_small_to_refine_is_returned_unchanged(self):
        """Below the size floor there is not enough border to measure against."""
        tiny = ((50.0, 50.0), (10.0, 10.0), 0.0)

        assert snap_to_border(_page(), tiny) == tiny
