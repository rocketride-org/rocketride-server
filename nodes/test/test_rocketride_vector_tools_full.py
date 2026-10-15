# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Integration tests for the rocketride_vector agent tools (real PostgreSQL, #2587).

Drives the node's real driver ``Store`` through the real ``VectorStoreToolMixin``
against a local pgvector container, the way an agent or app reaches the store
through invoke: writes refused until the node allows them, then upsert, stats,
objdir, get, search and delete in one round trip. The engine library is stood in
for only when it is not importable (a plain venv); the ``ai`` and ``rocketride``
packages are the real ones.

Requires the same container as test_rocketride_db_full.py::

    docker run -d --name rr-pg-phase1 -p 55432:5432 \\
        -e POSTGRES_PASSWORD=rrpass -e POSTGRES_USER=rruser -e POSTGRES_DB=rrtenant \\
        pgvector/pgvector:pg16
    docker exec rr-pg-phase1 psql -U rruser -d rrtenant -c 'CREATE EXTENSION IF NOT EXISTS vector;'

Configuration via environment variables:
    RR_TEST_PG_DSN       libpq URL of the test database
                         (default: postgresql://rruser:rrpass@localhost:55432/rrtenant)
    RR_REQUIRE_DB_TESTS  when set, an unreachable database fails instead of skipping
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

_REPO = Path(__file__).resolve().parents[2]
_VEC_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_vector'
_AI_SRC = _REPO / 'packages' / 'ai' / 'src'
_CLIENT_SRC = _REPO / 'packages' / 'client-python' / 'src'

TEST_DSN = os.environ.get('RR_TEST_PG_DSN', 'postgresql://rruser:rrpass@localhost:55432/rrtenant')
_DB_TESTS_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))
TABLE = 'rr_vec_tools_e2e'
DIMS = 8

psycopg2 = pytest.importorskip('psycopg2')
pytest.importorskip('pgvector')
np = pytest.importorskip('numpy')


def _db_reachable() -> bool:
    try:
        conn = psycopg2.connect(TEST_DSN, connect_timeout=3)
        conn.close()
        return True
    except Exception:
        return False


if _DB_TESTS_REQUIRED and not _db_reachable():
    pytest.fail(f'RR_REQUIRE_DB_TESTS is set but the test database is not reachable at {TEST_DSN}', pytrace=False)

pytestmark = pytest.mark.skipif(not _db_reachable(), reason=f'RocketRide test database not reachable at {TEST_DSN}')


def _unit_vec(rng) -> list[float]:
    v = rng.standard_normal(DIMS)
    return [float(x) for x in v / np.linalg.norm(v)]


def _service_definition(name, *_args, **_kwargs):
    """Serve a node's services.json from the tree, the way the engine's catalog does."""
    json5 = pytest.importorskip('json5')
    path = _REPO / 'nodes' / 'src' / 'nodes' / name / 'services.json'
    return json5.loads(path.read_text(encoding='utf-8')) if path.exists() else None


def _stub_engine(monkeypatch):
    """Provide ``rocketlib`` and ``depends`` when the engine is not importable.

    Under the built engine both exist and nothing is replaced. In a plain venv
    the stand-in answers every name the ``ai`` package imports at module level
    with a placeholder class, and the few functions the store path calls.
    """
    try:
        import rocketlib  # noqa: F401
    except ImportError:
        rocketlib = types.ModuleType('rocketlib')
        rocketlib.warning = lambda *a, **kw: None
        rocketlib.debug = lambda *a, **kw: None
        rocketlib.error = lambda *a, **kw: None
        rocketlib.args = lambda: []

        # Config.getNodeConfig merges the node's services.json profile with the
        # pipeline config; the engine serves that file, here it is read from the tree.
        class _IJson:
            @staticmethod
            def toDict(value):
                return dict(value) if isinstance(value, dict) else value

        rocketlib.getServiceDefinition = _service_definition
        rocketlib.tool_function = lambda **kw: lambda f: f
        rocketlib.OPEN_MODE = SimpleNamespace(CONFIG='config', SOURCE='source', TARGET='target', TRANSFORM='transform')
        rocketlib.SERVICE_MODE = SimpleNamespace(SOURCE='source', TARGET='target', TRANSFORM='transform')
        rocketlib.IJson = _IJson
        rocketlib.__getattr__ = lambda name: type(name, (), {})
        monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)
    try:
        import depends  # noqa: F401
    except ImportError:
        depends = types.ModuleType('depends')
        depends.depends = lambda *a, **kw: None
        monkeypatch.setitem(sys.modules, 'depends', depends)


@pytest.fixture()
def tools_env(monkeypatch):
    """Real ``ai`` package, real driver Store on the container, real tool mixin.

    Returns ``(make_tools, raw_conn)``: ``make_tools(allow_write, expose_tools=True)``
    builds a mixin instance whose fake IGlobal carries the store and the two
    switches, the way StoreGlobalBase leaves them after beginGlobal.
    """
    _stub_engine(monkeypatch)
    # The engine bundles both packages; a plain venv finds them in the tree.
    for src in (_AI_SRC, _CLIENT_SRC):
        if str(src) not in sys.path:
            monkeypatch.syspath_prepend(str(src))
    # The production injection path: the task engine hands the resolved
    # tenant DSN to the node process through this variable.
    monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({'org': TEST_DSN}))

    from ai.common.store.document_store import VectorStoreToolMixin

    pkg = types.ModuleType('nodes.rocketride_vector')
    pkg.__path__ = [str(_VEC_NODE_DIR)]
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector', pkg)
    for name in ('IGlobal', 'rocketride_vector'):
        spec = importlib.util.spec_from_file_location(f'nodes.rocketride_vector.{name}', _VEC_NODE_DIR / f'{name}.py')
        module = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, f'nodes.rocketride_vector.{name}', module)
        spec.loader.exec_module(module)
    store_cls = sys.modules['nodes.rocketride_vector.rocketride_vector'].Store

    raw_conn = psycopg2.connect(TEST_DSN)
    with raw_conn.cursor() as cur:
        cur.execute(f'DROP TABLE IF EXISTS {TABLE}')
        raw_conn.commit()

    stores = []

    class _Tools(VectorStoreToolMixin):
        def __init__(self, allow_write: bool, expose_tools: bool = True):
            store = store_cls('rocketride_vector', {'collection': TABLE, 'similarity': 'cosine'}, {})
            stores.append(store)
            self.IGlobal = SimpleNamespace(
                serverName='rrvector',
                store=store,
                embed_query=None,
                embed_model_name=None,
                expose_tools=expose_tools,
                allow_write=allow_write,
            )

    yield _Tools, raw_conn

    for store in stores:
        if store.client is not None:
            store.client.close()
            store.client = None
    with raw_conn.cursor() as cur:
        cur.execute(f'DROP TABLE IF EXISTS {TABLE}')
        raw_conn.commit()
    raw_conn.close()


def _docs(vectors):
    return [
        {
            'content': f'document {name}',
            'object_id': f'obj-{name}',
            'metadata': {'parent': f'/{name}'},
            'embedding': vec,
            'embedding_model': 'test-model',
        }
        for name, vec in vectors
    ]


def _table_exists(raw_conn) -> bool:
    with raw_conn.cursor() as cur:
        cur.execute('SELECT to_regclass(%s) IS NOT NULL', (TABLE,))
        return bool(cur.fetchone()[0])


def test_writes_are_refused_until_the_node_allows_them(tools_env):
    make_tools, raw_conn = tools_env
    rng = np.random.default_rng(1)
    tools = make_tools(allow_write=False)

    upsert = tools.upsert({'documents': _docs([('a', _unit_vec(rng))])})
    delete = tools.delete({'object_ids': ['obj-a']})

    assert upsert['success'] is False and 'rrvector.upsert is disabled' in upsert['error']
    assert delete['success'] is False and 'rrvector.delete is disabled' in delete['error']
    # Nothing touched the database: the table was never created.
    assert not _table_exists(raw_conn)
    assert tools.stats({}) == {'success': True, 'count': 0, 'model': '', 'vector_size': 0}


def test_tools_round_trip_on_the_real_store(tools_env):
    make_tools, raw_conn = tools_env
    rng = np.random.default_rng(2)
    vectors = [(name, _unit_vec(rng)) for name in ('a', 'b', 'c')]
    tools = make_tools(allow_write=True)

    # upsert: three documents, distinct parent paths, pre-computed embeddings
    result = tools.upsert({'documents': _docs(vectors)})
    assert result == {'success': True, 'count': 3, 'skipped': 0}
    assert _table_exists(raw_conn)

    # stats: rows (the three documents plus the store's own schema row), model and width
    assert tools.stats({}) == {'success': True, 'count': 4, 'model': 'test-model', 'vector_size': DIMS}

    # objdir: one entry per distinct parent path
    listing = tools.objdir({})
    assert listing['success'] is True
    assert listing['paths'] == {'/a': 'obj-a', '/b': 'obj-b', '/c': 'obj-c'}
    assert tools.objdir({'parent': '/b'})['paths'] == {'/b': 'obj-b'}

    # get: the chunks of one document
    fetched = tools.get({'object_id': 'obj-b'})
    assert fetched['success'] is True and fetched['total'] == 1
    assert fetched['chunks'][0]['content'] == 'document b'
    assert fetched['chunks'][0]['metadata']['parent'] == '/b'

    # search: the bound embedder returns document c's vector, so c comes first
    tools.IGlobal.embed_query = lambda text: vectors[2][1]
    tools.IGlobal.embed_model_name = 'test-model'
    found = tools.search({'query': 'the third document', 'top_k': 2})
    assert found['total'] >= 1
    assert found['results'][0]['metadata']['objectId'] == 'obj-c'
    assert found['results'][0]['score'] > 0.99

    # delete: gone from the count and the listing
    assert tools.delete({'object_ids': ['obj-c']}) == {'success': True, 'deleted_count': 1}
    assert tools.stats({})['count'] == 3
    assert '/c' not in tools.objdir({})['paths']


def test_search_without_an_embedder_names_the_node(tools_env):
    make_tools, _ = tools_env
    tools = make_tools(allow_write=False)

    result = tools.search({'query': 'anything'})

    assert result['success'] is False
    assert 'rrvector' in result['error'] and 'embedding' in result['error']


def test_a_rejected_upsert_is_reported_and_the_tools_keep_working(tools_env):
    """One bad write must not take the node's tools down (#2587).

    psycopg2 leaves a connection whose statement failed in an aborted
    transaction; without the driver's rollback every later tool call fails
    with "current transaction is aborted" until the pipeline restarts.
    """
    make_tools, _ = tools_env
    rng = np.random.default_rng(4)
    tools = make_tools(allow_write=True)
    assert tools.upsert({'documents': _docs([('a', _unit_vec(rng))])})['count'] == 1

    rejected = tools.upsert({'documents': _docs([('a', [float('nan')] * DIMS)])})  # pgvector rejects NaN

    assert rejected['success'] is False
    assert 'NaN' in rejected['error']
    # The next calls run: a count, a listing, a read and a write that replaces the document.
    # The driver replaces a document in one transaction (#2603), so the rejected
    # write rolled back and the previous version of obj-a is still there.
    assert tools.stats({})['count'] == 2  # obj-a and the schema row
    assert tools.objdir({})['paths'] == {'/a': 'obj-a'}
    assert len(tools.get({'object_id': 'obj-a'})['chunks']) == 1
    assert tools.upsert({'documents': _docs([('a', _unit_vec(rng))])})['count'] == 1
    assert tools.objdir({})['paths'] == {'/a': 'obj-a'}
    assert tools.stats({})['count'] == 2


def test_the_listing_hides_the_schema_row_and_soft_deleted_documents(tools_env):
    """Objdir shows documents, not the store's bookkeeping.

    The base writes a zero-vector 'schema' row with no parent at first write;
    before #2587 the listing returned it as a None key, and documents the
    pipeline had soft-deleted still appeared.
    """
    make_tools, raw_conn = tools_env
    rng = np.random.default_rng(5)
    tools = make_tools(allow_write=True)
    assert tools.upsert({'documents': _docs([('a', _unit_vec(rng)), ('b', _unit_vec(rng))])})['count'] == 2
    tools.IGlobal.store.markDeleted(['obj-b'])

    assert tools.objdir({})['paths'] == {'/a': 'obj-a'}
    # stats keeps counting rows: both documents and the schema row.
    assert tools.stats({})['count'] == 3
    with raw_conn.cursor() as cur:
        cur.execute(f"SELECT parent FROM {TABLE} WHERE objectid = 'schema'")
        assert cur.fetchall() == [(None,)]


def test_objdir_collapses_documents_that_share_a_parent(tools_env):
    # The listing contract every store driver shares: a map keyed by parent
    # path, one object id per key. Two documents under the same parent show
    # as one entry, which the README states; a listing of every object id is
    # a follow-up across drivers.
    make_tools, _ = tools_env
    rng = np.random.default_rng(3)
    tools = make_tools(allow_write=True)
    docs = _docs([('x', _unit_vec(rng)), ('y', _unit_vec(rng))])
    for doc in docs:
        doc['metadata'] = {'parent': '/shared'}

    assert tools.upsert({'documents': docs})['count'] == 2
    assert tools.stats({})['count'] == 3
    assert list(tools.objdir({})['paths'].keys()) == ['/shared']


def test_tools_are_refused_until_the_node_exposes_them(tools_env):
    """With Expose as tools off nothing is listed and every direct call is refused (#2631 review)."""
    make_tools, raw_conn = tools_env
    rng = np.random.default_rng(6)
    tools = make_tools(allow_write=True, expose_tools=False)

    assert tools._collect_tool_methods() == {}
    calls = [
        ('stats', {}),
        ('objdir', {}),
        ('get', {'object_id': 'obj-a'}),
        ('search', {'query': 'anything'}),
        ('upsert', {'documents': _docs([('a', _unit_vec(rng))])}),
        ('delete', {'object_ids': ['obj-a']}),
    ]
    for tool, args in calls:
        result = getattr(tools, tool)(args)
        assert result['success'] is False, tool
        assert 'expose_tools=true' in result['error'], tool
    assert not _table_exists(raw_conn)  # the refused upsert never reached the database


@pytest.mark.parametrize('scope, target', [('org', ''), ('team', 't-1'), ('user', 'u-1')])
def test_the_shipped_profile_resolves_through_the_real_node(tools_env, monkeypatch, scope, target):
    """services.json is the switch that ships: the real IGlobal must read it at start (#2631 review).

    Builds the node's own IGlobal and IInstance (no stand-in base), runs the
    real beginGlobal against the test database with the node's services.json
    as the profile source, and checks what the engine would list. Flip the
    cloud profile's ``expose_tools`` or ``allow_write`` to true and its default
    assertion fails.
    """
    import rocketlib
    from rocketlib import OPEN_MODE

    import ai.common.config as config_module
    from ai.common.rocketride_db import dsn_key

    # Deliver only the requested database: a fallback to org for another
    # scope must fail, while the tool switches retain the same behavior.
    monkeypatch.setenv('ROCKETRIDE_DB_DSNS', json.dumps({dsn_key(scope, target): TEST_DSN}))

    iglobal_cls = sys.modules['nodes.rocketride_vector.IGlobal'].IGlobal
    spec = importlib.util.spec_from_file_location('nodes.rocketride_vector.IInstance', _VEC_NODE_DIR / 'IInstance.py')
    iinstance_module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_vector.IInstance', iinstance_module)
    spec.loader.exec_module(iinstance_module)
    iinstance_cls = iinstance_module.IInstance

    # Config.getNodeConfig merges the node's services.json into the pipeline
    # config; serve the tree's copy so the shipped defaults are what resolve.
    # Config binds the lookup at import (``from rocketlib import
    # getServiceDefinition``), so patch its name, not rocketlib's export.
    service_definition = Mock(side_effect=_service_definition)
    monkeypatch.setattr(config_module, 'getServiceDefinition', service_definition)
    # The engine's collector reads the decorator's __tool_meta__; a stand-in rocketlib has neither.
    real_collector = hasattr(rocketlib.IInstanceBase, '_collect_tool_methods')
    opened = []

    def make(cloud_config):
        glb = object.__new__(iglobal_cls)
        glb.IEndpoint = SimpleNamespace(endpoint=SimpleNamespace(openMode=OPEN_MODE.SOURCE, bag={}))
        glb.glb = SimpleNamespace(
            logicalType='rocketride_vector',
            connConfig={'profile': 'cloud', 'cloud': {**cloud_config, 'scope': scope, 'target': target}},
        )
        glb.beginGlobal()
        opened.append(glb)
        inst = object.__new__(iinstance_cls)
        inst.IGlobal = glb
        return glb, inst

    try:
        glb, inst = make({'collection': TABLE})
        service_definition.assert_any_call('rocketride_vector')
        assert glb.expose_tools is False  # the cloud profile's default ships the switch off
        assert glb.allow_write is False
        if real_collector:
            assert set(inst._collect_tool_methods()) == set()

        glb, inst = make({'collection': TABLE, 'expose_tools': True})
        assert glb.expose_tools is True and glb.allow_write is False
        if real_collector:
            assert set(inst._collect_tool_methods()) == {'search', 'objdir', 'get', 'stats'}

        glb, inst = make({'collection': TABLE, 'expose_tools': True, 'allow_write': True})
        assert glb.expose_tools is True and glb.allow_write is True
        if real_collector:
            assert set(inst._collect_tool_methods()) == {'search', 'objdir', 'get', 'stats', 'upsert', 'delete'}
    finally:
        for glb in opened:
            store = getattr(glb, 'store', None)
            if store is not None and getattr(store, 'client', None) is not None:
                store.client.close()
                store.client = None
