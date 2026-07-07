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
from ai.common.image import Image, ImageProcessor
from ai.common.image.dense_resize import resize_for_inference, restore_dense_output
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

        orig_rgb = image.convert('RGB')
        # Downscale only for inference; the cutout is restored to the original resolution.
        source_capped, original_size = resize_for_inference(orig_rgb, self.IGlobal.max_edge)

        t0 = time.perf_counter()
        with self.IGlobal.device_lock:
            alpha = self.IGlobal.remover.remove(source_capped)
        debug(f'bg_removal: infer={(time.perf_counter() - t0) * 1000:.0f}ms')

        alpha_norm = alpha.astype(np.float32) / 255.0
        stats = {
            'mean_alpha': float(alpha_norm.mean()),
            'alpha_coverage_pct': float((alpha_norm > 0.5).mean() * 100.0),
        }

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(stats))

        if self.instance.hasListener('image'):
            # Restore the matte to the original resolution and composite over the full-res
            # source so the cutout matches the input size. Straight (un-premultiplied) alpha
            # avoids dark fringes when consumers re-composite over a non-black background.
            t0 = time.perf_counter()
            alpha_full = restore_dense_output(alpha, original_size, mode='bilinear')
            r, g, b = orig_rgb.split()
            rgba = Image.merge('RGBA', (r, g, b, Image.fromarray(alpha_full, mode='L')))
            # Fast zlib level: ~5-6x faster encode on big RGBA cutouts, slightly larger file.
            image_bytes = ImageProcessor.get_bytes(rgba, compress_level=1)
            debug(f'bg_removal: encode={(time.perf_counter() - t0) * 1000:.0f}ms out={len(image_bytes) / 1e6:.1f}MB')
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
            try:
                image = ImageProcessor.load_image_from_bytes(self._image_data)
                self._emit(image)
            except Exception as exc:
                warning(f'background_removal: dropping frame due to inference error: {exc}')
            finally:
                self._image_data = None
            return self.preventDefault()
