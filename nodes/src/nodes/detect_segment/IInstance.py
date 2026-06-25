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

import colorsys
import json
import time

from rocketlib import IInstanceBase, AVI_ACTION, debug, warning

from ai.common.image import ImageProcessor

from .IGlobal import IGlobal


def _color_for_index(i: int):
    """Generate a visually distinct RGB color for instance/class index ``i``."""
    hue = (i * 0.6180339887) % 1.0  # golden-ratio jitter for separation
    r, g, b = colorsys.hsv_to_rgb(hue, 0.85, 0.95)
    return (int(r * 255), int(g * 255), int(b * 255))


def _decode_rle_to_mask(rle):
    """Decode a COCO RLE dict to a HxW uint8 binary mask (1 = foreground)."""
    from pycocotools import mask as mask_util  # type: ignore
    import numpy as np

    rle_copy = dict(rle)
    counts = rle_copy.get('counts')
    if isinstance(counts, str):
        rle_copy['counts'] = counts.encode('utf-8')
    decoded = mask_util.decode(rle_copy)
    if decoded.ndim == 3:
        decoded = decoded[..., 0]
    return decoded.astype(np.uint8)


class IInstance(IInstanceBase):
    """
    Per-frame segmentation for the detect_segment node.

    Accepts an image lane (AVI stream). Emits per frame:
      - text lane: JSON Masks payload (instance list or semantic dict).
      - image lane: annotated frame (translucent per-instance/class overlay).
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        """Initialize per-instance image-accumulation state."""
        super().__init__(*args, **kwargs)
        self._image_data = None

    def _annotate_instances(self, image, instances):
        """Overlay translucent per-instance colored masks + bbox + label on a copy of ``image``.

        Args:
            image: Source PIL image.
            instances: InstanceMask dicts {label, score, box, mask}.

        Returns:
            Annotated RGB PIL image.
        """
        from PIL import Image, ImageDraw
        import numpy as np

        base = image.convert('RGBA')
        overlay = Image.new('RGBA', base.size, (0, 0, 0, 0))
        draw = ImageDraw.Draw(overlay)

        for i, inst in enumerate(instances):
            color = _color_for_index(i)
            mask = inst.get('mask')
            if isinstance(mask, dict) and 'counts' in mask:
                try:
                    binary = _decode_rle_to_mask(mask)
                    color_layer = np.zeros((binary.shape[0], binary.shape[1], 4), dtype=np.uint8)
                    color_layer[..., 0] = color[0]
                    color_layer[..., 1] = color[1]
                    color_layer[..., 2] = color[2]
                    color_layer[..., 3] = (binary * 110).astype(np.uint8)  # ~43% alpha
                    inst_overlay = Image.fromarray(color_layer, mode='RGBA')
                    overlay.alpha_composite(inst_overlay)
                except Exception as exc:
                    warning(f'detect_segment: failed to render mask for instance {i}: {exc}')

            box = inst.get('box')
            if box:
                draw.rectangle(
                    [box['x1'], box['y1'], box['x2'], box['y2']],
                    outline=color + (255,),
                    width=2,
                )
                label = inst.get('label', 'object')
                score = float(inst.get('score', 0.0))
                draw.text(
                    (box['x1'], max(0, box['y1'] - 10)),
                    f'{label} {score:.2f}',
                    fill=color + (255,),
                )

        return Image.alpha_composite(base, overlay).convert('RGB')

    def _annotate_semantic(self, image, semantic):
        """Overlay a per-class colored map on top of ``image``.

        Args:
            image: Source PIL image.
            semantic: SemanticMask dict {semantic_map, classes, size, class_map}.

        Returns:
            Annotated RGB PIL image (or the input if decoding fails).
        """
        import base64
        import zlib
        import numpy as np
        from PIL import Image

        size = semantic.get('size') or [image.height, image.width]
        h, w = int(size[0]), int(size[1])
        # Bound payload-provided dims so a hostile size can't force a huge allocation.
        if h <= 0 or w <= 0 or (h * w) > (image.height * image.width * 4):
            warning(f'detect_segment: invalid semantic size [{h}, {w}], skipping overlay')
            return image
        classes = semantic.get('classes') or {}

        class_map_b64 = semantic.get('class_map')
        class_arr = None
        if class_map_b64:
            try:
                # Bounded decompression: cap output at h*w+1 so a zip-bomb payload can't blow up memory.
                decomp = zlib.decompressobj()
                raw_bytes = decomp.decompress(base64.b64decode(class_map_b64), max_length=h * w + 1)
                if len(raw_bytes) == h * w and not decomp.unconsumed_tail:
                    class_arr = np.frombuffer(raw_bytes, dtype=np.uint8).reshape(h, w)
            except Exception as exc:
                warning(f'detect_segment: failed to decode class_map: {exc}')

        if class_arr is None:
            try:
                class_arr = _decode_rle_to_mask(semantic['semantic_map'])
            except Exception as exc:
                warning(f'detect_segment: failed to decode semantic_map: {exc}')
                return image

        color_layer = np.zeros((class_arr.shape[0], class_arr.shape[1], 4), dtype=np.uint8)
        for idx, cid in enumerate(np.unique(class_arr).tolist()):
            if cid == 0:
                continue
            color = _color_for_index(idx)
            sel = class_arr == cid
            color_layer[sel, 0] = color[0]
            color_layer[sel, 1] = color[1]
            color_layer[sel, 2] = color[2]
            color_layer[sel, 3] = 110

        overlay = Image.fromarray(color_layer, mode='RGBA')
        if overlay.size != image.size:
            overlay = overlay.resize(image.size, resample=Image.NEAREST)
        _ = classes  # class names are surfaced in the JSON, not drawn on pixels
        return Image.alpha_composite(image.convert('RGBA'), overlay).convert('RGB')

    def _emit(self, image, result):
        """Emit the JSON Masks payload (text) and the annotated frame (image).

        Args:
            image: Source PIL image for this frame.
            result: instance list or semantic dict from the segmenter.
        """
        if self.IGlobal.segmenter.mode == 'semantic':
            annotated = self._annotate_semantic(image, result)
        else:
            annotated = self._annotate_instances(image, result or [])

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(result, default=str))

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(annotated, fmt='JPEG')
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/jpeg')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/jpeg', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/jpeg')

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        """Accumulate an inbound image stream and run segmentation on END.

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
                    result = self.IGlobal.segmenter.segment(image)
                debug(f'segment: infer={(time.perf_counter() - t0) * 1000:.0f}ms')
                self._emit(image, result)
            except Exception as exc:
                warning(f'detect_segment: dropping frame due to inference error: {exc}')
            finally:
                self._image_data = None
            return self.preventDefault()
