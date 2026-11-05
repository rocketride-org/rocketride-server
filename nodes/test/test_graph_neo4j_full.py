# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Live tests for graph_neo4j's read_query / execute(shape='graph') against a real Neo4j 5.

The node runs with the real ``neo4j`` driver and the real shared graph base;
only the engine surface (rocketlib, config resolution) is stubbed. Every
refused write is proven by database state before and after, not by the error
text alone.

Configuration (defaults are the local disposable container):
    RR_TEST_NEO4J_URI       bolt://127.0.0.1:57687
    RR_TEST_NEO4J_USER      neo4j
    RR_TEST_NEO4J_PASSWORD  gxlocal-test-pass
    RR_TEST_NEO4J_READONLY_URI / _USER / _PASSWORD
                            optional: a user on the SAME server whose database
                            role is read-only (e.g. the built-in `reader` role;
                            Neo4j Enterprise or Aura). The role-boundary tests
                            prove the database refuses writes for it. Without it
                            they are reported as skipped (NOT RUN), never as passed.

Concurrency: Community Edition has one user database, so every label and
relationship type these tests create carries a per-run namespace
(``Gx<run id>`` / ``GX<run id>_``; set RR_TEST_RUN_ID to fix it). The tests
are written with plain ``Gx``/``GX_`` names; the node's tools are wrapped to
namespace their input and un-namespace their output, and every before/after
state check counts only this run's labels and types, so two runs against one
server cannot see or disturb each other.

Skips when the server is unreachable unless RR_REQUIRE_DB_TESTS is set.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types
import uuid

from pathlib import Path

import pytest

_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))
for _name in [n for n in sys.modules if n.split('.')[0] == 'neo4j']:
    if not getattr(sys.modules[_name], '__file__', None):
        del sys.modules[_name]
if _REQUIRED:
    import neo4j
else:
    neo4j = pytest.importorskip('neo4j')

_REPO = Path(__file__).resolve().parents[2]
_AI_SRC = _REPO / 'packages' / 'ai' / 'src'
_GRAPH_PKG = _AI_SRC / 'ai' / 'common' / 'graph'
_UTILS_DIR = _AI_SRC / 'ai' / 'common' / 'utils'

RUN_ID = os.environ.get('RR_TEST_RUN_ID') or uuid.uuid4().hex[:8]
NS_LABEL, NS_REL = f'Gx{RUN_ID}', f'GX{RUN_ID}_'


def ns(value):
    """Plain test names (Gx..., GX_...) -> this run's namespace, recursively."""
    if isinstance(value, str):
        return value.replace('GX_', NS_REL).replace('Gx', NS_LABEL)
    if isinstance(value, dict):
        return {k: ns(v) for k, v in value.items()}
    if isinstance(value, list):
        return [ns(v) for v in value]
    return value


def un_ns(value):
    """This run's namespace -> plain test names, recursively (other runs' names untouched)."""
    if isinstance(value, str):
        return value.replace(NS_REL, 'GX_').replace(NS_LABEL, 'Gx')
    if isinstance(value, dict):
        return {un_ns(k): un_ns(v) for k, v in value.items()}
    if isinstance(value, list):
        return [un_ns(v) for v in value]
    return value


class _NamespacedTools:
    """The node instance, with tool input namespaced and output un-namespaced."""

    TOOLS = ('read_query', 'execute', 'get_schema', 'refresh_schema', 'dialect')

    def __init__(self, inst):
        self._inst = inst

    def __getattr__(self, name):
        attr = getattr(self._inst, name)
        if name not in self.TOOLS:
            return attr
        return lambda args: un_ns(attr(ns(args)))


URI = os.environ.get('RR_TEST_NEO4J_URI', 'bolt://127.0.0.1:57687')
USER = os.environ.get('RR_TEST_NEO4J_USER', 'neo4j')
PASSWORD = os.environ.get('RR_TEST_NEO4J_PASSWORD', 'gxlocal-test-pass')


def _reachable() -> bool:
    try:
        with neo4j.GraphDatabase.driver(URI, auth=(USER, PASSWORD), connection_timeout=3) as d:
            d.verify_connectivity()
        return True
    except Exception:
        return False


_REACHABLE = _reachable()
if _REQUIRED and not _REACHABLE:
    pytest.fail(f'RR_REQUIRE_DB_TESTS is set but Neo4j is not reachable at {URI}', pytrace=False)
pytestmark = pytest.mark.skipif(not _REACHABLE, reason=f'Neo4j test server not reachable at {URI}')


# ---------------------------------------------------------------------------
# Loading a graph node with the real base and driver (shared with the
# FalkorDB live suite)
# ---------------------------------------------------------------------------


def _load_from_path(name: str, path: Path, *, is_package: bool = False):
    search = [str(path.parent)] if is_package else None
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=search)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def load_graph_node(monkeypatch, node: str):
    """Stub the engine surface, load the real graph package and ``nodes/<node>``.

    Returns a namespace with the IGlobal/IInstance classes and a list that
    collects warning() calls.
    """
    warnings: list = []
    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = warnings.append
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG='config', RUN='run')
    rocketlib_types = types.ModuleType('rocketlib.types')
    rocketlib_types.IInvokeLLM = types.SimpleNamespace(Ask=lambda **kw: kw)
    rocketlib.types = rocketlib_types
    monkeypatch.setitem(sys.modules, 'rocketlib', rocketlib)
    monkeypatch.setitem(sys.modules, 'rocketlib.types', rocketlib_types)

    ai_pkg = types.ModuleType('ai')
    ai_pkg.__path__ = []
    common_pkg = types.ModuleType('ai.common')
    common_pkg.__path__ = [str(_AI_SRC / 'ai' / 'common')]
    schema = types.ModuleType('ai.common.schema')
    schema.Answer = type('Answer', (), {'setAnswer': lambda self, v: setattr(self, 'value', v)})
    schema.Question = type('Question', (), {})
    schema.QuestionType = types.SimpleNamespace(QUESTION=1, DIALECT=2, EXECUTE=3)
    table = types.ModuleType('ai.common.table')
    table.Table = types.SimpleNamespace(generate_markdown_table=lambda data, headers=None: str(data))
    config = types.ModuleType('ai.common.config')
    config.Config = types.SimpleNamespace(getNodeConfig=lambda provider, conn: dict(conn))
    for name, module in (
        ('ai', ai_pkg),
        ('ai.common', common_pkg),
        ('ai.common.schema', schema),
        ('ai.common.table', table),
        ('ai.common.config', config),
    ):
        monkeypatch.setitem(sys.modules, name, module)

    config_utils = _load_from_path('ai.common.config_utils', _UTILS_DIR / 'config_utils.py')
    tool_args = _load_from_path('ai.common.tool_args', _UTILS_DIR / 'tool_args.py')
    utils = types.ModuleType('ai.common.utils')
    utils.parse_bool = config_utils.parse_bool
    utils.config_int = config_utils.config_int
    for fn in ('normalize_tool_input', 'require_str', 'require_dict', 'require_int', 'optional_int', 'optional_str'):
        setattr(utils, fn, getattr(tool_args, fn))
    monkeypatch.setitem(sys.modules, 'ai.common.utils', utils)

    for name in list(sys.modules):
        if name == 'ai.common.graph' or name.startswith(('ai.common.graph.', f'nodes.{node}')):
            monkeypatch.delitem(sys.modules, name)
    graph_pkg = _load_from_path('ai.common.graph', _GRAPH_PKG / '__init__.py', is_package=True)
    monkeypatch.setitem(sys.modules, 'ai.common.graph', graph_pkg)

    node_dir = _REPO / 'nodes' / 'src' / 'nodes' / node
    pkg = types.ModuleType(f'nodes.{node}')
    pkg.__path__ = [str(node_dir)]
    monkeypatch.setitem(sys.modules, f'nodes.{node}', pkg)
    iglobal = _load_from_path(f'nodes.{node}.IGlobal', node_dir / 'IGlobal.py')
    pkg.IGlobal = iglobal
    iinstance = _load_from_path(f'nodes.{node}.IInstance', node_dir / 'IInstance.py')
    errors = sys.modules['ai.common.graph.graph_errors']
    return types.SimpleNamespace(
        iglobal_cls=iglobal.IGlobal,
        iinstance_cls=iinstance.IInstance,
        iglobal_module=iglobal,
        GraphToolError=errors.GraphToolError,
        warnings=warnings,
    )


def start_node(env, logical_type: str, config: dict):
    glb = env.iglobal_cls()
    glb.glb = types.SimpleNamespace(logicalType=logical_type, connConfig=dict(config))
    glb.IEndpoint = types.SimpleNamespace(endpoint=types.SimpleNamespace(openMode='run'))
    glb.beginGlobal()
    inst = env.iinstance_cls()
    inst.IGlobal = glb
    return glb, inst


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

SEED = """
CREATE (a:GxPerson {name: 'Alice', age: 37, big: 9007199254740993, born: date('1989-02-28'),
                    seen: datetime({year: 2026, month: 10, day: 4, hour: 12, timezone: 'Europe/Berlin'}),
                    tenure: duration('P1Y2M3DT4.5S'), home: point({longitude: 13.405, latitude: 52.52}),
                    meta: '{"@kind": "node"}'}),
       (b:GxPerson {name: 'Bob', age: 41}),
       (c:GxCompany {name: 'Acme'}),
       (a)-[:GX_KNOWS {since: 2019}]->(b),
       (a)-[:GX_KNOWS {since: 2021}]->(b),
       (b)-[:GX_KNOWS {since: 2020}]->(a),
       (a)-[:GX_LIKES]->(a),
       (a)-[:GX_WORKS_AT {role: 'eng'}]->(c)
SET a:GxEmployee
"""
CLEANUP = "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Gx') DETACH DELETE n"  # namespaced by ns()


def run_admin(driver, cypher, **params):
    """Fixture-side Cypher (namespaced) on a write session."""
    with driver.session(database='neo4j') as s:
        return s.run(ns(cypher), **params).data()


@pytest.fixture()
def neo_db():
    driver = neo4j.GraphDatabase.driver(URI, auth=(USER, PASSWORD))
    with driver.session(database='neo4j') as s:
        s.run(ns(CLEANUP)).consume()
        s.run(ns(SEED)).consume()
        s.run(ns('CREATE (:GxBlob {b: $b})'), b=bytearray(b'\x00\xffraw')).consume()
    yield driver
    with driver.session(database='neo4j') as s:
        s.run(ns(CLEANUP)).consume()
    driver.close()


@pytest.fixture()
def neo_env(monkeypatch):
    return load_graph_node(monkeypatch, 'graph_neo4j')


def _start(neo_env, **config):
    glb, inst = start_node(
        neo_env,
        'graph_neo4j',
        {'uri': URI, 'user': USER, 'password': PASSWORD, 'database': 'neo4j', **config},
    )
    return glb, _NamespacedTools(inst)


def _count(driver, cypher=None):
    """This run's node count (or a namespaced custom count query)."""
    if cypher is None:
        cypher = "MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Gx') RETURN count(n) AS c"
    return run_admin(driver, cypher)[0]['c']


def _labels(driver):
    """This run's labels and relationship types in the database catalog."""
    with driver.session(database='neo4j') as s:
        labels = [r['label'] for r in s.run('CALL db.labels() YIELD label RETURN label')]
        types_ = [r['t'] for r in s.run('CALL db.relationshipTypes() YIELD relationshipType AS t RETURN t')]
    return sorted(x for x in labels + types_ if x.startswith((NS_LABEL, NS_REL)))


# ~10^10 rows: far beyond any test deadline on every edition and runtime.
SLOW_QUERY = 'UNWIND range(1, 100000) AS a UNWIND range(1, 100000) AS b WITH a, b WHERE (a * b) % 7 = 3 RETURN count(*)'


def _server_identity(driver):
    """(version, edition) as the server reports them."""
    with driver.session(database='neo4j') as s:
        rec = s.run('CALL dbms.components() YIELD versions, edition RETURN versions, edition').single()
    return rec['versions'][0], rec['edition'].lower()


def _port(uri):
    return uri.rsplit(':', 1)[-1]


READONLY_URI = os.environ.get('RR_TEST_NEO4J_READONLY_URI')
READONLY_USER = os.environ.get('RR_TEST_NEO4J_READONLY_USER', '')
READONLY_PASSWORD = os.environ.get('RR_TEST_NEO4J_READONLY_PASSWORD', '')
_NEEDS_ROLE = pytest.mark.skipif(
    not READONLY_URI,
    reason='NOT RUN: needs RR_TEST_NEO4J_READONLY_URI/_USER/_PASSWORD for a read-only database role '
    '(Neo4j Enterprise or Aura); Community has no roles',
)


def _start_reader(neo_env, **config):
    """The node connected as the read-only database user (namespaced tools)."""
    glb, inst = start_node(
        neo_env,
        'graph_neo4j',
        {
            'uri': READONLY_URI,
            'user': READONLY_USER,
            'password': READONLY_PASSWORD,
            'database': 'neo4j',
            **config,
        },
    )
    return glb, _NamespacedTools(inst)


def _state(driver):
    """Everything a refused write could change in this run's namespace, read as the admin user."""
    with driver.session(database='neo4j') as s:
        props = s.run(
            ns("MATCH (n) WHERE any(l IN labels(n) WHERE l STARTS WITH 'Gx') RETURN properties(n) AS p ORDER BY n.name")
        ).data()
        rels = s.run(ns("MATCH ()-[r]->() WHERE type(r) STARTS WITH 'GX_' RETURN count(r) AS c")).single()['c']
    return _count(driver), rels, _labels(driver), [r['p'] for r in props]


class _WriteModeDriver:
    """Driver wrapper whose READ transactions are opened as WRITE transactions.

    Lets a test remove the READ-mode layer, so a refusal can only come from
    the database role.
    """

    def __init__(self, driver):
        self._driver = driver

    def __getattr__(self, name):
        return getattr(self._driver, name)

    def session(self, **kwargs):
        kwargs.pop('default_access_mode', None)
        session = self._driver.session(default_access_mode=neo4j.WRITE_ACCESS, **kwargs)
        session.execute_read = session.execute_write
        return session


def _security_code(exc):
    """The Neo4j error code behind a raised error (directly or as its cause)."""
    while exc is not None:
        code = getattr(exc, 'code', None)
        if code:
            return code
        exc = exc.__cause__
    return None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestReadQueryShape:
    def test_entities_ids_and_stored_direction(self, neo_env, neo_db):
        glb, inst = _start(neo_env)
        try:
            out = inst.read_query(
                {
                    'cypher': "MATCH (a:GxPerson {name: 'Alice'})-[r]->(m) RETURN a, r, m ORDER BY type(r), r.since",
                    'limit': 10,
                }
            )
            assert out['columns'] == ['a', 'r', 'm']
            assert out['truncated'] is False and out['row_limit'] == 10
            alice = out['rows'][0][0]
            assert alice['@kind'] == 'node' and alice['labels'] == ['GxEmployee', 'GxPerson']
            assert isinstance(alice['id'], str) and alice['id'].count(':') == 2  # elementId
            assert alice['properties']['big'] == {'@kind': 'number', 'value': '9007199254740993'}
            assert alice['properties']['born'] == {'@kind': 'temporal', 'type': 'date', 'value': '1989-02-28'}
            assert alice['properties']['seen']['type'] == 'datetime'
            assert alice['properties']['seen']['zone'] == 'Europe/Berlin'
            assert alice['properties']['tenure'] == {'@kind': 'temporal', 'type': 'duration', 'value': 'P1Y2M3DT4.5S'}
            assert alice['properties']['home'] == {'@kind': 'point', 'srid': 4326, 'coordinates': [13.405, 52.52]}
            rels = [row[1] for row in out['rows']]
            assert [r['type'] for r in rels] == ['GX_KNOWS', 'GX_KNOWS', 'GX_LIKES', 'GX_WORKS_AT']
            knows1, knows2, likes = rels[0], rels[1], rels[2]
            assert knows1['id'] != knows2['id']  # parallel relationships stay distinct
            assert knows1['start'] == alice['id'] and knows1['end'] == out['rows'][0][2]['id']
            assert likes['start'] == likes['end'] == alice['id']  # self loop
        finally:
            glb.endGlobal()

    def test_path_keeps_traversal_order_and_stored_direction(self, neo_env, neo_db):
        glb, inst = _start(neo_env)
        try:
            out = inst.read_query(
                {'cypher': "MATCH p = (b:GxPerson {name: 'Bob'})<-[:GX_KNOWS {since: 2019}]-(a) RETURN p"}
            )
            path = out['rows'][0][0]
            assert [n['properties']['name'] for n in path['nodes']] == ['Bob', 'Alice']
            rel = path['relationships'][0]
            assert rel['start'] == path['nodes'][1]['id'] and rel['end'] == path['nodes'][0]['id']
        finally:
            glb.endGlobal()

    def test_element_id_round_trips_as_a_parameter(self, neo_env, neo_db):
        glb, inst = _start(neo_env)
        try:
            alice = inst.read_query({'cypher': "MATCH (a:GxPerson {name: 'Alice'}) RETURN a"})['rows'][0][0]
            out = inst.read_query(
                {'cypher': 'MATCH (n) WHERE elementId(n) = $id RETURN n.name', 'params': {'id': alice['id']}}
            )
            assert out['rows'] == [['Alice']]
        finally:
            glb.endGlobal()

    def test_binary_property_does_not_fail_the_query(self, neo_env, neo_db):
        glb, inst = _start(neo_env)
        try:
            out = inst.read_query({'cypher': 'MATCH (n:GxBlob) RETURN n.b'})
            assert out['rows'] == [[{'@kind': 'bytes', 'size': 5, 'base64': 'AP9yYXc='}]]
        finally:
            glb.endGlobal()

    def test_odd_string_parameters_are_bound_not_spliced(self, neo_env, neo_db):
        glb, inst = _start(neo_env)
        try:
            tricky = 'x\' RETURN 1 // " \\ `'
            out = inst.read_query({'cypher': 'RETURN $s AS s, $n AS n', 'params': {'s': tricky, 'n': None}})
            assert out['rows'] == [[tricky, None]]
        finally:
            glb.endGlobal()


WRITES = [
    "CREATE (:GxEvil {name: 'x'})",
    "MERGE (:GxEvil {name: 'x'})",
    "MATCH (a:GxPerson {name: 'Alice'}) SET a:GxEvil",
    "MATCH (a:GxPerson {name: 'Bob'}) DETACH DELETE a",
    "CALL db.createLabel('GxEvilLabel')",
    "CALL `db`.`createLabel`('GxEvilLabel')",
    'MATCH (a:GxPerson) CALL { WITH a CREATE (:GxEvil) } RETURN count(*)',
    'FOREACH (x IN [1] | CREATE (:GxEvil))',
    "CALL apoc.create.node(['GxEvil'], {})",
]


class TestReadOnlyInvariant:
    @pytest.mark.parametrize('allow_execute', [False, True])
    @pytest.mark.parametrize('statement', WRITES)
    def test_writes_refused_with_state_unchanged(self, neo_env, neo_db, allow_execute, statement):
        glb, inst = _start(neo_env, allow_execute=allow_execute)
        try:
            before = (_count(neo_db), _labels(neo_db))
            with pytest.raises(neo_env.GraphToolError) as err:
                inst.read_query({'cypher': statement})
            assert str(err.value).startswith('Refused: ')
            assert (_count(neo_db), _labels(neo_db)) == before
        finally:
            glb.endGlobal()

    def test_read_session_refuses_writes_even_without_the_lexical_check(self, neo_env, neo_db, monkeypatch):
        # Defence in depth, layer 2: with the token check disabled, the
        # READ-mode transaction still refuses (single instance, 5.x). This is
        # not the security boundary; the database role is.
        monkeypatch.setattr(neo_env.iglobal_module, 'check_read_only_cypher', lambda *a, **kw: None)
        glb, inst = _start(neo_env, allow_execute=True)
        try:
            before = (_count(neo_db), _labels(neo_db))
            for statement in ("CREATE (:GxEvil {name: 'x'})", "CALL db.createLabel('GxEvilLabel')"):
                with pytest.raises(neo_env.GraphToolError) as err:
                    inst.read_query({'cypher': statement})
                assert str(err.value).startswith('Refused: the database refused a write')
                assert 'read access mode' in str(err.value)
            assert (_count(neo_db), _labels(neo_db)) == before
        finally:
            glb.endGlobal()

    def test_allowlisted_procedures_run(self, neo_env, neo_db):
        glb, inst = _start(neo_env)
        try:
            out = inst.read_query({'cypher': 'CALL `db`.`labels`() YIELD label RETURN label ORDER BY label'})
            assert ['GxPerson'] in out['rows']
            # Case variants pass the allowlist (it compares case-insensitively)
            # but Neo4j procedure names are case-sensitive, so they cannot reach
            # any other procedure: the server just reports it unknown.
            with pytest.raises(neo_env.GraphToolError, match='no procedure with the name'):
                inst.read_query({'cypher': 'CALL DB.LABELS()'})
        finally:
            glb.endGlobal()


@_NEEDS_ROLE
class TestDatabaseRoleBoundary:
    """With a read-only DATABASE ROLE, the database itself refuses every write.

    These prove the boundary the README names; the node's own checks and the
    READ-mode session are removed one at a time to show the role holds alone.
    """

    WRITES = [
        "CREATE (:GxRoleEvil {name: 'x'})",
        "MERGE (:GxPerson {name: 'Mallory'})",
        "MATCH (a:GxPerson {name: 'Alice'}) SET a.age = 99",
        "MATCH (a:GxPerson {name: 'Bob'}) DETACH DELETE a",
        "MATCH (a:GxPerson {name: 'Alice'}) REMOVE a.age",
        "MATCH (a:GxPerson {name: 'Alice'}), (b:GxPerson {name: 'Bob'}) CREATE (a)-[:GX_KNOWS]->(b)",
    ]

    def test_reads_work_for_the_read_only_user(self, neo_env, neo_db):
        glb, inst = _start_reader(neo_env)
        try:
            out = inst.read_query({'cypher': "MATCH (a:GxPerson {name: 'Alice'})-[r]->(m) RETURN a, r, m"})
            assert len(out['rows']) == 4 and out['rows'][0][0]['labels'] == ['GxEmployee', 'GxPerson']
            assert 'GxPerson' in inst.refresh_schema({})['labels']
        finally:
            glb.endGlobal()

    @pytest.mark.parametrize('shape', ['legacy', 'graph'])
    @pytest.mark.parametrize('statement', WRITES)
    def test_execute_writes_are_refused_by_the_database(self, neo_env, neo_db, shape, statement):
        # execute has no token check and uses a WRITE session: only the role stops it.
        glb, inst = _start_reader(neo_env, allow_execute=True)
        try:
            before = _state(neo_db)
            with pytest.raises(Exception) as err:
                inst.execute({'query': statement, 'shape': shape})
            assert _security_code(err.value) == 'Neo.ClientError.Security.Forbidden'
            assert 'is not allowed for user' in str(err.value)
            if shape == 'graph':
                assert str(err.value).startswith('Refused: the database user may not run this statement')
            assert _state(neo_db) == before
        finally:
            glb.endGlobal()

    def test_procedure_write_is_refused_by_the_role(self, neo_env, neo_db):
        glb, inst = _start_reader(neo_env, allow_execute=True)
        try:
            before = _state(neo_db)
            with pytest.raises(Exception) as err:
                inst.execute({'query': "CALL db.createLabel('GxRoleEvil')"})
            assert _security_code(err.value) == 'Neo.ClientError.Security.Forbidden'
            assert _state(neo_db) == before
            assert ns('GxRoleEvil') not in _labels(neo_db)
        finally:
            glb.endGlobal()

    @pytest.mark.parametrize('statement', WRITES + ["CALL db.createLabel('GxRoleEvil')"])
    def test_read_query_with_the_node_checks_removed_is_still_refused(self, neo_env, neo_db, monkeypatch, statement):
        monkeypatch.setattr(neo_env.iglobal_module, 'check_read_only_cypher', lambda *a, **kw: None)
        glb, inst = _start_reader(neo_env)
        try:
            # Layer removed: the token check. The READ session and the role remain.
            before = _state(neo_db)
            with pytest.raises(neo_env.GraphToolError) as err:
                inst.read_query({'cypher': statement})
            assert str(err.value).startswith('Refused: ')
            assert _state(neo_db) == before
            # Layer removed: READ mode too. Only the database role remains.
            glb.driver = _WriteModeDriver(glb.driver)
            with pytest.raises(neo_env.GraphToolError) as err:
                inst.read_query({'cypher': statement})
            assert _security_code(err.value) == 'Neo.ClientError.Security.Forbidden'
            assert str(err.value).startswith('Refused: the database user may not run this statement')
            assert _state(neo_db) == before
        finally:
            glb.endGlobal()

    def test_dialect_reports_a_verified_role_boundary_only_for_the_reader(self, neo_env, neo_db):
        reader_glb, reader = _start_reader(neo_env)
        admin_glb, admin = _start(neo_env)
        try:
            out = reader.dialect({})
            assert out['engine']['edition'] == 'enterprise'
            assert out['read_boundary'] == 'database_role' and out['read_boundary_verified'] is True
            assert READONLY_PASSWORD not in str(out)
            admin_out = admin.dialect({})
            assert admin_out['read_boundary'] == 'read_session' and admin_out['read_boundary_verified'] is False
        finally:
            reader_glb.endGlobal()
            admin_glb.endGlobal()


class TestLimitsAndBudgets:
    def test_exact_limit_and_truncation(self, neo_env, neo_db):
        glb, inst = _start(neo_env)
        try:
            q = 'MATCH (p:GxPerson) RETURN p.name ORDER BY p.name'
            exact = inst.read_query({'cypher': q, 'limit': 2})
            assert exact['rows'] == [['Alice'], ['Bob']] and exact['truncated'] is False
            cut = inst.read_query({'cypher': q, 'limit': 1})
            assert cut['rows'] == [['Alice']] and cut['truncated'] is True and cut['truncated_by'] == 'rows'
        finally:
            glb.endGlobal()

    def test_collect_is_bounded_by_the_element_budget(self, neo_env, neo_db):
        run_admin(neo_db, 'UNWIND range(1, 10050) AS i CREATE (:GxBulk {i: i})')
        glb, inst = _start(neo_env)
        try:
            with pytest.raises(neo_env.GraphToolError, match='first row holds more than 10,000 graph elements'):
                inst.read_query({'cypher': 'MATCH (n:GxBulk) RETURN collect(n)'})
            out = inst.read_query(
                {
                    'cypher': 'UNWIND [0, 1] AS k MATCH (n:GxBulk) WITH k, collect(n)[0..6000] AS c RETURN k, c ORDER BY k'
                }
            )
            assert len(out['rows']) == 1 and out['truncated_by'] == 'elements' and out['elements'] == 6000
        finally:
            glb.endGlobal()

    def test_server_deadline(self, neo_env, neo_db, monkeypatch):
        monkeypatch.setattr(neo_env.iglobal_cls, 'QUERY_TIMEOUT', 0.5)
        glb, inst = _start(neo_env)
        try:
            with pytest.raises(neo_env.GraphToolError) as err:
                inst.read_query({'cypher': SLOW_QUERY, 'limit': 1})
            assert str(err.value).startswith('Query timed out after 500 ms')
        finally:
            glb.endGlobal()


class TestExecuteGraphShape:
    def test_graph_shape_write_when_allowed(self, neo_env, neo_db):
        glb, inst = _start(neo_env, allow_execute=True)
        try:
            out = inst.execute({'query': "CREATE (n:GxNew {name: 'n1'}) RETURN n", 'shape': 'graph'})
            assert out['rows'][0][0]['labels'] == ['GxNew'] and out['affected_rows'] >= 2
            assert _count(neo_db, 'MATCH (n:GxNew) RETURN count(n) AS c') == 1
            legacy = inst.execute({'query': 'MATCH (n:GxNew) RETURN n.name AS name'})
            assert legacy == {'rows': [{'name': 'n1'}], 'affected_rows': 0}
        finally:
            glb.endGlobal()

    def test_graph_shape_binds_params(self, neo_env, neo_db):
        glb, inst = _start(neo_env, allow_execute=True)
        try:
            out = inst.execute(
                {
                    'query': 'UNWIND $rows AS r CREATE (n:GxNew {name: r.name}) RETURN n.name AS name',
                    'params': {'rows': [{'name': 'p1'}, {'name': "p'2"}]},
                    'shape': 'graph',
                }
            )
            assert out['columns'] == ['name'] and out['rows'] == [['p1'], ["p'2"]]
            assert _count(neo_db, 'MATCH (n:GxNew) RETURN count(n) AS c') == 2
        finally:
            glb.endGlobal()

    def test_refused_when_execute_is_off(self, neo_env, neo_db):
        glb, inst = _start(neo_env, allow_execute=False)
        try:
            before = _count(neo_db)
            with pytest.raises(ValueError, match='execute tool is disabled'):
                inst.execute({'query': "CREATE (:GxNew {name: 'n2'})", 'shape': 'graph'})
            assert _count(neo_db) == before
        finally:
            glb.endGlobal()


class TestSchemaAndDialect:
    def test_refresh_reflects_raw_labels_types_endpoints_and_counts(self, neo_env, neo_db):
        run_admin(neo_db, "CREATE (:`Gx Odd``Label` {v: 'x'}), (:GxPerson {name: 'Carol', age: 'unknown'})")
        glb, inst = _start(neo_env)
        try:
            out = inst.refresh_schema({})
            block = out['schema']
            labels = {label['name']: label for label in block['labels']}
            assert 'Gx Odd`Label' in labels  # raw name, not a back-quoted display string
            person = labels['GxPerson']
            assert person['count'] == 3 and person['count_estimated'] is False
            types = {p['name']: p['types'] for p in person['properties']}
            assert types['age'] == ['string', 'integer']  # every observed type kept
            assert types['born'] == ['temporal'] and types['home'] == ['point']
            rels = {r['type']: r for r in block['relationship_types']}
            knows = rels['GX_KNOWS']
            assert knows['count'] == 3 and {'name': 'since', 'types': ['integer']} in knows['properties']
            pairs = {(e['start'], e['end']) for e in knows['endpoints']}
            assert ('GxPerson', 'GxPerson') in pairs and ('GxEmployee', 'GxPerson') in pairs
            assert all(e['observed'] for e in knows['endpoints'])
            assert block['sampled'] is True and block['stale'] is False and block['error'] is None
        finally:
            glb.endGlobal()

    def test_label_filter_matches_raw_label_names(self, neo_env, neo_db):
        # Regression: labels used to be stored back-quoted (":`GxPerson`"), so
        # get_schema(label='GxPerson') answered "not found".
        glb, inst = _start(neo_env)
        try:
            out = inst.get_schema({'label': 'GxPerson'})
            assert out['labels'] == ['GxPerson'] and 'error' not in out
            assert any(r['type'] == 'GX_KNOWS' for r in out['relationships'])
        finally:
            glb.endGlobal()

    def test_refresh_shows_a_change_made_by_execute(self, neo_env, neo_db):
        glb, inst = _start(neo_env, allow_execute=True)
        try:
            assert 'GxLater' not in inst.get_schema({})['labels']
            inst.execute({'query': "CREATE (:GxLater {k: 1})-[:GX_LATER_REL]->(:GxPerson {name: 'z'})"})
            assert 'GxLater' not in inst.get_schema({})['labels']  # snapshot until refreshed
            out = inst.refresh_schema({})
            assert 'GxLater' in out['labels']
            assert any(r['type'] == 'GX_LATER_REL' for r in out['schema']['relationship_types'])
        finally:
            glb.endGlobal()

    def test_failed_refresh_keeps_the_last_good_schema(self, neo_env, neo_db, monkeypatch):
        glb, inst = _start(neo_env)
        try:
            good = inst.get_schema({})['schema']
            monkeypatch.setattr(
                glb, '_reflect_schema_v2', lambda builder, deadline: (_ for _ in ()).throw(TimeoutError('slow'))
            )
            stale = inst.refresh_schema({})['schema']
            assert stale['stale'] is True and 'slow' in stale['error']
            assert stale['labels'] == good['labels'] and stale['refreshed_at'] == good['refreshed_at']
        finally:
            glb.endGlobal()

    def test_dialect_identity_without_credentials(self, neo_env, neo_db):
        glb, inst = _start(neo_env, allow_execute=True)
        try:
            out = inst.dialect({})
            assert out['dialect'] == 'neo4j' and out['database'] == 'neo4j' and out['allow_execute'] is True
            version, edition = _server_identity(neo_db)
            assert out['engine'] == {'name': 'Neo4j', 'version': version, 'edition': edition}
            assert version.startswith('5.') and edition in ('community', 'enterprise')
            # The suite's main identity can write (it seeds the fixtures), so it is
            # never a verified read-only boundary, on either edition.
            assert out['read_boundary'] == 'read_session' and out['read_boundary_verified'] is False
            assert out['limits']['statement_timeout_ms'] == 30000 and out['capabilities']['read_query'] is True
            text = str(out)
            assert PASSWORD not in text
            assert _port(URI) not in text and 'bolt' not in text and 'neo4j://' not in text
        finally:
            glb.endGlobal()

    def test_prompt_names_the_engine_and_its_rules(self, neo_env, neo_db):
        glb, _inst = _start(neo_env)
        try:
            rules = ' '.join(glb._prompt_rules())
            assert 'Neo4j 5.' in rules and 'elementId' in rules and 'db.labels()' in rules
        finally:
            glb.endGlobal()


def test_role_check_requires_only_read_privileges(neo_env):
    role_is_read_only = neo_env.iglobal_module.role_is_read_only
    reader = [
        {'access': 'GRANTED', 'action': 'access'},
        {'access': 'GRANTED', 'action': 'traverse'},
        {'access': 'GRANTED', 'action': 'read'},
        {'access': 'GRANTED', 'action': 'execute'},
        {'access': 'DENIED', 'action': 'write'},
    ]
    assert role_is_read_only(reader) is True
    # PUBLIC grants LOAD by default; LOAD CSV reads external files but never writes the graph.
    assert role_is_read_only(reader + [{'access': 'GRANTED', 'action': 'load'}]) is True
    assert role_is_read_only(reader + [{'access': 'GRANTED', 'action': 'write'}]) is False
    assert role_is_read_only(reader + [{'access': 'GRANTED', 'action': 'execute_boosted'}]) is False
    assert role_is_read_only(reader + [{'access': 'GRANTED', 'action': 'some_future_privilege'}]) is False
    assert role_is_read_only([]) is False
