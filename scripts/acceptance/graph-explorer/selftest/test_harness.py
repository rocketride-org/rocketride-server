# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================
"""Self-tests for the acceptance harness's own verdict logic.

They need no engine, database or browser: the SDK and the Neo4j driver are
replaced by small in-memory stand-ins written to a temporary directory. They
check that a harness check cannot pass without testing anything, and that the
Neo4j clean-up stays inside the run's label.

Run: python3 -m unittest discover -s scripts/acceptance/graph-explorer/selftest -v
"""

import contextlib
import importlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import types
import unittest

from pathlib import Path

ACC = Path(__file__).resolve().parent.parent
REPO = ACC.parent.parent.parent

# A stand-in for the rocketride SDK, enough for graph_lifecycle.py. FAKE_RESTART_MODE
# 'window' makes calls fail with TASK_STOPPED for a moment after restart(); 'none'
# restarts instantly, so a caller never sees the restart window.
FAKE_SDK = textwrap.dedent(
    """
    import asyncio
    import os
    import time
    import uuid


    class CommandException(RuntimeError):
        def __init__(self, message, code=None):
            super().__init__(message)
            self.code = code


    class RocketRideClient:
        def __init__(self, uri=None, auth=None, **_):
            self.tasks = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def use(self, pipeline, source):
            token = uuid.uuid4().hex
            wired = any(c.get('control') for c in pipeline['components'])
            self.tasks[token] = {'project_id': pipeline['project_id'], 'source': source, 'wired': wired, 'stopped_until': 0.0}
            return {'token': token}

        async def get_tasks(self):
            return [{'token': t, 'source': v['source'], 'pipeline': {'project_id': v['project_id']}} for t, v in self.tasks.items()]

        async def tool(self, token, tool, node_id='', input=None, timeout=None):
            await asyncio.sleep(0)
            task = self.tasks.get(token)
            if task is None:
                raise CommandException('Task not registered', 'TASK_NOT_REGISTERED')
            if time.monotonic() < task['stopped_until']:
                raise CommandException('Task is stopping', 'TASK_STOPPED')
            if not task['wired']:
                raise CommandException(f'Node "{node_id}" not found in pipeline')
            return {'dialect': 'falkordb'}

        async def terminate(self, token):
            self.tasks.pop(token, None)

        async def restart(self, project_id, source, pipeline, token=None, team_id=None):
            if os.environ.get('FAKE_RESTART_MODE') == 'window':
                self.tasks[token]['stopped_until'] = time.monotonic() + 0.5
    """
)


def _write_fake_sdk(root: Path) -> Path:
    pkg = root / 'rocketride'
    pkg.mkdir(parents=True)
    (pkg / '__init__.py').write_text(FAKE_SDK)
    return root


class ValidateAllExitCode(unittest.TestCase):
    """validate_all.sh must report a failed gate in its exit status."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gx-selftest-'))
        repo = self.tmp / 'repo'
        (repo / 'scripts').mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(repo)], check=True)
        builder = repo / 'builder'
        # Records each action and the pooler DSN it was given.
        builder.write_text(
            '#!/bin/sh\necho "builder $* pooler=${RR_TEST_AGE_POOLER_DSN:-}" >> "$FAKE_CALLS"\nexit "${FAKE_RC:-0}"\n'
        )
        builder.chmod(0o755)
        (repo / 'scripts' / 'validate-node-readme.py').write_text(
            "import os, sys\nsys.exit(int(os.environ.get('FAKE_RC', '0')))\n"
        )
        (repo / 'scripts' / 'build.js').write_text("process.exit(Number(process.env.FAKE_RC || '0'));\n")
        # The engine the database version check runs in, as a fresh build leaves it: it
        # records its arguments, and has no database drivers until something installs
        # nodes/test/requirements.txt (a plain build does not; nodes:test and nodes:test-db
        # do, first). Until then the version check fails the way the real one does.
        # FAKE_ENGINE_RC is the version check's own verdict.
        (repo / 'dist' / 'server').mkdir(parents=True)
        engine = repo / 'dist' / 'server' / 'engine'
        engine.write_text(
            textwrap.dedent(
                """\
                #!/bin/sh
                echo "engine $*" >> "$FAKE_CALLS"
                case "$*" in
                *depends*nodes/test/requirements.txt)
                    [ "${FAKE_RC:-0}" = 0 ] && : > "$FAKE_DRIVERS"
                    exit "${FAKE_RC:-0}" ;;
                *check_db_versions.py)
                    if [ ! -e "$FAKE_DRIVERS" ]; then
                        echo "neo4j: could not read the server version (ModuleNotFoundError: No module named 'neo4j')"
                        exit 1
                    fi
                    exit "${FAKE_ENGINE_RC:-${FAKE_RC:-0}}" ;;
                esac
                exit "${FAKE_RC:-0}"
                """
            )
        )
        engine.chmod(0o755)
        self.calls = self.tmp / 'calls.txt'
        self.repo = repo

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_gates(self, rc: str, **extra: str) -> subprocess.CompletedProcess:
        base = {k: v for k, v in os.environ.items() if k != 'RR_TEST_AGE_POOLER_DSN'}
        env = dict(
            base,
            FAKE_RC=rc,
            FAKE_CALLS=str(self.calls),
            FAKE_DRIVERS=str(self.tmp / 'drivers-installed'),
            OUT_DIR=str(self.tmp / 'out'),
            STORE_DIR=str(self.tmp / 'store'),
            **extra,
        )
        return subprocess.run(
            ['bash', str(ACC / 'validate_all.sh')], cwd=self.repo, env=env, capture_output=True, text=True
        )

    def summary_steps(self, res: subprocess.CompletedProcess) -> list:
        return [line.split()[0] for line in res.stdout.splitlines() if ' exit=' in line]

    def test_failed_gate_exits_non_zero(self):
        res = self.run_gates('1')
        self.assertNotEqual(res.returncode, 0, f'validate_all.sh exited 0 although every gate failed:\n{res.stdout}')

    def test_all_gates_passing_exits_zero(self):
        res = self.run_gates('0')
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)

    def test_database_versions_are_checked_before_the_node_suites(self):
        res = self.run_gates('0')
        steps = self.summary_steps(res)
        self.assertIn('db-versions', steps, res.stdout)
        self.assertLess(steps.index('db-versions'), steps.index('nodes-test-db'), res.stdout)
        calls = self.calls.read_text() if self.calls.exists() else ''
        self.assertRegex(calls, r'engine \S*check_db_versions\.py', 'the version check did not run in the engine')

    def engine_calls(self) -> list:
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        return [line for line in calls if line.startswith('engine ')]

    def test_the_version_check_gets_the_database_drivers_first(self):
        # A fresh build has no neo4j, falkordb or psycopg2 in dist/server: the gate must
        # install nodes/test/requirements.txt (depends(), as nodes:test does) before the check.
        res = self.run_gates('0')
        self.assertRegex(res.stdout, r'db-versions\s+exit=0', 'the version check failed on a fresh build')
        calls = self.engine_calls()
        installs = r'depends\(sys\.argv\[1\]\) \S*/nodes/test/requirements\.txt$'
        install = [i for i, c in enumerate(calls) if re.search(installs, c)]
        check = [i for i, c in enumerate(calls) if c.endswith('check_db_versions.py')]
        self.assertTrue(install, f'nodes/test/requirements.txt was never installed into the engine: {calls}')
        self.assertTrue(check, f'the version check never ran: {calls}')
        self.assertLess(install[0], check[0], f'the drivers were installed after the check: {calls}')

    def node_suite_poolers(self) -> dict:
        calls = self.calls.read_text().splitlines() if self.calls.exists() else []
        out = {}
        for line in calls:
            m = re.match(r'builder (nodes:test(?:-db)?) pooler=(.*)$', line)
            if m:
                out[m.group(1)] = m.group(2)
        return out

    def test_node_suites_run_the_pooler_pass(self):
        # CI sets RR_TEST_AGE_POOLER_DSN, so nodes:test runs the AGE suites a second time through PgBouncer.
        res = self.run_gates('0')
        poolers = self.node_suite_poolers()
        self.assertEqual(sorted(poolers), ['nodes:test', 'nodes:test-db'], res.stdout)
        for action, dsn in poolers.items():
            self.assertRegex(dsn, r'^postgresql://.*@127\.0\.0\.1:56433/', f'{action} ran without the pooler pass')
        self.assertIn('pooler 127.0.0.1:56433', res.stdout)
        self.assertNotIn('rrpass', res.stdout, 'the pooler DSN password was printed')

    def test_a_pooler_dsn_from_the_environment_is_used(self):
        dsn = 'postgresql://someone:secret@127.0.0.1:6543/elsewhere'
        self.run_gates('0', RR_TEST_AGE_POOLER_DSN=dsn)
        self.assertEqual(set(self.node_suite_poolers().values()), {dsn})

    def printed(self, res: subprocess.CompletedProcess) -> str:
        """Everything the run showed: stdout, stderr and every SUMMARY.txt it wrote."""
        summaries = ''.join(p.read_text() for p in (self.tmp / 'out').glob('*/SUMMARY.txt'))
        return res.stdout + res.stderr + summaries

    def test_a_pooler_dsn_password_is_never_printed(self):
        # libpq also takes key/value DSNs, and a URL password may hold an unencoded '@'
        # or '/': whatever the form, the password must stay out of stdout and SUMMARY.txt.
        cases = [
            # (DSN, its password, what the summary shows)
            ('host=127.0.0.1 port=6543 dbname=elsewhere user=someone password=kv-pw-1', 'kv-pw-1', 'pooler (set)'),
            ("host='127.0.0.1' password = 'kv pw 2' port=6543", 'kv pw 2', 'pooler (set)'),
            ('postgresql://someone:at@pw-3@127.0.0.1:6543/elsewhere', 'pw-3', 'pooler (set)'),
            ('postgresql://someone:6543/pw-4@127.0.0.1/elsewhere', 'pw-4', 'pooler (set)'),
            ('postgresql://127.0.0.1:6543/elsewhere?password=at@pw-5', 'pw-5', 'pooler (set)'),
            ('postgresql+psycopg2://someone:pw-6@127.0.0.1:6543/elsewhere', 'pw-6', 'pooler 127.0.0.1:6543'),
            ('postgres://someone:pw-7@[::1]:6543', 'pw-7', 'pooler [::1]:6543'),
        ]
        for dsn, password, shown in cases:
            with self.subTest(dsn=dsn):
                shutil.rmtree(self.tmp / 'out', ignore_errors=True)
                self.calls.unlink(missing_ok=True)
                res = self.run_gates('0', RR_TEST_AGE_POOLER_DSN=dsn)
                out = self.printed(res)
                self.assertNotIn(password, out, 'the pooler password was printed')
                self.assertIn(shown + '\n', out)
                self.assertEqual(set(self.node_suite_poolers().values()), {dsn}, 'the node suites got another DSN')

    def test_a_database_on_another_version_fails_the_run(self):
        res = self.run_gates('0', FAKE_ENGINE_RC='1')
        self.assertNotEqual(res.returncode, 0, res.stdout)
        self.assertRegex(res.stdout, r'db-versions\s+exit=1')


class DatabaseImagesMatchCI(unittest.TestCase):
    """README.md starts the database images CI runs, so the exact wire-fixture comparison means the same locally."""

    IMAGE = re.compile(
        r'(?<![\w./-])(apache/age|pgvector/pgvector|neo4j|falkordb/falkordb|edoburu/pgbouncer)'
        r'((?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?)'
    )

    def images(self, path: Path) -> dict:
        found = {}
        for repo, ref in self.IMAGE.findall(path.read_text()):
            if ref:  # a bare "neo4j" (a user name, NEO4J_AUTH=neo4j/...) is not an image
                found.setdefault(repo, set()).add(repo + ref)
        return found

    def test_readme_starts_the_database_images_ci_runs(self):
        readme = self.images(ACC / 'README.md')
        ci = self.images(REPO / '.github' / 'workflows' / '_build.yaml')
        # The graph servers are started by nodes/test/db-services/graph.sh (and the shared
        # PgBouncer pin in _common.sh); the Postgres images stay in _build.yaml.
        for script in sorted((REPO / 'nodes' / 'test' / 'db-services').glob('*.sh')):
            for repo, refs in self.images(script).items():
                ci.setdefault(repo, set()).update(refs)
        for repo in ('apache/age', 'pgvector/pgvector', 'neo4j', 'falkordb/falkordb', 'edoburu/pgbouncer'):
            self.assertIn(repo, ci, f'CI (_build.yaml, db-services) no longer starts {repo}')
            self.assertEqual(readme.get(repo), ci[repo], f'README.md does not start the {repo} image CI runs')


class DbVersionCheck(unittest.TestCase):
    """check_db_versions.py compares the servers with the versions in the committed captures."""

    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(ACC))
        sys.modules.pop('check_db_versions', None)
        cls.cv = importlib.import_module('check_db_versions')

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(str(ACC))

    def test_expected_versions_come_from_the_committed_captures(self):
        expected = self.cv.expected_versions()
        self.assertEqual(sorted(expected), ['age', 'falkordb', 'neo4j'])
        captured = json.loads((self.cv.CAPTURES / 'neo4j_dialect.json').read_text())['engine']
        self.assertEqual(expected['neo4j'], {'version': captured['version'], 'edition': captured['edition']})
        for engine, want in expected.items():
            self.assertRegex(want['version'] or '', r'^\d+\.\d+', engine)

    def test_matching_servers_pass(self):
        expected = {
            'neo4j': {'version': '5.26.31', 'edition': 'community'},
            'age': {'version': '1.5.0', 'edition': None},
        }
        problems = self.cv.compare(expected, {'neo4j': ('5.26.31', 'community'), 'age': ('1.5.0', None)})
        self.assertEqual(problems, [])

    def test_another_version_or_edition_fails(self):
        expected = {
            'neo4j': {'version': '5.26.31', 'edition': 'community'},
            'falkordb': {'version': '6.0.1', 'edition': None},
        }
        problems = self.cv.compare(expected, {'neo4j': ('5.26.32', 'community'), 'falkordb': ('6.0.1', None)})
        self.assertEqual(len(problems), 1)
        self.assertIn('5.26.32', problems[0])
        self.assertIn('5.26.31', problems[0])
        problems = self.cv.compare(expected, {'neo4j': ('5.26.31', 'enterprise'), 'falkordb': ('6.0.1', None)})
        self.assertEqual(len(problems), 1)

    def test_an_unreachable_server_fails(self):
        expected = {'falkordb': {'version': '6.0.1', 'edition': None}}
        problems = self.cv.compare(expected, {'falkordb': ConnectionRefusedError('nothing listens')})
        self.assertEqual(len(problems), 1)
        self.assertIn('nothing listens', problems[0])


class LifecycleRestartWindow(unittest.TestCase):
    """graph_lifecycle.py must not pass its restart checks when the window was never observed."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gx-selftest-'))
        _write_fake_sdk(self.tmp / 'stub')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_lifecycle(self, mode: str) -> subprocess.CompletedProcess:
        env = dict(os.environ, PYTHONPATH=str(self.tmp / 'stub'), FAKE_RESTART_MODE=mode)
        return subprocess.run(
            [sys.executable, str(ACC / 'graph_lifecycle.py'), 'ws://fake.invalid'],
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def test_restart_window_not_observed_fails(self):
        res = self.run_lifecycle('none')
        self.assertNotEqual(
            res.returncode, 0, f'lifecycle passed although no call saw the restart window:\n{res.stdout}{res.stderr}'
        )
        self.assertRegex(res.stdout, r'\[FAIL\] restart: .*TASK_STOPPED')

    def test_restart_window_observed_passes(self):
        res = self.run_lifecycle('window')
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)


class Neo4jCleanupScope(unittest.TestCase):
    """On the shared Neo4j database the acceptance only deletes and counts nodes with its run label."""

    @classmethod
    def setUpClass(cls):
        cls.statements = []
        statements = cls.statements

        class _Driver:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def execute_query(self, cypher):
                statements.append(cypher)
                return [], None, None

        neo4j = types.ModuleType('neo4j')
        neo4j.GraphDatabase = types.SimpleNamespace(driver=_Driver)
        sdk = types.ModuleType('rocketride')
        sdk.CommandException = type('CommandException', (RuntimeError,), {})
        sdk.RocketRideClient = object
        cls._saved = {name: sys.modules.get(name) for name in ('neo4j', 'rocketride', 'graph_acceptance')}
        sys.modules['neo4j'] = neo4j
        sys.modules['rocketride'] = sdk
        sys.modules.pop('graph_acceptance', None)
        sys.path.insert(0, str(ACC))
        cls.ga = importlib.import_module('graph_acceptance')

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(str(ACC))
        for name, module in cls._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def setUp(self):
        self.statements.clear()

    def assert_scoped(self, statements):
        label = f':{self.ga.RUN}'
        for stmt in statements:
            self.assertIn(label, stmt, f'statement is not limited to the run label {label}: {stmt}')

    def test_reset_deletes_only_run_nodes(self):
        self.ga.Admin('neo4j').reset_and_seed()
        deletes = [s for s in self.statements if 'DELETE' in s.upper()]
        self.assertTrue(deletes)
        self.assert_scoped(deletes)

    def test_intruder_count_is_run_scoped(self):
        self.ga.Admin('neo4j').count('Intruder')
        self.assert_scoped(self.statements)

    def test_write_probes_carry_the_run_label(self):
        probes = self.ga.write_probes('neo4j') + [self.ga.execute_probe('neo4j')]
        self.assertEqual(len(probes), 4)
        self.assert_scoped(probes)

    def test_other_engines_keep_their_own_graph(self):
        probes = self.ga.write_probes('falkordb') + [self.ga.execute_probe('age')]
        self.assertNotIn(f':{self.ga.RUN}', ' '.join(probes))


class FixturePipelines(unittest.TestCase):
    """start_fixtures.py starts what the browser lanes open, and only the write console's fixture may write."""

    GRAPH_PROVIDERS = ('rocketride_graph', 'graph_neo4j', 'graph_falkordb')

    @classmethod
    def setUpClass(cls):
        sdk = types.ModuleType('rocketride')
        sdk.RocketRideClient = object
        cls._saved = {name: sys.modules.get(name) for name in ('rocketride', 'start_fixtures', 'falkordb')}
        sys.modules['rocketride'] = sdk
        sys.modules.pop('start_fixtures', None)
        sys.path.insert(0, str(ACC))
        cls.sf = importlib.import_module('start_fixtures')
        # The display names the Node lanes look for (env.cjs FIXTURES).
        script = 'process.stdout.write(JSON.stringify(require(process.argv[1]).FIXTURES))'
        out = subprocess.run(['node', '-e', script, str(ACC / 'env.cjs')], capture_output=True, text=True, check=True)
        cls.lane_names = json.loads(out.stdout)

    @classmethod
    def tearDownClass(cls):
        sys.path.remove(str(ACC))
        for name, module in cls._saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module

    def test_every_fixture_a_lane_opens_is_started(self):
        started = {fixture[0] for fixture in self.sf.FIXTURES}
        self.assertEqual(sorted(set(self.lane_names.values()) - started), [])

    def test_only_the_write_console_fixture_can_write_to_a_graph(self):
        graphs = [f for f in self.sf.FIXTURES if f[2] in self.GRAPH_PROVIDERS]
        writable = [f for f in graphs if f[3].get('allow_execute')]
        self.assertEqual([f[0] for f in writable], [self.lane_names.get('falkordbWrite')])
        _, _, provider, cfg = writable[0]
        self.assertEqual(provider, 'graph_falkordb')
        self.assertEqual(cfg['graph'], self.sf.E.WRITE_GRAPH)
        E = self.sf.E
        self.assertNotIn(cfg['graph'], {E.ACCEPT_GRAPH, E.PERF_GRAPH, E.DEMO_GRAPH})

    def _fake_falkordb(self, graphs):
        queries = []

        class _Graph:
            def __init__(self, name):
                self.name = name

            def query(self, cypher):
                queries.append((self.name, cypher))

        class _FalkorDB:
            def __init__(self, host=None, port=None):
                pass

            def list_graphs(self):
                return list(graphs)

            def select_graph(self, name):
                return _Graph(name)

        module = types.ModuleType('falkordb')
        module.FalkorDB = _FalkorDB
        sys.modules['falkordb'] = module
        return queries

    def test_write_graph_is_created_empty_when_missing(self):
        queries = self._fake_falkordb(graphs=['gx_accept'])
        with contextlib.redirect_stdout(io.StringIO()):
            self.sf.ensure_write_graph()
        self.assertEqual(queries, [(self.sf.E.WRITE_GRAPH, 'CREATE (n) DELETE n')])

    def test_existing_write_graph_is_left_unchanged(self):
        queries = self._fake_falkordb(graphs=['gx_accept', self.sf.E.WRITE_GRAPH])
        with contextlib.redirect_stdout(io.StringIO()):
            self.sf.ensure_write_graph()
        self.assertEqual(queries, [])


if __name__ == '__main__':
    unittest.main()
