# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The vector store drivers' refusals say what is wrong and what to do (#2476).

Each driver's ``Store`` is loaded from the ``nodes`` package with its vendor
client stubbed: every message checked here is raised before a client is built
or a connection is opened. ``Config.getNodeConfig`` is patched to hand the test
config straight through, so no profile merge is involved.
"""

from __future__ import annotations

import importlib
import importlib.abc
import importlib.machinery
import sys
import types
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

# The engine-side modules the drivers import, loaded for real before any stub is
# in place so none of them binds to a stub.
import ai.common.rocketride_db  # noqa: F401
import ai.common.schema  # noqa: F401
import ai.common.store  # noqa: F401
from ai.common.store.store_instance_base import NO_STORE_MESSAGE
import ai.common.transform  # noqa: F401
from ai.common.config import Config

# Every third-party module a driver imports, stubbed whether or not it is
# installed (several sibling suites leave a fake numpy behind), plus
# ``depends``, which would install the requirements on import.
_STUB_ROOTS = frozenset(
    {
        'astrapy',
        'chromadb',
        'depends',
        'elasticsearch',
        'engLib',
        'numpy',
        'pgvector',
        'pinecone',
        'psycopg2',
        'qdrant_client',
        'weaviate',
    }
)


class _StubFinder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Serve any module under ``_STUB_ROOTS`` as a package whose attributes are mocks."""

    def find_spec(self, fullname, path, target=None):
        if fullname.split('.')[0] in _STUB_ROOTS:
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec):
        module = types.ModuleType(spec.name)
        module.__path__ = []

        def __getattr__(name):
            if name.startswith('__'):
                raise AttributeError(name)
            value = MagicMock(name=f'{spec.name}.{name}')
            setattr(module, name, value)
            return value

        module.__getattr__ = __getattr__
        return module

    def exec_module(self, module):
        return None


def _is_stub(name: str) -> bool:
    return name.split('.')[0] in _STUB_ROOTS


@contextmanager
def _stubbed_vendor_clients():
    """Install the stub finder for the duration of the block.

    Afterwards the stubs and the node modules imported against them leave
    ``sys.modules`` (so no later test sees a node bound to mocks), and any real
    module under a stub root comes back. Everything else imported meanwhile
    stays: C extensions such as numpy cannot be loaded twice in one process.
    """
    before = set(sys.modules)
    saved = {name: sys.modules.pop(name) for name in list(sys.modules) if _is_stub(name)}
    finder = _StubFinder()
    sys.meta_path.insert(0, finder)
    try:
        yield
    finally:
        sys.meta_path.remove(finder)
        for name in list(sys.modules):
            if _is_stub(name) or (name not in before and (name == 'nodes' or name.startswith('nodes.'))):
                del sys.modules[name]
        sys.modules.update(saved)


def _load(module_name: str):
    """Import a node module with the vendor clients stubbed."""
    with _stubbed_vendor_clients():
        return importlib.import_module(module_name)


@pytest.fixture(autouse=True)
def _config_passthrough(monkeypatch):
    monkeypatch.setattr(Config, 'getNodeConfig', lambda provider, connConfig: dict(connConfig))


# ---------------------------------------------------------------------------
# Unsupported similarity metric
# ---------------------------------------------------------------------------

_SIMILARITY_CASES = [
    ('nodes.store_weaviate.weaviate', 'Weaviate', 'cosine, dot, l2-squared, hamming, manhattan'),
    ('nodes.store_pinecone.pinecone', 'Pinecone', 'cosine, euclidean, dotproduct'),
    ('nodes.store_postgres.postgres', 'PostgreSQL (pgvector)', 'cosine, l2, inner_product'),
    ('nodes.rocketride_vector.rocketride_vector', 'RocketRide Vector', 'cosine, l2, inner_product'),
    ('nodes.store_astra.astra_db', 'Astra DB', 'cosine, euclidean, dot_product'),
    ('nodes.store_chroma.chroma', 'Chroma', 'cosine, l2, ip'),
    ('nodes.store_qdrant.qdrant', 'Qdrant', 'Cosine, Euclid, Dot, Manhattan'),
]


@pytest.mark.parametrize(
    ('module_name', 'store_name', 'allowed'),
    _SIMILARITY_CASES,
    ids=[case[0].rsplit('.', 1)[1] for case in _SIMILARITY_CASES],
)
def test_an_unsupported_similarity_metric_names_the_value_and_the_choices(module_name, store_name, allowed):
    store_class = _load(module_name).Store
    config = {'collection': 'docs', 'host': 'localhost', 'port': 1234, 'similarity': 'no-such-metric'}

    with pytest.raises(Exception) as excinfo:
        store_class('provider', config, {})

    assert str(excinfo.value) == (
        f'{store_name}: unsupported similarity \'no-such-metric\'. Set "similarity" to: {allowed}.'
    )


# ---------------------------------------------------------------------------
# Elasticsearch: an index RocketRide did not set up, and a store that is not open
# ---------------------------------------------------------------------------


def test_an_elasticsearch_index_without_one_setup_record_says_how_to_recover():
    store_class = _load('nodes.store_elasticsearch.elasticsearch_store').Store
    store = SimpleNamespace(
        _doesCollectionExist=lambda: True,
        get=lambda docFilter, checkCollection=True: [],
        count_documents=lambda: 3,
    )

    with pytest.raises(Exception) as excinfo:
        store_class._checkCollectionExists(store)

    message = str(excinfo.value)
    assert message == 'Index setup record is missing or invalid (found 0, expected 1). Choose a new index name.'


def test_elasticsearch_render_without_an_open_store_says_what_to_check():
    module = _load('nodes.store_elasticsearch.IInstance')

    instance = SimpleNamespace(IGlobal=SimpleNamespace(backend=module.BACKEND_ELASTICSEARCH, store=None), instance=None)
    entry = SimpleNamespace(hasVectorBatchId=True, vectorBatchId='batch', objectId='obj')

    with pytest.raises(Exception) as excinfo:
        module.IInstance.renderObject(instance, entry)

    assert str(excinfo.value) == NO_STORE_MESSAGE


@pytest.mark.parametrize('lane', ['writeDocuments', 'writeQuestions'])
def test_elasticsearch_vector_lanes_without_an_open_store_say_what_to_check(lane):
    # Before, both lanes failed with an AttributeError on the missing store.
    module = _load('nodes.store_elasticsearch.IInstance')

    # Any mode other than index is the vector store path (constants.MODE_VSTORE).
    instance = SimpleNamespace(
        IGlobal=SimpleNamespace(backend=module.BACKEND_ELASTICSEARCH, mode='vstore', store=None), instance=None
    )
    payload = [] if lane == 'writeDocuments' else SimpleNamespace(questions=[])

    with pytest.raises(Exception) as excinfo:
        getattr(module.IInstance, lane)(instance, payload)

    assert str(excinfo.value) == NO_STORE_MESSAGE
