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

import os
from typing import Any, Dict, List, Optional, Tuple, Union

from depends import depends

requirements = os.path.dirname(os.path.realpath(__file__)) + '/requirements.txt'
depends(requirements)

from rocketlib import warning

from ai.common.config import Config
from ai.common.image.dense_resize import (
    resize_for_inference,
    restore_dense_output,
    restore_rle_mask,
)


# Mode -> tuple of supported engines. First entry is the default for the mode.
MODE_ENGINES: Dict[str, Tuple[str, ...]] = {
    'instance': ('mask2former-instance',),
    'semantic': ('mask2former-semantic',),
}

ENGINE_DEFAULTS: Dict[str, Optional[str]] = {
    'mask2former-instance': 'facebook/mask2former-swin-tiny-coco-instance',
    'mask2former-semantic': 'facebook/mask2former-swin-tiny-ade-semantic',
}


class Segmenter:
    """
    Mode + engine dispatcher for the Segmentation (``detect_segment``) node.

    Modes:
      - ``instance`` (default): Mask2Former-instance (HuggingFace, MIT).
      - ``semantic``: Mask2Former-semantic — single SemanticMask output.

    Reads ``mode``, ``engine``, ``model``, ``threshold``, and ``maxEdge`` from
    node config. Applies dense-resize (long edge clamp) on the inference path,
    then upsamples masks back to the original frame size so emitted RLEs match
    the source resolution.
    """

    def __init__(self, provider: str, connConfig: Dict[str, Any], bag: Dict[str, Any]):
        config = Config.getNodeConfig(provider, connConfig)

        self.mode = str(config.get('mode', 'instance')).lower().strip()
        if self.mode not in MODE_ENGINES:
            warning(f'detect_segment: unknown mode "{self.mode}", falling back to instance.')
            self.mode = 'instance'

        engine = str(config.get('engine', '')).lower().strip()
        if not engine or engine not in MODE_ENGINES[self.mode]:
            engine = MODE_ENGINES[self.mode][0]
        self.engine = engine

        configured_model = (config.get('model') or '').strip()
        self.model_name = configured_model or ENGINE_DEFAULTS.get(self.engine) or self.engine
        self.threshold = float(config.get('threshold', 0.3))
        self.max_edge = int(config.get('maxEdge', 1024))

        self.loader = self._build_loader()
        self.device = getattr(self.loader, 'device', 'cpu')

    def _build_loader(self):
        """Construct the loader for the resolved (mode, engine) pair."""
        from ai.common.models.detection.detection import (
            Mask2FormerInstanceLoader,
            Mask2FormerSemanticLoader,
        )

        engine = self.engine

        if engine == 'mask2former-instance':
            return Mask2FormerInstanceLoader(model_name=self.model_name, threshold=self.threshold)
        if engine == 'mask2former-semantic':
            return Mask2FormerSemanticLoader(model_name=self.model_name, threshold=self.threshold)

        raise ValueError(
            f'detect_segment: unknown engine "{engine}" for mode "{self.mode}". '
            f'Expected one of {MODE_ENGINES[self.mode]}.'
        )

    # ------------------------------------------------------------------
    # Inference entrypoint
    # ------------------------------------------------------------------

    def segment(self, image: Any) -> Union[List[Dict[str, Any]], Dict[str, Any]]:
        """
        Run the configured (mode, engine) segmentation on a PIL Image.

        Returns:
            - instance mode: list of InstanceMask dicts
              ``[{label, score, box, mask: {size, counts}}]``.
            - semantic mode: a single SemanticMask dict
              ``{semantic_map, classes, size}``.
        """
        if image is None:
            raise ValueError('Image must not be None')

        resized, original_size = resize_for_inference(image, self.max_edge)
        orig_w, orig_h = original_size
        inf_w, inf_h = resized.size
        sx = orig_w / float(inf_w) if inf_w else 1.0
        sy = orig_h / float(inf_h) if inf_h else 1.0

        if self.mode == 'semantic':
            return self._segment_semantic(resized, (orig_w, orig_h), (inf_w, inf_h))

        raw = self.loader.segment(resized)
        return self._scale_instance_masks(raw, original_size=(orig_w, orig_h), sx=sx, sy=sy)

    # ------------------------------------------------------------------
    # Output scaling
    # ------------------------------------------------------------------

    def _scale_instance_masks(
        self,
        raw: List[Dict[str, Any]],
        original_size: Tuple[int, int],
        sx: float,
        sy: float,
    ) -> List[Dict[str, Any]]:
        """Upsample RLE masks and rescale boxes back to original frame size."""
        if not raw:
            return []
        out: List[Dict[str, Any]] = []
        for inst in raw:
            mask = inst.get('mask')
            if isinstance(mask, dict) and 'counts' in mask and 'size' in mask:
                try:
                    rescaled = restore_rle_mask(mask, original_size)
                except ImportError as exc:
                    warning(f'detect_segment: {exc}; emitting unscaled mask.')
                    rescaled = mask
            else:
                rescaled = mask

            box = inst.get('box') or {'x1': 0.0, 'y1': 0.0, 'x2': 0.0, 'y2': 0.0}
            scaled_box = {
                'x1': float(box['x1']) * sx,
                'y1': float(box['y1']) * sy,
                'x2': float(box['x2']) * sx,
                'y2': float(box['y2']) * sy,
            }
            out.append(
                {
                    'label': inst.get('label', 'object'),
                    'score': float(inst.get('score', 0.0)),
                    'box': scaled_box,
                    'mask': rescaled,
                }
            )
        return out

    def _segment_semantic(
        self,
        resized_image: Any,
        original_size: Tuple[int, int],
        inference_size: Tuple[int, int],
    ) -> Dict[str, Any]:
        """Run semantic mode and scale the class map back to the source resolution."""
        import base64
        import zlib
        import numpy as np
        from pycocotools import mask as mask_util  # type: ignore

        result = self.loader.segment(resized_image)
        orig_w, orig_h = original_size

        # Decode the packed class_map if present, upsample with NEAREST, repack.
        class_map_b64 = result.get('class_map')
        if class_map_b64:
            inf_w, inf_h = inference_size
            decoded = np.frombuffer(zlib.decompress(base64.b64decode(class_map_b64)), dtype=np.uint8)
            inf_arr = decoded.reshape(inf_h, inf_w)
            full_arr = restore_dense_output(inf_arr, (orig_w, orig_h), mode='nearest')

            # Re-encode the foreground RLE at the new size.
            foreground = (full_arr != 0).astype(np.uint8)
            rle = mask_util.encode(np.asfortranarray(foreground))
            if isinstance(rle.get('counts'), bytes):
                rle['counts'] = rle['counts'].decode('utf-8')

            present_ids = sorted({int(v) for v in np.unique(full_arr).tolist()})
            classes = {int(i): result.get('classes', {}).get(int(i), str(int(i))) for i in present_ids}

            class_map_repacked = base64.b64encode(zlib.compress(full_arr.tobytes())).decode('utf-8')

            return {
                'semantic_map': {'size': [int(orig_h), int(orig_w)], 'counts': rle['counts']},
                'classes': classes,
                'size': [int(orig_h), int(orig_w)],
                'class_map': class_map_repacked,
                'class_map_encoding': 'base64+zlib+uint8',
            }

        # No class_map (loader returned only the foreground RLE) — just upscale that.
        try:
            rescaled = restore_rle_mask(result['semantic_map'], (orig_w, orig_h))
        except (ImportError, KeyError, TypeError):
            rescaled = result.get('semantic_map')
        result = dict(result)
        if rescaled is not None:
            result['semantic_map'] = rescaled
        result['size'] = [int(orig_h), int(orig_w)]
        return result
