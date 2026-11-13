# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Real Milvus tests for the store_milvus driver.

Run with the built engine and RR_TEST_MILVUS_URI set to a Milvus server's http://
address with a host name or an IPv4 address, for example http://127.0.0.1:19530.
Without the variable every test skips, even with RR_REQUIRE_DB_TESTS=1, which CI
sets for its Postgres suites and starts no Milvus; with both set, any other
address, a server that does not answer or a missing pymilvus fails instead of
skipping. Each test writes to its own collection and drops it afterwards; one
test also writes from a second engine process. The driver, pymilvus, the Doc
models and DocumentStoreBase are real.
"""

import importlib
import importlib.util
import json
import os
import subprocess
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock
from urllib.parse import urlsplit
from uuid import uuid4

import pytest

_REPO = Path(__file__).resolve().parents[3]
_NODE_DIR = _REPO / 'nodes/src/nodes/store_milvus'
_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))
_URI = os.environ.get('RR_TEST_MILVUS_URI')

# The writer process runs this file's _write_and_wait with the Store config
_WRITER = 'import json, runpy, sys; runpy.run_path(sys.argv[1])["_write_and_wait"](json.loads(sys.argv[2]))'


def _load_driver(prepend_path, set_module):
    """Load the store_milvus driver from source, with the installed pymilvus.

    Args:
        prepend_path: Puts a directory first on ``sys.path``.
        set_module: Puts a module into ``sys.modules`` under a name.

    Returns:
        The driver module.
    """
    for src in ('packages/ai/src', 'packages/client-python/src', 'nodes/src'):
        prepend_path(str(_REPO / src))
    # depends installs the node's requirements; the test uses the installed pymilvus as it is
    set_module('depends', MagicMock())
    package = types.ModuleType('nodes.store_milvus')
    package.__path__ = [str(_NODE_DIR)]
    set_module(package.__name__, package)
    module = None
    for name in ('mode', 'milvus'):
        spec = importlib.util.spec_from_file_location(f'nodes.store_milvus.{name}', _NODE_DIR / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        set_module(spec.name, module)
        spec.loader.exec_module(module)
    return module


def _write_and_wait(config):
    """Write chunk 'a' to the collection, print 'written', and wait until stdin closes.

    Runs in the writer process, started with ``_WRITER``.

    Args:
        config: The Store's config.
    """
    module = _load_driver(lambda path: sys.path.insert(0, path), sys.modules.__setitem__)
    store = module.Store('milvus', config, {})
    store.addChunks([_doc('a')])
    print('written', flush=True)
    sys.stdin.read()
    store.client.close()


@pytest.fixture
def open_store(monkeypatch):
    """Return a function that opens a Store on one new collection; drop the collection afterwards.

    Args:
        monkeypatch: Restores ``sys.path`` and ``sys.modules`` after the test.

    Yields:
        A function that opens another Store on the same collection each time it is called; its
        ``config`` attribute is the Store config.
    """
    if not _URI:
        pytest.skip('Set RR_TEST_MILVUS_URI to a Milvus test server; CI starts none yet (#3094)')
    url = urlsplit(_URI)
    if url.scheme != 'http' or not url.hostname or ':' in url.hostname:
        # The store opens in local mode, which connects to http://<host>:<port>, and
        # pymilvus does not connect to an IPv6 host
        message = 'RR_TEST_MILVUS_URI must be an http://<host>:<port> address with a host name or an IPv4 address'
        if _REQUIRED:
            pytest.fail(message)
        pytest.skip(message)
    if _REQUIRED:
        import rocketlib  # noqa: F401

        pymilvus = importlib.import_module('pymilvus')
    else:
        pytest.importorskip('rocketlib', reason='Run these tests with the built engine')
        pymilvus = pytest.importorskip('pymilvus')
    try:
        admin = pymilvus.MilvusClient(uri=_URI, timeout=10)
        admin.list_collections()
    except Exception as e:
        if _REQUIRED:
            pytest.fail(f'Milvus test server {_URI} is unavailable: {e}')
        pytest.skip(f'Milvus test server {_URI} is unavailable')

    module = _load_driver(
        monkeypatch.syspath_prepend, lambda name, value: monkeypatch.setitem(sys.modules, name, value)
    )

    config = {
        'collection': 'rr_test_' + uuid4().hex,
        'host': url.hostname,
        'port': url.port or 19530,
        'mode': 'local',
        'similarity': 'COSINE',
    }
    stores = []

    def open_store():
        """Open a Store on the test's collection.

        Returns:
            A new driver Store with its own Milvus client.
        """
        store = module.Store('milvus', dict(config), {})
        stores.append(store)
        return store

    open_store.config = config
    try:
        yield open_store
    finally:
        try:
            for store in stores:
                if store.client is not None:
                    store.client.close()
                    store.client = None
        finally:
            try:
                admin.drop_collection(config['collection'])
            finally:
                admin.close()


def _doc(object_id='a', chunk_id=0, content='original', **metadata):
    """Build an embedded chunk the way the pipeline hands it to a store.

    Args:
        object_id: The object the chunk belongs to.
        chunk_id: The chunk's position in its object.
        content: The chunk's text.
        **metadata: More DocMetadata fields, extra ones included; parent defaults to ``/<object_id>``.

    Returns:
        The Doc.
    """
    from ai.common.schema import Doc, DocMetadata

    metadata.setdefault('parent', f'/{object_id}')
    return Doc(
        page_content=content,
        metadata=DocMetadata(objectId=object_id, chunkId=chunk_id, isDeleted=False, **metadata),
        embedding=[1.0, 0.0, 0.0],
        embedding_model='test-model',
    )


def _filter(**fields):
    """Build a DocFilter from its fields.

    Args:
        **fields: DocFilter fields.

    Returns:
        The DocFilter.
    """
    from ai.common.schema import DocFilter

    return DocFilter(**fields)


def _chunks(docs):
    """Return (objectId, chunkId, content) of each doc, sorted.

    Args:
        docs: Docs a store returned.

    Returns:
        The sorted tuples.
    """
    return sorted((doc.metadata.objectId, doc.metadata.chunkId, doc.page_content) for doc in docs)


def _found(store, text):
    """Return the object ids that a keyword search for text finds, sorted.

    Args:
        store: The Store to search.
        text: The question's text.

    Returns:
        The sorted object ids.
    """
    from ai.common.schema import QuestionText

    return [object_id for object_id, _, _ in _chunks(store.searchKeyword(QuestionText(text=text), _filter()))]


@pytest.mark.parametrize(
    'metadata',
    [{}, {'signature': 'test-signature', 'extraField': 'kept'}],
    ids=['plain', 'signature-and-extra'],
)
def test_the_first_write_leaves_a_collection_another_store_opens(open_store, metadata):
    """The first write stores the control row and the chunk, so a new store opens the collection (#3014)."""
    open_store().addChunks([_doc(**metadata)])

    other = open_store()
    assert other.doesCollectionExist()
    assert (other.vectorSize, other.modelName) == (3, 'test-model')
    docs = other.get(_filter(objectIds=['a']))
    assert _chunks(docs) == [('a', 0, 'original')]
    assert {key: getattr(docs[0].metadata, key) for key in metadata} == metadata


def test_the_control_row_is_found_right_after_the_collection_is_created(open_store):
    """A second pipeline thread checks the control row the moment the creating thread releases the lock."""
    store = open_store()
    store.createCollection([_doc()])
    assert store.doesCollectionExist()


def test_reads_see_a_write_at_once(open_store):
    """get, semantic search, getPaths and count see chunks the moment they are written."""
    from ai.common.schema import QuestionText

    store = open_store()
    store.addChunks([_doc('a', 0), _doc('a', 1), _doc('b')])

    assert _chunks(store.get(_filter(objectIds=['a']))) == [('a', 0, 'original'), ('a', 1, 'original')]
    question = QuestionText(text='anything', embedding=[1.0, 0.0, 0.0], embedding_model='test-model')
    assert _chunks(store.searchSemantic(question, _filter())) == [
        ('a', 0, 'original'),
        ('a', 1, 'original'),
        ('b', 0, 'original'),
    ]
    assert store.getPaths() == {'/a': 'a', '/b': 'b'}
    # The three chunks and the control row
    assert store.count_documents() == 4


def test_keyword_search_matches_the_question_text(open_store):
    """Keyword search looks for the question's text, not for the QuestionText object."""
    from ai.common.schema import QuestionText

    store = open_store()
    store.addChunks([_doc('a', 0, 'the quick fox'), _doc('b', 0, 'a slow turtle')])
    docs = store.searchKeyword(QuestionText(text='quick'), _filter())
    assert _chunks(docs) == [('a', 0, 'the quick fox')]


def test_keyword_search_takes_percent_and_underscore_literally(open_store):
    """A % or _ in the question matches only itself; text that ends with % still finds every row that has it."""
    store = open_store()
    store.addChunks(
        [
            _doc('a', 0, 'growth 50% now'),
            _doc('b', 0, 'growth 500 now'),
            _doc('c', 0, 'key a_b'),
            _doc('d', 0, 'key axb'),
        ]
    )
    assert _found(store, '50% now') == ['a']
    assert _found(store, 'a_b') == ['c']
    assert 'a' in _found(store, '50%')


def test_keyword_search_matches_text_with_line_breaks(open_store):
    """A question with LF or CRLF finds the chunk with that text, and a match may sit between lines of a chunk."""
    store = open_store()
    store.addChunks(
        [
            _doc('a', 0, 'first line\nsecond line'),
            _doc('b', 0, 'first line second line'),
            _doc('c', 0, 'one\r\ntwo'),
            _doc('d', 0, 'intro\ngrowth 50% now\nend'),
        ]
    )
    assert _found(store, 'line\nsecond') == ['a']
    assert _found(store, 'one\r\ntwo') == ['c']
    assert _found(store, 'growth 50% now') == ['d']
    # Text that ends with % takes the wildcard path
    assert _found(store, 'growth 50%') == ['d']


def test_render_joins_the_chunks_in_order(open_store):
    """Render puts an object's chunks back in chunk order, whatever order they were written in."""
    store = open_store()
    store.addChunks([_doc('a', 0, 'one '), _doc('a', 2, 'three'), _doc('a', 1, 'two ')])
    rendered = []
    store.render('a', rendered.append)
    assert rendered == ['one two three']


def test_marks_and_removes_apply_right_after_a_write(open_store):
    """markDeleted, markActive and remove reach chunks written a moment before."""
    store = open_store()
    store.addChunks([_doc('a'), _doc('b')])

    store.markDeleted(['b'])
    assert store.getPaths() == {'/a': 'a'}
    assert [doc.metadata.isDeleted for doc in store.get(_filter(objectIds=['b'], isDeleted=True))] == [True]

    store.markActive(['b'])
    assert store.getPaths() == {'/a': 'a', '/b': 'b'}

    store.remove(['b'])
    assert store.getPaths() == {'/a': 'a'}
    assert store.get(_filter(objectIds=['b'], isDeleted=True)) == []


def test_a_mark_reaches_a_chunk_another_process_wrote_a_moment_before(open_store):
    """A mark reaches a chunk another process just wrote, in a process that never wrote to the collection.

    The writer process also creates the collection, so this process first finds a control row it did not write.
    """
    store = open_store()
    writer = subprocess.Popen(
        [sys.executable, '-c', _WRITER, __file__, json.dumps(open_store.config)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert 'written' in (line.strip() for line in iter(writer.stdout.readline, ''))
        store.markDeleted(['a'])
        assert store.getPaths() == {}
        assert [doc.metadata.isDeleted for doc in store.get(_filter(objectIds=['a'], isDeleted=True))] == [True]
    finally:
        writer.stdin.close()
        writer.wait(timeout=60)


def test_a_chunk_without_a_deletion_flag_is_live(open_store):
    """A chunk whose metadata leaves isDeleted out is found by default reads."""
    from ai.common.schema import Doc, DocMetadata

    store = open_store()
    metadata = DocMetadata(objectId='a', chunkId=0, parent='/a')
    store.addChunks([Doc(page_content='plain', metadata=metadata, embedding=[1.0, 0.0, 0.0], embedding_model='m')])
    assert store.getPaths() == {'/a': 'a'}
    assert _chunks(store.get(_filter(objectIds=['a']))) == [('a', 0, 'plain')]


def test_only_chunk_zero_starts_an_object_over(open_store):
    """A batch without chunk 0 adds to the object; a batch with chunk 0 replaces it (#1986)."""
    store = open_store()
    store.addChunks([_doc('a', 0), _doc('a', 1)])
    store.addChunks([_doc('a', 2), _doc('a', 3)])
    assert [chunk_id for _, chunk_id, _ in _chunks(store.get(_filter(objectIds=['a'])))] == [0, 1, 2, 3]

    store.addChunks([_doc('a', 0, 'replacement')])
    assert _chunks(store.get(_filter(objectIds=['a']))) == [('a', 0, 'replacement')]


def test_every_filter_field_matches_its_metadata(open_store):
    """Each DocFilter field selects by the type the metadata is stored with: str, bool or int."""
    store = open_store()
    store.addChunks(
        [
            _doc('text', 0, 'text-0', nodeId='n1', permissionId=5, isTable=False, tableId=0),
            _doc('tab', 0, 'tab-0', nodeId='n2', permissionId=7, isTable=True, tableId=3),
            _doc('tab', 1, 'tab-1', nodeId='n2', permissionId=7, isTable=True, tableId=4),
        ]
    )
    cases = {
        'nodeId': (dict(nodeId='n1'), ['text-0']),
        'parent': (dict(parent='/tab'), ['tab-0', 'tab-1']),
        'isTable true': (dict(isTable=True), ['tab-0', 'tab-1']),
        'isTable false': (dict(isTable=False), ['text-0']),
        'tableIds': (dict(tableIds=[3]), ['tab-0']),
        'permissions': (dict(permissions=[5]), ['text-0']),
        'objectIds': (dict(objectIds=['tab']), ['tab-0', 'tab-1']),
        'chunkIds': (dict(chunkIds=[1]), ['tab-1']),
        'minChunkId': (dict(minChunkId=1), ['tab-1']),
        'maxChunkId': (dict(maxChunkId=0), ['tab-0', 'text-0']),
        # The filter DocumentStoreBase builds to fetch the full tables of a search hit
        'full tables': (dict(isTable=True, objectIds=['tab'], tableIds=[3, 4]), ['tab-0', 'tab-1']),
    }
    got = {
        label: sorted(doc.page_content for doc in store.get(_filter(**fields))) for label, (fields, _) in cases.items()
    }
    assert got == {label: expected for label, (_, expected) in cases.items()}
