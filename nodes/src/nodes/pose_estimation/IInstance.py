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

import json
import time
from typing import Any, Dict, List

from rocketlib import IInstanceBase, AVI_ACTION, debug, warning
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance handles per-frame pose estimation for the pose_estimation node.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: JSON array of person dicts (box + 17 COCO keypoints).
      - image lane: annotated frame with skeleton + keypoints.

    Inference is delegated to the PoseEstimator facade (ai.common.models.vision.pose),
    which runs on the model server when --modelserver is set, else locally.
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize per-instance image-accumulation state."""
        super().__init__(*args, **kwargs)
        self._image_data = None

    def _annotate(self, image, persons: List[Dict[str, Any]]):
        """Draw bbox + skeleton edges + keypoint dots onto a copy of the image.

        Keypoints scoring below the IGlobal threshold are skipped, and any edge
        with either endpoint skipped is dropped.

        Args:
            image: Source PIL image.
            persons: Canonical person dicts (box + keypoints).

        Returns:
            Annotated PIL image copy.
        """
        from PIL import ImageDraw
        from ai.common.models.vision.pose import COCO_17_EDGES

        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)
        threshold = self.IGlobal.threshold

        for person in persons:
            b = person['box']
            draw.rectangle([b['x1'], b['y1'], b['x2'], b['y2']], outline='lime', width=2)

            kpts = person['keypoints']
            for i, j in COCO_17_EDGES:
                if i >= len(kpts) or j >= len(kpts):
                    continue
                a, c = kpts[i], kpts[j]
                if a['score'] < threshold or c['score'] < threshold:
                    continue
                draw.line([(a['x'], a['y']), (c['x'], c['y'])], fill='green', width=2)

            for kp in kpts:
                if kp['score'] < threshold:
                    continue
                x, y = kp['x'], kp['y']
                draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill='cyan', outline='cyan')

        return annotated

    def _emit(self, image, persons: List[Dict[str, Any]]):
        """Write the person JSON (text lane) and the annotated frame (image lane).

        Args:
            image: Source PIL image for this frame.
            persons: Canonical person dicts from the estimator.
        """
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(persons))

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(self._annotate(image, persons), fmt='JPEG')
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/jpeg')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/jpeg', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/jpeg')

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        """Accumulate an inbound image stream and run pose estimation on END.

        Args:
            action: AVI stream action (BEGIN/WRITE/END).
            mimeType: MIME type of the image chunk.
            buffer: Raw bytes for a WRITE action.

        Returns:
            preventDefault() on END to suppress default forwarding; None otherwise.
        """
        if action == AVI_ACTION.BEGIN:
            self._image_data = bytearray()
        elif action == AVI_ACTION.WRITE:
            self._image_data += buffer
        elif action == AVI_ACTION.END:
            try:
                image = ImageProcessor.load_image_from_bytes(self._image_data)
                t0 = time.perf_counter()
                with self.IGlobal.device_lock:
                    persons = self.IGlobal.pose_estimator.estimate(image)
                debug(f'pose: infer={(time.perf_counter() - t0) * 1000:.0f}ms')
                self._emit(image, persons)
            except Exception as exc:
                warning(f'pose_estimation: dropping frame due to inference error: {exc}')
            finally:
                self._image_data = None
            return self.preventDefault()
