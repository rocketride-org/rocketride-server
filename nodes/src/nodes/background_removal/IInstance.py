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

from rocketlib import IInstanceBase, AVI_ACTION
from ai.common.image import Image, ImageProcessor
from ai.common.image.dense_resize import resize_for_inference
from .IGlobal import IGlobal


class IInstance(IInstanceBase):
    """
    IInstance handles background removal for the background_removal node.

    Accepts image lane (AVI stream). Emits per frame:
      - text lane: JSON alpha stats {mean_alpha, alpha_coverage_pct}.
      - image lane: RGBA cutout PNG (straight, non-premultiplied alpha).

    The model facade (ai.common.models.vision.background) returns a raw alpha
    matte; source capping, RGBA compositing and stats are done here (node-side).
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize per-instance image-accumulation state."""
        super().__init__(*args, **kwargs)
        self._image_data = None

    def _emit(self, image):
        """Remove background for one image; write JSON stats (text) and an RGBA cutout (image).

        Args:
            image: Decoded input PIL image for this frame.
        """
        import numpy as np

        # Cap the source first; the cutout is emitted at this (capped) resolution.
        source_capped, _ = resize_for_inference(image.convert('RGB'), self.IGlobal.max_edge)

        with self.IGlobal.device_lock:
            alpha = self.IGlobal.remover.remove(source_capped)

        alpha_norm = alpha.astype(np.float32) / 255.0
        stats = {
            'mean_alpha': float(alpha_norm.mean()),
            'alpha_coverage_pct': float((alpha_norm > 0.5).mean() * 100.0),
        }

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(stats))

        if self.instance.hasListener('image'):
            # Straight (un-premultiplied) alpha avoids dark fringes when consumers
            # re-composite over a non-black background.
            r, g, b = source_capped.split()
            rgba = Image.merge('RGBA', (r, g, b, Image.fromarray(alpha, mode='L')))
            image_bytes = ImageProcessor.get_bytes(rgba)
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/png')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/png', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/png')

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        """Accumulate an inbound image stream and run background removal on END.

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
            image = ImageProcessor.load_image_from_bytes(self._image_data)
            self._emit(image)
            self._image_data = None
            return self.preventDefault()
