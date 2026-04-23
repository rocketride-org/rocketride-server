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

"""
Frame-level CLIP embedding for the Visual Similarity Filter node.

Loads a CLIP model once and provides normalized image embeddings.
Reference image logic lives in IInstance, not here.
"""

import io
from typing import Any, Dict


# COCO vehicle label IDs accepted by DETR crop (car=3, motorcycle=4, bus=6, truck=8)
# F1 cars are low-slung and open-wheeled — DETR often classifies them as motorcycle.
_DETR_VEHICLE_LABELS = {3, 4, 6, 8}

# Module-level DETR cache — loaded once, reused across all calls.
_detr_processor = None
_detr_model = None

# YOLO COCO class IDs for vehicles (0-indexed): car=2, motorcycle=3, bus=5, truck=7
# F1 cars are sometimes classified as motorcycle due to open-wheel low-profile shape.
_YOLO_VEHICLE_CLASSES = {2, 3, 5, 7}

# Module-level YOLO cache — loaded once, reused across all calls.
_yolo_model = None


def _get_detr():
    global _detr_processor, _detr_model
    if _detr_model is None:
        from transformers import DetrImageProcessor, DetrForObjectDetection

        _detr_processor = DetrImageProcessor.from_pretrained('facebook/detr-resnet-50')
        _detr_model = DetrForObjectDetection.from_pretrained('facebook/detr-resnet-50')
        _detr_model.eval()
    return _detr_processor, _detr_model


def _get_yolo():
    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO

        _yolo_model = YOLO('yolo11x.pt')  # extra-large — ~109MB, highest accuracy
    return _yolo_model


def detect_car_crops(image_bytes: bytes, padding: float = 0.05) -> list:
    """Detect vehicles in a frame using YOLOv8 nano and return tight crops.

    Each detected vehicle is cropped (with padding) and returned as PNG bytes,
    sorted by confidence descending. Returns an empty list if no vehicles found.

    Args:
        image_bytes: raw image file content (any PIL-supported format).
        padding: fractional expansion around each detected bbox (0.05 = 5%).

    Returns:
        List of cropped image bytes (PNG), highest confidence first.
    """
    from PIL import Image

    image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
    W, H = image.size

    model = _get_yolo()
    results = model(image, verbose=False)[0]

    crops = []
    for box in results.boxes:
        cls = int(box.cls.item())
        if cls not in _YOLO_VEHICLE_CLASSES:
            continue
        conf = float(box.conf.item())
        x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].tolist()]

        pad_w = (x2 - x1) * padding
        pad_h = (y2 - y1) * padding
        x1 = max(0, x1 - pad_w)
        y1 = max(0, y1 - pad_h)
        x2 = min(W, x2 + pad_w)
        y2 = min(H, y2 + pad_h)

        crop = image.crop((x1, y1, x2, y2))
        buf = io.BytesIO()
        crop.save(buf, format='PNG')
        crops.append((buf.getvalue(), conf))

    crops.sort(key=lambda x: x[1], reverse=True)
    return [c[0] for c in crops]


def crop_car_bytes(image_bytes: bytes, padding: float = 0.10) -> bytes:
    """Detect the car in image_bytes with DETR and return a tight crop.

    Uses facebook/detr-resnet-50 (lazy-loaded, not part of FrameEmbedder so it
    doesn't interfere with the embedding model).  If no car is detected the
    original bytes are returned unchanged.

    Args:
        image_bytes: raw image file content (any PIL-supported format).
        padding: fractional expansion added around the detected bbox (0.10 = 10%).

    Returns:
        Cropped image bytes (PNG) centred on the highest-confidence car detection.
    """
    import torch
    from PIL import Image

    image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
    W, H = image.size

    processor, model = _get_detr()
    inputs = processor(images=image, return_tensors='pt')
    with torch.no_grad():
        outputs = model(**inputs)

    target_sizes = torch.tensor([[H, W]])
    results = processor.post_process_object_detection(outputs, threshold=0.3, target_sizes=target_sizes)[0]

    best_score = 0.0
    best_box = None
    for score, label, box in zip(results['scores'], results['labels'], results['boxes']):
        if label.item() in _DETR_VEHICLE_LABELS and float(score) > best_score:
            best_score = float(score)
            best_box = [float(v) for v in box.tolist()]

    if best_box is None:
        return image_bytes  # no car found — return original

    x1, y1, x2, y2 = best_box
    pad_w = (x2 - x1) * padding
    pad_h = (y2 - y1) * padding
    x1 = max(0, x1 - pad_w)
    y1 = max(0, y1 - pad_h)
    x2 = min(W, x2 + pad_w)
    y2 = min(H, y2 + pad_h)

    cropped = image.crop((x1, y1, x2, y2))
    buf = io.BytesIO()
    cropped.save(buf, format='PNG')
    return buf.getvalue()


class FrameEmbedder:
    """Wraps a vision model to produce unit-normalised image embeddings.

    Supports:
      - DINOv2 (facebook/dinov2-*): mean-pool over patch tokens
      - SigLIP (google/siglip-*): SiglipVisionModel + SiglipImageProcessor
        (vision-only — no SiglipTokenizer, no sentencepiece dependency)
      - CLIP-family (openai/clip-*): get_image_features
    """

    def __init__(self, config: Dict[str, Any]):  # noqa: D107
        model_name = config.get('embedding_model', 'facebook/dinov2-base')
        self._model_name = model_name
        self._is_dinov2 = 'dinov2' in model_name.lower() or 'dinov3' in model_name.lower()
        self._is_siglip = 'siglip' in model_name.lower()

        if self._is_siglip:
            # Use vision-only classes — avoids SiglipTokenizer / sentencepiece dep
            from transformers import SiglipVisionModel, SiglipImageProcessor

            self._model = SiglipVisionModel.from_pretrained(model_name)
            self._processor = SiglipImageProcessor.from_pretrained(model_name)
        else:
            from transformers import AutoProcessor, AutoModel

            self._model = AutoModel.from_pretrained(model_name)
            self._processor = AutoProcessor.from_pretrained(model_name)

        self._model.eval()
        self.similarity_threshold: float = float(config.get('similarity_threshold', 0.25))

    def embed(self, image_bytes: bytes):
        """Return a unit-normalised embedding for the given image bytes."""
        import torch
        import numpy as np
        from PIL import Image

        image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
        inputs = self._processor(images=image, return_tensors='pt')
        with torch.no_grad():
            if self._is_siglip:
                outputs = self._model(**inputs)
                # pooler_output is the attention-pooled global representation;
                # fall back to mean-pooling last_hidden_state if head is absent
                features = outputs.pooler_output if outputs.pooler_output is not None else outputs.last_hidden_state.mean(dim=1)
            elif self._is_dinov2:
                outputs = self._model(**inputs)
                # Mean-pool over patch tokens (exclude CLS token)
                features = outputs.last_hidden_state[:, 1:, :].mean(dim=1)
            elif hasattr(self._model, 'get_image_features'):
                features = self._model.get_image_features(**inputs)
                if not isinstance(features, torch.Tensor):
                    features = features.image_embeds if hasattr(features, 'image_embeds') else features.pooler_output
            else:
                outputs = self._model(**inputs)
                features = outputs.pooler_output if hasattr(outputs, 'pooler_output') else outputs.last_hidden_state[:, 0, :]
        emb = features.squeeze().cpu().numpy()
        norm = np.linalg.norm(emb)
        return emb / norm if norm > 0 else emb

    def embed_multicrop(self, image_bytes: bytes):
        """Return a list of unit-normalised embeddings for multi-crop views.

        Crops: full image, top-left, top-right, bottom-left, bottom-right, center.
        6 embeddings total.  Frame score = max cosine over all crops.
        """
        from PIL import Image

        image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
        w, hw = image.width, image.width // 2
        h, hh = image.height, image.height // 2

        crops = [
            image,  # full
            image.crop((0, 0, hw, hh)),  # top-left
            image.crop((hw, 0, w, hh)),  # top-right
            image.crop((0, hh, hw, h)),  # bottom-left
            image.crop((hw, hh, w, h)),  # bottom-right
            image.crop((w // 4, h // 4, 3 * w // 4, 3 * h // 4)),  # center
        ]

        embeddings = []
        for crop in crops:
            buf = io.BytesIO()
            crop.save(buf, format='PNG')
            embeddings.append(self.embed(buf.getvalue()))
        return embeddings

    def embed_patches(self, image_bytes: bytes):
        """Return per-patch L2-normalised embeddings. DINOv2 only.

        For a 224px input the model produces 196 patch tokens (14×14 grid).
        Shape: [N_patches, D]  e.g. [196, 768] for dinov2-base.
        """
        import torch
        import numpy as np
        from PIL import Image

        assert self._is_dinov2, 'embed_patches only supported for DINOv2 models'
        image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
        inputs = self._processor(images=image, return_tensors='pt')
        with torch.no_grad():
            outputs = self._model(**inputs)
        patches = outputs.last_hidden_state[0, 1:, :].cpu().numpy()  # [N_patches, D]
        norms = np.linalg.norm(patches, axis=1, keepdims=True)
        return patches / np.where(norms > 0, norms, 1.0)
