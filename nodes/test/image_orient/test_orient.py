# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The real `orient` callable, over shapes that defeat it.

`test_emit` stubs this function out and `test_vote` tests the arithmetic behind it, so
nothing drove the decode-and-downscale path itself. That is where an image can stop the
node with an exception instead of a reason — the one outcome its contract rules out.

The detector is faked: what is under test is what happens to the frame before detection,
not the detection.
"""

import sys
import unittest
from pathlib import Path

import numpy as np

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from ai.common.opencv import cv2  # noqa: E402
from image_orient import orient as orient_module  # noqa: E402
from image_orient.vote import NO_FACES  # noqa: E402


def _png(width, height):
    """Encode a real PNG of the given shape, so the node's own decode is what reads it."""
    ok, buffer = cv2.imencode('.png', np.full((height, width, 3), 128, np.uint8))
    assert ok
    return buffer.tobytes()


def _build(detect_size):
    """The node's own `orient`, with the model swapped for a detector that finds nothing."""
    orient_module.build_detector = lambda min_confidence: object()
    orient_module.detect_rotations = lambda detector, lock, image: ([[], [], [], []], [0.0] * 4)
    return orient_module.build_orient({'detectSize': detect_size})


class TestExtremeShapes(unittest.TestCase):
    """A frame far longer than it is tall."""

    def test_a_sliver_abstains_instead_of_raising(self):
        """The short side scales to zero, and `cv2.resize` rejects a zero dimension.

        3000x2 at the default detectSize lands on (800, 0). Every other way an image can
        defeat this node is answered on the text lane; unfloored, this one was answered
        with an exception out of `writeImage`.
        """
        orient = _build(800)

        _data, record = orient(_png(3000, 2), 'image/png', want_image=True)

        self.assertTrue(record['decoded'])
        self.assertEqual(record['rotation'], 0)
        self.assertFalse(record['confident'])
        self.assertEqual(record['reason'], NO_FACES)

    def test_the_lowest_detect_size_reaches_ordinary_scans(self):
        """The floor of `detectSize` is 320, where a 25px side on an 8000px scan truncates."""
        orient = _build(320)

        _data, record = orient(_png(8000, 20), 'image/png', want_image=True)

        self.assertEqual(record['reason'], NO_FACES)

    def test_a_short_side_that_survives_is_unaffected(self):
        """7000x9 at 800 gives (800, 1) on its own — the floor changes nothing here."""
        orient = _build(800)

        _data, record = orient(_png(7000, 9), 'image/png', want_image=True)

        self.assertEqual(record['reason'], NO_FACES)

    def test_bytes_that_are_not_an_image_return_nothing_rather_than_raising(self):
        """The neighbouring case: undecodable input answers with None, not an exception.

        `IInstance` turns that into the forward and the `decoded: false` record; what is
        asserted here is only that nothing escapes.
        """
        orient = _build(800)

        self.assertIsNone(orient(b'not an image', 'image/png', want_image=True))
