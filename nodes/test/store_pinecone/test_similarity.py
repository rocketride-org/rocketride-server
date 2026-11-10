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

"""The Pinecone store pins its metric: the index is created with cosine, a value Pinecone accepts."""

from unittest.mock import MagicMock, patch

import rocketlib
from rocketlib.config import resolveConfig


def _store():
    """A Store on the resolved default config with the Pinecone client stood in."""
    with patch('nodes.store_pinecone.pinecone.Pinecone') as client:
        from nodes.store_pinecone.pinecone import Store

        config = resolveConfig(rocketlib.getServiceSchema('pinecone'), {'apikey': 'k'})
        store = Store('pinecone', config, {})
    return store, client.return_value


def test_the_metric_is_cosine():
    store, _ = _store()
    assert store.similarity == 'cosine'


def test_the_index_is_created_with_the_cosine_metric():
    store, client = _store()
    store._doesCollectionExist = lambda: False
    client.list_indexes.return_value = MagicMock(names=lambda: [])

    store._createCollection(vectorSize=5)

    assert client.create_index.call_args.kwargs['metric'] == 'cosine'
    assert client.create_index.call_args.kwargs['dimension'] == 5
