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

"""The Milvus store pins its metric: the index uses COSINE and the scores take the cosine rescaling."""

from unittest.mock import patch

import rocketlib
from rocketlib.config import resolveConfig


def _store():
    """A Store on the resolved local config with the Milvus client stood in."""
    with patch('nodes.store_milvus.milvus.MilvusClient') as client:
        from nodes.store_milvus.milvus import Store

        config = resolveConfig(rocketlib.getServiceSchema('milvus'), {'profile': 'local'})
        store = Store('milvus', config, {})
    return store, client.return_value


def test_the_metric_is_cosine():
    store, _ = _store()
    assert store.similarity == 'COSINE'


def test_the_vector_index_is_created_with_the_cosine_metric():
    store, client = _store()
    store._doesCollectionExist = lambda: False

    store._createCollection(vectorSize=5)

    index_params = client.prepare_index_params.return_value
    vector_index = [call for call in index_params.add_index.call_args_list if call.kwargs.get('field_name') == 'vector']
    assert len(vector_index) == 1
    assert vector_index[0].kwargs['metric_type'] == 'COSINE'


def test_scores_take_the_cosine_rescaling_and_the_threshold():
    """A COSINE distance of 0.8 rescales to 0.9; 0.2 rescales to 0.6, below the 0.7 threshold."""
    store, _ = _store()
    store.threshold_search = 0.7
    points = [
        {'id': 1, 'distance': 0.8, 'entity': {'content': 'kept', 'meta': {'objectId': 'a', 'chunkId': 0}}},
        {'id': 2, 'distance': 0.2, 'entity': {'content': 'dropped', 'meta': {'objectId': 'b', 'chunkId': 0}}},
    ]

    docs = store._convertToDocs(points)

    assert [doc.page_content for doc in docs] == ['kept']
    assert abs(docs[0].score - 0.9) < 1e-9
