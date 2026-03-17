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
Frame-level object detection using a HuggingFace object-detection pipeline.
"""

import io
from dataclasses import dataclass
from typing import Any, Dict, List, Set


@dataclass
class Detection:
    """A single object detection result."""

    label: str
    score: float
    box: Dict[str, float]


def _is_columnar(d: dict) -> bool:
    for v in d.values():
        if isinstance(v, list):
            return True
    return False


def _unzip_columnar(d: dict) -> list:
    list_keys = [k for k, v in d.items() if isinstance(v, list)]
    if not list_keys:
        return [d]
    n = len(d[list_keys[0]])
    result = []
    for i in range(n):
        row = {}
        for k, v in d.items():
            row[k] = v[i] if isinstance(v, list) and i < len(v) else v
        result.append(row)
    return result


class FrameDetector:
    """
    Object detection using a HuggingFace pipeline.

    Filters detections by confidence threshold and an optional class allowlist.
    No embedding or reference image matching — that belongs in the
    visual_similarity_filter node.
    """

    def __init__(self, config: Dict[str, Any]):
        from ai.common.models.transformers import pipeline

        det_model = config.get('detection_model', 'facebook/detr-resnet-50')

        raw_allowlist = config.get('class_allowlist', [])
        if isinstance(raw_allowlist, str):
            self._class_allowlist: Set[str] = {
                c.strip().lower() for c in raw_allowlist.split(',') if c.strip()
            }
        elif isinstance(raw_allowlist, list):
            self._class_allowlist = {c.lower() for c in raw_allowlist if c}
        else:
            self._class_allowlist = set()

        self._min_confidence: float = float(config.get('min_confidence', 0.3))

        self._pipeline = pipeline(task='object-detection', model=det_model)

    def detect(self, frame_bytes: bytes) -> List[Detection]:
        """Run detection on a single PNG frame. Returns filtered detections."""
        from PIL import Image

        frame_image = Image.open(io.BytesIO(frame_bytes)).convert('RGB')
        try:
            raw = self._pipeline([frame_image])
        except Exception:
            return []

        results: List[Detection] = []
        for det in self._parse_raw(raw):
            label = det.get('label', '')
            score_raw = det.get('score', 0.0)
            score = float(score_raw) if not isinstance(score_raw, (list, type(None))) else 0.0
            box = det.get('box', {})

            if score < self._min_confidence:
                continue
            if self._class_allowlist and label.lower() not in self._class_allowlist:
                continue

            results.append(Detection(label=label, score=score, box=box))

        return results

    @staticmethod
    def _parse_raw(raw: Any) -> List[Dict[str, Any]]:
        if not raw:
            return []
        if isinstance(raw, list) and raw and isinstance(raw[0], list):
            return raw[0]
        if isinstance(raw, list) and raw and isinstance(raw[0], dict):
            first = raw[0]
            if _is_columnar(first):
                return _unzip_columnar(first)
            return raw
        return []
