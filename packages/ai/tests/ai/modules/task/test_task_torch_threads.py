"""
Unit tests for per-task BLAS/OMP thread pinning (issue #2128).

Two seams:

- ``resolve_torch_threads`` — the request value, the
  ``ROCKETRIDE_TORCH_THREADS`` fallback, and the refusal to fail a launch
  over an unusable value.
- ``Task._build_subprocess_env`` — the six thread variables reach the engine
  subprocess together, and only when a count was resolved.
- ``TaskServer.start_task`` — the wire name reaches ``Task`` as the kwarg.

``Task.__init__`` and ``TaskServer.__init__`` are heavy (sockets, DAP base,
asyncio locks, background tasks), so tests bypass them via ``__new__`` and
seed only what the code under test reads.

``CONST_DEFAULT_TORCH_THREADS`` is read at import time, so the fallback tests
patch the module attribute rather than the environment.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from ai.constants import CONST_TORCH_THREAD_ENV_VARS
from ai.modules.task import task_server as task_server_module
from ai.modules.task.task_engine import Task
from ai.modules.task.task_server import TaskServer, resolve_torch_threads


# ---------------------------------------------------------------------------
# resolve_torch_threads
# ---------------------------------------------------------------------------


def test_explicit_request_wins_over_the_server_default(monkeypatch):
    monkeypatch.setattr(task_server_module, 'CONST_DEFAULT_TORCH_THREADS', '8')
    assert resolve_torch_threads(3) == 3


def test_a_numeric_string_request_is_accepted():
    """JSON-RPC callers and env-shaped values both arrive as strings."""
    assert resolve_torch_threads('4') == 4


def test_explicit_zero_pins_nothing(monkeypatch):
    """0 is an answer, not "unset": it must not fall through to the default."""
    monkeypatch.setattr(task_server_module, 'CONST_DEFAULT_TORCH_THREADS', '8')
    assert resolve_torch_threads(0) == 0


def test_unset_falls_back_to_the_server_default(monkeypatch):
    monkeypatch.setattr(task_server_module, 'CONST_DEFAULT_TORCH_THREADS', '4')
    assert resolve_torch_threads(None) == 4


def test_unset_without_a_server_default_pins_nothing(monkeypatch):
    monkeypatch.setattr(task_server_module, 'CONST_DEFAULT_TORCH_THREADS', None)
    assert resolve_torch_threads(None) == 0


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
    """A bool subclasses int — True would otherwise quietly pin one thread."""
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)

    assert resolve_torch_threads(True) == 0

    warn.assert_called_once()


def test_a_request_above_the_core_count_is_rejected(monkeypatch):
    """More threads than cores only oversubscribes — treat it as a typo."""
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'warning', warn)
    monkeypatch.setattr(task_server_module.os, 'cpu_count', lambda: 8)

    assert resolve_torch_threads(8) == 8
    assert resolve_torch_threads(9) == 0

    warn.assert_called_once()
    assert '0 to 8' in warn.call_args.args[0]


def test_an_unknown_core_count_falls_back_to_a_fixed_ceiling(monkeypatch):
    """os.cpu_count() returns None on exotic hosts; still cap the value."""
    monkeypatch.setattr(task_server_module, 'warning', MagicMock())
    monkeypatch.setattr(task_server_module.os, 'cpu_count', lambda: None)

    assert resolve_torch_threads(64) == 64
    assert resolve_torch_threads(65) == 0


def test_the_warning_is_ungated_so_operators_see_it(monkeypatch):
    """debug() is trace-gated; a bad server default has to surface anyway."""
    debug = MagicMock()
    warn = MagicMock()
    monkeypatch.setattr(task_server_module, 'debug', debug)
    monkeypatch.setattr(task_server_module, 'warning', warn)
    monkeypatch.setattr(task_server_module, 'CONST_DEFAULT_TORCH_THREADS', 'lots')

    assert resolve_torch_threads(None) == 0

    debug.assert_not_called()
    warn.assert_called_once()
    # The operator, not the caller, has to know which value was dropped.
    assert 'ROCKETRIDE_TORCH_THREADS' in warn.call_args.args[0]


# ---------------------------------------------------------------------------
# Task._build_subprocess_env — thread-variable injection
# ---------------------------------------------------------------------------


def _task(*, torch_threads):
    """Build a Task with ``__init__`` bypassed, seeded for the env build only."""
    t = Task.__new__(Task)
    t._torch_threads = torch_threads
    t._pipeline = {}  # no RocketRide DB nodes, so no DSN resolution
    t.client_id = 'client-1'
    t.org_id = 'org-1'
    t.debug_message = MagicMock()
    return t


@pytest.mark.asyncio
async def test_all_six_thread_vars_are_pinned_together():
    """Pinning OMP alone still lets MKL or OpenBLAS take every core."""
    env = await Task._build_subprocess_env(_task(torch_threads=4))

    assert [env[var] for var in CONST_TORCH_THREAD_ENV_VARS] == ['4'] * 6


@pytest.mark.asyncio
async def test_zero_injects_nothing(monkeypatch):
    """Pre-feature behaviour: the child inherits the operator's environment."""
    for var in CONST_TORCH_THREAD_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv('OMP_NUM_THREADS', '12')

    env = await Task._build_subprocess_env(_task(torch_threads=0))

    assert env['OMP_NUM_THREADS'] == '12'
    assert [var for var in CONST_TORCH_THREAD_ENV_VARS if var in env] == ['OMP_NUM_THREADS']


@pytest.mark.asyncio
async def test_a_resolved_count_overrides_the_inherited_value(monkeypatch):
    """The per-task count is the specific answer; the ambient one is a default."""
    monkeypatch.setenv('OMP_NUM_THREADS', '12')

    env = await Task._build_subprocess_env(_task(torch_threads=2))

    assert env['OMP_NUM_THREADS'] == '2'


# ---------------------------------------------------------------------------
# TaskServer.start_task — the request path
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
    monkeypatch.setattr(task_server_module, 'CONST_DEFAULT_TORCH_THREADS', None)
    task_cls = _patch_task(monkeypatch)
    ts = _server()

    await ts.start_task({'command': 'launch', 'arguments': {'pipeline': _PIPELINE}}, conn=MagicMock())

    assert task_cls.call_args.kwargs['torch_threads'] == 0
