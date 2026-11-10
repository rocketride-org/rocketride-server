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

"""The Chroma store pins its metric: the collection uses the cosine space and the scores take the cosine rescaling."""

from unittest.mock import patch

import rocketlib
from rocketlib.config import resolveConfig


def _store():
    """A Store on the resolved local config with the Chroma client stood in."""
    with patch('chromadb.HttpClient') as client:
        from nodes.store_chroma.chroma import Store

        config = resolveConfig(rocketlib.getServiceSchema('chroma'), {})
        store = Store('chroma', config, {})
    return store, client.return_value


def test_the_metric_is_cosine():
    store, _ = _store()
    assert store.similarity == 'cosine'


def test_the_collection_is_created_in_the_cosine_space():
    store, client = _store()

    store._createCollection(vectorSize=5)

    assert client.get_or_create_collection.call_args.kwargs['metadata'] == {'hnsw:space': 'cosine'}


def test_scores_take_the_cosine_rescaling():
    """A cosine distance of 0.8 rescales to 0.9; a result below 0.20 is dropped."""
    store, _ = _store()
    results = {
        'ids': [['a', 'b']],
        'metadatas': [[{'objectId': 'a', 'chunkId': 0}, {'objectId': 'b', 'chunkId': 0}]],
        'distances': [[0.8, -0.9]],
        'documents': [['kept', 'dropped']],
    }

    docs = store._convertToDocs(results)

    assert [doc.page_content for doc in docs] == ['kept']
    assert abs(docs[0].score - 0.9) < 1e-9
