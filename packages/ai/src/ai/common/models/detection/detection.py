"""
Permissive-license detection and segmentation loaders.

Active loaders consumed by the detect / detect_segment nodes:
  - RFDetrLoader               (closed-set, Apache-2.0)
  - MmGDinoLoader              (open-vocab, Apache-2.0 / BSD-3)
  - Mask2FormerInstanceLoader  (MIT)
  - Mask2FormerSemanticLoader  (MIT)

Each detection loader exposes ``detect(image, prompt) -> List[dict]`` returning:
  [{label, score, box: {x1, y1, x2, y2}, centroid: {x, y}}]

Each segmentation loader exposes ``segment(image, ...) -> List[dict]`` returning
InstanceMask / SemanticMask dicts (mask encoded as COCO RLE for JSON-friendliness).
"""

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger('rocketlib.models.detection')


def _pick_device():
    """Return (device_str, torch_dtype) preferring CUDA > MPS > CPU."""
    from ai.common.torch import torch

    if torch.cuda.is_available():
        return 'cuda:0', torch.float16
    if torch.backends.mps.is_available():
        return 'mps', torch.float32
    return 'cpu', torch.float32


def _to_detection(label: str, score: float, x1: float, y1: float, x2: float, y2: float) -> Dict[str, Any]:
    """Build a single canonical detection dict."""
    x1, y1, x2, y2 = float(x1), float(y1), float(x2), float(y2)
    return {
        'label': str(label),
        'score': float(score),
        'box': {'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2},
        'centroid': {'x': (x1 + x2) / 2.0, 'y': (y1 + y2) / 2.0},
    }


class RFDetrLoader:
    """
    RF-DETR closed-set object detector (Apache-2.0).

    Prefers the official ``rfdetr`` PyPI package when available, and falls
    back to ``transformers``'s ``RTDetrForObjectDetection`` (also Apache-2.0)
    when ``rfdetr`` is not installed. Ignores ``prompt`` — emits whatever
    classes the underlying model was trained on (COCO by default).
    """

    DEFAULT_MODEL = 'PekingU/rtdetr_r50vd'

    def __init__(self, model_name: Optional[str] = None, threshold: float = 0.3):
        from ai.common.torch import torch

        self.model_name = model_name or self.DEFAULT_MODEL
        self.threshold = float(threshold)
        self.device, self.dtype = _pick_device()
        self._impl = None  # 'rfdetr' | 'rtdetr'
        self._labels: Dict[int, str] = {}

        try:
            # RF-DETR's own package — preferred when available.
            from rfdetr import RFDETRBase  # type: ignore

            self._model = RFDETRBase()
            self._impl = 'rfdetr'
        except Exception:
            # Apache-2.0 fallback: RT-DETR via transformers.
            from transformers import AutoImageProcessor, RTDetrForObjectDetection

            self._processor = AutoImageProcessor.from_pretrained(self.model_name)
            self._model = RTDetrForObjectDetection.from_pretrained(self.model_name).to(self.device).eval()
            self._labels = getattr(self._model.config, 'id2label', {}) or {}
            self._impl = 'rtdetr'
        self._torch = torch

    def detect(self, image: Any, prompt: Optional[str] = None) -> List[Dict[str, Any]]:
        """Run detection. ``prompt`` is ignored (closed-set)."""
        if image is None:
            raise ValueError('Image must not be None')

        if self._impl == 'rfdetr':
            # rfdetr returns a supervision.Detections-like object with xyxy
            # boxes, confidence and class_id arrays.
            preds = self._model.predict(image, threshold=self.threshold)
            boxes = getattr(preds, 'xyxy', None)
            scores = getattr(preds, 'confidence', None)
            class_ids = getattr(preds, 'class_id', None)
            labels = getattr(preds, 'data', {}).get('class_name') if hasattr(preds, 'data') else None

            if boxes is None or scores is None:
                return []

            out: List[Dict[str, Any]] = []
            for i in range(len(boxes)):
                x1, y1, x2, y2 = [float(v) for v in boxes[i]]
                score = float(scores[i])
                if score < self.threshold:
                    continue
                if labels is not None:
                    label = str(labels[i])
                elif class_ids is not None:
                    label = str(int(class_ids[i]))
                else:
                    label = 'object'
                out.append(_to_detection(label, score, x1, y1, x2, y2))
            return out

        # RT-DETR fallback path
        torch = self._torch
        inputs = self._processor(images=image, return_tensors='pt').to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)

        target_sizes = torch.tensor([(image.height, image.width)], device=self.device)
        results = self._processor.post_process_object_detection(
            outputs, target_sizes=target_sizes, threshold=self.threshold
        )[0]

        out = []
        for score, label_id, box in zip(results['scores'], results['labels'], results['boxes']):
            label = self._labels.get(int(label_id), str(int(label_id)))
            x1, y1, x2, y2 = box.tolist()
            out.append(_to_detection(label, float(score), x1, y1, x2, y2))
        return out


class MmGDinoLoader:
    """
    Grounding-DINO open-vocabulary detector (Apache-2.0 / BSD-3).

    Uses ``IDEA-Research/grounding-dino-tiny`` by default. Opt-in via the
    ``mmgdino`` engine. Prompts are joined with a period as required by
    Grounding-DINO.
    """

    DEFAULT_MODEL = 'IDEA-Research/grounding-dino-tiny'

    def __init__(self, model_name: Optional[str] = None, threshold: float = 0.3, text_threshold: float = 0.25):
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

        self.model_name = model_name or self.DEFAULT_MODEL
        self.threshold = float(threshold)
        self.text_threshold = float(text_threshold)
        self.device, _ = _pick_device()

        self._processor = AutoProcessor.from_pretrained(self.model_name)
        self._model = AutoModelForZeroShotObjectDetection.from_pretrained(self.model_name).to(self.device).eval()

    def detect(self, image: Any, prompt: Optional[str] = None) -> List[Dict[str, Any]]:
        from ai.common.torch import torch

        if image is None:
            raise ValueError('Image must not be None')

        classes = _parse_prompt(prompt or '')
        if not classes:
            return []

        # Grounding-DINO expects a single lowercase string of period-separated
        # classes ending in a period.
        text = '. '.join(c.lower() for c in classes) + '.'

        inputs = self._processor(images=image, text=text, return_tensors='pt').to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)

        target_sizes = torch.tensor([(image.height, image.width)], device=self.device)
        results = self._processor.post_process_grounded_object_detection(
            outputs,
            inputs.input_ids,
            box_threshold=self.threshold,
            text_threshold=self.text_threshold,
            target_sizes=target_sizes,
        )[0]

        out = []
        labels_field = results.get('labels') or results.get('text_labels') or []
        for score, label, box in zip(results['scores'], labels_field, results['boxes']):
            x1, y1, x2, y2 = box.tolist()
            out.append(_to_detection(str(label), float(score), x1, y1, x2, y2))
        return out


def _parse_prompt(prompt: str) -> List[str]:
    """Split a detection prompt on commas/periods into a clean class list."""
    if not prompt:
        return []
    return [c.strip() for c in prompt.replace('.', ',').split(',') if c.strip()]


# ---------------------------------------------------------------------------
# Segmentation loaders for the ``detect_segment`` (Segmentation) node.
# ---------------------------------------------------------------------------
#
# Modes & engines:
#   - instance:  Mask2Former instance  (MIT, facebook/mask2former-swin-tiny-coco-instance).
#   - semantic:  Mask2Former semantic  (MIT, facebook/mask2former-swin-tiny-ade-semantic).
#
# Loaders return plain ``dict`` (InstanceMask / SemanticMask shape) so they
# remain JSON-serializable. Mask encoding uses COCO RLE via
# ``pycocotools.mask``; ``counts`` is decoded to ``str`` for JSON-friendliness.


def _encode_rle(binary_mask) -> Dict[str, Any]:
    """COCO-RLE encode a HxW uint8/bool ndarray. Returns a {size, counts:str} dict."""
    import numpy as np
    from pycocotools import mask as mask_util  # type: ignore

    arr = np.asarray(binary_mask)
    if arr.dtype != np.uint8:
        arr = (arr > 0).astype(np.uint8)
    rle = mask_util.encode(np.asfortranarray(arr))
    counts = rle.get('counts')
    if isinstance(counts, bytes):
        rle['counts'] = counts.decode('utf-8')
    # pycocotools returns size as [h, w] already.
    return {'size': [int(rle['size'][0]), int(rle['size'][1])], 'counts': rle['counts']}


def _bbox_from_mask(binary_mask) -> Dict[str, float]:
    """Compute a tight axis-aligned bbox from a binary mask. Returns canonical {x1,y1,x2,y2}."""
    import numpy as np

    arr = np.asarray(binary_mask) > 0
    if not arr.any():
        return {'x1': 0.0, 'y1': 0.0, 'x2': 0.0, 'y2': 0.0}
    ys, xs = np.where(arr)
    return {
        'x1': float(xs.min()),
        'y1': float(ys.min()),
        'x2': float(xs.max() + 1),
        'y2': float(ys.max() + 1),
    }


def _pick_seg_device():
    """Device + dtype preference for segmentation: CUDA > MPS > CPU."""
    from ai.common.torch import torch

    if torch.cuda.is_available():
        return 'cuda:0', torch.float32
    if torch.backends.mps.is_available():
        return 'mps', torch.float32
    return 'cpu', torch.float32


class Mask2FormerInstanceLoader:
    """
    Mask2Former instance segmenter (MIT, ``facebook/mask2former-swin-tiny-coco-instance``).

    No prompts; emits one InstanceMask per detected COCO instance whose score
    clears ``threshold``.
    """

    DEFAULT_MODEL = 'facebook/mask2former-swin-tiny-coco-instance'

    def __init__(self, model_name: Optional[str] = None, threshold: float = 0.3, **_kwargs):
        from transformers import (
            Mask2FormerForUniversalSegmentation,
            Mask2FormerImageProcessor,
        )
        from ai.common.torch import torch

        self.model_name = model_name or self.DEFAULT_MODEL
        self.threshold = float(threshold)
        self.device, _ = _pick_seg_device()

        self._processor = Mask2FormerImageProcessor.from_pretrained(self.model_name)
        self._model = Mask2FormerForUniversalSegmentation.from_pretrained(self.model_name).to(self.device).eval()
        self._id2label = getattr(self._model.config, 'id2label', {}) or {}
        self._torch = torch

    def segment(self, image: Any, prompts: Optional[List[Dict[str, Any]]] = None) -> List[Dict[str, Any]]:
        """Run instance segmentation. ``prompts`` is ignored (closed-set)."""
        import numpy as np

        if image is None:
            raise ValueError('Image must not be None')

        torch = self._torch
        inputs = self._processor(images=image, return_tensors='pt').to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)

        target_size = (image.height, image.width)
        results = self._processor.post_process_instance_segmentation(
            outputs,
            target_sizes=[target_size],
            threshold=self.threshold,
        )[0]

        segmentation = results.get('segmentation')
        segments_info = results.get('segments_info', []) or []
        if segmentation is None:
            return []

        seg_arr = segmentation.cpu().numpy() if hasattr(segmentation, 'cpu') else np.asarray(segmentation)

        out: List[Dict[str, Any]] = []
        for seg in segments_info:
            seg_id = int(seg.get('id', -1))
            if seg_id < 0:
                continue
            score = float(seg.get('score', 0.0))
            if score < self.threshold:
                continue
            label_id = int(seg.get('label_id', -1))
            label = self._id2label.get(label_id, str(label_id))
            binary = seg_arr == seg_id
            if not binary.any():
                continue
            out.append(
                {
                    'label': label,
                    'score': score,
                    'box': _bbox_from_mask(binary),
                    'mask': _encode_rle(binary),
                }
            )
        return out


class Mask2FormerSemanticLoader:
    """
    Mask2Former semantic segmenter (MIT, ``facebook/mask2former-swin-tiny-ade-semantic``).

    Emits the canonical SemanticMask schema as a dict: ``{semantic_map: {size,
    counts}, classes: {id: name}, size: [h, w]}``. The semantic map is encoded
    as a COCO RLE over the raw per-pixel class-id array (treated as a binary
    mask by ``pycocotools`` of non-zero pixels is NOT what we want, so we
    instead encode the class id directly via ``mask_util.encode`` of a 2D
    uint8/uint16 array reinterpreted as a multi-channel binary stack? — no,
    a single COCO RLE only encodes binary masks; for a class-id raster we
    therefore RLE-encode the array reinterpreted as a single-channel uint8
    stream where each pixel is the class id. Decoders downstream are
    responsible for treating ``counts`` as a class-id raster, not a binary
    mask.).
    """

    DEFAULT_MODEL = 'facebook/mask2former-swin-tiny-ade-semantic'

    def __init__(self, model_name: Optional[str] = None, threshold: float = 0.0, **_kwargs):
        from transformers import (
            Mask2FormerForUniversalSegmentation,
            Mask2FormerImageProcessor,
        )
        from ai.common.torch import torch

        self.model_name = model_name or self.DEFAULT_MODEL
        self.threshold = float(threshold)
        self.device, _ = _pick_seg_device()

        self._processor = Mask2FormerImageProcessor.from_pretrained(self.model_name)
        self._model = Mask2FormerForUniversalSegmentation.from_pretrained(self.model_name).to(self.device).eval()
        self._id2label = getattr(self._model.config, 'id2label', {}) or {}
        self._torch = torch

    def segment(self, image: Any, prompts: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
        """Run semantic segmentation. Returns a SemanticMask-shaped dict."""
        import numpy as np
        from pycocotools import mask as mask_util  # type: ignore

        if image is None:
            raise ValueError('Image must not be None')

        torch = self._torch
        inputs = self._processor(images=image, return_tensors='pt').to(self.device)
        with torch.no_grad():
            outputs = self._model(**inputs)

        target_size = (image.height, image.width)
        seg_map = self._processor.post_process_semantic_segmentation(outputs, target_sizes=[target_size])[0]

        if hasattr(seg_map, 'cpu'):
            seg_arr = seg_map.cpu().numpy().astype(np.uint8)
        else:
            seg_arr = np.asarray(seg_map).astype(np.uint8)

        h, w = int(seg_arr.shape[0]), int(seg_arr.shape[1])

        # Reinterpret class-id raster as a binary stack: pycocotools RLE only
        # encodes binary masks, so we per-class encode each id that appears
        # and pack them into a single MaskRLE list. That would mean returning
        # multiple RLEs; per the SemanticMask schema we need ONE MaskRLE.
        # Compromise (documented for callers): we encode the non-background
        # foreground binary (any class != 0) as the schema's `semantic_map`
        # MaskRLE, and ship the full per-class id raster in an additional
        # `class_map` field as a base64-encoded zlib-compressed uint8 buffer.
        import base64
        import zlib

        foreground = (seg_arr != 0).astype(np.uint8)
        rle = mask_util.encode(np.asfortranarray(foreground))
        if isinstance(rle.get('counts'), bytes):
            rle['counts'] = rle['counts'].decode('utf-8')

        class_map_b64 = base64.b64encode(zlib.compress(seg_arr.tobytes())).decode('utf-8')

        # Reduce id2label to only the classes that appear (smaller payload).
        present_ids = sorted({int(v) for v in np.unique(seg_arr).tolist()})
        classes = {int(i): str(self._id2label.get(int(i), str(int(i)))) for i in present_ids}

        return {
            'semantic_map': {'size': [h, w], 'counts': rle['counts']},
            'classes': classes,
            'size': [h, w],
            # Extras (not in the strict SemanticMask schema but tolerated by
            # `extra='allow'` DocMetadata consumers):
            'class_map': class_map_b64,
            'class_map_encoding': 'base64+zlib+uint8',
        }
