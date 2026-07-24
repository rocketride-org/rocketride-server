# =============================================================================
# RocketRide Engine
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

"""Abstract IGlobal layer shared by every vector store node.

Vector stores differ in transport (Qdrant REST/gRPC, Weaviate, Pinecone, ...)
and in how they validate a collection name, but they share a lifecycle: skip the
driver in CONFIG mode, resolve the tool namespace, open the store, wire an
optional embedder for the control-plane tool path, and register a transform key.
That lifecycle lives here; the driver-specific pieces live in the hooks below.

A concrete node implements ``_open_store``, ``_sub_key`` and ``_probe_connection``
and inherits the rest. See ``nodes/src/nodes/store_qdrant/IGlobal.py`` for a
worked example.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional

from rocketlib import OPEN_MODE, warning

from ai.common.config import Config
from ai.common.transform import IGlobalTransform

from .document_store import DocumentStoreBase


class StoreGlobalBase(IGlobalTransform, ABC):
    """Abstract base for the IGlobal layer of any vector store node."""

    # Namespace prefix for agent-facing tool names (``<serverName>.search`` ...).
    # Overridden by the driver and, when present, by the merged node config.
    serverName: str = ''

    # The live store, opened in beginGlobal and read by StoreInstanceBase.
    store: Optional[DocumentStoreBase] = None

    # Embedder wiring for the control-plane tool path (search/upsert). Bound in
    # beginGlobal only when an embedding sub-block is configured.
    embed_query = None
    embed_model_name: Optional[str] = None

    # ------------------------------------------------------------------
    # Abstract interface — every store driver must implement these
    # ------------------------------------------------------------------

    @abstractmethod
    def _open_store(self, logical_type: str, conn_config: Dict[str, Any], bag: Dict[str, Any]) -> DocumentStoreBase:
        """Instantiate and return the driver's ``DocumentStoreBase`` for this node.

        Called once per pipeline start (outside CONFIG mode). Must raise if the
        store cannot be constructed so the failure surfaces at pipeline start.
        """

    @abstractmethod
    def _sub_key(self) -> str:
        """Return the driver-specific transform sub-key (e.g. ``host/port/collection``).

        Read from ``self.store`` after it is opened. Folded into the transform
        key that tracks which objects a given store has already ingested.
        """

    @abstractmethod
    def _probe_connection(self, config: Dict[str, Any]) -> None:
        """Save-time connectivity/format probe. Report problems with ``warning()``.

        Must not raise: this runs while the user is still editing the node, so a
        bad host or collection name should produce a readable warning, not a
        stack trace.
        """

    # ------------------------------------------------------------------
    # Lifecycle — identical across vector stores
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        """Open the store and wire the tool-path embedder, unless in CONFIG mode."""
        # CONFIG mode only needs configureService; the driver is not loaded.
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.CONFIG:
            return

        self.store = None
        bag = self.IEndpoint.endpoint.bag
        connConfig = self.getConnConfig()

        # Resolve the namespace used for agent-facing tool names from the merged
        # config so it honors both profile defaults and user overrides.
        cfg = Config.getNodeConfig(self.glb.logicalType, connConfig)
        resolved_name = cfg.get('serverName') if hasattr(cfg, 'get') else None
        if isinstance(resolved_name, str) and resolved_name.strip():
            self.serverName = resolved_name.strip()

        # Open the driver's store, then wire an optional embedder for the tool path.
        # Pass the raw connConfig, not the merged cfg above: each driver's Store
        # re-resolves it via Config.getNodeConfig, so the profile merge stays in one place.
        self.store = self._open_store(self.glb.logicalType, connConfig, bag)
        self._wire_embedding(connConfig, bag)

        # Register the transform key so re-ingest can skip unchanged objects.
        super().beginGlobal(self._sub_key())

    def _wire_embedding(self, connConfig: Dict[str, Any], bag: Dict[str, Any]) -> None:
        """Bind ``embed_query``/``embed_model_name`` for the control-plane tool path.

        Tool invocations do not flow through the data-lane embedding filters, so
        the search/upsert tools need their own embedder. Only instantiate one
        when an embedding sub-block is present; otherwise leave the hooks unset
        and the tools fall back to keyword search.
        """
        self._tool_embedding = None
        self.embed_query = None
        self.embed_model_name = None

        try:
            embed_provider, embed_config = Config.getMultiProviderConfig('embedding', connConfig)
        except Exception:
            embed_provider, embed_config = None, None

        if embed_provider:
            try:
                from ai.common.embedding import getEmbedding as _getEmbedding

                self._tool_embedding = _getEmbedding(embed_provider, embed_config, bag)
            except Exception as exc:  # noqa: BLE001
                warning(f'{self.glb.logicalType}: tool path embedder unavailable: {exc}')
                self._tool_embedding = None

        if self._tool_embedding is not None:
            from ai.common.schema import Question as _Question, QuestionText as _QuestionText

            def _embed_query(text: str, _emb=self._tool_embedding) -> list:
                qt = _QuestionText(text=text)
                q = _Question()
                q.questions = [qt]
                _emb.encodeQuestion(q)
                return list(qt.embedding or [])

            self.embed_query = _embed_query
            self.embed_model_name = getattr(self._tool_embedding, '_model', None)

    def endGlobal(self) -> None:
        """Drop the store and the tool-path embedder, then clear the transform key."""
        self._tool_embedding = None
        self.embed_query = None
        self.embed_model_name = None
        self.store = None

        # Let the transform layer clear TRANFORM_KEY_TAG_NAME on teardown.
        super().endGlobal()

    def validateConfig(self) -> None:
        """Save-time validation: probe the server so the user sees errors immediately."""
        try:
            config = Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)
            self._probe_connection(config)
        except Exception as e:
            warning(str(e))
