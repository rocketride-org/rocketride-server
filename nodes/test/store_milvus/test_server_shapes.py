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

import pytest
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
    """Meta is plain JSON without None: pymilvus 3 encodes it itself, and Doc rejects a None it reads back (#3014).

    A chunk without isDeleted is stored as live, so default reads find it.
    """
    store = _store(monkeypatch)
    control = DocMetadata(objectId='schema', chunkId=0, vectorSize=3, modelName='m', isDeleted=True)
    chunk = DocMetadata(objectId='a', chunkId=0, parent='/a', isDeleted=False, extraField='kept')
    unmarked = DocMetadata(objectId='b', chunkId=0, parent='/b')
    for metadata in (control, chunk, unmarked):
        store.addChunks([Doc(page_content='', metadata=metadata, embedding=[1.0, 0.0, 0.0])], checkCollection=False)

    metas = [row['meta'] for call in store.client.upsert.call_args_list for row in call.kwargs['data']]
    assert [json.loads(json.dumps(meta)) for meta in metas] == [
        {'objectId': 'schema', 'chunkId': 0, 'vectorSize': 3, 'modelName': 'm', 'isDeleted': True},
        {'objectId': 'a', 'chunkId': 0, 'parent': '/a', 'isDeleted': False, 'extraField': 'kept'},
        {'objectId': 'b', 'chunkId': 0, 'parent': '/b', 'isDeleted': False},
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


def test_filter_strings_escape_line_breaks(monkeypatch):
    """The filter grammar rejects a raw CR or LF inside a string literal, so they are written as escapes."""
    store = _store(monkeypatch)
    assert store._convertFilter(DocFilter(nodeId='n\r\n1', parent='/a\nb', objectIds=['x\ny'])) == [
        r"meta['nodeId'] == 'n\r\n1'",
        r"meta['parent'] == '/a\nb'",
        r"meta['objectId'] in ['x\ny']",
        "meta['isDeleted'] == False",
    ]


def test_keyword_search_looks_for_the_question_text(monkeypatch):
    """The LIKE pattern is the question's text, escaped, and the read sees this process's writes."""
    store = _store(monkeypatch)
    store.searchKeyword(QuestionText(text="it's"), DocFilter())
    kwargs = store.client.query.call_args.kwargs
    assert kwargs['filter'].endswith("content like '%it\\'s%'")
    assert kwargs['consistency_level'] == 'Session'


@pytest.mark.parametrize(
    ('text', 'condition'),
    [
        ('a_b', r"content like '%a\\_b%'"),
        ('50% up', r"content like '%50\\% up%'"),
        ('c:\\dir', r"content like '%c:\\dir%'"),
        ('50%', r"content like '%50_%'"),
        ('a_b 50%', r"content like '%a_b 50_%'"),
        ('one\ntwo', r"content like '%one\ntwo%'"),
        ('one\r\ntwo', r"content like '%one\r\ntwo%'"),
    ],
    ids=['underscore', 'percent', 'backslash', 'trailing-percent', 'trailing-percent-and-underscore', 'lf', 'crlf'],
)
def test_keyword_search_takes_wildcards_in_the_text_literally(monkeypatch, text, condition):
    """A % or _ in the question is escaped; text ending with % turns them into the wildcard _ instead.

    Milvus trims the trailing % of a pattern before it reads escapes, so an escaped % at
    the end would match nothing. A line break is written as an escape, as in every literal.
    """
    store = _store(monkeypatch)
    store.searchKeyword(QuestionText(text=text), DocFilter())
    assert store.client.query.call_args.kwargs['filter'].endswith(condition)


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


@pytest.mark.parametrize('method', ['markDeleted', 'markActive'])
def test_marks_read_the_rows_they_change_strong(monkeypatch, method):
    """The rows a mark rewrites include other processes' writes, so a mark never misses a chunk and changes nothing."""
    store = _store(monkeypatch)
    store.client.query.return_value = [{'id': 1, 'vector': [1.0, 0.0, 0.0], 'content': '', 'meta': {'objectId': 'a'}}]
    getattr(store, method)(['a'])
    assert store.client.query.call_args.kwargs['consistency_level'] == 'Strong'
    assert store.client.upsert.call_count == 1


def test_a_control_row_a_session_read_misses_is_read_again_strong(monkeypatch):
    """The control-row check (checkCollection=False) reads again with Strong before the store reports a broken collection.

    Another process may have written the row a moment ago; other reads that find nothing keep that answer.
    """
    store = _store(monkeypatch)
    control = {'id': 1, 'content': '', 'meta': {'objectId': 'schema', 'chunkId': 0, 'vectorSize': 3, 'isDeleted': True}}
    store.client.query.side_effect = [[], [control]]
    docs = store.get(DocFilter(objectIds=['schema'], isDeleted=True), checkCollection=False)
    assert [doc.metadata.vectorSize for doc in docs] == [3]
    assert [call.kwargs['consistency_level'] for call in store.client.query.call_args_list] == ['Session', 'Strong']

    store.client.query.reset_mock(side_effect=True)
    store.client.query.return_value = []
    assert store.get(DocFilter(objectIds=['a'])) == []
    assert [call.kwargs['consistency_level'] for call in store.client.query.call_args_list] == ['Session']


@pytest.mark.parametrize(('configured', 'reads'), [(0, 'Strong'), (2, 'Session')], ids=['strong', 'bounded'])
def test_a_collection_configured_as_strong_keeps_strong_reads(monkeypatch, configured, reads):
    """Plain reads use Strong when the collection is configured with it, and Session otherwise."""
    store = _store(monkeypatch)
    store.client.has_collection.return_value = True
    store.client.describe_collection.return_value = {'consistency_level': configured}
    assert store._doesCollectionExist()
    store.searchKeyword(QuestionText(text='x'), DocFilter())
    assert store.client.query.call_args.kwargs['consistency_level'] == reads
