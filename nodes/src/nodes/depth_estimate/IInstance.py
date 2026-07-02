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
from ai.common.image.dense_resize import resize_for_inference, restore_dense_output
from ai.common.utils import colorize_depth
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance handles depth estimation for the depth_estimate node.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: JSON depth stats {min, max, mean}.
      - image lane: colorized depth map (red = near, blue = far).

    The model facade (ai.common.models.vision.depth) returns a raw depth array;
    resolution handling, stats and colorization are done here (node-side).
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize per-instance image-accumulation state."""
        super().__init__(*args, **kwargs)
        self._image_data = None

    def _emit(self, image):
        """Estimate depth for one image; write JSON stats (text lane) and a colorized map (image lane).

        Args:
            image: Decoded input PIL image for this frame.
        """
        resized, original_size = resize_for_inference(image, self.IGlobal.max_edge)
        t0 = time.perf_counter()
        with self.IGlobal.device_lock:
            depth_np = self.IGlobal.estimator.estimate(resized)
        debug(f'depth: infer={(time.perf_counter() - t0) * 1000:.0f}ms')
        depth_full = restore_dense_output(depth_np, original_size, mode='bilinear')

        stats = {
            'min': float(depth_full.min()),
            'max': float(depth_full.max()),
            'mean': float(depth_full.mean()),
        }

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(stats))

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(colorize_depth(depth_full), fmt='JPEG')
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/jpeg')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/jpeg', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/jpeg')

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        """Accumulate an inbound image stream and run depth estimation on END.

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
                self._emit(image)
            except Exception as exc:
                warning(f'depth_estimate: dropping frame due to inference error: {exc}')
            finally:
                self._image_data = None
            return self.preventDefault()
