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
Which way up, and whether we are sure enough to act.

Deliberately free of cv2 and numpy. The ``nodes/test`` suite runs under the engine's bundled
Python, which has neither, so keeping the decision here is what makes it unit-testable at all —
and the decision is the part worth testing, because getting it wrong turns a photo the wrong way
round rather than merely failing.
"""

ROTATIONS = (0, 90, 180, 270)

# Abstention reasons, as they appear on the text lane.
NO_FACES = 'no_faces'
THIN_MARGIN = 'thin_margin'
FEW_FACES = 'few_faces'
MIXED_SIGNALS = 'mixed_signals'
UNENCODABLE = 'unencodable_format'
NO_MODEL = 'no_model'


def score(detections, image_area: float, confidence_weight: float = 1.0) -> float:
    """
    Score one rotation from its detections, as ``confidence ** k * area``.

    Two things about a detection carry information, and they can disagree. Its **area** says how
    much of the frame the face fills, so a large foreground face outvotes a small background one.
    Its **confidence** says how face-like the model found it, which is the better signal when the
    same face is detected at more than one rotation — an upside-down face is still detected, just
    less confidently, and the box drawn around it can be the larger of the two.

    ``confidence_weight`` is the exponent ``k``, and it decides which wins. At 1 they contribute
    about equally. Raising it makes confidence dominate, which rescues photos where the wrong
    rotation happens to draw a bigger box — at the cost of acting on thinner evidence elsewhere.
    There is no universally right value, which is why it is a setting rather than a constant.

    Area is a *fraction* of the image rather than a pixel count, which keeps the score independent
    of ``detectSize``: scored in pixels, re-tuning the detection size would silently rescale every
    score and change what ``margin`` means.

    Args:
        detections: Iterable of ``(confidence, width, height)`` in the rotated frame's pixels.
        image_area: Area of that frame, in the same pixels.
        confidence_weight: The exponent applied to confidence before weighting by area.

    Returns:
        float: The rotation's score; 0.0 when nothing was detected.
    """
    if not image_area:
        return 0.0
    return sum((conf**confidence_weight) * (w * h) / image_area for conf, w, h in detections)


def decide(scores, confidences, faces, margin: float, min_faces: int):
    """
    Choose a correction, or abstain.

    Two independent readings of the same detections have to agree before the node acts. The
    area-weighted score says which rotation holds the most face; the single most confident
    detection says which rotation the model was most certain about. They usually coincide. Where
    they do not, the evidence is genuinely mixed and the node declines — measured over 45 labelled
    photographs, that one rule removed every wrong answer and let the margin fall from 2.0 to 1.1,
    taking the number corrected from 29 to 37.

    Args:
        scores: Four area-weighted scores, parallel to ``ROTATIONS``.
        confidences: Four best-single-detection confidences, parallel to ``ROTATIONS``.
        faces: Four surviving-detection counts, parallel to ``ROTATIONS``.
        margin: How many times the best score must exceed the runner-up.
        min_faces: How many faces must back the winner.

    Returns:
        tuple: ``(rotation, confident, reason, ratio, best_index)``. ``rotation`` is the correction
        to apply in degrees clockwise, and is 0 whenever the node declines to act — ``confident``
        is what separates "verified upright" from "do not know".
    """
    order = sorted(range(len(ROTATIONS)), key=lambda i: scores[i], reverse=True)
    best, runner = order[0], order[1]

    if scores[best] <= 0.0:
        return 0, False, NO_FACES, 0.0, best

    # A zero runner-up is the healthy case — one rotation fired and nothing else. Dividing would
    # raise on the strongest evidence there is.
    ratio = float('inf') if scores[runner] <= 0.0 else scores[best] / scores[runner]

    if faces[best] < min_faces:
        return 0, False, FEW_FACES, ratio, best
    if ratio < margin:
        return 0, False, THIN_MARGIN, ratio, best
    if max(range(len(ROTATIONS)), key=lambda i: confidences[i]) != best:
        return 0, False, MIXED_SIGNALS, ratio, best

    # A confident 0 is "measured, already upright" — an abstention reports 0 too, but unconfident.
    return ROTATIONS[best], True, None, ratio, best
