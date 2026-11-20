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

"""The shipped Graph Explorer templates, started in a real engine and called through the SDK.

The other graph suites load the node classes directly and stub the engine
surface (``rocketlib.tool_function`` becomes a no-op), so none of them shows
that the engine registers and dispatches the graph tools, or that the
templates in ``apps/graph-ui/templates`` start. This suite does, unmocked:

1. It starts the engine (``dist/server/engine ai/eaas.py``) without
   ``ROCKETRIDE_MOCK``, with its own API key and store, and with a stand-in
   for the cloud database broker: an HTTP server in this process that answers
   ``/provision`` with the AGE test database's DSN for one per-run token. The
   ``rocketride_graph`` template therefore gets its database the way it does
   on a hosted engine (the task engine resolves the tenant's DSN at task
   start); no secret is needed.
2. For each template it keeps the template's pipeline and node configuration
   and changes only what points at a server: the connection settings (Neo4j's
   uri, user and password; FalkorDB's host and port) and the graph namespace
   (the AGE and FalkorDB graph name, a per-run name). It starts the template
   with the Python SDK, finds the run with ``get_tasks`` as the explorer does,
   and calls the graph tools by name through ``client.tool``: dialect,
   get_schema, refresh_schema, read_query, and execute with a write, which the
   template (allow_execute off) must refuse with the data unchanged.
3. A per-run random value is written to each database by an independent admin
   connection and must come back through read_query, and the engine version
   that dialect reports must equal the server's own: only the real driver
   talking to the real server can produce either.

Services (the names CI exports; the defaults are the local containers):

    RR_TEST_AGE_DSN, RR_TEST_AGE_ADMIN_DSN   rocketride_graph (age.pipe)
    RR_TEST_NEO4J_URI, _USER, _PASSWORD      graph_neo4j (neo4j.pipe)
    RR_TEST_FALKORDB_URL                     graph_falkordb (falkordb.pipe)

CI provides all three, so no template is skipped there. A template whose graph
provider has no entry in ``SERVICES`` fails: add its service here, or, if CI
cannot provide it, a skip whose reason starts with "NOT RUN:" and names it.

Optional: ``RR_TEST_TOOLPATH_GRAPH`` fixes the AGE/FalkorDB graph name
(default ``rr_toolpath_<random>``; Neo4j nodes carry a per-run label instead)
and ``RR_TEST_TOOLPATH_ENGINE_PORT`` the engine's port (default: a free one).

A service that is unreachable skips its template unless ``RR_REQUIRE_DB_TESTS``
is set (CI), which turns it into a failure.
"""

from __future__ import annotations

import asyncio
import collections
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import uuid

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

import pytest

_REPO = Path(__file__).resolve().parents[2]
_SERVER_DIR = _REPO / 'dist' / 'server'
_ENGINE = _SERVER_DIR / ('engine.exe' if sys.platform == 'win32' else 'engine')
_TEMPLATES = sorted((_REPO / 'apps' / 'graph-ui' / 'templates').glob('*.pipe'))

_DB_TESTS_REQUIRED = bool(os.environ.get('RR_REQUIRE_DB_TESTS'))

if _DB_TESTS_REQUIRED:
    from rocketride import CommandException, RocketRideClient
else:
    _sdk = pytest.importorskip('rocketride')
    CommandException, RocketRideClient = _sdk.CommandException, _sdk.RocketRideClient

if not _ENGINE.exists():
    if _DB_TESTS_REQUIRED:
        pytest.fail(f'RR_REQUIRE_DB_TESTS is set but there is no engine at {_ENGINE}', pytrace=False)
    pytest.skip(f'no engine at {_ENGINE} (run: builder server:build)', allow_module_level=True)

RUN = uuid.uuid4().hex[:8]
GRAPH = os.environ.get('RR_TEST_TOOLPATH_GRAPH') or f'rr_toolpath_{RUN}'
# Written by the admin connection, read back through the engine: a mocked
# driver cannot return it.
TOKEN = f'tp-{secrets.token_hex(8)}'

ENGINE_START_S = 180
TOOL_TIMEOUT_MS = 60_000
REFRESH_TIMEOUT_MS = 130_000  # the refresh lock wait (65 s) + its budget (60 s) + a margin


def _seed_cypher(scope: str) -> str:
    return (
        f"CREATE (a:Person{scope} {{name: 'Ada', token: '{TOKEN}'}})-[:KNOWS {{since: 1833}}]->"
        f"(b:Person{scope} {{name: 'Bob', token: '{TOKEN}'}}), "
        f"(b)-[:KNOWS {{since: 1840}}]->(c:Person{scope} {{name: 'Cy', token: '{TOKEN}'}})"
    )


def _first_value(value: Any) -> int:
    """A count cell as an int (AGE returns agtype text such as '3')."""
    return int(str(value).split('::')[0])


# ---------------------------------------------------------------------------
# Services: an independent admin connection per database, never via the node
# ---------------------------------------------------------------------------


class _Age:
    """rocketride_graph: Postgres + Apache AGE; the node gets the DSN from the (stand-in) broker."""

    dialect = 'age'
    scope = ''

    def __init__(self) -> None:
        self.dsn = os.environ.get('RR_TEST_AGE_DSN', 'postgresql://rruser:rrpass@localhost:55433/rrtenant')
        self.admin_dsn = os.environ.get('RR_TEST_AGE_ADMIN_DSN') or self.dsn
        self.where = f'{urlparse(self.dsn).hostname}:{urlparse(self.dsn).port}'

    def secrets(self) -> List[str]:
        return [p for p in (urlparse(self.dsn).password, urlparse(self.admin_dsn).password) if p] + ['postgresql://']

    def unavailable(self) -> Optional[str]:
        try:
            import psycopg2

            for dsn in {self.dsn, self.admin_dsn}:
                psycopg2.connect(dsn, connect_timeout=3).close()
        except Exception as e:  # noqa: BLE001 - reported as the reason
            return f'the AGE test database is not reachable at {self.where} ({type(e).__name__})'
        return None

    def broker_dsn(self) -> str:
        # The engine requires TLS on a broker DSN unless every host is loopback
        # and the DSN says so; the test database has no TLS.
        if 'sslmode=' in self.dsn:
            return self.dsn
        return self.dsn + ('&' if '?' in self.dsn else '?') + 'sslmode=disable'

    def overrides(self) -> Dict[str, Any]:
        return {'graph': GRAPH}

    def _sql(self, statement: str, params: tuple = ()) -> List[tuple]:
        import psycopg2

        conn = psycopg2.connect(self.admin_dsn, connect_timeout=5)
        conn.autocommit = True
        try:
            with conn.cursor() as cur:
                cur.execute('SET search_path = ag_catalog, "$user", public')
                cur.execute(statement, params or None)
                return cur.fetchall() if cur.description else []
        finally:
            conn.close()

    def run(self, cypher: str) -> List[Any]:
        return [row[0] for row in self._sql(f'SELECT * FROM cypher(%s, $$ {cypher} $$) AS (v agtype)', (GRAPH,))]

    def seed(self) -> None:
        self.cleanup()
        self._sql('SELECT create_graph(%s)', (GRAPH,))
        self.run(_seed_cypher(''))

    def count(self, label: str = '') -> int:
        return _first_value(self.run(f'MATCH (n{":" + label if label else ""}) RETURN count(n)')[0])

    def version(self) -> str:
        return self._sql("SELECT extversion FROM pg_extension WHERE extname = 'age'")[0][0]

    def cleanup(self) -> None:
        if self._sql('SELECT 1 FROM ag_graph WHERE name = %s', (GRAPH,)):
            self._sql('SELECT drop_graph(%s, true)', (GRAPH,))


class _Neo4j:
    """graph_neo4j: one database, so this run's nodes carry a per-run label and are deleted by it."""

    dialect = 'neo4j'

    def __init__(self) -> None:
        self.uri = os.environ.get('RR_TEST_NEO4J_URI', 'bolt://127.0.0.1:57687')
        self.user = os.environ.get('RR_TEST_NEO4J_USER', 'neo4j')
        self.password = os.environ.get('RR_TEST_NEO4J_PASSWORD', 'gxlocal-test-pass')
        self.label = f'Tp{RUN}'
        self.scope = f':{self.label}'
        self.where = self.uri

    def secrets(self) -> List[str]:
        return [self.password, 'bolt://', 'neo4j://']

    def _driver(self):
        from neo4j import GraphDatabase

        return GraphDatabase.driver(self.uri, auth=(self.user, self.password))

    def unavailable(self) -> Optional[str]:
        try:
            with self._driver() as driver:
                driver.verify_connectivity()
        except Exception as e:  # noqa: BLE001 - reported as the reason
            return f'Neo4j is not reachable at {self.uri} ({type(e).__name__})'
        return None

    def overrides(self) -> Dict[str, Any]:
        # The template's neo4j:// scheme asks the server for a routing table,
        # which a container advertises with its internal port; the service
        # container is reached at the URI CI exports (bolt://).
        return {'uri': self.uri, 'user': self.user, 'password': self.password}

    def run(self, cypher: str) -> List[Any]:
        with self._driver() as driver:
            records, _summary, _keys = driver.execute_query(cypher)
            return [record.values()[0] if record.values() else None for record in records]

    def seed(self) -> None:
        self.cleanup()
        self.run(_seed_cypher(self.scope))

    def count(self, label: str = '') -> int:
        return _first_value(self.run(f'MATCH (n:{self.label}{":" + label if label else ""}) RETURN count(n)')[0])

    def version(self) -> str:
        return str(self.run('CALL dbms.components() YIELD versions RETURN versions[0]')[0])

    def cleanup(self) -> None:
        self.run(f'MATCH (n:{self.label}) DETACH DELETE n')


class _FalkorDB:
    """graph_falkordb: a per-run graph on the FalkorDB server."""

    dialect = 'falkordb'
    scope = ''

    def __init__(self) -> None:
        url = urlparse(os.environ.get('RR_TEST_FALKORDB_URL', 'redis://127.0.0.1:56379'))
        self.host, self.port = url.hostname or '127.0.0.1', url.port or 6379
        self.where = f'{self.host}:{self.port}'

    def secrets(self) -> List[str]:
        return []

    def _db(self):
        from falkordb import FalkorDB

        return FalkorDB(host=self.host, port=self.port)

    def unavailable(self) -> Optional[str]:
        try:
            self._db().connection.ping()
        except Exception as e:  # noqa: BLE001 - reported as the reason
            return f'FalkorDB is not reachable at {self.where} ({type(e).__name__})'
        return None

    def overrides(self) -> Dict[str, Any]:
        return {'host': self.host, 'port': self.port, 'graph': GRAPH}

    def run(self, cypher: str) -> List[Any]:
        return [row[0] for row in self._db().select_graph(GRAPH).query(cypher).result_set]

    def seed(self) -> None:
        self.cleanup()
        self.run(_seed_cypher(''))

    def count(self, label: str = '') -> int:
        return _first_value(self.run(f'MATCH (n{":" + label if label else ""}) RETURN count(n)')[0])

    def version(self) -> Optional[str]:
        for module in self._db().connection.execute_command('MODULE', 'LIST') or []:
            fields = dict(zip(module[::2], module[1::2]))
            name = fields.get(b'name', fields.get('name'))
            if name in (b'graph', 'graph'):
                ver = int(fields.get(b'ver', fields.get('ver')))
                return f'{ver // 10000}.{ver // 100 % 100}.{ver % 100}'
        return None

    def cleanup(self) -> None:
        if GRAPH.encode() in (self._db().connection.execute_command('GRAPH.LIST') or []) or GRAPH in (
            self._db().connection.execute_command('GRAPH.LIST') or []
        ):
            self._db().select_graph(GRAPH).delete()


# Graph provider -> its service. Every shipped template's graph node must be here.
SERVICES = {'rocketride_graph': _Age, 'graph_neo4j': _Neo4j, 'graph_falkordb': _FalkorDB}


# ---------------------------------------------------------------------------
# The engine and the broker stand-in
# ---------------------------------------------------------------------------


class _Broker:
    """Answers the broker's POST /provision with the AGE test DSN, for this run's token only."""

    def __init__(self, dsn: str) -> None:
        self.token = f'toolpath-broker-{secrets.token_hex(12)}'
        self.tenants: List[str] = []
        broker = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - http.server API
                length = int(self.headers.get('Content-Length') or 0)
                body = json.loads(self.rfile.read(length) or b'{}')
                if self.headers.get('Authorization') != f'Bearer {broker.token}':
                    self.send_response(401)
                    self.end_headers()
                    return
                broker.tenants.append(body.get('tenant_id'))
                payload = json.dumps({'dsn': dsn, 'database': 'test', 'role': 'test', 'created': False}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        self._server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self._server.server_port}/provision'
        threading.Thread(target=self._server.serve_forever, name='toolpath-broker', daemon=True).start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


class _Engine:
    """``engine ai/eaas.py`` without mocks, plus one SDK client on a loop thread of its own."""

    def __init__(self, store_dir: Path, broker: _Broker) -> None:
        self.apikey = f'toolpath-{secrets.token_hex(12)}'
        env = {
            name: value
            for name, value in os.environ.items()
            if name.upper()
            not in (
                'ROCKETRIDE_MOCK',
                'ROCKETRIDE_DB_DSN',
                'ROCKETRIDE_DB_DSNS',
                'ROCKETRIDE_DB_RESOLVE_ERROR',
                'ROCKETRIDE_DB_BROKER_URL',
                'ROCKETRIDE_DB_BROKER_TOKEN',
            )
        }
        env.update(
            {
                'ROCKETRIDE_APIKEY': self.apikey,
                'RR_STORE_URL': f'filesystem://{store_dir.as_posix()}',
                'ROCKETRIDE_DB_BROKER_URL': broker.url,
                'ROCKETRIDE_DB_BROKER_TOKEN': broker.token,
            }
        )
        port = int(os.environ.get('RR_TEST_TOOLPATH_ENGINE_PORT') or 0)
        self.output: collections.deque = collections.deque(maxlen=200)
        self._port: Optional[int] = None
        self._ready = threading.Event()
        # --autoterm: the engine exits when this process does (its stdin closes).
        self.proc = subprocess.Popen(
            [str(_ENGINE), '--autoterm', 'ai/eaas.py', '--host=127.0.0.1', f'--port={port}', '--base_port=43000'],
            cwd=str(_SERVER_DIR),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            errors='replace',
        )
        threading.Thread(target=self._read_output, name='toolpath-engine-output', daemon=True).start()
        deadline = time.monotonic() + ENGINE_START_S
        while not self._ready.wait(0.5):
            if self.proc.poll() is not None or time.monotonic() > deadline:
                self.stop()
                raise RuntimeError(f'the engine did not start:\n{self.tail()}')
        self.uri = f'http://127.0.0.1:{self._port}'
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, name='toolpath-sdk-loop', daemon=True).start()
        self.client = RocketRideClient(uri=self.uri, auth=self.apikey)
        self.run(self.client.connect(), 60)

    def _read_output(self) -> None:
        port_re = re.compile(r'Uvicorn running on https?://[\w.\[\]:]+:(\d+)')
        started = False
        for line in self.proc.stdout:
            self.output.append(line.rstrip())
            match = port_re.search(line)
            if match and self._port is None:
                self._port = int(match.group(1))
            started = started or 'Application startup complete' in line
            # Uvicorn prints the startup line before the address line.
            if started and self._port is not None:
                self._ready.set()

    def tail(self) -> str:
        return '\n'.join(list(self.output)[-40:])

    def run(self, coro, timeout: float = 150) -> Any:
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    def stop(self) -> None:
        if getattr(self, 'loop', None) is not None:
            try:
                self.run(self.client.disconnect(), 15)
            except Exception:  # noqa: BLE001 - shutting down
                pass
            self.loop.call_soon_threadsafe(self.loop.stop)
        try:
            self.proc.stdin.close()
        except Exception:  # noqa: BLE001 - shutting down
            pass
        self.proc.terminate()
        try:
            self.proc.wait(20)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(10)


@pytest.fixture(scope='module')
def broker():
    service = _Age()
    stand_in = _Broker(service.broker_dsn())
    yield stand_in
    stand_in.close()


@pytest.fixture(scope='module')
def engine(tmp_path_factory, broker):
    started = _Engine(tmp_path_factory.mktemp('toolpath-store'), broker)
    yield started
    started.stop()


# ---------------------------------------------------------------------------
# One running pipeline per shipped template
# ---------------------------------------------------------------------------


def _graph_component(pipe: Dict[str, Any], source_id: str) -> Dict[str, Any]:
    controlled = [
        c
        for c in pipe['components']
        if any(link.get('classType') == 'tool' and link.get('from') == source_id for link in c.get('control') or [])
    ]
    assert len(controlled) == 1, f'expected one tool node under {source_id!r}, got {[c["id"] for c in controlled]}'
    return controlled[0]


@pytest.fixture(scope='module', params=_TEMPLATES, ids=lambda path: path.stem)
def running(request):
    """The template started with only its server settings changed; yields what the tests need."""
    path: Path = request.param
    template = json.loads(path.read_text(encoding='utf-8'))
    pipe = template.get('pipeline', template)
    (source,) = [c for c in pipe['components'] if c.get('provider') == 'tools']
    node = _graph_component(pipe, source['id'])
    service_cls = SERVICES.get(node['provider'])
    if service_cls is None:
        pytest.fail(
            f'{path.name}: no service for provider {node["provider"]!r}; add it to SERVICES '
            '(or a "NOT RUN:" skip naming it when CI does not provide the service)',
            pytrace=False,
        )
    service = service_cls()
    reason = service.unavailable()
    if reason:
        if _DB_TESTS_REQUIRED:
            pytest.fail(f'RR_REQUIRE_DB_TESTS is set but {reason}', pytrace=False)
        pytest.skip(reason)
    eng: _Engine = request.getfixturevalue('engine')
    service.seed()

    project_id = str(uuid.uuid4())
    pipe = json.loads(json.dumps(pipe))
    pipe['project_id'] = project_id
    config = next(c for c in pipe['components'] if c['id'] == node['id'])['config']
    profile = config.get('profile', 'default')
    original = dict(config[profile])
    config[profile] = {**original, **service.overrides()}

    started = eng.run(eng.client.use(pipeline=pipe, source=source['id']))
    try:
        task = None
        deadline = time.monotonic() + 90
        while task is None and time.monotonic() < deadline:
            for row in eng.run(eng.client.get_tasks()):
                if (row.get('pipeline') or {}).get('project_id') == project_id and row.get('source') == source['id']:
                    task = row
            if task is None:
                time.sleep(0.5)

        def tool(name: str, inp: Dict[str, Any], timeout: int = TOOL_TIMEOUT_MS) -> Any:
            return eng.run(
                eng.client.tool(token=started['token'], tool=name, node_id=node['id'], input=inp, timeout=timeout)
            )

        def refused(name: str, inp: Dict[str, Any]) -> str:
            try:
                out = tool(name, inp)
            except CommandException as e:
                return str(e)
            raise AssertionError(f'{name} {inp} was not refused: {out}')

        yield SimpleNamespace(
            template=path.name,
            node=node,
            original=original,
            service=service,
            task=task,
            token=started['token'],
            tool=tool,
            refused=refused,
            engine=eng,
        )
    finally:
        try:
            eng.run(eng.client.terminate(started['token']), 60)
        finally:
            service.cleanup()


def _tagged(value: Any, kind: str, out: Optional[list] = None) -> list:
    out = [] if out is None else out
    if isinstance(value, list):
        for item in value:
            _tagged(item, kind, out)
    elif isinstance(value, dict):
        if value.get('@kind') == kind:
            out.append(value)
        for item in value.values():
            _tagged(item, kind, out)
    return out


ENVELOPE = (
    'columns',
    'rows',
    'row_limit',
    'truncated',
    'truncated_by',
    'element_limit',
    'elements',
    'value_limit',
    'values',
)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_the_engine_runs_the_template_as_shipped(running):
    """get_tasks finds the run by project and source; the template's components and settings are intact."""
    assert running.task is not None, f'{running.template}: get_tasks never listed the run'
    assert running.task['token'] == running.token
    components = {c['id']: c for c in (running.task.get('pipeline') or {}).get('components', [])}
    assert components[running.node['id']]['provider'] == running.node['provider']
    assert any(c.get('provider') == 'annotation' for c in components.values()), 'the template note was dropped'
    assert running.original.get('allow_execute') is False, f'{running.template} ships with allow_execute on'


def test_dialect_comes_from_the_real_server(running, broker):
    d = running.tool('dialect', {})
    assert d['dialect'] == running.service.dialect
    assert d['allow_execute'] is False
    assert d['capabilities'].get('read_query') is True and d['capabilities'].get('refresh_schema') is True
    assert isinstance(d['limits'].get('statement_timeout_ms'), int)
    assert d['engine']['version'] == running.service.version(), 'dialect does not report the server it reached'
    blob = json.dumps(d)
    leaked = [s for s in running.service.secrets() + [broker.token, running.engine.apikey] if s and s in blob]
    assert leaked == [], 'dialect carries credentials or connection strings'
    if running.service.dialect == 'age':
        # The engine resolved the database through the broker, for the task's tenant.
        assert broker.tenants and all(t for t in broker.tenants)
        assert d['graph'] == GRAPH


def test_get_schema_lists_the_seeded_graph(running):
    out = running.tool('get_schema', {})
    schema = out['schema']
    assert 'Person' in {label['name'] for label in schema['labels']}
    assert 'KNOWS' in {rel['type'] for rel in schema['relationship_types']}
    assert schema['refreshed_at'] and schema['stale'] is False and schema['error'] is None
    assert 'nodes' in out and 'relationships' in out  # the legacy keys stay


def test_read_query_returns_the_databases_rows(running):
    s = running.service.scope
    out = running.tool(
        'read_query', {'cypher': f"MATCH (a:Person{s} {{name: 'Ada'}})-[r:KNOWS]->(b) RETURN a, r, b, a.token"}
    )
    assert all(key in out for key in ENVELOPE), sorted(out)
    assert out['columns'] == ['a', 'r', 'b', 'a.token']
    assert out['truncated'] is False and out['truncated_by'] is None
    ((a, r, b, token),) = out['rows']
    assert token == TOKEN, 'the row did not come from this run’s database'
    assert a['@kind'] == 'node' and 'Person' in a['labels'] and a['properties']['name'] == 'Ada'
    assert isinstance(a['id'], str) and isinstance(r['id'], str)
    assert r['@kind'] == 'relationship' and r['type'] == 'KNOWS' and r['properties']['since'] == 1833
    assert (r['start'], r['end']) == (a['id'], b['id']) and b['properties']['name'] == 'Bob'


def test_read_query_row_cap_and_truncated_by(running):
    exact = running.tool('read_query', {'cypher': 'UNWIND range(1, 5) AS x RETURN x', 'limit': 5})
    assert [row[0] for row in exact['rows']] == [1, 2, 3, 4, 5]
    assert exact['truncated'] is False and exact['truncated_by'] is None and exact['row_limit'] == 5
    cut = running.tool('read_query', {'cypher': 'UNWIND range(1, 6) AS x RETURN x', 'limit': 5})
    assert len(cut['rows']) == 5 and cut['truncated'] is True and cut['truncated_by'] == 'rows'


def test_writes_are_refused_with_the_data_unchanged(running):
    s = running.service.scope
    before = running.service.count()
    message = running.refused('execute', {'query': f'CREATE (:Intruder{s} {{x: 1}})'})
    assert 'allow_execute' in message, message
    message = running.refused('read_query', {'cypher': f'CREATE (:Intruder{s} {{x: 2}})'})
    assert message.startswith('Refused'), message
    assert running.service.count() == before
    assert running.service.count('Intruder') == 0


def test_refresh_schema_publishes_a_label_added_outside_the_node(running):
    fresh = f'AaFresh{RUN}'
    running.service.run(f'CREATE (:{fresh}{running.service.scope} {{added: true}})')
    snapshot = {label['name'] for label in running.tool('get_schema', {})['schema']['labels']}
    assert fresh not in snapshot, 'get_schema must serve the snapshot until a refresh'
    refreshed = running.tool('refresh_schema', {}, timeout=REFRESH_TIMEOUT_MS)['schema']
    assert fresh in {label['name'] for label in refreshed['labels']}
    assert refreshed['refreshed_at'] and refreshed['stale'] is False and refreshed['error'] is None
