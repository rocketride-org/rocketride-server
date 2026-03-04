# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

from unittest.mock import Mock, call
from nodes.milvus.store.milvus import Store
from haystack import Document
import numpy as np


def test_collect_parent_ids():
    """Test collecting unique parent IDs from chunks."""
    # Mock the Store instance
    store = Store(host='localhost', port=19530, collection='test_collection')

    # Sample chunks
    chunks = [
        Document(content='Test content 1', embedding=np.array([0.1]), meta={'parent': 'parent_1'}),
        Document(content='Test content 2', embedding=np.array([0.2]), meta={'parent': 'parent_2'}),
    ]

    # Call the method
    parents = store._collect_parent_ids(chunks)

    # Verify the output
    assert parents == {'parent_1': True, 'parent_2': True}


def test_delete_by_parents():
    """Test deleting by a set of parent IDs."""
    # Mock the Store instance
    store = Store(host='localhost', port=19530, collection='test_collection')
    store.client = Mock()

    # Parent IDs to delete
    parents = {'parent_1': True, 'parent_2': True}

    # Call the method
    store._delete_by_parents(parents)

    # Verify that delete was called for each parent
    expected_calls = [
        call(collection_name='test_collection', filter="parent in ['parent_1']"),
        call(collection_name='test_collection', filter="parent in ['parent_2']"),
    ]
    store.client.delete.assert_has_calls(expected_calls, any_order=True)


def test_split_content():
    """Test splitting content into database-safe chunks."""
    # Mock the Store instance
    store = Store(host='localhost', port=19530, collection='test_collection')

    # Test input
    content = 'a' * 70000  # Longer than max_length
    max_length = 65535

    # Call the method
    parts = store._split_content(content, max_length)

    # Verify the split results
    assert len(parts) == 2  # Should split into 2 parts
    assert len(parts[0].encode('utf-8')) <= max_length
    assert len(parts[1].encode('utf-8')) <= max_length


def test_insert_chunk_part():
    """Test inserting a single chunk part into the store."""
    # Mock the Store instance
    store = Store(host='localhost', port=19530, collection='test_collection')
    store.client = Mock()

    # Sample input
    chunk = Document(content='Part 1', embedding=np.array([0.1]), meta={'parent': 'parent_1'})
    content_part = 'Part 1'
    part_index = 0

    # Call the method
    store._insert_chunk_part(chunk, content_part, part_index)

    # Verify that upsert was called with the correct arguments
    args, kwargs = store.client.upsert.call_args
    assert kwargs['collection_name'] == 'test_collection'
    assert 'id' in kwargs['data']
    assert kwargs['data']['content'] == 'Part 1'
    assert kwargs['data']['chunkId'] == 0
    assert kwargs['data']['vector'] is not None
    assert kwargs['data']['parent'] == 'parent_1'
