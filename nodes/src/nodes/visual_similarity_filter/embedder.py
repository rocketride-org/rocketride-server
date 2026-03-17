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
Frame-level visual similarity matching using a CLIP-compatible embedding model.

Each incoming frame is embedded and compared (cosine similarity) against:
  - a reference image embedding (loaded from config at startup), and/or
  - a text prompt embedding (set per-request via set_text_prompt()).

When both are present the higher of the two similarities is used.
When neither is configured all frames pass through.
"""

import base64
import io
from typing import Any, Dict, Optional, Tuple


def _decode_data_url(value: str) -> bytes:
    if value.startswith('data:'):
        _, encoded = value.split(',', 1)
        return base64.b64decode(encoded)
    return base64.b64decode(value)


class FrameEmbedder:
    """
    Loads an embedding model once (CLIP or compatible) and exposes
    is_match() to test whether a frame is visually similar to the reference.
    """

    def __init__(self, config: Dict[str, Any]):
        from transformers import CLIPModel, CLIPProcessor

        model_name = config.get('embedding_model', 'openai/clip-vit-base-patch32')
        self._model: Any = CLIPModel.from_pretrained(model_name)
        self._processor: Any = CLIPProcessor.from_pretrained(model_name)
        self._model.eval()

        self._similarity_threshold: float = float(config.get('similarity_threshold', 0.25))
        self._reference_embedding: Optional[Any] = None
        self._text_embedding: Optional[Any] = None

        ref_raw: str = config.get('reference_image', '')
        if ref_raw:
            ref_bytes = _decode_data_url(ref_raw)
            self._reference_embedding = self._embed_image(ref_bytes)

        text: str = config.get('text_prompt', '')
        if text:
            self._text_embedding = self._embed_text(text)

    # ------------------------------------------------------------------
    # Per-request text prompt override
    # ------------------------------------------------------------------

    def set_text_prompt(self, text: str) -> None:
        """Update the text prompt embedding at runtime (called per-request)."""
        if not text:
            self._text_embedding = None
            return
        self._text_embedding = self._embed_text(text)

    # ------------------------------------------------------------------
    # Frame matching
    # ------------------------------------------------------------------

    def is_match(self, frame_bytes: bytes) -> Tuple[bool, float]:
        """
        Test whether a frame passes the similarity threshold.

        Returns:
            (is_match, similarity_score)
            When no reference is configured, returns (True, 1.0) so the
            node acts as a pass-through.
        """
        if self._reference_embedding is None and self._text_embedding is None:
            return True, 1.0

        import numpy as np

        frame_emb = self._embed_image(frame_bytes)

        image_sim = (
            float(np.dot(self._reference_embedding, frame_emb))
            if self._reference_embedding is not None
            else -1.0
        )
        text_sim = (
            float(np.dot(self._text_embedding, frame_emb))
            if self._text_embedding is not None
            else -1.0
        )
        similarity = max(image_sim, text_sim)
        return similarity >= self._similarity_threshold, similarity

    # ------------------------------------------------------------------
    # Embedding helpers
    # ------------------------------------------------------------------

    def _embed_image(self, image_bytes: bytes) -> Any:
        import torch
        import numpy as np
        from PIL import Image

        image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
        inputs = self._processor(images=image, return_tensors='pt')
        with torch.no_grad():
            features = self._model.get_image_features(**inputs)
        emb = features.squeeze().cpu().numpy()
        norm = np.linalg.norm(emb)
        return emb / norm if norm > 0 else emb

    def _embed_text(self, text: str) -> Any:
        import torch
        import numpy as np

        inputs = self._processor(text=[text], return_tensors='pt', padding=True)
        with torch.no_grad():
            features = self._model.get_text_features(**inputs)
        emb = features.squeeze().cpu().numpy()
        norm = np.linalg.norm(emb)
        return emb / norm if norm > 0 else emb
