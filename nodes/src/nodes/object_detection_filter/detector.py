# =============================================================================
# MIT License
# Copyright (c) 2026 RocketRide, Inc.
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
Object detection and reference image matching.

Uses a HuggingFace object-detection pipeline for per-frame detection and
CLIP for visual similarity matching against an optional reference image.
"""

import io
import base64
from typing import Any, Dict, List, Optional, Set

from .segment_tracker import Detection


def _is_columnar(d: dict) -> bool:
    """True when the dict has list-valued fields (grouped/columnar format)."""
    for v in d.values():
        if isinstance(v, list):
            return True
    return False


def _unzip_columnar(d: dict) -> list:
    """Convert {'label': ['a','b'], 'score': [0.9,0.8]} to [{label:'a',score:0.9}, ...]."""
    list_keys = [k for k, v in d.items() if isinstance(v, list)]
    if not list_keys:
        return [d]
    n = len(d[list_keys[0]])
    result = []
    for i in range(n):
        row = {}
        for k, v in d.items():
            if isinstance(v, list) and i < len(v):
                row[k] = v[i]
            else:
                row[k] = v
        result.append(row)
    return result


def _decode_data_url(value: str) -> bytes:
    """Decode a data-url string (``data:...;base64,XXXX``) or plain base64."""
    if value.startswith('data:'):
        _, encoded = value.split(',', 1)
        return base64.b64decode(encoded)
    return base64.b64decode(value)


_LOG_PATH = '/tmp/objdet_debug.log'


class ObjectDetector:
    """
    Object detection with optional CLIP-based reference image matching.

    Workflow per frame:
      1. Run HuggingFace object-detection model → raw detections
      2. Filter by confidence threshold and class allowlist
      3. (Optional) Crop each surviving detection, embed with CLIP,
         compare cosine similarity to the reference embedding
      4. Return detections that pass all filters
    """

    _frame_idx: int = 0

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

        self._min_confidence: float = config.get('min_confidence', 0.3)
        self._similarity_threshold: float = config.get('similarity_threshold', 0.82)
        self._crop_padding: float = config.get('crop_padding', 0.20)

        self._det_pipeline = pipeline(
            task='object-detection', model=det_model
        )

        self._clip_model = None
        self._clip_processor = None
        self._reference_embedding: Optional[Any] = None

        ref_image_raw: str = config.get('reference_image', '')
        if ref_image_raw:
            self._init_clip()
            ref_bytes = _decode_data_url(ref_image_raw)
            self._reference_embedding = self._embed_image(ref_bytes)

        self._frame_idx = 0

        self._log(f'[ObjectDetector] Model: {det_model}')
        self._log(f'[ObjectDetector] min_confidence={self._min_confidence}')
        self._log(f'[ObjectDetector] similarity_threshold={self._similarity_threshold}')
        self._log(f'[ObjectDetector] crop_padding={self._crop_padding}')
        self._log(f'[ObjectDetector] Class allowlist: {self._class_allowlist or "all"}')
        self._log(
            f'[ObjectDetector] Reference matching: '
            f'{"enabled" if self._reference_embedding is not None else "disabled"}'
        )

    # ------------------------------------------------------------------
    # CLIP helpers
    # ------------------------------------------------------------------

    def _init_clip(self):
        """Load CLIP model for image embedding."""
        from transformers import CLIPModel, CLIPProcessor

        clip_name = 'openai/clip-vit-base-patch32'
        self._clip_model = CLIPModel.from_pretrained(clip_name)
        self._clip_processor = CLIPProcessor.from_pretrained(clip_name)
        self._clip_model.eval()

    def _embed_image(self, image_bytes: bytes):
        """Compute a unit-normalised CLIP embedding for an image."""
        import torch
        import numpy as np
        from PIL import Image

        image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
        inputs = self._clip_processor(images=image, return_tensors='pt')
        with torch.no_grad():
            features = self._clip_model.get_image_features(**inputs)
        emb = features.squeeze().cpu().numpy()
        norm = np.linalg.norm(emb)
        return emb / norm if norm > 0 else emb

    # ------------------------------------------------------------------
    # Detection
    # ------------------------------------------------------------------

    def detect_and_match(self, frame_bytes: bytes) -> List[Detection]:
        """
        Run object detection on a single frame and optionally filter
        against the reference image.

        Args:
            frame_bytes: PNG-encoded frame image bytes.

        Returns:
            Detections that pass confidence, class, and similarity filters.
        """
        import numpy as np
        from PIL import Image

        frame_image = Image.open(io.BytesIO(frame_bytes)).convert('RGB')

        try:
            raw_results = self._det_pipeline([frame_image])
        except Exception as e:
            self._log(f'[ObjectDetector] Detection error: {e}')
            return []

        detections_list = self._parse_raw_detections(raw_results)

        self._log_raw(detections_list)

        matched: List[Detection] = []
        for det in detections_list:
            label = det.get('label', '')
            score_raw = det.get('score', 0.0)
            score = float(score_raw) if not isinstance(score_raw, (list, type(None))) else 0.0
            box = det.get('box', {})

            if score < self._min_confidence:
                continue

            if self._class_allowlist and label.lower() not in self._class_allowlist:
                continue

            similarity = 0.0
            if self._reference_embedding is not None and box:
                crop = self._crop_detection(frame_image, box)
                if crop is None:
                    continue
                buf = io.BytesIO()
                crop.save(buf, format='PNG')
                crop_emb = self._embed_image(buf.getvalue())
                similarity = float(np.dot(self._reference_embedding, crop_emb))
                self._log_sim(label, score, similarity)
                if similarity < self._similarity_threshold:
                    continue

            matched.append(
                Detection(label=label, score=score, box=box, similarity=similarity)
            )

        return matched

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_raw_detections(raw: Any) -> List[Dict[str, Any]]:
        """
        Normalise detection output from the RocketRide pipeline wrapper
        or a raw HuggingFace pipeline into a flat list of detection dicts.

        Handles three formats:
        1. HF batch: [[{det}, ...], ...]
        2. Flat list: [{det}, ...]
        3. Grouped/columnar from RocketRide wrapper:
           [{'label': ['car', 'person'], 'score': [0.9, 0.8], 'box': [{...}, {...}]}]
        """
        if not raw:
            return []

        # HF batch output: [[{det}, …], …] — take first image result
        if isinstance(raw, list) and raw and isinstance(raw[0], list):
            return raw[0]

        # Already a flat list of individual detection dicts
        if isinstance(raw, list) and raw and isinstance(raw[0], dict):
            first = raw[0]
            # Check if this is columnar (values are lists) vs per-detection dicts
            if _is_columnar(first):
                return _unzip_columnar(first)
            return raw

        return []

    def _crop_detection(self, image, box: Dict[str, float]):
        """Crop a bounding box from the frame with padding for CLIP context."""
        xmin = int(box.get('xmin', 0))
        ymin = int(box.get('ymin', 0))
        xmax = int(box.get('xmax', image.width))
        ymax = int(box.get('ymax', image.height))

        w = xmax - xmin
        h = ymax - ymin

        min_px = 16
        if w < min_px or h < min_px:
            return None

        pad = self._crop_padding
        pad_x = int(w * pad)
        pad_y = int(h * pad)

        xmin = max(0, xmin - pad_x)
        ymin = max(0, ymin - pad_y)
        xmax = min(image.width, xmax + pad_x)
        ymax = min(image.height, ymax + pad_y)

        return image.crop((xmin, ymin, xmax, ymax))

    # ------------------------------------------------------------------
    # Diagnostic logging
    # ------------------------------------------------------------------

    def _log(self, msg: str):
        with open(_LOG_PATH, 'a') as f:
            f.write(msg + '\n')

    def _log_raw(self, detections_list: List[Dict[str, Any]]):
        """Log a summary of raw DETR detections before any filtering."""
        self._frame_idx += 1
        if self._frame_idx % 10 != 1:
            return
        labels = {}
        for det in detections_list:
            lbl = det.get('label', '?')
            sc = det.get('score', 0)
            sc = float(sc) if not isinstance(sc, (list, type(None))) else 0
            labels.setdefault(lbl, []).append(round(sc, 3))
        summary = ', '.join(
            f'{lbl}({len(scores)}): {sorted(scores, reverse=True)[:5]}'
            for lbl, scores in sorted(labels.items(), key=lambda x: -len(x[1]))
        )
        self._log(f'[DETR raw] frame={self._frame_idx} total={len(detections_list)} | {summary}')

    def _log_sim(self, label: str, score: float, similarity: float):
        """Log CLIP similarity score for a candidate detection."""
        tag = 'PASS' if similarity >= self._similarity_threshold else 'REJECT'
        self._log(
            f'[CLIP] {tag} label={label} conf={score:.3f} '
            f'sim={similarity:.4f} (threshold={self._similarity_threshold})'
        )
