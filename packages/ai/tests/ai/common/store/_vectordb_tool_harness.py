"""Shared stand-ins for the VectorStoreToolMixin unit tests in this directory (#2587).

The mixin is exercised on a bare object, the way an IInstance carries it: a
MagicMock store behind a fake IGlobal, and a stand-in for the engine base whose
``_collect_tool_methods`` lists every tool the mixin defines, so the mixin's own
hiding is what the discovery tests observe.
"""

import functools
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

from ai.common.store.document_store import DocumentStoreBase, VectorStoreToolMixin
from ai.common.tool_context import ToolCallContext, tool_call

EVERY_TOOL_NAME = ('search', 'upsert', 'delete', 'soft_delete', 'restore', 'list_documents', 'objdir', 'get', 'stats')
READ_TOOLS = frozenset({'search', 'objdir', 'get', 'stats'})
WRITE_TOOLS = frozenset({'upsert', 'delete', 'soft_delete', 'restore'})

#: Keys a write answer carries beyond #2704's: the audit block, the per-id outcome and a refusal's code.
EXTRA_KEYS = frozenset({'audit', 'not_found', 'code', 'moved_chunks', 'removed_chunks', 'kept_live'})


def core(answer):
    """``answer`` without the keys of :data:`EXTRA_KEYS`, to compare with #2704's reply."""
    return {key: value for key, value in answer.items() if key not in EXTRA_KEYS}


DOC = {'content': 'hello', 'object_id': 'obj-1', 'embedding': [0.1, 0.2], 'embedding_model': 'test-model'}


class Discoverable:
    """Stand-in for the engine base whose _collect_tool_methods lists every tool."""

    def _collect_tool_methods(self):
        return {name: getattr(self, name) for name in EVERY_TOOL_NAME}


@contextmanager
def as_agent():
    """Run the body as an agent's tool call, the context the engine's agent host attaches.

    The write gate (``vx_write_gate.check_write``) fails closed without a call context, so the tools
    run as an agent's, which an ``allow_write`` node lets write.
    """
    with tool_call(ToolCallContext(origin='agent', source_type=None, targeted=True, caller={'auth': 'agent'})):
        yield


class Tools(VectorStoreToolMixin, Discoverable):
    """The mixin on a bare object, the way an IInstance carries it; each tool call runs as an agent's."""

    def __getattribute__(self, name):
        attr = super().__getattribute__(name)
        if name in EVERY_TOOL_NAME and callable(attr):

            @functools.wraps(attr)
            def call(*args, **kwargs):
                with as_agent():
                    return attr(*args, **kwargs)

            return call
        return attr

    def __init__(self, store, allow_write=None, expose_tools=None):
        glb = SimpleNamespace(serverName='rrvector', store=store, embed_query=None, embed_model_name=None)
        if allow_write is not None:
            glb.allow_write = allow_write
        if expose_tools is not None:
            glb.expose_tools = expose_tools
        self.IGlobal = glb


def make_store():
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
    # What the explorer's tool bodies read: no native counting or listing, one chunk per document, and no
    # collection name to audit.
    store.capabilities.return_value = frozenset()
    store.countChunks.return_value = 1
    del store.vxCollectionName
    return store


class FakeDriver(DocumentStoreBase):
    """The smallest real driver the abstract base accepts; reads answer empty, writes do nothing.

    The explorer's tool bodies keep state on the store, which a MagicMock cannot hold, so the tests that
    reach them (stats, the trash tools of a driver that cannot count) use this.
    """

    def __init__(self):
        super().__init__('fake', {}, {})
        # Known model and width, so stats has no control row to look up.
        self.modelName = 'test-model'
        self.vectorSize = 3
        self.marked = []

    def _doesCollectionExist(self):
        return True

    def _createCollection(self):
        return True

    def count_documents(self):
        return 0

    def searchKeyword(self, query, docFilter):
        return []

    def searchSemantic(self, query, docFilter):
        return []

    def get(self, docFilter, checkCollection=True):
        return []

    def getPaths(self, parent=None, offset=0, limit=1000):
        return {}

    def addChunks(self, chunks):
        return None

    def remove(self, objectIds):
        return None

    def markDeleted(self, objectIds):
        self.marked.append(('deleted', objectIds))

    def markActive(self, objectIds):
        self.marked.append(('active', objectIds))

    def render(self, objectId, callback):
        return None
