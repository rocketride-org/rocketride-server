# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The agent tools on the LanceDB node, run against a real table.

The tools come from VectorStoreToolMixin through the node's IInstance. These
tests drive them end to end and check that expose_tools and allow_write gate
them, which is all the node owner controls.
"""

import hashlib
import types

import pytest

from nodes.store_lancedb.IInstance import IInstance

from ._helpers import DIM, MODEL, unit


def _embed(text: str):
    """A small deterministic embedder: hashed bag of words."""
    vector = [0.0] * DIM
    for word in text.lower().split():
        digest = hashlib.sha256(word.encode()).digest()
        vector[digest[0] % DIM] += 1.0
    return unit(vector) if any(vector) else [1.0] + [0.0] * (DIM - 1)


@pytest.fixture
def tools(make_store):
    def factory(expose_tools=True, allow_write=True):
        instance = object.__new__(IInstance)
        instance.IGlobal = types.SimpleNamespace(
            store=make_store(),
            serverName='lancedb',
            expose_tools=expose_tools,
            allow_write=allow_write,
            embed_query=_embed,
            embed_model_name=MODEL,
        )
        return instance

    return factory


def _documents():
    return [
        {
            'object_id': 'doc-paris',
            'content': 'paris is the capital of france',
            'metadata': {'parent': '/geo/paris.txt'},
        },
        {'object_id': 'doc-soup', 'content': 'tomato soup needs basil', 'metadata': {'parent': '/food/soup.txt'}},
    ]


def test_upsert_search_get_and_delete(tools):
    node = tools()

    result = node.upsert({'documents': _documents()})
    assert result['success'] is True
    assert result['count'] == 2

    found = node.search({'query': 'capital of france', 'top_k': 1})
    assert found['results'][0]['metadata']['objectId'] == 'doc-paris'

    listing = node.objdir({})
    assert listing['paths'] == {'/geo/paris.txt': 'doc-paris', '/food/soup.txt': 'doc-soup'}

    fetched = node.get({'object_id': 'doc-soup'})
    assert fetched['success'] is True
    assert 'tomato soup' in str(fetched)

    assert node.stats({})['count'] == 2

    deleted = node.delete({'object_ids': ['doc-paris']})
    assert deleted['success'] is True
    assert node.stats({})['count'] == 1
    assert node.objdir({})['paths'] == {'/food/soup.txt': 'doc-soup'}
    after = node.search({'query': 'paris is the capital of france', 'top_k': 5})
    assert all(hit['metadata']['objectId'] != 'doc-paris' for hit in after['results'])


def test_writes_refused_when_not_allowed(tools):
    writer = tools()
    writer.upsert({'documents': _documents()})

    reader = tools(allow_write=False)
    reader.IGlobal.store = writer.IGlobal.store

    new_doc = {'object_id': 'doc-rome', 'content': 'rome is the capital of italy'}
    assert reader.upsert({'documents': [new_doc]})['success'] is False
    assert reader.delete({'object_ids': ['doc-paris']})['success'] is False
    assert reader.search({'query': 'capital of france'})['results']
    assert set(reader._collect_tool_methods()) >= {'search', 'objdir', 'get', 'stats'}
    assert not {'upsert', 'delete'} & set(reader._collect_tool_methods())
    assert writer.IGlobal.store.count_documents() == 2
    assert 'doc-rome' not in writer.objdir({})['paths'].values()


def test_no_tools_when_not_exposed(tools):
    node = tools(expose_tools=False)
    assert node._collect_tool_methods() == {}
    assert node.search({'query': 'anything'})['success'] is False
    assert node.upsert({'documents': _documents()})['success'] is False
