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
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set

import numpy as np
from PIL import Image

from ai.common.models.transformers import pipeline


def _decode_data_url(value: str) -> bytes:
    """Decode a data-url string (``data:...;base64,XXXX``) or plain base64."""
    if value.startswith('data:'):
        # Strip the "data:<mime>;base64," prefix
        _, encoded = value.split(',', 1)
        return base64.b64decode(encoded)
    return base64.b64decode(value)


@dataclass
class Detection:
    """A single object detection result with optional reference similarity."""

    label: str
    score: float
    box: Dict[str, float]
    similarity: float = 0.0


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

    def __init__(self, config: Dict[str, Any]):
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

        self._min_confidence: float = config.get('min_confidence', 0.7)
        self._similarity_threshold: float = config.get('similarity_threshold', 0.75)

        self._det_pipeline = pipeline(
            task='object-detection', model=det_model
        )

        self._clip_model = None
        self._clip_processor = None
        self._reference_embedding: Optional[np.ndarray] = None

        ref_image_raw: str = config.get('reference_image', '')
        if ref_image_raw:
            self._init_clip()
            ref_bytes = _decode_data_url(ref_image_raw)
            self._reference_embedding = self._embed_image(ref_bytes)

        print(f'[ObjectDetector] Model: {det_model}')
        print(f'[ObjectDetector] Class allowlist: {self._class_allowlist or "all"}')
        print(
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
        print(f'[ObjectDetector] CLIP model loaded: {clip_name}')

    def _embed_image(self, image_bytes: bytes) -> np.ndarray:
        """Compute a unit-normalised CLIP embedding for an image."""
        import torch

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
        frame_image = Image.open(io.BytesIO(frame_bytes)).convert('RGB')

        try:
            raw_results = self._det_pipeline([frame_image])
        except Exception as e:
            print(f'[ObjectDetector] Detection error: {e}')
            return []

        detections_list = self._parse_raw_detections(raw_results)

        matched: List[Detection] = []
        for det in detections_list:
            label = det.get('label', '')
            score = float(det.get('score', 0.0))
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
        """
        if not raw:
            return []

        # HF batch output: [[{det}, …], …] — take first image result
        if isinstance(raw, list) and raw and isinstance(raw[0], list):
            return raw[0]

        # Already a flat list of dicts
        if isinstance(raw, list) and raw and isinstance(raw[0], dict):
            return raw

        return []

    @staticmethod
    def _crop_detection(
        image: Image.Image, box: Dict[str, float]
    ) -> Optional[Image.Image]:
        """Crop a bounding box from the frame, or None if too small."""
        xmin = max(0, int(box.get('xmin', 0)))
        ymin = max(0, int(box.get('ymin', 0)))
        xmax = min(image.width, int(box.get('xmax', image.width)))
        ymax = min(image.height, int(box.get('ymax', image.height)))

        min_px = 16
        if (xmax - xmin) < min_px or (ymax - ymin) < min_px:
            return None

        return image.crop((xmin, ymin, xmax, ymax))
