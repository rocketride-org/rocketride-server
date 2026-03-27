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


class FrameEmbedder:
    """Wraps a CLIP model to produce unit-normalised image embeddings."""

    def __init__(self, config: Dict[str, Any]):
        from transformers import CLIPModel, CLIPProcessor

        model_name = config.get('embedding_model', 'openai/clip-vit-base-patch32')
        self._model = CLIPModel.from_pretrained(model_name)
        self._processor = CLIPProcessor.from_pretrained(model_name)
        self._model.eval()

        self.similarity_threshold: float = float(config.get('similarity_threshold', 0.25))

    def embed(self, image_bytes: bytes):
        """Return a unit-normalised CLIP embedding for the given image bytes."""
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
