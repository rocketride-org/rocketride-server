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
Vector DB tool node - global (shared) state.

Reads the node configuration, resolves the configured vector DB backend
(Pinecone, ChromaDB, or Qdrant), and stores the backend connection and
config for IInstance tool methods.
"""

from __future__ import annotations

from ai.common.config import Config
from ai.common.store import DocumentStoreBase
from rocketlib import IGlobalBase, OPEN_MODE, warning

# Supported backends and the store module paths they resolve to
_BACKEND_MODULES = {
    'pinecone': 'nodes.pinecone.pinecone',
    'chroma': 'nodes.chroma.chroma',
    'qdrant': 'nodes.qdrant.qdrant',
}

_DEFAULT_TOP_K = 10
_MAX_TOP_K = 100


class IGlobal(IGlobalBase):
    """Global state for tool_vectordb."""

    store: DocumentStoreBase | None = None
    default_top_k: int = _DEFAULT_TOP_K
    score_threshold: float = 0.0

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        backend = str(cfg.get('backend') or 'pinecone').strip().lower()
        self.default_top_k = max(1, min(int(cfg.get('topK', _DEFAULT_TOP_K)), _MAX_TOP_K))
        self.score_threshold = max(0.0, min(float(cfg.get('scoreThreshold', 0.0)), 1.0))

        if backend not in _BACKEND_MODULES:
            raise ValueError(f'tool_vectordb: unsupported backend {backend!r}. Supported: {", ".join(sorted(_BACKEND_MODULES))}')

        # Resolve the store from the backend vector DB node.
        bag = self.IEndpoint.endpoint.bag
        conn_config = bag.get(f'{backend}_connConfig') or bag.get('vectordb_connConfig') or self.glb.connConfig
        self.store = self._create_store(backend, conn_config, bag)

    @staticmethod
    def _create_store(backend: str, conn_config: dict, bag: dict):  # noqa: ANN205
        """Dynamically import and instantiate the backend Store class."""
        import importlib

        module_path = _BACKEND_MODULES[backend]
        mod = importlib.import_module(module_path)
        store_cls = mod.Store
        return store_cls(backend, conn_config, bag)

    def validateConfig(self) -> None:
        try:
            cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            backend = str(cfg.get('backend') or '').strip().lower()
            if backend not in _BACKEND_MODULES:
                warning(f'Unsupported backend {backend!r}. Supported: {", ".join(sorted(_BACKEND_MODULES))}')
            server_name = str(cfg.get('serverName') or '').strip()
            if not server_name:
                warning('serverName is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.store = None
