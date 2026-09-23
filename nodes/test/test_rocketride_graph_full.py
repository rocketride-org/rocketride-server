# =============================================================================
# RocketRide Engine
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

"""Integration tests for rocketride_graph against a real Postgres + Apache AGE.

Runs the node end-to-end on the live pin (PG16 + AGE 1.5.0) through the real
seam (env ``ROCKETRIDE_CLIENT_ID`` + a fake, injectable
``Account.resolve_db_dsn``). Container:

    docker run -d --name rr-pg-phase2 -p 55433:5432 \
        -e POSTGRES_PASSWORD=rrpass -e POSTGRES_USER=rruser -e POSTGRES_DB=rrtenant \
        rr-age-pin:pg16-age1.5.0-pgvector0.8.0
    # image: apache/age:release_PG16_1.5.0 + pgvector v0.8.0 (see the layer README)

Configuration via environment variables:
    RR_TEST_AGE_DSN — libpq URL of the AGE test database
                      (default: postgresql://rruser:rrpass@localhost:55433/rrtenant)

Skips cleanly when the database is unreachable.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types

from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_AI_SRC = _REPO / 'packages' / 'ai' / 'src'
_GRAPH_PKG = _AI_SRC / 'ai' / 'common' / 'graph'
_UTILS_DIR = _AI_SRC / 'ai' / 'common' / 'utils'
_RRDB_PATH = _AI_SRC / 'ai' / 'common' / 'rocketride_db.py'
_NODE_DIR = _REPO / 'nodes' / 'src' / 'nodes' / 'rocketride_graph'

TEST_DSN = os.environ.get('RR_TEST_AGE_DSN', 'postgresql://rruser:rrpass@localhost:55433/rrtenant')
TEST_CLIENT_ID = 'tenant-graph-test'
GRAPH = 'rr_graph_e2e'

# RR_REQUIRE_DB_TESTS (set by CI once its DB containers are healthy) turns
# every skip in this module into a hard failure: a broken container or missing
# dependency must never let the safety-control tests silently go green.
_DB_TESTS_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))

if _DB_TESTS_REQUIRED:
    import antlr4  # noqa: F401
    import psycopg2
else:
    psycopg2 = pytest.importorskip('psycopg2')
    pytest.importorskip('antlr4')


def _db_reachable() -> bool:
    try:
        conn = psycopg2.connect(TEST_DSN, connect_timeout=3)
        conn.close()
        return True
    except Exception:
        return False


if _DB_TESTS_REQUIRED and not _db_reachable():
    pytest.fail(f'RR_REQUIRE_DB_TESTS is set but the AGE test database is not reachable at {TEST_DSN}', pytrace=False)

pytestmark = pytest.mark.skipif(not _db_reachable(), reason=f'RocketRide AGE test database not reachable at {TEST_DSN}')


def _load_from_path(name: str, path: Path, *, is_package: bool = False):
    search = [str(path.parent)] if is_package else None
    spec = importlib.util.spec_from_file_location(name, path, submodule_search_locations=search)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def rr_env(monkeypatch):
    """Stub the engine surface, load real graph base + age layer + node."""
    warnings: list[str] = []

    depends_mod = types.ModuleType('depends')
    depends_mod.depends = lambda *a, **kw: None
    monkeypatch.setitem(sys.modules, 'depends', depends_mod)

    rocketlib = types.ModuleType('rocketlib')
    rocketlib.IGlobalBase = type('IGlobalBase', (), {})
    rocketlib.IInstanceBase = type('IInstanceBase', (), {})
    rocketlib.tool_function = lambda **kwargs: lambda f: f
    rocketlib.debug = lambda *a, **kw: None
    rocketlib.error = lambda *a, **kw: None
    rocketlib.warning = warnings.append
    rocketlib.OPEN_MODE = types.SimpleNamespace(CONFIG=object())
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
    table.Table = types.SimpleNamespace(
        generate_markdown_table=lambda data, headers=None: '\n'.join(' | '.join(map(str, r)) for r in data)
    )

    config = types.ModuleType('ai.common.config')
    config.Config = types.SimpleNamespace(getNodeConfig=lambda provider, connConfig: dict(connConfig))

    monkeypatch.setitem(sys.modules, 'ai', ai_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common', common_pkg)
    monkeypatch.setitem(sys.modules, 'ai.common.schema', schema)
    monkeypatch.setitem(sys.modules, 'ai.common.table', table)
    monkeypatch.setitem(sys.modules, 'ai.common.config', config)

    config_utils = _load_from_path('ai.common.config_utils', _UTILS_DIR / 'config_utils.py')
    tool_args = _load_from_path('ai.common.tool_args', _UTILS_DIR / 'tool_args.py')
    utils = types.ModuleType('ai.common.utils')
    utils.parse_bool = config_utils.parse_bool
    utils.config_int = config_utils.config_int
    for fn in ('normalize_tool_input', 'require_str', 'require_dict', 'require_int', 'optional_int', 'optional_str'):
        setattr(utils, fn, getattr(tool_args, fn))
    monkeypatch.setitem(sys.modules, 'ai.common.utils', utils)

    rrdb_mod = _load_from_path('ai.common.rocketride_db', _RRDB_PATH)
    monkeypatch.setitem(sys.modules, 'ai.common.rocketride_db', rrdb_mod)

    # Real graph base package (brings ai.common.graph.age with it).
    graph_pkg = _load_from_path('ai.common.graph', _GRAPH_PKG / '__init__.py', is_package=True)
    monkeypatch.setitem(sys.modules, 'ai.common.graph', graph_pkg)

    # The injectable fake resolver — the same seam a SaaS build fills in.
    account_mod = types.ModuleType('ai.account')

    async def fake_resolve_db_dsn(client_id):
        assert client_id == TEST_CLIENT_ID
        return TEST_DSN

    account_mod.account = types.SimpleNamespace(resolve_db_dsn=fake_resolve_db_dsn)
    monkeypatch.setitem(sys.modules, 'ai.account', account_mod)
    monkeypatch.setenv('ROCKETRIDE_CLIENT_ID', TEST_CLIENT_ID)
    monkeypatch.delenv('ROCKETRIDE_DB_DSN', raising=False)

    iglobal = _load_from_path('nodes.rocketride_graph.IGlobal', _NODE_DIR / 'IGlobal.py')
    pkg = types.ModuleType('nodes.rocketride_graph')
    pkg.__path__ = [str(_NODE_DIR)]
    pkg.IGlobal = iglobal
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_graph', pkg)
    monkeypatch.setitem(sys.modules, 'nodes.rocketride_graph.IGlobal', iglobal)
    iinstance = _load_from_path('nodes.rocketride_graph.IInstance', _NODE_DIR / 'IInstance.py')

    return types.SimpleNamespace(iglobal_cls=iglobal.IGlobal, iinstance_cls=iinstance.IInstance, warnings=warnings)


@pytest.fixture()
def age_graph(rr_env):
    """Provision + seed the test graph out-of-band (provisioning is not the
    node's job while create_graph ownership is open).
    """
    conn = psycopg2.connect(TEST_DSN)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute('SET search_path = ag_catalog, "$user", public')
        cur.execute('SELECT 1 FROM ag_graph WHERE name = %s', (GRAPH,))
        if cur.fetchone():
            cur.execute('SELECT drop_graph(%s, true)', (GRAPH,))
        cur.execute('SELECT create_graph(%s)', (GRAPH,))
        cur.execute(
            f"SELECT * FROM cypher('{GRAPH}', $$ "
            "CREATE (a:Person {name:'alice', age: 30})-[:KNOWS {since: 2019}]->(b:Person {name:'bob', age: 25}), "
            "(b)-[:KNOWS {since: 2021}]->(c:Person {name:'carol', age: 41}), "
            "(a)-[:WORKS_AT]->(x:Company {name:'RocketRide'}) "
            '$$) AS (v agtype)'
        )
    yield conn
    with conn.cursor() as cur:
        cur.execute('SET search_path = ag_catalog, "$user", public')
        cur.execute('SELECT drop_graph(%s, true)', (GRAPH,))
    conn.close()


def _begin(rr_env, config=None):
    glb = rr_env.iglobal_cls()
    merged = {'graph': GRAPH, **(config or {})}
    glb.glb = types.SimpleNamespace(logicalType='rocketride_graph', connConfig=merged)
    glb.beginGlobal()
    return glb


class TestLifecycle:
    def test_begin_global_connects_and_reflects(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            assert glb.age_version == '1.5.0'
            assert glb.graph_name == GRAPH
            assert set(glb.graph_schema['nodes']) == {'Person', 'Company'}
            props = dict(glb.graph_schema['nodes']['Person'])
            assert props.get('name') == 'str'
            assert props.get('age') == 'int'
            rel_types = {r['type'] for r in glb.graph_schema['relationships']}
            assert rel_types == {'KNOWS', 'WORKS_AT'}
            knows = next(r for r in glb.graph_schema['relationships'] if r['type'] == 'KNOWS')
            assert knows['start'] == 'Person' and knows['end'] == 'Person'
        finally:
            glb.endGlobal()

    def test_missing_graph_fails_fast(self, rr_env, age_graph):
        glb = rr_env.iglobal_cls()
        glb.glb = types.SimpleNamespace(logicalType='rocketride_graph', connConfig={'graph': 'rr_graph_missing'})
        with pytest.raises(RuntimeError, match='does not exist'):
            glb.beginGlobal()


class TestSafePath:
    def test_read_query_decodes_rows(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            rows = glb._run_query(
                'MATCH (a:Person)-[r:KNOWS]->(b:Person) RETURN a.name AS who, r.since AS since, b ORDER BY r.since'
            )
            assert [r['who'] for r in rows] == ['alice', 'bob']
            assert rows[0]['since'] == 2019
            assert rows[0]['b']['label'] == 'Person'
            assert rows[0]['b']['properties']['name'] == 'bob'
        finally:
            glb.endGlobal()

    def test_params_round_trip(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            rows = glb._run_query('MATCH (p:Person) WHERE p.name = $who RETURN p.age AS age', params={'who': 'carol'})
            assert rows == [{'age': 41}]
        finally:
            glb.endGlobal()

    def test_limit_contract_returns_at_most_limit_plus_one(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            rows = glb._run_query('MATCH (p:Person) RETURN p.name AS name', limit=1)
            assert len(rows) == 2  # limit + 1 => the base detects truncation
        finally:
            glb.endGlobal()

    def test_read_only_transaction_enforced_at_database(self, rr_env, age_graph):
        """Read back SHOW transaction_read_only inside a safe plan: it must be
        'on'. Outside a transaction both SET TRANSACTION READ ONLY and SET
        LOCAL are silent no-ops, so this pins the precondition (autocommit
        off -> implicit transaction) that the write protection and the
        statement_timeout cap both hang on.
        """
        age = sys.modules['ai.common.graph.age']
        glb = _begin(rr_env)
        try:
            assert glb.client.autocommit is False
            plan = age.TranslatedQuery(columns=['ro'], has_return=True)
            plan.statements.append('SHOW transaction_read_only')
            plan.binds.append(())
            plan.result_index = 0
            plan.read_only = True
            rows = glb._execute_plan(plan, fetch_cap=1)
            assert rows and rows[0][0] == 'on'
        finally:
            glb.endGlobal()

    def test_write_rejected_before_reaching_db(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            with pytest.raises(Exception, match='write_clause'):
                glb._run_query("CREATE (n:Person {name: 'evil'})")
        finally:
            glb.endGlobal()

    def test_unsupported_datetime_rejected(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            with pytest.raises(Exception, match='datetime'):
                glb._run_query('MATCH (n) RETURN datetime()')
        finally:
            glb.endGlobal()


class TestExecutePath:
    def test_execute_gated_by_allow_execute(self, rr_env, age_graph):
        glb = _begin(rr_env, {'allow_execute': False})
        inst = rr_env.iinstance_cls()
        inst.IGlobal = glb
        try:
            with pytest.raises(ValueError, match='execute tool is disabled'):
                inst.execute({'query': 'MATCH (n) RETURN n.name'})
        finally:
            glb.endGlobal()

    def test_execute_write_and_read_back(self, rr_env, age_graph):
        glb = _begin(rr_env, {'allow_execute': True})
        inst = rr_env.iinstance_cls()
        inst.IGlobal = glb
        try:
            written = inst.execute({'query': "CREATE (d:Person {name: 'dave', age: 8}) RETURN d.name AS name"})
            assert written['rows'] == [{'name': 'dave'}]
            back = glb._run_query('MATCH (p:Person) WHERE p.name = $n RETURN p.age AS age', params={'n': 'dave'})
            assert back == [{'age': 8}]
        finally:
            glb.endGlobal()

    def test_execute_still_enforces_resource_caps(self, rr_env, age_graph):
        glb = _begin(rr_env, {'allow_execute': True})
        inst = rr_env.iinstance_cls()
        inst.IGlobal = glb
        try:
            with pytest.raises(Exception, match='unbounded_var_length'):
                inst.execute({'query': 'MATCH (a)-[*]->(b) RETURN a'})
        finally:
            glb.endGlobal()


class TestValidateQuery:
    def test_valid_query_passes(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            ok, err = glb._validate_query('MATCH (p:Person) RETURN p.name')
            assert ok, err
        finally:
            glb.endGlobal()

    def test_syntax_error_reported_for_repair_loop(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            ok, err = glb._validate_query('MATCHX (p RETURN p')
            assert not ok
            assert 'syntax error' in err
        finally:
            glb.endGlobal()

    def test_firewall_rejection_reported(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            ok, err = glb._validate_query('MATCH (a)-[*]->(b) RETURN a')
            assert not ok
            assert 'unbounded_var_length' in err
        finally:
            glb.endGlobal()

    def test_validate_does_not_execute(self, rr_env, age_graph):
        glb = _begin(rr_env)
        try:
            before = glb._run_query('MATCH (p:Person) RETURN count(p) AS n')[0]['n']
            # EXPLAIN of a read; graph must be unchanged afterwards.
            ok, _ = glb._validate_query('MATCH (p:Person) RETURN p.name')
            assert ok
            after = glb._run_query('MATCH (p:Person) RETURN count(p) AS n')[0]['n']
            assert before == after
        finally:
            glb.endGlobal()


class TestInstanceTools:
    def test_dialect_and_schema_tools(self, rr_env, age_graph):
        glb = _begin(rr_env)
        inst = rr_env.iinstance_cls()
        inst.IGlobal = glb
        try:
            assert inst.dialect({}) == {'dialect': 'age'}
            schema = inst.get_schema({})
            assert 'Person' in schema['labels']
        finally:
            glb.endGlobal()
