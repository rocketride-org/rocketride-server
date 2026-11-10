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
and in how they validate a collection name, but they share a lifecycle: read
the resolved config, resolve the tool namespace and the two tool switches,
check the credentials, open the store and expose the agent tools. That
lifecycle lives here; the driver-specific piece lives in the hook below.

A concrete node implements ``_open_store`` and inherits the rest. See
``nodes/src/nodes/store_qdrant/IGlobal.py`` for a worked example. Save-time
validation is not part of this class: the engine imports the package's
``IValidator`` alone in CONFIG mode, so a driver with a connectivity probe
ships it in ``IValidator.py``.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict, List, Mapping, Optional, Tuple

from rocketlib import IGlobalBase

from ai.common.config import check_credential_resolved

from .document_store import DocumentStoreBase


class StoreGlobalBase(IGlobalBase, ABC):
    """Abstract base for the IGlobal layer of any vector store node."""

    # Namespace prefix for agent-facing tool names (``<serverName>.search`` ...).
    # Overridden by the driver and, when present, by the resolved node config.
    serverName: str = ''

    # Whether the write tools (upsert, delete, soft_delete, restore) may change
    # the store (read by VectorStoreToolMixin). True keeps every existing driver as it was; a
    # driver whose store is shared or managed sets the class default to False
    # and lets the node owner opt in through an ``allow_write`` config field.
    # Resolved from the node config in beginGlobal, like serverName.
    allow_write: bool = True

    # Whether the node offers its tool surface at all (read by
    # VectorStoreToolMixin). True keeps every existing driver as it was; a
    # driver whose store is shared or managed sets the class default to False
    # and lets the node owner opt in through an ``expose_tools`` config field.
    # Resolved from the node config in beginGlobal, like allow_write.
    expose_tools: bool = True

    # The live store, opened in beginGlobal and read by StoreInstanceBase.
    store: Optional[DocumentStoreBase] = None

    # Embedder hook for the control-plane tool path (search/upsert). Nothing
    # binds it today: the store embeds in the data lane only, and the tool
    # path reports semantic search as unavailable. A query-embedding provider
    # on the store node is a planned addition (plan section 15, item 13).
    embed_query = None
    embed_model_name: Optional[str] = None

    # ------------------------------------------------------------------
    # Abstract interface - every store driver must implement this
    # ------------------------------------------------------------------

    @abstractmethod
    def _open_store(self, logical_type: str, config: Mapping, bag: Dict[str, Any]) -> DocumentStoreBase:
        """Instantiate and return the driver's ``DocumentStoreBase`` for this node.

        Called once per pipeline start. Must raise if the store cannot be
        constructed so the failure surfaces at pipeline start. ``config`` is
        the resolved ``ConfigView``: defaults applied, the active branch
        flattened, keys read by their short name.
        """

    # The config fields holding what the driver sends its server to sign in.
    # A driver that uses one in some modes only overrides ``_credentials``.
    credential_fields: Tuple[str, ...] = ()

    def _credentials(self, config: Mapping) -> List[Tuple[str, Any]]:
        """The credentials this config has the driver send, as ``(field, value)``."""
        return [(field, config.get(field)) for field in self.credential_fields]

    def _check_credentials(self, config: Mapping) -> None:
        """Raise when a credential is still a ${...} that no saved variable filled.

        Sent as is, the server's "unauthorized" reply would not say which variable is missing.
        """
        for field, value in self._credentials(config):
            check_credential_resolved(self.glb.logicalType, field, value)

    # ------------------------------------------------------------------
    # Lifecycle - identical across vector stores
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        """Open the store from the resolved config."""
        self.store = None
        bag = self.IEndpoint.endpoint.bag

        # The resolved config: defaults applied, the active branch flattened
        config = self.config

        # Resolve the namespace used for agent-facing tool names; the schema
        # supplies the driver's default and the user may override it.
        resolved_name = config.get('serverName')
        if isinstance(resolved_name, str) and resolved_name.strip():
            self.serverName = resolved_name.strip()

        # The two tool switches: a driver that declares them reads the
        # resolved boolean; one that does not keeps its class default.
        if 'expose_tools' in config:
            self.expose_tools = bool(config['expose_tools'])
        if 'allow_write' in config:
            self.allow_write = bool(config['allow_write'])

        # A key left as an unfilled ${ROCKETRIDE_...} fails here, before the driver sends it.
        self._check_credentials(config)

        # Open the driver's store on the resolved view
        self.store = self._open_store(self.glb.logicalType, config, bag)

    def endGlobal(self) -> None:
        """Drop the store."""
        self.store = None
