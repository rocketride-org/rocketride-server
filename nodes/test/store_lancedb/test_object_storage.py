# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The LanceDB store on object storage, tested live only.

Set ROCKETRIDE_LANCEDB_TEST_URI to a bucket uri such as s3://bucket/prefix and,
when the cloud's environment variables are not enough,
ROCKETRIDE_LANCEDB_TEST_STORAGE_OPTIONS to the storage options JSON. For an S3
compatible server such as MinIO that is for example
{"endpoint": "http://localhost:9000", "allow_http": "true", "region": "us-east-1",
"aws_access_key_id": "...", "aws_secret_access_key": "..."}.
Each run uses its own table and drops it at the end.
"""

import os
import uuid

import pytest

from ai.common.schema import DocFilter

from ._helpers import chunk, question, random_vector

URI = os.environ.get('ROCKETRIDE_LANCEDB_TEST_URI', '')
STORAGE_OPTIONS = os.environ.get('ROCKETRIDE_LANCEDB_TEST_STORAGE_OPTIONS', '')

pytestmark = pytest.mark.skipif(not URI, reason='Set ROCKETRIDE_LANCEDB_TEST_URI to run the object storage tests')


@pytest.fixture
def remote_store(make_store):
    table = f'rr_test_{uuid.uuid4().hex[:12]}'
    store = make_store(uri=URI, table=table, storageOptions=STORAGE_OPTIONS, searchMode='hybrid')
    yield store
    if store.doesCollectionExist():
        store.db.drop_table(table)


def test_ingest_search_and_reopen_on_object_storage(remote_store, make_store, rng):
    target = random_vector(rng)
    remote_store.addChunks(
        [chunk('doc-a', 0, 'lancedb on object storage', target)]
        + [chunk(f'doc-{i}', 0, f'filler text {i}', random_vector(rng)) for i in range(50)]
    )

    assert remote_store.searchSemantic(question('object storage', target), DocFilter())[0].metadata.objectId == 'doc-a'
    assert remote_store.searchKeyword(question('object storage'), DocFilter())[0].metadata.objectId == 'doc-a'

    remote_store.addChunks([chunk('doc-a', 0, 'replaced text', target)])
    remote_store.markDeleted(['doc-1'])
    assert remote_store.count_documents() == 50

    reopened = make_store(uri=URI, table=remote_store.table, storageOptions=STORAGE_OPTIONS)
    assert reopened.doesCollectionExist()
    assert [doc.page_content for doc in reopened.get(DocFilter(objectIds=['doc-a']))] == ['replaced text']
    assert reopened.get(DocFilter(objectIds=['doc-1'])) == []
    assert [doc.page_content for doc in reopened.get(DocFilter(objectIds=['doc-2']))] == ['filler text 2']
    assert reopened.count_documents() == 50
