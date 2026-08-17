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

"""The decision itself: which rotation wins, and when to refuse to answer."""

import sys
import unittest
from pathlib import Path

NODES_SRC = Path(__file__).parent.parent.parent / 'src' / 'nodes'
# Move to the front rather than "insert only if absent": another test dir already on
# sys.path can hold a package with the same name as the node (see #1687).
while str(NODES_SRC) in sys.path:
    sys.path.remove(str(NODES_SRC))
sys.path.insert(0, str(NODES_SRC))

from image_orient.vote import (  # noqa: E402
    FEW_FACES,
    MIXED_SIGNALS,
    NO_FACES,
    ROTATIONS,
    THIN_MARGIN,
    decide,
    score,
)


def _agreeing(scores):
    """Confidences whose strongest entry matches the strongest score, so the gate passes."""
    return list(scores)


class TestScore(unittest.TestCase):
    """Scoring one rotation from its detections."""

    def test_nothing_detected_scores_zero(self):
        self.assertEqual(score([], 1000.0), 0.0)

    def test_confidence_is_weighted_by_share_of_the_frame(self):
        # A face filling a quarter of the frame at confidence 0.8 scores 0.2.
        self.assertAlmostEqual(score([(0.8, 50.0, 50.0)], 100.0 * 100.0), 0.2)

    def test_faces_accumulate(self):
        two = score([(0.9, 10.0, 10.0), (0.9, 10.0, 10.0)], 100.0 * 100.0)
        one = score([(0.9, 10.0, 10.0)], 100.0 * 100.0)
        self.assertAlmostEqual(two, one * 2)

    def test_score_is_independent_of_detection_size(self):
        """The whole point of using relative area: re-tuning detectSize must not move the scores.

        Scored in pixels, doubling the detection size would quadruple every score and silently
        change what ``margin`` means.
        """
        small = score([(0.9, 40.0, 40.0)], 400.0 * 400.0)
        large = score([(0.9, 80.0, 80.0)], 800.0 * 800.0)
        self.assertAlmostEqual(small, large)


class TestConfidenceWeight(unittest.TestCase):
    """The exponent that decides whether a bigger face or a clearer one wins."""

    # A smaller but much more confident face, against a larger doubtful one — the shape of
    # 31.crop0, where the upside-down detection draws the bigger box.
    CLEAR_SMALL = [(0.92, 30.0, 30.0)]
    DOUBTFUL_BIG = [(0.85, 34.0, 34.0)]
    AREA = 100.0 * 100.0

    def test_at_one_the_larger_face_wins(self):
        self.assertGreater(score(self.DOUBTFUL_BIG, self.AREA), score(self.CLEAR_SMALL, self.AREA))

    def test_raising_it_lets_the_clearer_face_win(self):
        self.assertGreater(score(self.CLEAR_SMALL, self.AREA, 8.0), score(self.DOUBTFUL_BIG, self.AREA, 8.0))

    def test_it_defaults_to_one(self):
        """The default must be the neutral value, not a silent preference."""
        self.assertAlmostEqual(score(self.CLEAR_SMALL, self.AREA), score(self.CLEAR_SMALL, self.AREA, 1.0))

    def test_it_never_reorders_when_one_rotation_has_nothing(self):
        """No exponent can conjure a score out of no detections."""
        for power in (1.0, 4.0, 8.0, 16.0):
            self.assertEqual(score([], self.AREA, power), 0.0)


class TestDecide(unittest.TestCase):
    """Choosing a correction, or abstaining."""

    def test_each_rotation_can_win(self):
        for index, expected in enumerate(ROTATIONS):
            scores = [0.01, 0.01, 0.01, 0.01]
            scores[index] = 1.0
            rotation, confident, reason, _, _ = decide(scores, _agreeing(scores), [3, 3, 3, 3], margin=2.0, min_faces=2)
            self.assertEqual(rotation, expected)
            self.assertTrue(confident)
            self.assertIsNone(reason)

    def test_no_detections_anywhere_abstains(self):
        rotation, confident, reason, _, _ = decide([0.0] * 4, [0.0] * 4, [0] * 4, margin=2.0, min_faces=2)
        self.assertEqual(rotation, 0)
        self.assertFalse(confident)
        self.assertEqual(reason, NO_FACES)

    def test_a_thin_lead_abstains(self):
        rotation, confident, reason, ratio, _ = decide(
            [1.0, 0.8, 0.0, 0.0], [0.9, 0.8, 0.0, 0.0], [4, 4, 0, 0], margin=2.0, min_faces=2
        )
        self.assertEqual(rotation, 0)
        self.assertFalse(confident)
        self.assertEqual(reason, THIN_MARGIN)
        self.assertAlmostEqual(ratio, 1.25)

    def test_rotations_disagreeing_is_a_thin_margin_not_its_own_case(self):
        """Two rotations scoring alike *is* a thin margin; a separate branch could never be hit."""
        _, _, reason, _, _ = decide([1.0, 1.0, 0.0, 0.0], [0.9, 0.9, 0.0, 0.0], [5, 5, 0, 0], margin=2.0, min_faces=2)
        self.assertEqual(reason, THIN_MARGIN)

    def test_too_few_faces_abstains_even_with_an_enormous_lead(self):
        """One face was behind most of the wrong answers in calibration, however confident."""
        rotation, confident, reason, ratio, _ = decide(
            [1.0, 0.0, 0.0, 0.0], [0.9, 0.0, 0.0, 0.0], [1, 0, 0, 0], margin=2.0, min_faces=2
        )
        self.assertEqual(rotation, 0)
        self.assertFalse(confident)
        self.assertEqual(reason, FEW_FACES)
        self.assertEqual(ratio, float('inf'))

    def test_a_lone_runner_up_of_zero_passes_without_dividing(self):
        """The healthiest input there is — the detector fired at one rotation and nowhere else.

        Computing the ratio blind would raise ZeroDivisionError on exactly the strongest evidence.
        """
        rotation, confident, reason, ratio, _ = decide(
            [0.5, 0.0, 0.0, 0.0], [0.9, 0.0, 0.0, 0.0], [3, 0, 0, 0], margin=2.0, min_faces=2
        )
        self.assertEqual(rotation, 90 * 0)  # index 0 -> no correction needed, but confidently so
        self.assertTrue(confident)
        self.assertIsNone(reason)
        self.assertEqual(ratio, float('inf'))

    def test_a_confident_zero_is_not_an_abstention(self):
        """Both report rotation 0; only ``confident`` separates 'verified upright' from 'unsure'."""
        _, upright, _, _, _ = decide([1.0, 0.0, 0.0, 0.0], [0.9, 0.0, 0.0, 0.0], [3, 0, 0, 0], margin=2.0, min_faces=2)
        _, unsure, _, _, _ = decide([1.0, 0.9, 0.0, 0.0], [0.9, 0.8, 0.0, 0.0], [3, 3, 0, 0], margin=2.0, min_faces=2)
        self.assertTrue(upright)
        self.assertFalse(unsure)

    def test_the_reported_index_is_the_best_scoring_one_even_when_abstaining(self):
        """``faces`` is reported from it, and on an abstention there is no winner to report from."""
        *_, best = decide([0.1, 0.9, 0.0, 0.0], [0.5, 0.9, 0.0, 0.0], [2, 7, 0, 0], margin=5.0, min_faces=2)
        self.assertEqual(best, 1)


class TestAgreement(unittest.TestCase):
    """Two readings of the same detections must point the same way before the node acts."""

    def test_disagreement_abstains(self):
        """Area says 0, confidence says 180 — exactly 31.crop0, where area is the one that is wrong."""
        rotation, confident, reason, _, _ = decide(
            [0.037, 0.026, 0.031, 0.0], [0.85, 0.74, 0.92, 0.0], [1, 1, 1, 0], margin=1.1, min_faces=1
        )
        self.assertEqual(rotation, 0)
        self.assertFalse(confident)
        self.assertEqual(reason, MIXED_SIGNALS)

    def test_agreement_acts_on_a_lead_too_thin_to_stand_alone(self):
        """1.15 would never clear the old 2.0 bar; agreement is what makes it safe."""
        rotation, confident, reason, _, _ = decide(
            [0.5, 0.0, 0.0, 0.58], [0.8, 0.0, 0.0, 0.95], [2, 0, 0, 2], margin=1.1, min_faces=2
        )
        self.assertEqual(rotation, 270)
        self.assertTrue(confident)
        self.assertIsNone(reason)

    def test_the_margin_is_still_checked_before_agreement(self):
        """A thin margin reports as such even when the two signals happen to agree."""
        _, _, reason, _, _ = decide([1.0, 0.99, 0.0, 0.0], [0.9, 0.5, 0.0, 0.0], [3, 3, 0, 0], margin=1.1, min_faces=2)
        self.assertEqual(reason, THIN_MARGIN)


if __name__ == '__main__':
    unittest.main()
