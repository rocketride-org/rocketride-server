# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Milvus must filter trash in the server query before applying its page."""

import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest


@pytest.mark.parametrize('parent', [None, '/documents', '/quoted"path'])
def test_paths_filter_trash_before_paging(parent, monkeypatch):
    path = Path(__file__).resolve().parents[2] / 'src/nodes/store_milvus/milvus.py'
    # Stub only pymilvus. Restoring all of sys.modules afterwards would unload
    # numpy if this test imported it first, and numpy cannot be loaded again
    # in the same process.
    monkeypatch.setitem(sys.modules, 'pymilvus', MagicMock())
    spec = importlib.util.spec_from_file_location('milvus_paths_under_test', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    store = module.Store.__new__(module.Store)
    store.collection = 'documents'
    store.doesCollectionExist = lambda: True
    store.client = MagicMock()
    store.client.query.return_value = [{'meta': {'parent': '/documents', 'objectId': 'doc'}}]

    assert store.getPaths(parent=parent, offset=3, limit=2) == {'/documents': 'doc'}
    expression = "meta['chunkId'] == 0 and meta['isDeleted'] == false"
    if parent is not None:
        expression += f' and meta["parent"] == {json.dumps(parent)}'
    store.client.query.assert_called_once_with(
        collection_name='documents', filter=expression, output_fields=['meta'], offset=3, limit=2
    )
