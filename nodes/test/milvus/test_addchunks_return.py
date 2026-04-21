# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Regression: Milvus Store.addChunks must match DocumentStoreBase.addChunks (returns None).

When collection creation fails, other stores use a bare ``return``; Milvus returned ``{}``,
violating the annotated contract and confusing callers that treat a dict as chunk metadata.
"""

import pytest
from unittest.mock import MagicMock

from ai.common.schema import Doc, DocMetadata


@pytest.mark.skip(reason='todo: refactor this unit test')
def test_milvus_addchunks_returns_none_when_create_collection_fails():
    """``addChunks`` must return None when ``createCollection`` fails."""
    from nodes.milvus.milvus import Store

    meta = DocMetadata(objectId='o1', chunkId=0)
    doc = Doc(page_content='x', metadata=meta, embedding=[0.0], score=0.0)

    mock_self = MagicMock()
    mock_self.collection = 'c'
    mock_self.client = MagicMock()
    mock_self.createCollection = MagicMock(return_value=False)

    result = Store.addChunks(mock_self, [doc], checkCollection=True)

    assert result is None
    mock_self.createCollection.assert_called_once()
