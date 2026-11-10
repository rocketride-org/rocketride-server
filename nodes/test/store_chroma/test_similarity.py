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

"""The Chroma store pins its metric: new collections use the cosine space, and scores follow the space of the open collection."""

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


def _results(distances):
    """A Chroma query() result with one record per distance."""
    ids = [f'r{i}' for i in range(len(distances))]
    return {
        'ids': [ids],
        'metadatas': [[{'objectId': record, 'chunkId': 0} for record in ids]],
        'distances': [list(distances)],
        'documents': [ids],
    }


def test_scores_take_the_cosine_rescaling():
    """Chroma's cosine distance is 1 - similarity: 0 scores 1.0, 0.2 scores 0.9, and 1.8 (0.1) is dropped by the 0.20 floor."""
    store, _ = _store()

    docs = store._convertToDocs(_results([0.0, 0.2, 1.8]))

    assert [doc.page_content for doc in docs] == ['r0', 'r1']
    assert abs(docs[0].score - 1.0) < 1e-9
    assert abs(docs[1].score - 0.9) < 1e-9


def test_a_closer_match_scores_higher():
    """The score falls as the distance grows, so ranking by score ranks by closeness."""
    store, _ = _store()

    docs = store._convertToDocs(_results([0.1, 0.5, 1.0]))

    scores = [doc.score for doc in docs]
    assert scores == sorted(scores, reverse=True)


def test_a_collection_created_in_another_space_keeps_its_rescaling():
    """A collection built before the pin reports its own hnsw:space; its distances are not rescaled as cosine."""
    store, client = _store()
    store.collectionObj = client.get_collection.return_value
    store.collectionObj.metadata = {'hnsw:space': 'l2'}

    docs = store._convertToDocs(_results([0.0]))

    assert store._distanceSpace() == 'l2'
    assert abs(docs[0].score - 1.0) > 1e-9
