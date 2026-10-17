"""
Unit tests for per-task BLAS/OMP thread pinning (issue #2128).

Three seams:

- ``resolve_torch_threads``: the request value, the ``RR_TORCH_THREADS``
  fallback, the core-count ceiling, and the refusal to fail a launch over an
  unusable value.
- ``Task._build_subprocess_env``: the six thread variables reach the engine
  subprocess together, and only when a count was resolved.
- ``TaskServer.start_task``: the wire name reaches ``Task`` as the kwarg.

``Task.__init__`` and ``TaskServer.__init__`` are heavy (sockets, DAP base,
asyncio locks, background tasks), so tests bypass them via ``__new__`` and
seed only what the code under test reads.

``RR_TORCH_THREADS`` is read each time a task starts, so tests set it with
``monkeypatch.setenv`` and every test starts with it unset. The core count is
pinned to 8 for every test so results do not depend on the runner's size.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.constants import CONST_TORCH_THREAD_ENV_VARS, CONST_TORCH_THREADS_CPU_FALLBACK
from ai.modules.task import task_server as task_server_module
from ai.modules.task.task_engine import Task, filter_subprocess_env
from ai.modules.task.task_server import TaskServer, _usable_cpu_count, resolve_torch_threads


@pytest.fixture(autouse=True)
def _eight_cores(monkeypatch):
    monkeypatch.setattr(task_server_module, '_usable_cpu_count', lambda: 8)


@pytest.fixture(autouse=True)
def _no_server_default(monkeypatch):
    """Start every test without RR_TORCH_THREADS, whatever the runner has set."""
    monkeypatch.delenv('RR_TORCH_THREADS', raising=False)


# ---------------------------------------------------------------------------
# resolve_torch_threads
# ---------------------------------------------------------------------------


def test_explicit_request_wins_over_the_server_default(monkeypatch):
    monkeypatch.setenv('RR_TORCH_THREADS', '8')
    assert resolve_torch_threads(3) == 3


@pytest.mark.parametrize('value', ['4', ' 4 '])
def test_a_numeric_string_request_is_accepted(value):
    """JSON-RPC callers and env-shaped values both arrive as strings."""
    assert resolve_torch_threads(value) == 4


def test_explicit_zero_pins_nothing(monkeypatch):
    """0 is an answer, not "unset": it must not fall through to the default."""
    monkeypatch.setenv('RR_TORCH_THREADS', '8')
    assert resolve_torch_threads(0) == 0


def test_unset_falls_back_to_the_server_default(monkeypatch):
    monkeypatch.setenv('RR_TORCH_THREADS', '4')
    assert resolve_torch_threads(None) == 4


def test_an_empty_request_falls_back_to_the_server_default(monkeypatch):
    """'' is "unset", not an invalid value: no warning, and no silent 0."""
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)
    monkeypatch.setenv('RR_TORCH_THREADS', '4')

    assert resolve_torch_threads('') == 4

    warn.assert_not_called()


def test_unset_without_a_server_default_pins_nothing():
    assert resolve_torch_threads(None) == 0


def test_the_server_default_is_read_when_each_task_starts(monkeypatch):
    """The engine loads its .env after this module is imported; that value must still apply."""
    assert resolve_torch_threads(None) == 0

    monkeypatch.setenv('RR_TORCH_THREADS', '4')

    assert resolve_torch_threads(None) == 4


def test_an_over_ceiling_request_falls_back_to_the_server_default(monkeypatch):
    """A bad request value warns and gets the operator's default, not 0."""
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)
    monkeypatch.setenv('RR_TORCH_THREADS', '2')

    assert resolve_torch_threads(16) == 2

    warn.assert_called_once()
    assert 'torchThreads=16' in warn.call_args.args[0]


def test_unparseable_request_warns_and_pins_nothing(monkeypatch):
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)

    assert resolve_torch_threads('four') == 0

    warn.assert_called_once()
    assert 'torchThreads' in warn.call_args.args[0]


def test_negative_request_warns_and_pins_nothing(monkeypatch):
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)

    assert resolve_torch_threads(-1) == 0

    warn.assert_called_once()


def test_bool_request_is_rejected(monkeypatch):
    """A bool subclasses int, so True would otherwise quietly pin one thread."""
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)

    assert resolve_torch_threads(True) == 0

    warn.assert_called_once()
    assert 'torchThreads=True' in warn.call_args.args[0]


@pytest.mark.parametrize('value', [4.7, float('inf'), float('nan'), '4.7'])
def test_a_value_that_is_not_a_whole_number_warns_and_pins_nothing(monkeypatch, value):
    """int() would truncate 4.7 to 4 and raise OverflowError on inf."""
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)

    assert resolve_torch_threads(value) == 0

    warn.assert_called_once()


def test_a_whole_float_is_accepted():
    """A JSON number written as 4.0 parses to a float but still means 4."""
    assert resolve_torch_threads(4.0) == 4


def test_a_request_above_the_core_count_is_rejected(monkeypatch):
    """More threads than cores only oversubscribes, so treat it as a typo."""
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)

    assert resolve_torch_threads(8) == 8
    assert resolve_torch_threads(9) == 0

    warn.assert_called_once()
    assert '0 to 8' in warn.call_args.args[0]


# ---------------------------------------------------------------------------
# _usable_cpu_count: the ceiling
# ---------------------------------------------------------------------------


def test_the_affinity_mask_wins_over_the_machine_core_count(monkeypatch):
    """A cpuset-limited container counts; a CFS cpu quota does not narrow the mask."""
    monkeypatch.setattr(task_server_module.os, 'sched_getaffinity', lambda pid: {0, 1}, raising=False)
    monkeypatch.setattr(task_server_module.os, 'cpu_count', lambda: 8)

    assert _usable_cpu_count() == 2


def _affinity_fails(pid):
    raise OSError('no affinity')


@pytest.mark.parametrize('affinity', [None, _affinity_fails], ids=['missing', 'raises'])
def test_without_an_affinity_mask_the_machine_core_count_is_used(monkeypatch, affinity):
    """Windows and macOS have no sched_getaffinity."""
    if affinity is None:
        monkeypatch.delattr(task_server_module.os, 'sched_getaffinity', raising=False)
    else:
        monkeypatch.setattr(task_server_module.os, 'sched_getaffinity', affinity, raising=False)
    monkeypatch.setattr(task_server_module.os, 'cpu_count', lambda: 8)

    assert _usable_cpu_count() == 8


def test_an_unknown_core_count_falls_back_to_a_fixed_ceiling(monkeypatch):
    """os.cpu_count() returns None on exotic hosts; still cap the value."""
    monkeypatch.delattr(task_server_module.os, 'sched_getaffinity', raising=False)
    monkeypatch.setattr(task_server_module.os, 'cpu_count', lambda: None)

    assert _usable_cpu_count() == CONST_TORCH_THREADS_CPU_FALLBACK


@pytest.mark.parametrize('value', ['lots', '4.7', '9'])
def test_an_invalid_server_default_warns_and_pins_nothing(monkeypatch, value):
    """warning(), not the trace-gated debug(): a bad server default has to surface."""
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)
    monkeypatch.setenv('RR_TORCH_THREADS', value)

    assert resolve_torch_threads(None) == 0

    warn.assert_called_once()
    # The operator, not the caller, has to know which value was dropped.
    assert f'RR_TORCH_THREADS={value!r}' in warn.call_args.args[0]


# ---------------------------------------------------------------------------
# Task._build_subprocess_env: thread-variable injection
# ---------------------------------------------------------------------------


def _task(*, torch_threads):
    """Build a Task with ``__init__`` bypassed, seeded for the env build only."""
    t = Task.__new__(Task)
    t._torch_threads = torch_threads
    t._pipeline = {}  # no RocketRide DB nodes, so no DSN resolution
    return t


async def _build_env(t):
    """Build the env the way start_task does: from _db_access of the pipeline."""
    return await Task._build_subprocess_env(t, Task._db_access(t, t._pipeline))


@pytest.fixture
def _allowlist_only(monkeypatch):
    """The default subprocess env: no operator opt-in widening the allowlist."""
    monkeypatch.delenv('RR_SUBPROCESS_ENV', raising=False)


@pytest.mark.asyncio
async def test_all_six_thread_vars_are_pinned_together(_allowlist_only):
    """Pinning OMP alone still lets MKL or OpenBLAS take every core."""
    env = await _build_env(_task(torch_threads=4))

    assert [env[var] for var in CONST_TORCH_THREAD_ENV_VARS] == ['4'] * 6


@pytest.mark.asyncio
async def test_zero_injects_nothing(monkeypatch, _allowlist_only):
    """With 0 the child keeps the operator's own value and gets nothing added."""
    for var in CONST_TORCH_THREAD_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv('OMP_NUM_THREADS', '12')

    env = await _build_env(_task(torch_threads=0))

    assert env['OMP_NUM_THREADS'] == '12'
    assert [var for var in CONST_TORCH_THREAD_ENV_VARS if var in env] == ['OMP_NUM_THREADS']


def test_the_allowlist_passes_every_pinned_name():
    """With pinning off, an operator's value for any of the six reaches the child."""
    ambient = {var: '12' for var in CONST_TORCH_THREAD_ENV_VARS}

    assert filter_subprocess_env(ambient) == ambient


@pytest.mark.asyncio
async def test_a_resolved_count_overrides_the_inherited_value(monkeypatch, _allowlist_only):
    """The per-task count is the specific answer; the ambient one is a default."""
    monkeypatch.setenv('OMP_NUM_THREADS', '12')

    env = await _build_env(_task(torch_threads=2))

    assert env['OMP_NUM_THREADS'] == '2'


# ---------------------------------------------------------------------------
# TaskServer.start_task: the request path
# ---------------------------------------------------------------------------

_PIPELINE = {
    'project_id': 'project-1',
    'source': 'src',
    'components': [{'id': 'src', 'provider': 'webhook', 'config': {}}],
}


def _server():
    """A TaskServer with no event loop, no ports and no real account service."""
    ts = TaskServer.__new__(TaskServer)
    ts._task_control = {}
    ts._connections = {}
    ts._connection_id = 0
    ts._unauthed_by_ip = {}
    ts._allocated_ports = []
    ts._reserved_ports = set()
    ts._store_instance = None
    ts._config = {}
    ts._server = MagicMock()
    ts._server.account.generate_token.return_value = 'tk_generated'
    ts.debug_message = MagicMock()
    return ts


def _patch_task(monkeypatch):
    """Stand in for Task so start_task runs without an engine subprocess."""
    task_cls = MagicMock()
    task_cls.return_value.start_task = AsyncMock()
    task_cls.return_value._stop_requested = False
    monkeypatch.setattr(task_server_module, 'Task', task_cls)
    return task_cls


@pytest.mark.asyncio
async def test_torch_threads_travels_from_the_request_to_the_task(monkeypatch):
    """The wire spells it torchThreads; Task takes torch_threads."""
    task_cls = _patch_task(monkeypatch)
    ts = _server()

    await ts.start_task(
        {'command': 'launch', 'arguments': {'pipeline': _PIPELINE, 'torchThreads': 3}},
        conn=MagicMock(),
    )

    assert task_cls.call_args.kwargs['torch_threads'] == 3


@pytest.mark.asyncio
async def test_a_request_without_torch_threads_starts_the_task_unpinned(monkeypatch):
    """No default configured, nothing asked for: the task pins nothing."""
    task_cls = _patch_task(monkeypatch)
    ts = _server()

    await ts.start_task({'command': 'launch', 'arguments': {'pipeline': _PIPELINE}}, conn=MagicMock())

    assert task_cls.call_args.kwargs['torch_threads'] == 0


@pytest.mark.asyncio
async def test_a_reused_task_does_not_resolve_torch_threads(monkeypatch):
    """A useExisting launch returns the running task, so a bad value there must not warn."""
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)
    task_cls = _patch_task(monkeypatch)
    ts = _server()
    running = MagicMock()
    running.task.is_task_complete.return_value = False
    ts._task_control['tk_generated'] = running

    result = await ts.start_task(
        {'command': 'launch', 'arguments': {'pipeline': _PIPELINE, 'useExisting': True, 'torchThreads': 'lots'}},
        conn=MagicMock(),
    )

    assert result['reused'] is True
    task_cls.assert_not_called()
    warn.assert_not_called()
