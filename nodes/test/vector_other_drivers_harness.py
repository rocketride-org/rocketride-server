# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Harness for the mocked explorer-hook suites of the experimental vector stores.

Milvus, Weaviate, Pinecone, Astra DB and MongoDB Atlas have no local server in
this repository, so their explorer hooks (``describe``, ``listDocumentPage``,
``scrollChunks``, ``getVectors``, ...) are tested against in-memory clients:

* Milvus, Weaviate, Pinecone and Astra use the client mocks under
  ``nodes/test/mocks`` (the same modules the services.json cases load through
  ``ROCKETRIDE_MOCK``), loaded here without leaking into ``sys.modules``.
* Atlas uses ``store_atlas/fake_pymongo.py`` (there is no pymongo mock).

Each driver gets an adapter that builds a fresh store, seeds a legacy collection
(rows written the way today's drivers write them: random ids, no ``size`` /
``ingestedAt`` extras, one document without chunk 0) and makes the backend
ignore paging offsets. This evidence is mocked: it never changes a driver's
``support`` level, which stays ``'experimental'``.
"""

from __future__ import annotations

import copy
import hashlib
import importlib
import importlib.util
import random
import sys
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from ai.common.schema import Doc, DocFilter, DocMetadata
from ai.common.store import DocumentStoreBase

ROOT = Path(__file__).resolve().parents[2]
MOCKS = ROOT / 'nodes' / 'test' / 'mocks'
NODES = ROOT / 'nodes' / 'src' / 'nodes'

DIM = 4
MODEL = 'test-model'


class VxFilter(DocFilter):
    """DocFilter with the explorer fields (``deleted``, ``minScore``) for these tests."""

    deleted: Optional[str] = None
    minScore: Optional[float] = None


# -----------------------------------------------------------------------------
# Loading a driver against a mock client library
# -----------------------------------------------------------------------------


def _is_lib(name: str, libs: Sequence[str]) -> bool:
    return any(name == lib or name.startswith(lib + '.') for lib in libs)


def load_driver(
    relpath: str,
    module_name: str,
    *,
    mock_libs: Sequence[str] = (),
    preload: Sequence[str] = (),
    real_libs: Sequence[str] = (),
) -> Tuple[ModuleType, Dict[str, ModuleType]]:
    """Load ``nodes/src/nodes/<relpath>`` with ``mock_libs`` resolved from ``nodes/test/mocks``.

    The real (or previously leaked) modules of those libraries are set aside while
    the driver imports and restored afterwards, so nothing leaks into the session.
    ``preload`` names extra submodules of the mocks to import (and return).
    ``real_libs`` are libraries that must be the installed packages while the driver
    imports (another test may have left a stand-in in ``sys.modules``).
    Returns the driver module and the mock modules by name.
    """
    # Real libraries are only set aside when a stand-in (a module without a file) took their
    # place; a real module stays loaded (C extensions cannot be imported twice).
    stand_ins = [
        name
        for name, module in sys.modules.items()
        if _is_lib(name, real_libs)
        and getattr(module, '__file__', None) is None
        and not getattr(module, '__path__', None)
    ]
    isolated = tuple(mock_libs)
    saved = {name: module for name, module in sys.modules.items() if _is_lib(name, isolated) or name in stand_ins}
    for name in saved:
        del sys.modules[name]
    sys.path.insert(0, str(MOCKS))
    try:
        mocks = {lib: importlib.import_module(lib) for lib in list(mock_libs) + list(preload)}
        sys.path.remove(str(MOCKS))
        for lib in real_libs:
            importlib.import_module(lib)
        spec = importlib.util.spec_from_file_location(module_name, NODES / relpath)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, mocks
    finally:
        if str(MOCKS) in sys.path:
            sys.path.remove(str(MOCKS))
        for name in [name for name in sys.modules if _is_lib(name, isolated)]:
            del sys.modules[name]
        sys.modules.update({name: module for name, module in saved.items() if name not in stand_ins})


def bare_store(store_class: type, **attrs: Any) -> Any:
    """Build a driver Store without connecting: base init plus the given attributes."""
    store = store_class.__new__(store_class)
    DocumentStoreBase.__init__(store, 'test', {}, {})
    for key, value in attrs.items():
        setattr(store, key, value)
    return store


# -----------------------------------------------------------------------------
# Documents
# -----------------------------------------------------------------------------


def vector_for(object_id: str, chunk_id: int, dim: int = DIM) -> List[float]:
    """Deterministic, non-zero vector for a chunk."""
    digest = hashlib.sha1(f'{object_id}#{chunk_id}'.encode()).digest()
    return [round(0.05 + digest[i] / 255.0, 6) for i in range(dim)]


def make_docs(
    object_id: str,
    path: str,
    chunk_ids: Sequence[int],
    *,
    extras: bool = True,
    deleted: bool = False,
    is_table: bool = False,
    dim: int = DIM,
    model: str = MODEL,
) -> List[Doc]:
    """Chunks as the embedding node hands them to a store (with the new metadata extras)."""
    docs: List[Doc] = []
    for chunk_id in chunk_ids:
        meta: Dict[str, Any] = {
            'objectId': object_id,
            'chunkId': chunk_id,
            'nodeId': 'chunk_1',
            'parent': path,
            'permissionId': 0,
            'isDeleted': deleted,
            'isTable': is_table,
            'tableId': 0,
        }
        if extras:
            meta.update({'size': 1000 + chunk_id, 'modifyTime': 1700000000, 'ingestedAt': '2026-10-08T18:20:11Z'})
        doc = Doc(page_content=f'{path} chunk {chunk_id} text', metadata=DocMetadata(**meta))
        doc.embedding = vector_for(object_id, chunk_id, dim)
        doc.embedding_model = model
        docs.append(doc)
    return docs


def legacy_meta(object_id: str, chunk_id: int, path: str, *, deleted: bool = False) -> Dict[str, Any]:
    """Metadata as today's drivers store it: declared fields only, no extras."""
    return {
        'objectId': object_id,
        'chunkId': chunk_id,
        'nodeId': 'chunk_1',
        'parent': path,
        'permissionId': 0,
        'isDeleted': deleted,
        'isTable': False,
        'tableId': 0,
    }


#: The legacy collection every adapter seeds: two whole documents and one without chunk 0.
LEGACY_DOCS: Tuple[Tuple[str, str, Tuple[int, ...]], ...] = (
    ('legacy-a', '/legacy/a.md', (0, 1, 2)),
    ('legacy-b', '/legacy/b.md', (0, 1)),
    ('legacy-orphan', '/legacy/orphan.md', (1, 2)),
)


def legacy_rows() -> List[Tuple[str, int, Dict[str, Any], str]]:
    """(objectId, chunkId, meta, content) of the legacy collection, control record first."""
    rows = [
        (
            'schema',
            0,
            {'objectId': 'schema', 'chunkId': 0, 'isDeleted': True, 'vectorSize': DIM, 'modelName': MODEL},
            '',
        )
    ]
    for object_id, path, chunk_ids in LEGACY_DOCS:
        for chunk_id in chunk_ids:
            rows.append((object_id, chunk_id, legacy_meta(object_id, chunk_id, path), f'{path} chunk {chunk_id} text'))
    return rows


def random_uuid() -> str:
    """A legacy-style random point id."""
    return str(uuid.UUID(int=random.getrandbits(128), version=4))


def keyed_uuid(object_id: str, chunk_id: int) -> str:
    """The deterministic point id of the new drivers."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'{object_id}#{chunk_id}'))


# -----------------------------------------------------------------------------
# Adapters
# -----------------------------------------------------------------------------


def client_error(module: str, message: str) -> BaseException:
    """An error of a client-library type (defined under ``module``) whose message names the server."""
    error_type = type('FakeClientError', (Exception,), {'code': 2, '__module__': f'{module}.exceptions'})
    return error_type(message)


def raising_in(module: str) -> Callable[[BaseException], None]:
    """A function that raises its argument from a frame of ``module``, as code inside a client library would."""
    namespace: Dict[str, Any] = {'__name__': f'{module}.transport'}
    exec('def throw(error):\n    raise error\n', namespace)
    return namespace['throw']


def _raise(error: BaseException) -> None:
    raise error


class FailingProxy:
    """Stands in for a client object whose server is unreachable: every call raises ``error``.

    Attribute chains (``client.collections.exists``) resolve to further proxies, so the
    failure surfaces at the first call. Names in ``allow`` are read from ``real`` instead,
    which lets an existence check succeed while every data call fails. With ``raise_from``
    the error is raised from a frame of that module (a client library raising a plain
    ``ValueError``, say), not from this harness.
    """

    def __init__(
        self, error: BaseException, real: Any = None, allow: Sequence[str] = (), raise_from: Optional[str] = None
    ) -> None:
        """Remember the error to raise, what still answers for real and where the error is raised."""
        self._error = error
        self._real = real
        self._allow = tuple(allow)
        self._raise_from = raise_from
        self._throw = raising_in(raise_from) if raise_from else _raise

    def __getattr__(self, name: str) -> Any:
        """A real attribute when allowed, else another failing proxy."""
        if name in self._allow:
            return getattr(self._real, name)
        return FailingProxy(self._error, raise_from=self._raise_from)

    def __getitem__(self, key: Any) -> Any:
        """Subscripts (``client['db']``) fail the same way."""
        return FailingProxy(self._error, raise_from=self._raise_from)

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        """Any call raises the client error."""
        self._throw(self._error)

    def __iter__(self) -> Any:
        """Iterating a cursor raises the client error."""
        self._throw(self._error)


class CountingProxy:
    """Wraps a client object and counts the calls made through it.

    Attribute chains (``collection.query.fetch_objects``) are counted too. The results of
    the calls named in ``wrap_results`` (``Index``, ``get_collection``) are wrapped as well,
    so calls on the object they return are counted.
    """

    def __init__(self, target: Any, counter: Dict[str, int], wrap_results: Sequence[str] = ()) -> None:
        """Remember the target, the shared counter and which call results to wrap."""
        self._target = target
        self._counter = counter
        self._wrap_results = tuple(wrap_results)

    def __getattr__(self, name: str) -> Any:
        """A counting wrapper for methods and sub-objects; plain values as they are."""
        value = getattr(self._target, name)
        if callable(value) and not isinstance(value, type):
            wrap = name in self._wrap_results

            def call(*args: Any, **kwargs: Any) -> Any:
                self._counter['calls'] += 1
                result = value(*args, **kwargs)
                return CountingProxy(result, self._counter, self._wrap_results) if wrap else result

            return call
        if value is None or isinstance(value, (str, bytes, int, float, bool, dict, list, tuple, set)):
            return value
        return CountingProxy(value, self._counter, self._wrap_results)


class Adapter:
    """What the shared suite needs from one driver."""

    #: provider name (the node's logical type)
    name: str = ''
    #: StoreInfo.backend
    backend: str = ''
    #: whether countChunks answers (None is allowed by the contract for some backends)
    counts: bool = True
    #: whether the listing has exact per-document chunk counts
    listing_counts: bool = True
    #: whether listDocumentPage is sorted by path natively
    listing_sorted: bool = False
    #: strategy_used for sampleChunks('random')
    random_strategy: str = 'first'
    #: whether sampleChunks('stratified') is native
    stratified_native: bool = False
    #: whether removeCounted reports rows
    remove_counts: bool = True
    #: path of the services.json whose test cases are replayed (None: no cases)
    services: Optional[str] = None
    #: whether the legacy control record kept vectorSize/modelName (Astra/Atlas wrote only declared fields)
    legacy_control_has_model: bool = True
    #: the client library the driver talks to (its errors may carry the server address)
    client_module: str = ''
    #: whether searchSemantic cuts at the node threshold when minScore is unset (develop's Milvus), else at the floor
    threshold_in_driver: bool = False

    def new_store(self) -> Any:  # pragma: no cover - interface
        raise NotImplementedError

    def seed_legacy(self, store: Any) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def ignore_offsets(self, store: Any) -> None:  # pragma: no cover - interface
        raise NotImplementedError

    def raw_rows(self, store: Any) -> List[Dict[str, Any]]:  # pragma: no cover - interface
        """Every stored row as ``{'objectId', 'chunkId', 'meta', 'id'}``."""
        raise NotImplementedError

    def set_scores(self, store: Any, scores: Sequence[float]) -> None:  # pragma: no cover - interface
        """Make the next semantic search answer one hit per score (in that order), driver scale."""
        raise NotImplementedError

    def scramble_ids(self, store: Any) -> None:
        """Give every stored row a random id, as older releases wrote them (no-op where ids are random)."""

    def server_address(self, store: Any) -> str:  # pragma: no cover - interface
        """The configured server address a client error message would name."""
        raise NotImplementedError

    def fail_backend(  # pragma: no cover - interface
        self, store: Any, error: BaseException, *, after_exists: bool, raise_from: Optional[str] = None
    ) -> None:
        """Make every client call raise ``error`` (``after_exists``: the existence check still answers).

        ``raise_from`` names the module whose frame raises it (see :class:`FailingProxy`).
        """
        raise NotImplementedError

    def duplicate_rows(self, store: Any, object_id: str) -> None:  # pragma: no cover - interface
        """Store a second copy (another id) of every row of ``object_id``, as a retried write once could."""
        raise NotImplementedError

    def count_calls(self, store: Any) -> Dict[str, int]:  # pragma: no cover - interface
        """Count every backend call the store makes from now on; returns the live counter."""
        raise NotImplementedError


def ingest(store: Any, object_id: str, path: str, chunk_ids: Sequence[int], **kwargs: Any) -> List[Doc]:
    """Write chunks through the driver's addChunks, as the data lane does."""
    docs = make_docs(object_id, path, chunk_ids, **kwargs)
    store.addChunks(docs)
    return docs


def collect_listing(
    store: Any, *, limit: int, deleted: str = 'active', max_pages: int = 50, **kwargs: Any
) -> Tuple[List[Any], List[Any]]:
    """Follow next_cursor to the end; return (rows, pages)."""
    rows: List[Any] = []
    pages: List[Any] = []
    cursor = None
    for _ in range(max_pages):
        page = store.listDocumentPage(
            cursor=cursor, limit=limit, object_ids=kwargs.get('object_ids'), deleted=deleted, sort='path'
        )
        pages.append(page)
        rows.extend(page.items)
        cursor = page.next_cursor
        if cursor is None:
            break
    return rows, pages


def collect_chunks(
    store: Any, object_id: str, *, limit: int, deleted: str = 'active', max_pages: int = 200
) -> Tuple[List[Doc], List[Any]]:
    """Follow scrollChunks to the end; return (docs, pages)."""
    docs: List[Doc] = []
    pages: List[Any] = []
    after = -1
    for _ in range(max_pages):
        page = store.scrollChunks(object_id, after_chunk=after, limit=limit, deleted=deleted)
        pages.append(page)
        docs.extend(page.docs)
        if not page.has_more:
            break
        assert page.next_after > after, 'scrollChunks must always advance'
        after = page.next_after
    return docs, pages


def find_case_expectation_failures(documents: List[Doc], expect: Dict[str, Any]) -> List[str]:
    """Check the subset of the services.json expectation grammar the store cases use."""
    failures: List[str] = []
    rows = [doc.toDict() if hasattr(doc, 'toDict') else doc.model_dump() for doc in documents]
    if expect.get('notEmpty') and not rows:
        failures.append('documents empty')
    needle = expect.get('contains')
    # As nodes/test/framework/expectations.py: content matchers read the lane's content path, [0].page_content
    if needle is not None and (not rows or needle not in (rows[0].get('page_content') or '')):
        failures.append(f'[0].page_content does not contain {needle!r}')
    props = expect.get('property') or []
    if isinstance(props, dict):
        props = [props]
    for prop in props:
        path = prop['path']
        value: Any = rows
        try:
            for part in path.replace('[', '.').replace(']', '').split('.'):
                if part == '':
                    continue
                value = value[int(part)] if part.isdigit() else value.get(part)
        except (IndexError, KeyError, AttributeError, TypeError):
            failures.append(f'{path} is missing')
            continue
        if 'greaterThan' in prop and not value > prop['greaterThan']:
            failures.append(f'{path}={value} not > {prop["greaterThan"]}')
        if 'greaterThanOrEqual' in prop and not value >= prop['greaterThanOrEqual']:
            failures.append(f'{path}={value} not >= {prop["greaterThanOrEqual"]}')
        if 'equals' in prop and value != prop['equals']:
            failures.append(f'{path}={value!r} != {prop["equals"]!r}')
    return failures


def services_cases(relpath: str) -> List[Dict[str, Any]]:
    """The ``test.cases`` of a node's services.json (JSON with comments)."""
    import json5

    data = json5.loads((NODES / relpath).read_text(encoding='utf-8'))
    return list((data.get('test') or {}).get('cases') or [])


def replace_method(obj: Any, name: str, factory: Callable[[Callable[..., Any]], Callable[..., Any]]) -> None:
    """Wrap ``obj.name`` with ``factory(original)`` on the instance."""
    original = getattr(obj, name)
    setattr(obj, name, factory(original))


def _plain(meta: Any) -> Dict[str, Any]:
    """A stored metadata value as a dict (mocks may hold pydantic objects)."""
    if hasattr(meta, 'model_dump'):
        return meta.model_dump(exclude_none=True)
    return dict(meta or {})


class MilvusAdapter(Adapter):
    """Milvus through ``nodes/test/mocks/pymilvus``."""

    name = 'milvus'
    client_module = 'pymilvus'
    backend = 'milvus'
    services = 'store_milvus/services.json'
    floor = 0.2
    threshold_in_driver = True
    offset_raises = True
    extras_stored = True

    def __init__(self) -> None:
        """Load the driver against the pymilvus mock."""
        self.module, mocks = load_driver('store_milvus/milvus.py', '_vx_milvus_driver', mock_libs=('pymilvus',))
        self.client_cls = mocks['pymilvus'].MilvusClient

    def new_store(self) -> Any:
        """A store on an empty mock server."""
        self.client_cls.reset()
        return bare_store(
            self.module.Store,
            collection='vx_test',
            host='localhost',
            port=19530,
            apikey=None,
            renderChunkSize=32 * 1024 * 1024,
            threshold_search=0.5,
            timeout=60,
            bulkInsertBatchSize=50,
            similarity='COSINE',
            client=self.client_cls(uri='http://localhost:19530'),
        )

    def records(self, store: Any) -> List[Dict[str, Any]]:
        """The raw records the mock holds for the collection."""
        return self.client_cls._data.get(store.collection, [])

    def server_address(self, store: Any) -> str:
        """host:port of the Milvus server."""
        return f'{store.host}:{store.port}'

    def fail_backend(
        self, store: Any, error: BaseException, *, after_exists: bool, raise_from: Optional[str] = None
    ) -> None:
        """Every MilvusClient call raises (has_collection still answers when ``after_exists``)."""
        store.client = FailingProxy(
            error, store.client, ('has_collection',) if after_exists else (), raise_from=raise_from
        )

    def duplicate_rows(self, store: Any, object_id: str) -> None:
        """Copies of the document's records under new random ids."""
        rows = [r for r in self.records(store) if _plain(r.get('meta')).get('objectId') == object_id]
        for row in rows:
            self.records(store).append({**copy.deepcopy(row), 'id': random.getrandbits(62)})

    def count_calls(self, store: Any) -> Dict[str, int]:
        """Count MilvusClient calls."""
        counter = {'calls': 0}
        store.client = CountingProxy(store.client, counter)
        return counter

    def seed_legacy(self, store: Any) -> None:
        """Rows as today's driver wrote them: random int64 ids, declared fields only."""
        store._createCollection(DIM)
        for object_id, chunk_id, meta, content in legacy_rows():
            vector = [0.0] * DIM if object_id == 'schema' else vector_for(object_id, chunk_id)
            self.records(store).append(
                {'id': random.getrandbits(62), 'vector': vector, 'content': content, 'meta': dict(meta)}
            )

    def ignore_offsets(self, store: Any) -> None:
        """Make every query answer from offset 0."""

        def factory(original: Callable[..., Any]) -> Callable[..., Any]:
            def query(*args: Any, **kwargs: Any) -> Any:
                kwargs['offset'] = 0
                return original(*args, **kwargs)

            return query

        replace_method(store.client, 'query', factory)

    def raw_rows(self, store: Any) -> List[Dict[str, Any]]:
        """Every stored row."""
        rows = []
        for record in self.records(store):
            meta = _plain(record['meta'])
            rows.append(
                {'objectId': meta.get('objectId'), 'chunkId': meta.get('chunkId'), 'meta': meta, 'id': record['id']}
            )
        return rows

    def set_scores(self, store: Any, scores: Sequence[float]) -> None:
        """Answer the next search with one hit per score (COSINE: distance = 2 * score - 1)."""
        records = [r for r in self.records(store) if _plain(r['meta']).get('objectId') != 'schema']

        def search(
            collection_name: str,
            data: Any,
            filter: Any = None,
            limit: int = 10,
            output_fields: Any = None,
            **kwargs: Any,
        ) -> Any:
            hits = []
            for record, score in zip(records, scores):
                entity = {'meta': _plain(record['meta']), 'content': record['content']}
                hits.append({'id': int(record['id']), 'distance': 2 * score - 1, 'entity': entity})
            return [hits]

        store.client.search = search


class WeaviateAdapter(Adapter):
    """Weaviate through ``nodes/test/mocks/weaviate``."""

    name = 'weaviate'
    client_module = 'weaviate'
    backend = 'weaviate'
    services = 'store_weaviate/services.json'
    floor = 0.2
    offset_raises = True
    extras_stored = True

    def __init__(self) -> None:
        """Load the driver against the weaviate mock."""
        self.module, mocks = load_driver('store_weaviate/weaviate.py', '_vx_weaviate_driver', mock_libs=('weaviate',))
        self.mock = mocks['weaviate']

    def new_store(self) -> Any:
        """A store on an empty mock server."""
        self.mock.MockWeaviateClient.reset()
        return bare_store(
            self.module.Store,
            collection='VxTest',
            host='localhost',
            port=8080,
            grpc_port=50051,
            apikey=None,
            renderChunkSize=32 * 1024 * 1024,
            threshold_search=0.5,
            similarity=self.module.VectorDistances.COSINE,
            client=self.mock.connect_to_local(),
            collectionObj=None,
        )

    def storage(self, store: Any) -> Dict[str, Dict[str, Any]]:
        """The mock's objects for the collection, keyed by uuid."""
        return self.mock.MockCollection._all_storage.setdefault(store.collection, {})

    def server_address(self, store: Any) -> str:
        """host:port of the Weaviate server."""
        return f'{store.host}:{store.port}'

    def fail_backend(
        self, store: Any, error: BaseException, *, after_exists: bool, raise_from: Optional[str] = None
    ) -> None:
        """Every client and collection call raises (collections.exists still answers when ``after_exists``)."""
        if after_exists:
            store._doesCollectionExist()
            store.collectionObj = FailingProxy(error, raise_from=raise_from)
            return
        # close() still reaches the mock so the store's destructor stays quiet
        store.client = FailingProxy(error, store.client, ('close',), raise_from=raise_from)
        store.collectionObj = FailingProxy(error, raise_from=raise_from)

    def duplicate_rows(self, store: Any, object_id: str) -> None:
        """Copies of the document's objects under random uuids."""
        storage = self.storage(store)
        for obj in [o for o in storage.values() if (o.get('properties') or {}).get('objectId') == object_id]:
            storage[random_uuid()] = copy.deepcopy(obj)

    def count_calls(self, store: Any) -> Dict[str, int]:
        """Count client and collection calls."""
        store._doesCollectionExist()
        counter = {'calls': 0}
        store.client = CountingProxy(store.client, counter)
        store.collectionObj = CountingProxy(store.collectionObj, counter)
        return counter

    def seed_legacy(self, store: Any) -> None:
        """Objects as today's driver wrote them: content-hash ids, declared fields only."""
        store._createCollection(DIM)
        for object_id, chunk_id, meta, content in legacy_rows():
            vector = [0.0] * DIM if object_id == 'schema' else vector_for(object_id, chunk_id)
            self.storage(store)[random_uuid()] = {'properties': {**meta, 'content': content}, 'vector': vector}

    def scramble_ids(self, store: Any) -> None:
        """Re-key every object with a random uuid."""
        storage = self.storage(store)
        items = list(storage.items())
        storage.clear()
        for _, obj in items:
            storage[random_uuid()] = obj

    def ignore_offsets(self, store: Any) -> None:
        """Make fetch_objects answer from offset 0."""
        store._doesCollectionExist()

        def factory(original: Callable[..., Any]) -> Callable[..., Any]:
            def fetch_objects(*args: Any, **kwargs: Any) -> Any:
                kwargs['offset'] = 0
                return original(*args, **kwargs)

            return fetch_objects

        replace_method(store.collectionObj.query, 'fetch_objects', factory)

    def raw_rows(self, store: Any) -> List[Dict[str, Any]]:
        """Every stored object."""
        return [
            {
                'objectId': o['properties'].get('objectId'),
                'chunkId': o['properties'].get('chunkId'),
                'meta': o['properties'],
                'id': uid,
            }
            for uid, o in self.storage(store).items()
        ]

    def set_scores(self, store: Any, scores: Sequence[float]) -> None:
        """Answer the next near_vector with one hit per score (cosine: distance = 2 - 2 * score)."""
        store._doesCollectionExist()
        objects = [(uid, o) for uid, o in self.storage(store).items() if o['properties'].get('objectId') != 'schema']
        mock = self.mock

        def near_vector(*args: Any, **kwargs: Any) -> Any:
            hits = []
            for (uid, obj), score in zip(objects, scores):
                props = {k: v for k, v in obj['properties'].items() if v is not None}
                hits.append(
                    mock.QueryObject(uuid=uid, properties=props, metadata=mock.MetadataResult(distance=2 - 2 * score))
                )
            return mock.QueryResult(objects=hits)

        store.collectionObj.query.near_vector = near_vector


class PineconeAdapter(Adapter):
    """Pinecone (serverless) through ``nodes/test/mocks/pinecone``."""

    name = 'pinecone'
    client_module = 'pinecone'
    backend = 'pinecone'
    services = 'store_pinecone/services.json'
    floor = 0.0
    offset_raises = True
    extras_stored = True
    counts = False
    listing_counts = False
    remove_counts = False

    def __init__(self) -> None:
        """Load the driver against the pinecone mock."""
        self.module, mocks = load_driver(
            'store_pinecone/pinecone.py', '_vx_pinecone_driver', mock_libs=('pinecone',), preload=('pinecone.grpc',)
        )
        self.mock = mocks['pinecone']

    def new_store(self, profile: str = 'serverless-dense') -> Any:
        """A store on an empty mock project."""
        self.mock.MockPinecone.reset()
        return bare_store(
            self.module.Store,
            collection='vx-test',
            apikey=None,
            profile=profile,
            threshold_search=0.5,
            renderChunkSize=32 * 1024 * 1024,
            similarity='cosine',
            client=self.mock.MockPinecone(api_key=None),
        )

    def storage(self, store: Any) -> Dict[str, Dict[str, Any]]:
        """The mock's vectors for the index, keyed by id."""
        return self.mock.MockIndex._all_storage.setdefault(store.collection, {})

    def server_address(self, store: Any) -> str:
        """The index host the control plane reports (the data-plane address)."""
        return f'{store.collection}-mock.svc.example.invalid'

    def fail_backend(
        self, store: Any, error: BaseException, *, after_exists: bool, raise_from: Optional[str] = None
    ) -> None:
        """Every client call raises (has_index still answers when ``after_exists``)."""
        store.client = FailingProxy(error, store.client, ('has_index',) if after_exists else (), raise_from=raise_from)

    def duplicate_rows(self, store: Any, object_id: str) -> None:
        """Copies of the document's vectors under random ids."""
        storage = self.storage(store)
        for vector in [v for v in storage.values() if (v.get('metadata') or {}).get('objectId') == object_id]:
            storage[random_uuid()] = copy.deepcopy(vector)

    def count_calls(self, store: Any) -> Dict[str, int]:
        """Count control-plane calls and calls on the index objects the client hands out."""
        counter = {'calls': 0}
        store.client = CountingProxy(store.client, counter, ('Index',))
        return counter

    def seed_legacy(self, store: Any) -> None:
        """Vectors as today's driver wrote them: uuid4 ids, declared fields plus content."""
        store._createCollection(DIM)
        for object_id, chunk_id, meta, content in legacy_rows():
            metadata = {**meta, 'content': content}
            vector = vector_for(object_id, chunk_id)
            if object_id == 'schema':
                metadata.update({'nodeId': '', 'parent': '', 'permissionId': 0, 'isTable': False, 'tableId': 0})
                vector = [0.0] * (DIM - 1) + [1.0]
            self.storage(store)[random_uuid()] = {'values': vector, 'metadata': metadata}

    def scramble_ids(self, store: Any) -> None:
        """Re-key every vector with a random id."""
        storage = self.storage(store)
        items = list(storage.items())
        storage.clear()
        for _, vector in items:
            storage[random_uuid()] = vector

    def _wrap_index(self, store: Any, method: str, factory: Callable[[Callable[..., Any]], Callable[..., Any]]) -> None:
        original_index = store.client.Index

        def index(name: str) -> Any:
            idx = original_index(name)
            replace_method(idx, method, factory)
            return idx

        store.client.Index = index

    def ignore_offsets(self, store: Any) -> None:
        """Make fetch_by_metadata ignore its pagination token."""

        def factory(original: Callable[..., Any]) -> Callable[..., Any]:
            def fetch_by_metadata(*args: Any, **kwargs: Any) -> Any:
                kwargs['pagination_token'] = None
                return original(*args, **kwargs)

            return fetch_by_metadata

        self._wrap_index(store, 'fetch_by_metadata', factory)

    def raw_rows(self, store: Any) -> List[Dict[str, Any]]:
        """Every stored vector."""
        return [
            {
                'objectId': v['metadata'].get('objectId'),
                'chunkId': v['metadata'].get('chunkId'),
                'meta': v['metadata'],
                'id': vid,
            }
            for vid, v in self.storage(store).items()
        ]

    def set_scores(self, store: Any, scores: Sequence[float]) -> None:
        """Answer the next semantic query with one match per score (raw cosine)."""
        rows = [(vid, v) for vid, v in self.storage(store).items() if v['metadata'].get('objectId') != 'schema']

        def factory(original: Callable[..., Any]) -> Callable[..., Any]:
            def query(*args: Any, **kwargs: Any) -> Any:
                # The driver's own reads query with a constant vector of ones; answer those for real
                if all(x == 1 for x in kwargs.get('vector') or []):
                    return original(*args, **kwargs)
                return {
                    'matches': [
                        {'id': vid, 'score': score, 'metadata': dict(v['metadata'])}
                        for (vid, v), score in zip(rows, scores)
                    ]
                }

            return query

        original_search = type(store).searchSemantic.__get__(store, type(store))

        def search(query: Any, docFilter: Any) -> Any:
            saved = store.client.__dict__.get('Index')
            self._wrap_index(store, 'query', factory)
            try:
                return original_search(query, docFilter)
            finally:
                if saved is None:
                    store.client.__dict__.pop('Index', None)
                else:
                    store.client.Index = saved

        store.searchSemantic = search


def legacy_document_rows() -> List[Tuple[str, int, Dict[str, Any], str]]:
    """Legacy rows as Astra/Atlas wrote them (``metadata.__dict__``): explicit nulls, no control extras."""
    rows = []
    for object_id, chunk_id, meta, content in legacy_rows():
        if object_id == 'schema':
            meta = {
                'objectId': 'schema',
                'chunkId': 0,
                'nodeId': None,
                'parent': None,
                'permissionId': None,
                'isDeleted': True,
                'isTable': None,
                'tableId': None,
            }
        rows.append((object_id, chunk_id, {**meta, 'signature': None}, content))
    return rows


class AstraAdapter(Adapter):
    """Astra DB through ``nodes/test/mocks/astrapy``."""

    name = 'astra_db'
    client_module = 'astrapy'
    backend = 'astra'
    services = 'store_astra/services.json'
    floor = 0.2
    offset_raises = False
    extras_stored = False
    legacy_control_has_model = False
    listing_counts = False

    def __init__(self) -> None:
        """Load the driver against the astrapy mock."""
        self.module, mocks = load_driver(
            'store_astra/astra_db.py', '_vx_astra_driver', mock_libs=('astrapy',), preload=('astrapy.exceptions',)
        )
        self.mock = mocks['astrapy']

    def new_store(self) -> Any:
        """A store on an empty mock database."""
        self.mock.Database.reset()
        client = self.mock.DataAPIClient()
        return bare_store(
            self.module.Store,
            collection_name='vx_test',
            api_endpoint='https://db-id-region.apps.example.invalid',
            similarity='cosine',
            application_token=None,
            threshold_search=0.5,
            client=client,
            database=client.get_database('https://db-id-region.apps.example.invalid', token=None),
        )

    def rows(self, store: Any) -> List[Dict[str, Any]]:
        """The mock's documents for the collection."""
        return self.mock.Database._data.setdefault(store.collection_name, [])

    def server_address(self, store: Any) -> str:
        """The Data API endpoint."""
        return store.api_endpoint

    def fail_backend(
        self, store: Any, error: BaseException, *, after_exists: bool, raise_from: Optional[str] = None
    ) -> None:
        """Every database call raises (list_collection_names still answers when ``after_exists``)."""
        store.database = FailingProxy(
            error, store.database, ('list_collection_names',) if after_exists else (), raise_from=raise_from
        )

    def duplicate_rows(self, store: Any, object_id: str) -> None:
        """Copies of the document's rows under new uuid4 ids."""
        rows = self.rows(store)
        for row in [r for r in rows if (r.get('meta') or {}).get('objectId') == object_id]:
            rows.append({**copy.deepcopy(row), '_id': random_uuid()})

    def count_calls(self, store: Any) -> Dict[str, int]:
        """Count database calls and calls on the collections it hands out."""
        counter = {'calls': 0}
        store.database = CountingProxy(store.database, counter, ('get_collection',))
        return counter

    def seed_legacy(self, store: Any) -> None:
        """Documents as today's driver wrote them: uuid4 ids, declared fields with explicit nulls."""
        store._createCollection(DIM)
        for object_id, chunk_id, meta, content in legacy_document_rows():
            vector = [1e-8] * DIM if object_id == 'schema' else vector_for(object_id, chunk_id)
            self.rows(store).append({'_id': random_uuid(), '$vector': vector, 'content': content, 'meta': dict(meta)})

    def ignore_offsets(self, store: Any) -> None:
        """Make find ignore skip and page states (with pages of 2, so a listing crosses pages)."""
        self.mock.Database.page_size = 2  # restored by the next new_store (Database.reset)
        original_get = store.database.get_collection

        def get_collection(name: str) -> Any:
            collection = original_get(name)

            def factory(original: Callable[..., Any]) -> Callable[..., Any]:
                def find(*args: Any, **kwargs: Any) -> Any:
                    kwargs.pop('skip', None)
                    kwargs.pop('initial_page_state', None)
                    return original(*args, **kwargs)

                return find

            replace_method(collection, 'find', factory)
            return collection

        store.database.get_collection = get_collection

    def raw_rows(self, store: Any) -> List[Dict[str, Any]]:
        """Every stored document."""
        return [
            {
                'objectId': d['meta'].get('objectId'),
                'chunkId': d['meta'].get('chunkId'),
                'meta': d['meta'],
                'id': d['_id'],
            }
            for d in self.rows(store)
        ]

    def set_scores(self, store: Any, scores: Sequence[float]) -> None:
        """Answer the next vector search with one hit per score ($similarity)."""
        docs = [d for d in self.rows(store) if d['meta'].get('objectId') != 'schema']
        original_get = store.database.get_collection

        def get_collection(name: str) -> Any:
            collection = original_get(name)

            def factory(original: Callable[..., Any]) -> Callable[..., Any]:
                def find(*args: Any, **kwargs: Any) -> Any:
                    if '$vector' not in (kwargs.get('sort') or {}):
                        return original(*args, **kwargs)
                    hits = [
                        {k: v for k, v in d.items() if k != '$vector'} | {'$similarity': s}
                        for d, s in zip(docs, scores)
                    ]
                    return iter(hits)

                return find

            replace_method(collection, 'find', factory)
            return collection

        store.database.get_collection = get_collection


class AtlasAdapter(Adapter):
    """MongoDB Atlas through ``store_atlas/fake_pymongo.py`` (the driver imports the real pymongo)."""

    name = 'atlas'
    client_module = 'pymongo'
    backend = 'atlas'
    services = None
    floor = 0.2
    offset_raises = True
    extras_stored = False
    legacy_control_has_model = False
    listing_sorted = True
    random_strategy = 'random'
    stratified_native = True

    def __init__(self) -> None:
        """Load the driver against the installed pymongo (its exceptions and models)."""
        from .store_atlas import fake_pymongo

        self.fake = fake_pymongo
        self.module, _ = load_driver('store_atlas/atlas.py', '_vx_atlas_driver', real_libs=('pymongo',))

    def new_store(self) -> Any:
        """A store on an empty fake cluster."""
        client = self.fake.FakeMongoClient()
        database = client['vxdb']
        return bare_store(
            self.module.Store,
            database_name='vxdb',
            collection_name='vx_test',
            host='mongodb+srv://cluster0.example.invalid',
            vector_index_name='vector_index',
            text_index_name='text_index',
            similarity='cosine',
            threshold_search=0.5,
            payload_limit=32 * 1024 * 1024,
            renderChunkSize=32 * 1024 * 1024,
            client=client,
            database=database,
            collection=database['vx_test'],
        )

    def seed_legacy(self, store: Any) -> None:
        """A collection as today's driver built it: a knnVector search index, uuid4 ids, nulls in meta."""
        store.database.create_collection(store.collection_name)
        store.collection.search_indexes.append(
            {
                'name': 'vector_index',
                'type': 'search',
                'latestDefinition': {
                    'mappings': {
                        'dynamic': True,
                        'fields': {'embedding': {'type': 'knnVector', 'dimensions': DIM, 'similarity': 'cosine'}},
                    }
                },
            }
        )
        for object_id, chunk_id, meta, content in legacy_document_rows():
            vector = [0.0] * DIM if object_id == 'schema' else vector_for(object_id, chunk_id)
            store.collection.docs.append(
                {'_id': random_uuid(), 'embedding': vector, 'content': content, 'meta': dict(meta)}
            )

    def server_address(self, store: Any) -> str:
        """The cluster address from the connection string."""
        return store.host.split('://', 1)[-1]

    def fail_backend(
        self, store: Any, error: BaseException, *, after_exists: bool, raise_from: Optional[str] = None
    ) -> None:
        """Every database and collection call raises (list_collection_names answers when ``after_exists``)."""
        store.database = FailingProxy(
            error, store.database, ('list_collection_names',) if after_exists else (), raise_from=raise_from
        )
        store.collection = FailingProxy(error, raise_from=raise_from)

    def duplicate_rows(self, store: Any, object_id: str) -> None:
        """Copies of the document's rows under new uuid4 ids."""
        docs = store.collection.docs
        for doc in [d for d in docs if (d.get('meta') or {}).get('objectId') == object_id]:
            docs.append({**copy.deepcopy(doc), '_id': random_uuid()})

    def count_calls(self, store: Any) -> Dict[str, int]:
        """Count database and collection calls."""
        counter = {'calls': 0}
        store.database = CountingProxy(store.database, counter)
        store.collection = CountingProxy(store.collection, counter)
        return counter

    def ignore_offsets(self, store: Any) -> None:
        """Drop $skip stages and cursor skips."""
        collection = store.collection
        original_aggregate = collection.aggregate

        def aggregate(pipeline: List[Dict[str, Any]], **kwargs: Any) -> Any:
            return original_aggregate([stage for stage in pipeline if '$skip' not in stage], **kwargs)

        collection.aggregate = aggregate
        original_find = collection.find

        def find(*args: Any, **kwargs: Any) -> Any:
            cursor = original_find(*args, **kwargs)
            cursor.skip = lambda count: cursor
            return cursor

        collection.find = find

    def raw_rows(self, store: Any) -> List[Dict[str, Any]]:
        """Every stored document."""
        return [
            {
                'objectId': d['meta'].get('objectId'),
                'chunkId': d['meta'].get('chunkId'),
                'meta': d['meta'],
                'id': d['_id'],
            }
            for d in store.collection.docs
        ]

    def set_scores(self, store: Any, scores: Sequence[float]) -> None:
        """Answer the next $vectorSearch with one hit per vectorSearchScore."""
        docs = [d for d in store.collection.docs if d['meta'].get('objectId') != 'schema']
        collection = store.collection
        original_aggregate = type(collection).aggregate.__get__(collection, type(collection))

        def aggregate(pipeline: List[Dict[str, Any]], **kwargs: Any) -> Any:
            if pipeline and '$vectorSearch' in pipeline[0]:
                return iter(
                    [{**{k: v for k, v in d.items() if k != 'embedding'}, 'score': s} for d, s in zip(docs, scores)]
                )
            return original_aggregate(pipeline, **kwargs)

        collection.aggregate = aggregate
