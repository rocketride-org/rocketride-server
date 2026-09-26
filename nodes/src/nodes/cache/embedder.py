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
Local sentence-embedding adapter for the ``cache`` node.

Wraps ``ai.common.models.SentenceTransformer`` (the same loader the
``embedding_transformer`` node uses) behind a tiny ``embed(text) -> list[float]``
interface. Using the shared loader means the heavyweight ML dependencies are
installed and cached by the engine exactly as they are for the embedding node —
the cache node's own ``requirements.txt`` only needs ``numpy``.
"""

from __future__ import annotations

from typing import List


class TransformerEmbedder:
    """Embed text into a vector using a local SentenceTransformer model."""

    def __init__(self, model_name: str):
        """
        Args:
            model_name: A SentenceTransformers model id or path
                (e.g. ``sentence-transformers/all-MiniLM-L6-v2``).
        """
        from ai.common.models import SentenceTransformer

        self._model = SentenceTransformer(model_name)

    def embed(self, text: str) -> List[float]:
        """
        Encode a single string into a plain list of floats.

        Args:
            text: The text to embed.

        Returns:
            The embedding vector as a list of Python floats.
        """
        vectors = self._model.encode([text], show_progress_bar=False)
        return vectors[0].tolist()
