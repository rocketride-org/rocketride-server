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

from rocketlib import IInstanceBase, AVI_ACTION, debug, warning
from ai.common.image import ImageProcessor
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    Per-frame object detection for the detect node.

    Accepts an image lane (AVI stream). Emits per frame:
      - text lane: JSON array of detections [{label, score, box, centroid}].
      - image lane: annotated frame with bounding boxes + labels.
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize per-instance image-accumulation state."""
        super().__init__(*args, **kwargs)
        self._image_data = None

    def _annotate(self, image, detections):
        """Draw boxes + labels onto a copy of the image.

        Args:
            image: Source PIL image.
            detections: Canonical detection dicts.

        Returns:
            Annotated PIL image copy.
        """
        from PIL import ImageDraw

        annotated = image.copy()
        draw = ImageDraw.Draw(annotated)
        for det in detections:
            b = det['box']
            draw.rectangle([b['x1'], b['y1'], b['x2'], b['y2']], outline='lime', width=2)
            draw.text((b['x1'], b['y1'] - 10), f'{det["label"]} {det["score"]:.2f}', fill='lime')
        return annotated

    def _emit(self, image, detections):
        """Write detections (text lane) and the annotated frame (image lane).

        Args:
            image: Source PIL image for this frame.
            detections: Canonical detection dicts.
        """
        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(detections))

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(self._annotate(image, detections), fmt='JPEG')
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/jpeg')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/jpeg', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/jpeg')

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        """Accumulate an inbound image stream and run detection on END.

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
                t0 = time.perf_counter()
                image = ImageProcessor.load_image_from_bytes(self._image_data)
                t_decode = (time.perf_counter() - t0) * 1000
                t0 = time.perf_counter()
                with self.IGlobal.device_lock:
                    detections = self.IGlobal.detector.detect(image)
                t_detect = (time.perf_counter() - t0) * 1000
                t0 = time.perf_counter()
                self._emit(image, detections)
                t_emit = (time.perf_counter() - t0) * 1000
                debug(
                    f'detect: decode={t_decode:.0f}ms detect={t_detect:.0f}ms '
                    f'emit={t_emit:.0f}ms total={t_decode + t_detect + t_emit:.0f}ms'
                )
            except Exception as exc:
                warning(f'detect: dropping frame due to inference error: {exc}')
            finally:
                self._image_data = None
            return self.preventDefault()
