# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""How a DocFilter becomes a LanceDB SQL predicate.

Every value from the filter is quoted or converted to an integer, so a filter
cannot change the shape of the query, and soft-deleted rows stay out unless the
caller asks for them. The last tests run the predicates against a real table.
"""

import pytest

from ai.common.schema import DocFilter

from ._helpers import chunk, random_vector


@pytest.fixture
def store(make_store):
    return make_store()


class TestTranslation:
    def test_default_filter_only_hides_deleted(self, store):
        assert store._convertFilter(DocFilter()) == 'deleted = false'

    def test_deleted_rows_on_request(self, store):
        assert store._convertFilter(DocFilter(isDeleted=True)) == ''

    def test_every_field(self, store):
        where = store._convertFilter(
            DocFilter(
                nodeId='node-1',
                isTable=True,
                tableIds=[1, 2],
                parent='/docs/a.txt',
                permissions=[3],
                objectIds=['a', 'b'],
                chunkIds=[0, 4],
                minChunkId=1,
                maxChunkId=9,
            )
        )
        assert where == (
            "nodeId = 'node-1' AND isTable = true AND tableId IN (1, 2) AND path = '/docs/a.txt' "
            "AND permissionId IN (3) AND objectId IN ('a', 'b') AND deleted = false "
            'AND chunk IN (0, 4) AND chunk >= 1 AND chunk <= 9'
        )

    def test_quotes_are_doubled(self, store):
        where = store._convertFilter(DocFilter(objectIds=["it's"], parent="/o'brien"))
        assert "path = '/o''brien'" in where
        assert "objectId IN ('it''s')" in where

    def test_empty_list_matches_nothing(self, store):
        assert store._convertFilter(DocFilter(objectIds=[])) == 'false AND deleted = false'

    def test_non_integer_is_refused_with_field_name(self, store):
        flt = DocFilter()
        flt.permissions = ['1 OR 1=1']
        with pytest.raises(Exception, match='permissions'):
            store._convertFilter(flt)


class TestAgainstTable:
    def test_injection_attempt_matches_nothing(self, store, rng):
        store.addChunks([chunk('doc-a', 0, 'alpha', random_vector(rng))])

        hostile = DocFilter(objectIds=["doc-a') OR (1 = 1"], limit=100)
        assert store.get(hostile) == []
        assert len(store.get(DocFilter(objectIds=['doc-a']))) == 1

    def test_filters_select_the_right_rows(self, store, rng):
        store.addChunks(
            [
                chunk('doc-a', 0, 'a0', random_vector(rng), parent='/x/a.txt', nodeId='n1', permissionId=1),
                chunk('doc-a', 1, 'a1', random_vector(rng), parent='/x/a.txt', nodeId='n1', permissionId=1),
                chunk('doc-b', 0, 'b0', random_vector(rng), parent='/x/b.csv', nodeId='n2', permissionId=2),
                chunk(
                    'doc-b',
                    1,
                    'b1',
                    random_vector(rng),
                    parent='/x/b.csv',
                    nodeId='n2',
                    permissionId=2,
                    isTable=True,
                    tableId=7,
                ),
            ]
        )

        def texts(**kwargs):
            return sorted(doc.page_content for doc in store.get(DocFilter(limit=100, **kwargs)))

        assert texts(nodeId='n1') == ['a0', 'a1']
        assert texts(parent='/x/b.csv') == ['b0', 'b1']
        assert texts(permissions=[2]) == ['b0', 'b1']
        assert texts(isTable=True) == ['b1']
        assert texts(tableIds=[7]) == ['b1']
        assert texts(chunkIds=[1]) == ['a1', 'b1']
        assert texts(minChunkId=1, maxChunkId=1) == ['a1', 'b1']
        assert texts(objectIds=['doc-b'], chunkIds=[0]) == ['b0']
