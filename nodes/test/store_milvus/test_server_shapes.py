# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""What store_milvus sends to Milvus has the shape a real server accepts and matches.

The driver is loaded from source with pymilvus stubbed, so these run without a server;
the round trip against a real Milvus is in ``test_store_milvus_live.py``.
"""

import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

from ai.common.schema import Doc, DocFilter, DocMetadata, QuestionText

_NODE_DIR = Path(__file__).resolve().parents[2] / 'src/nodes/store_milvus'


def _store(monkeypatch):
    """Build a Milvus Store from source whose client is a MagicMock.

    Args:
        monkeypatch: Restores ``sys.modules`` after the test.

    Returns:
        The store, with an existing collection.
    """
    for name in ('depends', 'pymilvus'):
        monkeypatch.setitem(sys.modules, name, MagicMock())
    module = None
    for name in ('mode', 'milvus'):
        spec = importlib.util.spec_from_file_location(f'nodes.store_milvus.{name}', _NODE_DIR / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, module)
        spec.loader.exec_module(module)
    store = module.Store.__new__(module.Store)
    store.collection = 'test'
    store.bulkInsertBatchSize = 50
    store.renderChunkSize = 4
    store.client = MagicMock()
    store.client.query.return_value = []
    store.doesCollectionExist = lambda *args: True
    return store


def test_rows_carry_meta_as_plain_json_without_none(monkeypatch):
    """Meta is plain JSON without None: pymilvus 3 encodes it itself, and Doc rejects a None it reads back (#3014)."""
    store = _store(monkeypatch)
    control = DocMetadata(objectId='schema', chunkId=0, vectorSize=3, modelName='m', isDeleted=True)
    chunk = DocMetadata(objectId='a', chunkId=0, parent='/a', isDeleted=False, extraField='kept')
    for metadata in (control, chunk):
        store.addChunks([Doc(page_content='', metadata=metadata, embedding=[1.0, 0.0, 0.0])], checkCollection=False)

    metas = [row['meta'] for call in store.client.upsert.call_args_list for row in call.kwargs['data']]
    assert [json.loads(json.dumps(meta)) for meta in metas] == [
        {'objectId': 'schema', 'chunkId': 0, 'vectorSize': 3, 'modelName': 'm', 'isDeleted': True},
        {'objectId': 'a', 'chunkId': 0, 'parent': '/a', 'isDeleted': False, 'extraField': 'kept'},
    ]


def test_filters_compare_bool_and_int_metadata_unquoted(monkeypatch):
    """A quoted 'True' or '5' never equals the bool or int stored in meta."""
    store = _store(monkeypatch)
    assert store._convertFilter(DocFilter(isTable=False, tableIds=[3, 4], permissions=[5])) == [
        "meta['isTable'] == False",
        "meta['tableId'] in [3, 4]",
        "meta['permissionId'] in [5]",
        "meta['isDeleted'] == False",
    ]


def test_keyword_search_looks_for_the_question_text(monkeypatch):
    """The LIKE pattern is the question's text, escaped, and the read sees this process's writes."""
    store = _store(monkeypatch)
    store.searchKeyword(QuestionText(text="it's"), DocFilter())
    kwargs = store.client.query.call_args.kwargs
    assert kwargs['filter'].endswith("content like '%it\\'s%'")
    assert kwargs['consistency_level'] == 'Session'


def test_render_orders_chunks_by_the_chunk_id_in_meta(monkeypatch):
    """A query row keeps chunkId inside meta, not at its top level."""
    store = _store(monkeypatch)
    store.client.query.return_value = [
        {'content': 'two', 'meta': {'chunkId': 1}},
        {'content': 'one ', 'meta': {'chunkId': 0}},
    ]
    rendered = []
    store.render('a', rendered.append)
    assert rendered == ['one two']
    assert store.client.query.call_args.kwargs['consistency_level'] == 'Session'
