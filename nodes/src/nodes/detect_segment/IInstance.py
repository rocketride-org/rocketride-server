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

import colorsys
import json

from rocketlib import IInstanceBase, AVI_ACTION, warning

from ai.common.image import ImageProcessor

from .IGlobal import IGlobal


def _color_for_index(i: int):
    """Generate a visually distinct RGB(A) color for instance/class index ``i``."""
    # Evenly spaced hues; bright saturation/value for visibility.
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
    IInstance handles per-frame segmentation for the Segmentation node.

    Accepts images via the image lane (AVI stream) and Image documents via the
    documents lane (e.g. frames produced by the frame_grabber node). Emits one
    Doc per frame with the Masks schema as JSON text, an annotated image
    (masks overlaid with translucent color per instance or class), and
    per-frame FrameMeta on metadata.

    Output shapes (build brief §4):
      - instance mode: list of InstanceMask dicts
        ``[{label, score, box, mask: {size, counts}}]``.
      - semantic mode: a single SemanticMask dict
        ``{semantic_map, classes, size}``.
    """

    IGlobal: IGlobal

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._chunk_id = 0
        self._image_data = None

    # ------------------------------------------------------------------
    # Annotation
    # ------------------------------------------------------------------

    def _annotate_instances(self, image, instances):
        """Overlay translucent per-instance colored masks + bbox + label on a copy of ``image``."""
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

        annotated = Image.alpha_composite(base, overlay).convert('RGB')
        return annotated

    def _annotate_semantic(self, image, semantic):
        """Overlay a per-class colored map on top of ``image``."""
        import base64
        import zlib
        import numpy as np
        from PIL import Image

        size = semantic.get('size') or [image.height, image.width]
        h, w = int(size[0]), int(size[1])
        classes = semantic.get('classes') or {}

        # Prefer the packed class_map for fidelity; fall back to the binary RLE.
        class_map_b64 = semantic.get('class_map')
        if class_map_b64:
            try:
                raw = np.frombuffer(zlib.decompress(base64.b64decode(class_map_b64)), dtype=np.uint8)
                if raw.size == h * w:
                    class_arr = raw.reshape(h, w)
                else:
                    class_arr = None
            except Exception as exc:
                warning(f'detect_segment: failed to decode class_map: {exc}')
                class_arr = None
        else:
            class_arr = None

        if class_arr is None:
            try:
                class_arr = _decode_rle_to_mask(semantic['semantic_map'])
            except Exception as exc:
                warning(f'detect_segment: failed to decode semantic_map: {exc}')
                return image

        color_layer = np.zeros((class_arr.shape[0], class_arr.shape[1], 4), dtype=np.uint8)
        unique_ids = np.unique(class_arr)
        for idx, cid in enumerate(unique_ids.tolist()):
            if cid == 0:
                continue
            color = _color_for_index(idx)
            sel = class_arr == cid
            color_layer[sel, 0] = color[0]
            color_layer[sel, 1] = color[1]
            color_layer[sel, 2] = color[2]
            color_layer[sel, 3] = 110

        overlay = Image.fromarray(color_layer, mode='RGBA')
        # Make sure overlay matches the base image size (it should already).
        if overlay.size != image.size:
            overlay = overlay.resize(image.size, resample=Image.NEAREST)
        base = image.convert('RGBA')
        annotated = Image.alpha_composite(base, overlay).convert('RGB')
        # Note: class names dict is rendered in metadata, not on the pixels —
        # there's no canonical way to label a contiguous semantic region.
        _ = classes
        return annotated

    # ------------------------------------------------------------------
    # Emission
    # ------------------------------------------------------------------

    def _emit(self, image, result, chunk_id):
        """Emit annotated image + JSON Masks payload for one frame."""
        mode = self.IGlobal.segmenter.mode

        if mode == 'semantic':
            annotated = self._annotate_semantic(image, result)
        else:
            annotated = self._annotate_instances(image, result or [])

        if self.instance.hasListener('text'):
            self.instance.writeText(json.dumps(result, default=str))

        if self.instance.hasListener('image'):
            image_bytes = ImageProcessor.get_bytes(annotated)
            self.instance.writeImage(AVI_ACTION.BEGIN, 'image/png')
            self.instance.writeImage(AVI_ACTION.WRITE, 'image/png', image_bytes)
            self.instance.writeImage(AVI_ACTION.END, 'image/png')

    # -------------------------------------------------------------------------
    # image lane: AVI stream
    # -------------------------------------------------------------------------

    def writeImage(self, action: int, mimeType: str, buffer: bytes):
        if action == AVI_ACTION.BEGIN:
            self._image_data = bytearray()

        elif action == AVI_ACTION.WRITE:
            self._image_data += buffer

        elif action == AVI_ACTION.END:
            image = ImageProcessor.load_image_from_bytes(self._image_data)

            with self.IGlobal.device_lock:
                result = self.IGlobal.segmenter.segment(image)

            self._emit(image, result, self._chunk_id)

            self._image_data = None
            self._chunk_id += 1
            return self.preventDefault()
