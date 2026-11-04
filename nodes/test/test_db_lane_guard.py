# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""The live-database lane's registry and result guard (nodes/scripts/tasks.js), checked with Node.

Domains register their live suites in ``nodes/scripts/db-lanes/*.js``. ``nodes:test-db``
and the database pass of ``nodes:test`` run every registered suite without the engine
mocks and read the pytest JUnit report. When the databases are required (``nodes:test-db``
by default, ``nodes:test`` with ``RR_REQUIRE_DB_TESTS``), every suite must pass at least
one test and no test may skip except a deliberate ``NOT RUN:`` one.

This file checks the registry as a whole (it does not name any domain's suites, so a
domain never edits it): every registration is well-formed, every suite file exists and
is registered exactly once, every suite that needs a live database is registered (an
unregistered one would be collected by the mocked pass, where the mocks shadow its
driver), and the result checks hold.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess

from pathlib import Path

import pytest

_TEST_DIR = Path(__file__).resolve().parent
_TASKS = _TEST_DIR.parent / 'scripts' / 'tasks.js'
_NODE = shutil.which('node')

pytestmark = pytest.mark.skipif(_NODE is None, reason='node is not on PATH')

_SCRIPT = r"""
const lane = require(process.argv[1]).dbLane;
const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = {};
const attempt = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
if (input.xml !== undefined) {
    out.counts = lane.countJunitResults(input.xml);
    out.error = attempt(() => lane.checkRequiredDbResults(input.xml, input.suites));
}
if (input.pooled !== undefined) {
    out.pooledError = attempt(() => lane.checkPooledCases(input.pooled, input.suites));
}
if (input.required !== undefined) {
    const saved = process.env.RR_REQUIRE_DB_TESTS;
    out.required = input.required.map(([value, byDefault]) => {
        if (value === null) delete process.env.RR_REQUIRE_DB_TESTS;
        else process.env.RR_REQUIRE_DB_TESTS = value;
        return lane.dbTestsRequired(byDefault);
    });
    if (saved === undefined) delete process.env.RR_REQUIRE_DB_TESTS;
}
if (input.registry) {
    out.lanes = lane.loadDbLanes().map((l) => ({
        file: l.file, name: l.name, suites: l.suites, poolerSuites: l.poolerSuites || [], poolerMode: l.poolerMode || null,
    }));
    out.suites = lane.DB_LIVE_SUITES;
    out.lanesDir = lane.DB_LANES_DIR;
}
if (input.ignores) {
    out.ignores = { mocked: lane.mockedPassIgnores(false), full: lane.mockedPassIgnores(true) };
    out.testDir = require('path').join(require('path').dirname(process.argv[1]), '..', 'test');
}
if (input.validate) {
    out.validate = input.validate.map((reg) => {
        const lanes = reg.map((r) => ({ ...r, secondPassEnv: r.hasSecondPassEnv ? () => ({}) : undefined }));
        return attempt(() => {
            const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'dblanes-'));
            lanes.forEach((l, i) => {
                const { hasSecondPassEnv, ...rest } = l;
                const code = 'module.exports = Object.assign(' + JSON.stringify(rest) + (l.secondPassEnv ? ', { secondPassEnv: () => ({}) }' : '') + ');';
                require('fs').writeFileSync(require('path').join(dir, `${String(i).padStart(2, '0')}-${l.name || 'x'}.js`), code);
            });
            try { lane.loadDbLanes(dir); } finally { require('fs').rmSync(dir, { recursive: true, force: true }); }
        });
    });
}
process.stdout.write(JSON.stringify(out));
"""


def _lane(payload):
    proc = subprocess.run(
        [_NODE, '-e', _SCRIPT, str(_TASKS)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def _case(module, name, body=''):
    return f'<testcase classname="test.{module}.TestX" name="{name}" time="0.1">{body}</testcase>'


def _skip(message):
    return f'<skipped type="pytest.skip" message="{message}">reason</skipped>'


def _xml(*cases):
    return '<?xml version="1.0"?><testsuites><testsuite>' + ''.join(cases) + '</testsuite></testsuites>'


SUITES = ['test_a_full', 'test_b_full']


# ---------------------------------------------------------------------------
# The result checks
# ---------------------------------------------------------------------------


def test_every_suite_passing_with_deliberate_skips_is_accepted():
    xml = _xml(
        _case('test_a_full', 't1'),
        _case('test_a_full', 't2', _skip('NOT RUN: needs an Enterprise role')),
        _case('test_b_full', 't1'),
    )
    out = _lane({'xml': xml, 'suites': SUITES})
    assert out['error'] is None
    assert out['counts']['test_a_full'] == {
        'passed': 1,
        'skipped': 1,
        'failed': 0,
        'pooledPassed': 0,
        'unexpectedSkips': [],
    }


def test_a_suite_without_passes_fails_the_lane():
    xml = _xml(_case('test_a_full', 't1'), _case('test_b_full', 't1', _skip('NOT RUN: role')))
    out = _lane({'xml': xml, 'suites': SUITES})
    assert 'no test passed in: test_b_full' in out['error']


def test_an_unexpected_skip_fails_the_lane_even_when_the_suite_has_passes():
    xml = _xml(
        _case('test_a_full', 't1'),
        _case('test_a_full', 'test_limits', _skip('server does not allow GRAPH.CONFIG GET RESULTSET_SIZE')),
        _case('test_b_full', 't1'),
    )
    out = _lane({'xml': xml, 'suites': SUITES})
    assert out['error'] is not None
    assert 'skipped without a NOT RUN: reason' in out['error']
    assert 'test_a_full::test_limits' in out['error']
    assert 'RESULTSET_SIZE' in out['error']


def test_escaped_skip_messages_are_read():
    xml = _xml(
        _case('test_a_full', 't1'),
        _case('test_a_full', 't2', _skip('NOT RUN: needs &quot;RR_TEST_X&quot; &amp; a role')),
        _case('test_b_full', 't1'),
    )
    assert _lane({'xml': xml, 'suites': SUITES})['error'] is None


def test_requirement_defaults_and_overrides():
    out = _lane(
        {
            'required': [
                [None, False],  # nodes:test without the variable: optional
                [None, True],  # nodes:test-db without the variable: required
                ['1', False],
                ['yes', False],
                ['0', True],  # explicit opt-out
                ['false', True],
                ['', True],
            ]
        }
    )
    assert out['required'] == [False, True, True, True, False, False, True]


def test_in_suite_pooler_suites_must_pass_a_pooled_case_when_the_pooler_is_set():
    suites = ['test_p_full', 'test_q_full']
    both = _xml(
        _case('test_p_full', 'test_ingest[direct]'),
        _case('test_p_full', 'test_ingest[pooler]'),
        _case('test_q_full', 'test_vec[pooler]'),
    )
    assert _lane({'pooled': both, 'suites': suites})['pooledError'] is None
    direct_only = _xml(
        _case('test_p_full', 'test_ingest[direct]'),
        _case('test_p_full', 'test_ingest[pooler]', _skip('NOT RUN: the pooler DSN is not set')),
        _case('test_q_full', 'test_vec[pooler]'),
    )
    error = _lane({'pooled': direct_only, 'suites': suites})['pooledError']
    assert error is not None and 'test_p_full' in error and 'test_q_full' not in error


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------


def _registry():
    return _lane({'registry': True})


def test_every_registration_loads_and_no_suite_is_registered_twice():
    out = _registry()
    assert out['lanes'], 'at least the registrations in nodes/scripts/db-lanes/ load'
    assert [lane['file'] for lane in out['lanes']] == sorted(lane['file'] for lane in out['lanes'])
    assert len({lane['name'] for lane in out['lanes']}) == len(out['lanes'])
    assert len(out['suites']) == len(set(out['suites']))
    assert out['suites'] == [suite for lane in out['lanes'] for suite in lane['suites']]


def test_every_registered_suite_file_exists_and_every_pooler_suite_is_registered():
    out = _registry()
    for suite in out['suites']:
        assert (_TEST_DIR / suite).is_file(), f'{suite} is registered but nodes/test has no such file'
    for lane in out['lanes']:
        assert set(lane['poolerSuites']) <= set(out['suites']), lane['file']


# A suite that needs a live database names its server variable as a string literal
# (os.environ.get('RR_TEST_PG_DSN'), a helper's parameter, ...); a docstring or comment that
# merely mentions a variable does not make a suite one.
_READS_A_SERVER = re.compile(r"""['"]RR_(?:REQUIRE_DB_TESTS|TEST_[A-Z0-9_]*(?:DSN|URI|URL))['"]""")


def _needs_a_live_database(path: Path) -> bool:
    return bool(_READS_A_SERVER.search(path.read_text(encoding='utf-8', errors='replace')))


def test_every_suite_that_needs_a_live_database_is_registered():
    # An unregistered one would be collected by the mocked pass, where nodes/test/mocks
    # shadows its driver, and skip or fail there instead of running on the real server.
    registered = set(_registry()['suites'])
    for path in sorted(_TEST_DIR.glob('test_*.py')):
        if path.name == Path(__file__).name:
            continue
        if _needs_a_live_database(path):
            assert path.name in registered, (
                f'{path.name} reads a live-database variable but no nodes/scripts/db-lanes/*.js registers it'
            )


def _reg(name='x', **extra):
    return {'name': name, 'suites': ['test_x_full.py'], **extra}


def test_malformed_registrations_are_rejected():
    out = _lane(
        {
            'validate': [
                [_reg()],  # well-formed
                [_reg(name='Bad Name')],
                [_reg(suites=[])],
                [_reg(suites=['sub/test_x_full.py'])],
                [_reg(suites=['test_x_full.py', 'test_x_full.py'])],
                [_reg(poolerSuites=['test_x_full.py'], poolerMode='sideways', poolerEnv='RR_P')],
                [_reg(poolerSuites=['test_x_full.py'], poolerMode='second-pass', poolerEnv='RR_P')],  # no secondPassEnv
                [_reg(poolerSuites=['test_x_full.py'], poolerMode='in-suite', poolerEnv='lower')],
                [_reg(poolerMode='in-suite')],  # pooler fields without poolerSuites
                [_reg(poolerSuites=['test_missing_full.py'], poolerMode='in-suite', poolerEnv='RR_P')],
                [_reg('a'), _reg('b')],  # the same suite in two domains
                [_reg('a'), {'name': 'a', 'suites': ['test_y_full.py']}],  # a name taken
                [
                    _reg(
                        poolerSuites=['test_x_full.py'],
                        poolerMode='second-pass',
                        poolerEnv='RR_P',
                        hasSecondPassEnv=True,
                    ),
                    {
                        'name': 'z',
                        'suites': ['test_z_full.py'],
                        'poolerSuites': ['test_x_full.py'],
                        'poolerMode': 'in-suite',
                        'poolerEnv': 'RR_Q',
                    },
                ],  # a domain may put another domain's suite through its own pooler
            ]
        }
    )['validate']
    assert out[0] is None
    assert 'kebab-case' in out[1]
    assert 'non-empty array' in out[2]
    assert 'no directories' in out[3]
    assert 'twice' in out[4]
    assert 'poolerMode must be one of' in out[5]
    assert 'secondPassEnv' in out[6]
    assert 'poolerEnv must name' in out[7]
    assert 'need poolerSuites' in out[8]
    assert 'no registration lists' in out[9]
    assert 'already registered' in out[10]
    assert 'is taken' in out[11]
    assert out[12] is None


def test_the_mocked_pass_leaves_the_live_suites_out_by_path_wherever_pytest_runs():
    # pytest makes an --ignore-glob pattern absolute against its working directory, so the
    # glob holds only from nodes/ or above; an --ignore path holds from anywhere.
    out = _lane({'ignores': True, 'registry': True})
    test_dir = Path(out['testDir']).resolve()
    by_path = [str(test_dir / suite) for suite in out['suites']]

    def ignored(args):
        paths = [args[i + 1] for i, a in enumerate(args) if a == '--ignore']
        # Checked before resolving: a relative --ignore would hold only from one directory.
        assert all(Path(p).is_absolute() for p in paths), paths
        return [str(Path(p).resolve()) for p in paths]

    mocked, full = out['ignores']['mocked'], out['ignores']['full']
    assert ignored(mocked) == by_path, 'nodes:test leaves every live suite out by absolute path'
    assert ignored(full) == by_path, 'so does nodes:test-full'
    assert mocked[:4] == ['--ignore-glob', '**/test_*_full.py', '--ignore-glob', '**/test_*_full/**']
    assert '--ignore-glob' not in full, 'nodes:test-full collects the other _full suites'
