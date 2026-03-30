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
(Pinecone, ChromaDB, or Qdrant), and creates a VectorDBDriver that
exposes search/upsert/delete tools for agent invocation.
"""

from __future__ import annotations

from ai.common.config import Config
from rocketlib import IGlobalBase, OPEN_MODE, warning

from .vectordb_driver import VectorDBDriver

# Supported backends and the store module paths they resolve to
_BACKEND_MODULES = {
    'pinecone': 'nodes.pinecone.pinecone',
    'chroma': 'nodes.chroma.chroma',
    'qdrant': 'nodes.qdrant.qdrant',
}


class IGlobal(IGlobalBase):
    """Global state for tool_vectordb."""

    driver: VectorDBDriver | None = None

    def beginGlobal(self) -> None:
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        cfg = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

        server_name = str((cfg.get('serverName') or 'vectordb')).strip()
        backend = str((cfg.get('backend') or 'pinecone')).strip().lower()
        collection_description = str((cfg.get('collection_description') or '')).strip()
        enable_search = cfg.get('enableSearch', True)
        enable_upsert = cfg.get('enableUpsert', False)
        enable_delete = cfg.get('enableDelete', False)
        default_top_k = int(cfg.get('topK', 10))
        score_threshold = float(cfg.get('scoreThreshold', 0.0))

        if backend not in _BACKEND_MODULES:
            raise ValueError(f'tool_vectordb: unsupported backend {backend!r}. Supported: {", ".join(sorted(_BACKEND_MODULES))}')

        # Resolve the store from the backend vector DB node.
        # The backend store is initialized via the same connConfig that
        # carries the vector DB connection parameters.
        bag = self.IEndpoint.endpoint.bag
        conn_config = self.glb.connConfig
        store = self._create_store(backend, conn_config, bag)

        try:
            self.driver = VectorDBDriver(
                server_name=server_name,
                backend=backend,
                store=store,
                collection_description=collection_description,
                enable_search=enable_search,
                enable_upsert=enable_upsert,
                enable_delete=enable_delete,
                default_top_k=default_top_k,
                score_threshold=score_threshold,
            )
        except Exception as e:
            warning(str(e))
            raise

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
            backend = str((cfg.get('backend') or '')).strip().lower()
            if backend not in _BACKEND_MODULES:
                warning(f'Unsupported backend {backend!r}. Supported: {", ".join(sorted(_BACKEND_MODULES))}')
            server_name = str((cfg.get('serverName') or '')).strip()
            if not server_name:
                warning('serverName is required')
        except Exception as e:
            warning(str(e))

    def endGlobal(self) -> None:
        self.driver = None
