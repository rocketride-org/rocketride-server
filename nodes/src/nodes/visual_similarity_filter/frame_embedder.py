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
CLIP-based frame embedder for visual similarity matching.

Used by IGlobal to embed frames and score them against a reference image.
The reference is set on the first invoke() call (the car reference photo),
and all subsequent calls compare candidate frames against it.
"""

import io
from typing import Any


class FrameEmbedder:
    """
    Wraps CLIP to embed image frames and score cosine similarity.

    Methods:
        augment_reference(frame_bytes) -> embedding  — embed + store reference
        embed_patches(frame_bytes) -> embedding      — embed a candidate frame
        score(reference, patches) -> float           — cosine similarity
        similarity_threshold                         — configurable cutoff
    """

    def __init__(self, config: dict) -> None:
        """Initialise CLIP model from config."""
        from transformers import CLIPModel, CLIPProcessor

        self.similarity_threshold: float = float(config.get('similarity_threshold', 0.25))

        clip_name = config.get('clip_model', 'openai/clip-vit-base-patch32')
        self._model = CLIPModel.from_pretrained(clip_name)
        self._processor = CLIPProcessor.from_pretrained(clip_name)
        self._model.eval()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def augment_reference(self, frame_bytes: bytes) -> Any:
        """Embed a reference image (the car photo). Returns normalised embedding."""
        return self._embed(frame_bytes)

    def embed_patches(self, frame_bytes: bytes) -> Any:
        """Embed a candidate frame. Returns normalised embedding."""
        return self._embed(frame_bytes)

    def score(self, reference: Any, patches: Any) -> float:
        """Cosine similarity between two unit-normalised embeddings."""
        import numpy as np

        return float(np.dot(reference, patches))

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _embed(self, image_bytes: bytes) -> Any:
        """Compute a unit-normalised CLIP image embedding."""
        import torch
        from PIL import Image

        image = Image.open(io.BytesIO(image_bytes)).convert('RGB')
        inputs = self._processor(images=image, return_tensors='pt')
        with torch.no_grad():
            features = self._model.get_image_features(**inputs)
        emb = features.squeeze().cpu().numpy()
        norm = float(numpy_norm(emb))
        return emb / norm if norm > 0 else emb


def numpy_norm(arr) -> float:
    import numpy as np

    return np.linalg.norm(arr)
