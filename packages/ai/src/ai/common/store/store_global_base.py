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
and in how they validate a collection name, but they share a lifecycle: check
the credentials, open the store a call names and expose the agent tools. That
lifecycle lives here; the driver-specific piece lives in the hook below.

The collection, the score threshold and the other values a store reads are
parameters (plan 4.1 rule 4): one control serves calls that name different
collections. The global therefore keeps a BOUNDED keyed cache of driver stores,
keyed by the store-shaping values of the call's settings, each store opened by
the driver from those settings on the first call that names them. It is a
cache, never state (plan 4.1 rule 1): an evicted store is opened again on its
next use. The tool namespace and the two tool switches are read per call by the
tool mixin, so they are not part of the key.

A concrete node implements ``_open_store`` and inherits the rest. See
``nodes/src/nodes/store_qdrant/IGlobal.py`` for a worked example. Save-time
validation is not part of this class: the engine imports the package's
``IValidator`` alone in CONFIG mode, so a driver with a connectivity probe
ships it in ``IValidator.py``.
"""

import hashlib
import json
import threading

from abc import ABC, abstractmethod
from collections import OrderedDict
from typing import Any, Dict, List, Mapping, Optional, Tuple

from rocketlib import IGlobalBase

from ai.common.config import check_credential_resolved

from .document_store import DocumentStoreBase

# The most driver stores one control keeps open. A call names its collection
# (and its threshold and the like) as parameters; past this many distinct
# combinations the least recently used store is dropped and opened again when
# a call returns to it. A cache, never state (plan 4.1 rule 1).
STORE_CACHE_MAX = 8

# The settings the tool mixin reads per call. They shape the tool surface, not
# the store, so two calls that differ only in them share one store.
TOOL_SURFACE_KEYS = frozenset({'serverName', 'expose_tools', 'allow_write'})


class StoreGlobalBase(IGlobalBase, ABC):
    """Abstract base for the IGlobal layer of any vector store node."""

    # The driver's default namespace prefix for agent-facing tool names
    # (``<serverName>.search`` ...); a call's ``serverName`` setting overrides it.
    serverName: str = ''

    # Whether the write tools (upsert, delete, soft_delete, restore) may change
    # the store when the node declares no ``allow_write`` field (read by
    # VectorStoreToolMixin). True keeps every existing driver as it was; a
    # driver whose store is shared or managed sets the class default to False
    # and declares the field, which a call then sets.
    allow_write: bool = True

    # Whether the node offers its tool surface at all when the node declares
    # no ``expose_tools`` field (read by VectorStoreToolMixin), like
    # allow_write.
    expose_tools: bool = True

    # Driver stores by the digest of the store-shaping settings, least
    # recently used first; created in beginGlobal, bounded by STORE_CACHE_MAX.
    _stores: Optional['OrderedDict[str, DocumentStoreBase]'] = None

    # Guards the cache: one store is opened per key, even when the calls of a
    # control that name a new collection arrive together.
    _stores_lock: Optional[threading.Lock] = None

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
        """Instantiate and return the driver's ``DocumentStoreBase`` for one set of store settings.

        Called from ``store_for`` on the first call whose store-shaping
        settings no cached store matches. Must raise if the store cannot be
        constructed so the failure surfaces on that call. ``config`` is the
        CALL's settings (``IInstance.settings``): the control's config with the
        call's parameters over it, defaults applied, the active branch
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
            check_credential_resolved(self.config.node.provider, field, value)

    # ------------------------------------------------------------------
    # Lifecycle - identical across vector stores
    # ------------------------------------------------------------------

    def beginGlobal(self) -> None:
        """Check the control's credentials and start the store cache empty.

        Nothing a call decides is read here: the collection and the other
        store settings are parameters, so a store is opened by ``store_for``
        on the first call that names its settings.
        """
        self._stores_lock = threading.Lock()
        self._stores = OrderedDict()

        # A key left as an unfilled ${ROCKETRIDE_...} fails here, before the driver sends it.
        self._check_credentials(self.config)

    def store_for(self, settings: Mapping) -> DocumentStoreBase:
        """Return the driver store for this call's settings, opening it on first use.

        Two calls whose store-shaping settings are equal share one store; the
        tool-surface settings are not part of the key. The key is a digest, so
        no setting value is kept as a key.

        Args:
            settings: The calling instance's ``self.settings``.

        Returns:
            DocumentStoreBase: The store for those settings.
        """
        # Step 1: the store-shaping settings, as one digest
        shape = {key: settings[key] for key in settings if key not in TOOL_SURFACE_KEYS}
        key = hashlib.sha256(json.dumps(shape, sort_keys=True, default=str).encode('utf-8')).hexdigest()

        with self._stores_lock:
            # Step 2: a store already open for these settings is served from the cache
            store = self._stores.get(key)
            if store is not None:
                self._stores.move_to_end(key)
                return store

            # Step 3: open it from the call's settings and keep it, bounded
            store = self._open_store(self.config.node.provider, settings, self.IEndpoint.endpoint.bag)
            self._stores[key] = store
            while len(self._stores) > STORE_CACHE_MAX:
                self._stores.popitem(last=False)
            return store

    def endGlobal(self) -> None:
        """Drop every cached store."""
        self._stores = None
