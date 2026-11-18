# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Elasticsearch store: a second batch into a new index keeps the first batch.

Each batch looks up the index's control row before it writes. The client is a
stand-in that answers that lookup the way Elasticsearch does: a sorted search
has a null `_score`, and a write is searchable only after a refresh.
"""

import sys
import types
from types import SimpleNamespace

import pytest

from ai.common.config import Config
from ai.common.schema import Doc, DocMetadata

STORE_MODULE = 'nodes.store_elasticsearch.elasticsearch_store'


class FakeElasticsearch:
    """One index. The periodic refresh never runs, so only a write sent with refresh='wait_for' is searchable."""

    def __init__(self, *args: object, **kwargs: object) -> None:
        self.searchable: list[dict] = []
        self.unrefreshed: list[dict] = []
        self.deletes = 0
        self._exists = False
        self.indices = SimpleNamespace(exists=self._index_exists, create=self._create_index, delete=self._delete_index)

    def _index_exists(self, index: str) -> bool:
        return self._exists

    def _create_index(self, index: str, body: dict) -> None:
        self._exists = True

    def _delete_index(self, index: str) -> None:
        self._exists = False
        self.searchable.clear()
        self.unrefreshed.clear()
        self.deletes += 1

    def bulk(self, actions: list[dict], refresh: str | None = None) -> None:
        sources = [action['_source'] for action in actions]
        (self.searchable if refresh == 'wait_for' else self.unrefreshed).extend(sources)

    def search(self, index: str, body: dict) -> dict:
        # The only search here is the sorted control-row lookup, and a sorted search has no score.
        return {'hits': {'hits': [{'_source': source, '_score': None} for source in self.searchable]}}

    def count(self, index: str) -> dict:
        return {'count': len(self.searchable)}

    def delete_by_query(self, index: str, body: dict) -> None:
        pass


@pytest.fixture
def store_class(monkeypatch: pytest.MonkeyPatch) -> type:
    """Install the stand-in client modules and return the store class loaded against them.

    Args:
        monkeypatch (pytest.MonkeyPatch): installs the stand-ins and restores the real modules afterwards.
    """
    elasticsearch = types.ModuleType('elasticsearch')
    elasticsearch.Elasticsearch = FakeElasticsearch
    helpers = types.ModuleType('elasticsearch.helpers')
    helpers.bulk = lambda es, actions, **kwargs: es.bulk(actions, **kwargs)
    helpers.scan = None
    helpers.BulkIndexError = type('BulkIndexError', (Exception,), {})

    import nodes.store_elasticsearch as package

    # Same isolation as test_elasticsearch_credentials.py: restore the package attribute and the
    # sys.modules entries, so later tests never get the module bound to these stand-ins.
    monkeypatch.setattr(package, 'elasticsearch_store', getattr(package, 'elasticsearch_store', None), raising=False)
    monkeypatch.setitem(sys.modules, 'elasticsearch', elasticsearch)
    monkeypatch.setitem(sys.modules, 'elasticsearch.helpers', helpers)
    monkeypatch.setitem(sys.modules, STORE_MODULE, sys.modules.get(STORE_MODULE))
    del sys.modules[STORE_MODULE]
    monkeypatch.setattr(Config, 'getNodeConfig', staticmethod(lambda provider, conn_config: {'index': 'docs'}))
    from nodes.store_elasticsearch.elasticsearch_store import Store

    return Store


def _batch(objectId: str) -> list[Doc]:
    doc = Doc(page_content='text', metadata=DocMetadata(objectId=objectId, chunkId=0, isDeleted=False))
    doc.embedding = [1.0, 0.0, 0.0]
    doc.embedding_model = 'model'
    return [doc]


def test_a_second_batch_before_a_refresh_keeps_the_first_batch(store_class: type) -> None:
    """The second batch finds the control row, so the index is not recreated and nothing is lost."""
    store = store_class('elasticsearch', {}, {})
    store.addChunks(_batch('first'))
    store.addChunks(_batch('second'))

    client = store.client
    assert client.deletes == 0
    stored = client.searchable + client.unrefreshed
    assert sorted(source['meta']['objectId'] for source in stored) == ['first', 'schema', 'second']
