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
Semantic cache node — global (per-pipe) state.

Builds the embedding model and the in-memory ``SemanticCache`` once per pipe and
shares them with every instance via ``self.embedder`` / ``self.cache``.
"""

from __future__ import annotations

from rocketlib import IGlobalBase, OPEN_MODE, debug
from ai.common.config import Config

# Default embedding model — matches the embedding_transformer "miniAll" profile:
# small, fast, CPU-friendly, downloaded once with no API key.
_DEFAULT_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'


def _coerce(value, default):
    """Coerce a config value to the type of ``default``, falling back on error.

    Profiles ship numeric defaults, but a user may clear or mistype a field in
    the UI (yielding ``None`` or a non-numeric string); coercion keeps the node
    from crashing at pipe open.
    """
    try:
        return type(default)(value)
    except (TypeError, ValueError):
        return default


class IGlobal(IGlobalBase):
    """Global state for the cache node — holds the embedder and the cache."""

    embedder = None
    cache = None
    config = None

    def beginGlobal(self) -> None:
        """Initialise the embedding model and the semantic cache from config."""
        # In CONFIG mode the engine only inspects the service definition; there is
        # no need to download a model or allocate the cache.
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        import os
        from depends import depends

        # Load this node's requirements before importing the model stack.
        requirements = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'requirements.txt')
        depends(requirements)

        # Resolve the node configuration (profile defaults merged with overrides).
        self.config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        from .semantic_cache import SemanticCache

        threshold = _coerce(self.config.get('threshold'), 0.92)
        max_entries = _coerce(self.config.get('max_entries'), 1000)
        ttl_seconds = _coerce(self.config.get('ttl_seconds'), 0.0)
        model_name = self.config.get('model') or _DEFAULT_MODEL

        self.cache = SemanticCache(
            threshold=threshold,
            max_entries=max_entries,
            ttl_seconds=ttl_seconds,
        )

        from .embedder import TransformerEmbedder

        self.embedder = TransformerEmbedder(model_name)

        debug(f'    Cache model       : {model_name}')
        debug(f'    Cache threshold   : {threshold}')
        debug(f'    Cache max entries : {max_entries}')
        debug(f'    Cache TTL seconds : {ttl_seconds}')

    def endGlobal(self) -> None:
        """Release the cache and embedder at pipe close."""
        self.embedder = None
        self.cache = None
        self.config = None
