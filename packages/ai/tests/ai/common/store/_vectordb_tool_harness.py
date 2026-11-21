"""Shared stand-ins for the VectorStoreToolMixin unit tests in this directory (#2587).

The mixin is exercised on a bare object, the way an IInstance carries it: a
MagicMock store as the call's store (``_store``), the call's tool-surface
settings (``settings``), and a stand-in for the engine base whose
``_collect_tool_methods`` lists every tool the mixin defines, so the mixin's own
hiding is what the discovery tests observe.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

from ai.common.store.document_store import VectorStoreToolMixin

EVERY_TOOL_NAME = ('search', 'upsert', 'delete', 'soft_delete', 'restore', 'list_documents', 'objdir', 'get', 'stats')
READ_TOOLS = frozenset({'search', 'objdir', 'get', 'stats'})
WRITE_TOOLS = frozenset({'upsert', 'delete', 'soft_delete', 'restore'})

DOC = {'content': 'hello', 'object_id': 'obj-1', 'embedding': [0.1, 0.2], 'embedding_model': 'test-model'}


class Discoverable:
    """Stand-in for the engine base whose _collect_tool_methods lists every tool."""

    def _collect_tool_methods(self):
        return {name: getattr(self, name) for name in EVERY_TOOL_NAME}


class CallCarrier:
    """What an IInstance gives the mixin: the call's store and the call's settings.

    ``_settings`` holds the call's tool-surface settings (a key left out is a
    field the node does not declare, so the IGlobal class default applies).
    """

    def _store(self):
        """Return the call's store: the stand-in global's one store."""
        if self.IGlobal.store is None:
            raise RuntimeError('no store')
        return self.IGlobal.store

    @property
    def settings(self):
        """The call's settings, as IInstanceBase serves them."""
        return self._settings


class Tools(VectorStoreToolMixin, CallCarrier, Discoverable):
    """The mixin on a bare object, the way an IInstance carries it."""

    def __init__(self, store, allow_write=None, expose_tools=None):
        self.IGlobal = SimpleNamespace(serverName='rrvector', store=store, embed_query=None, embed_model_name=None)
        self._settings = {'serverName': 'rrvector'}
        if allow_write is not None:
            self._settings['allow_write'] = allow_write
        if expose_tools is not None:
            self._settings['expose_tools'] = expose_tools


def make_store(*, lists_documents=False):
    """A MagicMock driver with the attributes the read tools report.

    A MagicMock answers every attribute with another mock, so the listing
    capability is set explicitly: only the real ``True`` opts a driver in.
    """
    store = MagicMock()
    store.getPaths.return_value = {'/docs': 'obj-1'}
    # One chunk, so get finds the document; an empty read is a not-found failure.
    store.get.return_value = [SimpleNamespace(page_content='hello', metadata={'chunkId': 0, 'objectId': 'obj-1'})]
    store.count_documents.return_value = 3
    store.modelName = 'test-model'
    store.vectorSize = 2
    store.supports_document_listing = lists_documents
    if lists_documents:
        store.listDocuments.return_value = []
        store.countDocuments.return_value = 0
    return store
