# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Pytest configuration and fixtures for node integration tests.

This module provides:
- Server availability checking
- RocketRideClient fixtures
- Dynamic test generation from service.json 'test' configs

Configuration via environment variables:
    ROCKETRIDE_URI           - Server URI (default: http://localhost:5565)
    ROCKETRIDE_APIKEY        - API key for authentication (default: MYAPIKEY)
    ROCKETRIDE_INCLUDE_SKIP  - Comma-separated node names to opt into (e.g. embedding_image,ocr).
                               Use to run skip_nodes when explicitly requested.
    ROCKETRIDE_TEST_DEVICE, ROCKETRIDE_TEST_VRAM_GB, ROCKETRIDE_TEST_RAM_GB
                             - Describe the test server's hardware instead of probing this machine.
    ROCKETRIDE_TEST_HARDWARE_STRICT - Fail (instead of skip) tests whose requiresHardware is not met.
    ROCKETRIDE_TEST_HW_LANES - Heavy tests allowed to run at once under xdist: 1 (default), N, or auto.

Running tests:
    # Run all tests (requires server)
    builder nodes:test

    # Run contract tests only (no server needed)
    pytest nodes/test/test_contracts.py -v

    # Run dynamic node tests
    pytest nodes/test/test_dynamic.py -v
"""

import os
import asyncio
import contextlib
import pytest
import pytest_asyncio
from pathlib import Path
from typing import Dict, Any, List

# Derive paths from the engine executable (dist/server/engine.exe)
# so they resolve correctly whether rocketride-server is standalone or a submodule.
import sys

_ENGINE_DIR = Path(sys.executable).resolve().parent

# Load environment variables from the build output root (next to the engine).
try:
    from dotenv import load_dotenv

    load_dotenv(_ENGINE_DIR / '.env')
except ImportError:
    pass  # dotenv is optional


# The sys.modules isolation guard (see #1640) lives in _sys_modules_guard so it is
# unit-testable in isolation; importing the hooks registers them with pytest.
# Imported package-relative on purpose: putting this directory on sys.path would let
# its node-named subpackages (text_output/, response/, telegram/, ...) shadow the real
# node packages under src/nodes (see #1687).
from ._sys_modules_guard import (  # noqa: E402,F401
    pytest_collectreport,
    pytest_collectstart,
    pytest_sessionfinish,
    pytest_terminal_summary,
)


# =============================================================================
# Test Configuration
# =============================================================================


class TestConfig:
    """Test configuration loaded from environment variables."""

    def __init__(self) -> None:
        """Initialize test configuration from ROCKETRIDE_* environment variables."""
        self.uri = os.getenv('ROCKETRIDE_URI', 'http://localhost:5565')
        self.auth = os.getenv('ROCKETRIDE_APIKEY', 'MYAPIKEY')
        self.timeout = float(os.getenv('ROCKETRIDE_TEST_TIMEOUT', '30.0'))

    def as_dict(self) -> Dict[str, Any]:
        """
        Return the test configuration as a dictionary.

        Returns:
            Dictionary containing the test configuration.
        """
        return {'uri': self.uri, 'auth': self.auth, 'timeout': self.timeout}


# Global config instance
TEST_CONFIG = TestConfig()


# =============================================================================
# Server Availability
# =============================================================================


async def is_server_available() -> bool:
    """Check if test server is available."""
    try:
        from rocketride import RocketRideClient

        client = RocketRideClient(uri=TEST_CONFIG.uri, auth=TEST_CONFIG.auth)
        await client.connect()
        await client.ping()
        await client.disconnect()
        return True
    except Exception:
        return False


@pytest_asyncio.fixture(scope='session')
async def server_available():
    """Check server availability once per session."""
    available = await is_server_available()
    if not available:
        pytest.skip(
            f"Server not available at {TEST_CONFIG.uri}. Run 'builder nodes:test' to start server automatically."
        )
    return True


# =============================================================================
# Client Fixtures
# =============================================================================


@pytest_asyncio.fixture
async def client(server_available):  # noqa: ARG001 — pytest fixture dependency, not unused
    """
    Provide a connected RocketRideClient for tests.

    Usage:
        async def test_something(client):
            result = await client.use(pipeline=pipeline)
            ...
    """
    from rocketride import RocketRideClient

    _client = RocketRideClient(uri=TEST_CONFIG.uri, auth=TEST_CONFIG.auth)
    await _client.connect()

    yield _client

    if _client.is_connected():
        try:
            await asyncio.wait_for(_client.disconnect(), timeout=10.0)
        except (asyncio.TimeoutError, Exception):
            pass  # Best-effort cleanup — don't let teardown hang the suite


@pytest.fixture
def test_config():
    """Provide test configuration."""
    return TEST_CONFIG


# =============================================================================
# Test Markers
# =============================================================================


def pytest_configure(config):
    """Register custom markers, resolve the hardware snapshot, enable collect-only modes."""
    config.addinivalue_line('markers', 'requires_server: mark test as requiring a running server')
    config.addinivalue_line('markers', 'node(name): mark test as testing a specific node')
    config.addinivalue_line(
        'markers',
        'skip_node: test for a node in skip_nodes (excluded from default run; run with -m skip_node or -k <node_name>)',
    )
    config.addinivalue_line('markers', 'requires_hardware(device, need_gb): heavy test gated by requiresHardware')
    config.addinivalue_line(
        'markers', 'hardware_unmet(reason, strict): requiresHardware invalid, or not met in strict mode'
    )

    workerinput = getattr(config, 'workerinput', None)
    if workerinput and gate.WORKER_KEY in workerinput:
        snapshot = HardwareSnapshot.from_dict(workerinput[gate.WORKER_KEY])
    else:
        try:
            gate.parse_lanes(os.environ.get(gate.ENV_LANES))
            snapshot = gate.resolve_snapshot(os.environ, TEST_CONFIG.uri)
        except ValueError as exc:
            raise pytest.UsageError(str(exc)) from exc
    config.stash[_SNAPSHOT] = snapshot

    warmup_mode = config.getoption('warmup_models', None)
    list_mode = config.getoption('list_skipped', None)
    if warmup_mode and list_mode:
        raise pytest.UsageError('--warmup-models and --list-skipped cannot be combined')
    if warmup_mode or list_mode:
        if _worker_count(config) > 1:
            raise pytest.UsageError('--warmup-models / --list-skipped run in a single process; drop -n')
        mode = _WarmupMode(config) if warmup_mode else _SkipReportMode(config)
        config.pluginmanager.register(mode, 'rocketride-collect-mode')


# =============================================================================
# Dynamic Node Test Framework
# =============================================================================

from ai.common.utils.hardware import HardwareSnapshot  # noqa: E402

from .framework import discover_testable_nodes, gate, warmup, NodeTestConfig, NodeTestRunner  # noqa: E402


@pytest.fixture(scope='session')
def testable_nodes() -> List[NodeTestConfig]:
    """Discover all nodes with test configurations."""
    return discover_testable_nodes()


@pytest_asyncio.fixture
async def node_test_runner(client):
    """
    Fixture to create a TestRunner for a specific node config.

    Usage:
        @pytest.mark.parametrize('node_config', [...])
        async def test_node(node_test_runner, node_config):
            runner = await node_test_runner(node_config)
            ...
    """
    runners = []

    async def _create_runner(config: NodeTestConfig, profile: str | None = None) -> NodeTestRunner:
        runner = NodeTestRunner(client, config, profile)
        await runner.setup()
        runners.append(runner)
        return runner

    yield _create_runner

    # Cleanup all runners
    for runner in runners:
        await runner.teardown()


# =============================================================================
# Gating: environment, native libraries, hardware
# =============================================================================

# Excluded from the default dynamic run (test_dynamic.py): they pull large libraries,
# use heavy models, or depend on local services, which would cause CI timeouts or OOM.
# Opt in via ROCKETRIDE_INCLUDE_SKIP:
#   ROCKETRIDE_INCLUDE_SKIP=embedding_image pytest nodes/test/test_dynamic.py -v -k embedding_image
SKIP_NODES = {
    'anonymize',
    'ocr',
    'ner',
    'embedding_image',
    # Download model weights from huggingface.co at test time, so they turn the
    # required CI check red whenever the HF hub is unreachable/rate-limited — on
    # PRs unrelated to embeddings (RR-1120). Same class as embedding_image above.
    'embedding_transformer',  # sentence-transformers (miniLM)
    'embedding_video',  # CLIP (openai-patch16)
    'image_cleanup',
    'frame_grabber',
    'audio_transcribe',  # it downloads faster-whisper model (1.5GB)
    'audio_tts',
    # Heavy vision models (model download); opt in via ROCKETRIDE_INCLUDE_SKIP.
    'depth_estimate',
    'detect',
    'detect_segment',
    'caption',
    'background_removal',
    'pose_estimation',
    'face_detection',
    # Temporarily exclude nodes with failing tests until they can be fixed and re-enabled:
    'store_elasticsearch',
    # Require live third-party API credentials (no live calls in default CI):
    'tool_xtrace_memory',
    'tool_mem0',
    # Hits data.sec.gov from the services.json test block; opt in via
    # ROCKETRIDE_INCLUDE_SKIP=authoritative_overlay.
    'authoritative_overlay',
}

_SNAPSHOT = pytest.StashKey[HardwareSnapshot]()
_PLAN = pytest.StashKey[gate.Plan]()


def pytest_addoption(parser):
    """Register the collect-only modes."""
    group = parser.getgroup('rocketride', 'RocketRide node tests')
    group.addoption(
        '--warmup-models',
        nargs='?',
        const='download',
        choices=('download', 'plan'),
        default=None,
        help='Download the models of the selected heavy tests instead of running them; "plan" only lists them.',
    )
    group.addoption(
        '--list-skipped',
        nargs='?',
        const='all',
        choices=('all',) + gate.CATEGORIES,
        default=None,
        help='List the selected tests that will be skipped, grouped by reason, instead of running them.',
    )
    group.addoption(
        '--rocketride-report',
        metavar='PATH',
        default=None,
        help='Also write the --warmup-models / --list-skipped report to PATH (the builder prints it at the end).',
    )


def _worker_count(config) -> int:
    """Number of xdist workers in this session (1 without xdist)."""
    workerinput = getattr(config, 'workerinput', None)
    if workerinput:
        return int(workerinput.get('workercount', 1))
    if getattr(config.option, 'dist', 'no') == 'no':
        return 1
    return max(1, len(getattr(config.option, 'tx', None) or []))


def _suite_timeout(config):
    """The pytest-timeout limit in effect (CLI over ini), or None."""
    try:
        value = config.getoption('timeout', None)
        if value is None:
            value = config.getini('timeout')
        return float(value) if value not in (None, '') else None
    except (ValueError, TypeError):
        return None


def _plan(config) -> gate.Plan:
    """Gating decisions for every dynamic test parameter, computed once per process."""
    if _PLAN not in config.stash:
        snapshot = config.stash[_SNAPSHOT]
        strict = gate.truthy(os.environ.get(gate.ENV_STRICT))
        include_skip = {n.strip() for n in os.environ.get('ROCKETRIDE_INCLUDE_SKIP', '').split(',') if n.strip()}
        specs = gate.build_specs(discover_testable_nodes(), 'test', snapshot, strict, SKIP_NODES, include_skip)
        # fulltest runs explicitly (nodes:test-full), so no skip_nodes filter.
        specs += gate.build_specs(discover_testable_nodes(test_key='fulltest'), 'fulltest', snapshot, strict)
        lanes, count = gate.assign_lanes(
            specs, snapshot, _worker_count(config), gate.parse_lanes(os.environ.get(gate.ENV_LANES))
        )
        config.stash[_PLAN] = gate.Plan(snapshot, strict, specs, lanes, count)
    return config.stash[_PLAN]


def _params(config, test_key: str):
    """pytest.param entries for one test key.

    Marks are applied here, not in `pytest_collection_modifyitems`, because xdist
    reads `xdist_group` during its own collection pass. Heavy tests share lanes
    (`hwN` groups) so that, under `--dist loadgroup`, each lane runs serially.
    """
    plan = _plan(config)
    suite_timeout = _suite_timeout(config)
    params = []
    for spec in plan.for_key(test_key):
        marks = []
        if spec.skip:
            marks.append(pytest.mark.skip(reason=spec.skip))
        if spec.fail:
            marks.append(pytest.mark.hardware_unmet(reason=spec.fail, strict=spec.fail_strict))
        if spec.heavy:
            marks.append(pytest.mark.xdist_group(f'hw{plan.lanes.get(spec.key, 0)}'))
            if spec.runnable:
                marks.append(pytest.mark.requires_hardware(device=spec.device, need_gb=spec.need_gb))
        # Group timeouts only extend the suite limit; they never shorten it.
        if suite_timeout and spec.timeout and spec.timeout > suite_timeout:
            marks.append(pytest.mark.timeout(spec.timeout))
        params.append(pytest.param((spec.config, spec.profile), id=spec.id, marks=marks))
    return params


def pytest_generate_tests(metafunc):
    """Parametrize the dynamic tests from the 'test' and 'fulltest' keys of service*.json."""
    if 'node_test_config' in metafunc.fixturenames:
        metafunc.parametrize('node_test_config', _params(metafunc.config, 'test'))
    if 'node_fulltest_config' in metafunc.fixturenames:
        metafunc.parametrize('node_fulltest_config', _params(metafunc.config, 'fulltest'))


@pytest.hookimpl(optionalhook=True)
def pytest_configure_node(node):
    """Hand the controller's hardware snapshot to each xdist worker."""
    node.workerinput[gate.WORKER_KEY] = node.config.stash[_SNAPSHOT].to_dict()


@pytest.hookimpl(optionalhook=True)
def pytest_xdist_node_collection_finished(node, ids):
    """Abort before any test runs when heavy tests would run side by side."""
    config = node.config
    dist = config.getoption('dist', 'no')
    workers = _worker_count(config)
    if dist == 'loadgroup' or workers <= 1:
        return
    hits = gate.heavy_nodeids(ids, _plan(config).runnable_heavy_keys())
    if hits:
        pytest.exit(
            f'{len(hits)} heavy test(s) selected (e.g. {hits[0]}) with {workers} xdist workers and '
            f'--dist {dist}; heavy tests need --dist loadgroup to run in their lanes.',
            returncode=pytest.ExitCode.USAGE_ERROR,
        )


def pytest_report_header(config):
    """Show what the hardware gate sees."""
    bits = [f'strict {"on" if gate.truthy(os.environ.get(gate.ENV_STRICT)) else "off"}']
    if _worker_count(config) > 1:
        lanes = os.environ.get(gate.ENV_LANES) or '1'
        bits.append(f'{_plan(config).lane_count} heavy lane(s) ({gate.ENV_LANES}={lanes})')
    return f'hardware: {config.stash[_SNAPSHOT].describe()}; {", ".join(bits)}'


def pytest_runtest_setup(item):
    """Fail strict-mode hardware misses; wait for a heavy CUDA test's VRAM to be free."""
    unmet = item.get_closest_marker('hardware_unmet')
    if unmet:
        reason = unmet.kwargs['reason']
        if unmet.kwargs.get('strict'):
            reason += f' (strict mode: {gate.ENV_STRICT} is set)'
        pytest.fail(reason, pytrace=False)

    hw = item.get_closest_marker('requires_hardware')
    if not hw or hw.kwargs.get('device') != 'cuda' or not hw.kwargs.get('need_gb'):
        return
    if item.config.stash[_SNAPSHOT].source != 'probe':
        return
    need = hw.kwargs['need_gb']
    ok, mem = gate.wait_for_free_vram(need)
    if not ok:
        held = f' (held by: {", ".join(mem.residents)})' if mem.residents else ''
        pytest.fail(
            f'[hardware] needs {need:g} GB free VRAM but only {mem.free_gb:.1f} GB of {mem.total_gb:.1f} GB '
            f'is free after {gate.PREFLIGHT_WAIT_S:.0f}s{held}. An earlier test kept its memory, or another '
            f'process is using the GPU.',
            pytrace=False,
        )


# =============================================================================
# Collect-only modes: --warmup-models, --list-skipped
# =============================================================================


def _static_skip_reason(item):
    """Reason a skip/skipif mark would skip ``item`` with, or None."""
    try:
        from _pytest.skipping import evaluate_skip_marks
    except ImportError:
        mark = item.get_closest_marker('skip')
        if mark is None:
            return None
        return mark.kwargs.get('reason') or (mark.args[0] if mark.args else 'unconditional skip')
    try:
        skipped = evaluate_skip_marks(item)
    except Exception:
        return None
    return skipped.reason if skipped else None


class _CollectMode:
    """Plugin base: collect, act on the selected items, run none of them.

    Registered from `pytest_configure` as a separate plugin object so its hooks
    don't clash with the conftest's own (e.g. the sys.modules guard's).
    """

    title = ''

    def __init__(self, config):
        """Remember the config; report lines accumulate in `lines`."""
        self.config = config
        self.lines: List[str] = []

    def handle(self, items) -> None:
        """Act on the selected items (subclass hook)."""
        raise NotImplementedError

    @pytest.hookimpl(trylast=True)
    def pytest_collection_modifyitems(self, session, config, items):
        """Hand the final selection (after -k/-m) to `handle`, then deselect everything."""
        selected = list(items)
        self.handle(selected)
        config.hook.pytest_deselected(items=selected)
        items[:] = []

    def pytest_sessionfinish(self, session, exitstatus):  # noqa: F811 - plugin-object hook, not the conftest one
        """Report success (running no tests is the point) and write the report file, if asked."""
        if exitstatus == pytest.ExitCode.NO_TESTS_COLLECTED:
            session.exitstatus = pytest.ExitCode.OK
        report = self.config.getoption('rocketride_report', None)
        if report and self.lines:
            heading = self.title[:1].upper() + self.title[1:]
            Path(report).write_text('\n'.join([heading, *self.lines]) + '\n', encoding='utf-8')

    def pytest_terminal_summary(self, terminalreporter):  # noqa: F811 - plugin-object hook, not the conftest one
        """Print the accumulated report as its own section."""
        if self.lines:
            terminalreporter.section(self.title)
            for line in self.lines:
                terminalreporter.write_line(line)


class _SkipReportMode(_CollectMode):
    """--list-skipped: report the selected tests that will be skipped, by reason."""

    title = 'tests that will be skipped'

    def __init__(self, config):
        """Also track module-level skips, which never become items."""
        super().__init__(config)
        self.collect_skips = []

    def pytest_collectreport(self, report):  # noqa: F811 - plugin-object hook, not the conftest one
        """Record a module skipped at collection (``pytest.skip(allow_module_level=True)``)."""
        if report.skipped and isinstance(report.longrepr, tuple):
            category, text = gate.split_reason(str(report.longrepr[2]))
            self.collect_skips.append((report.nodeid, category, text, None))

    def handle(self, items) -> None:
        """Categorise each item's skip (or strict-mode failure) reason."""
        entries = list(self.collect_skips)
        for item in items:
            unmet = item.get_closest_marker('hardware_unmet')
            reason = unmet.kwargs['reason'] if unmet else _static_skip_reason(item)
            if reason is not None:
                category, text = gate.split_reason(reason)
                note = None
                if unmet:
                    note = 'fails in strict mode' if unmet.kwargs.get('strict') else 'fails: invalid declaration'
                entries.append((item.nodeid, category, text, note))
        only = self.config.getoption('list_skipped')
        selected = len(items) + len(self.collect_skips)
        self.lines = gate.format_skip_report(entries, selected, _plan(self.config), only)


class _WarmupMode(_CollectMode):
    """--warmup-models: fetch (or, with =plan, list) the models of the selected heavy tests."""

    title = 'model warmup'

    def handle(self, items) -> None:
        """Resolve the runnable heavy items to snapshots and fetch what is missing.

        A failed download is reported, not fatal: the affected test fails on its
        own with the real error.
        """
        pairs = []
        for item in items:
            callspec = getattr(item, 'callspec', None)
            if callspec is None or not item.get_closest_marker('requires_hardware'):
                continue
            pair = callspec.params.get('node_test_config') or callspec.params.get('node_fulltest_config')
            if pair:
                pairs.append(pair)
        refs = warmup.collect_refs(pairs)
        download = self.config.getoption('warmup_models') == 'download'
        tr = self.config.pluginmanager.get_plugin('terminalreporter')
        capman = self.config.pluginmanager.get_plugin('capturemanager')
        write = tr.write_line if tr else print

        pending = not_ready = 0
        for ref in refs:
            status = warmup.inspect(ref)
            line = warmup.describe(status)
            error = status.error
            if download and status.missing and not error:
                write(f'warmup: downloading {line}')
                with capman.global_and_fixture_disabled() if capman else contextlib.nullcontext():
                    error = warmup.download(status)
                line = f'{ref.label}: download failed ({error})' if error else f'{ref.label}: downloaded'
            elif not error:
                pending += status.missing_bytes
            not_ready += bool(error)
            self.lines.append(line)

        summary = f'{len(refs)} model(s) for {len(pairs)} selected heavy test(s)'
        if not download:
            summary += f'; {warmup.format_size(pending)} to download'
        self.lines.append(summary)
        if not_ready:
            self.lines.append(f'{not_ready} model(s) not ready; their tests will fail when they load them.')
