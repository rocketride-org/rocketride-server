# Copyright 2026 Aparavi Software AG. MIT License.
"""Visibility tools: `monitor`, `list_running_pipelines`.

**REDESIGNED from the original event-streaming design.** The design (see
tool-specs.md Visibility section) originally specified `monitor` as
`set_events`/`add_monitor` -> `rrext_monitor` event collection until
terminal. A live probe found that `set_events(token, [...])` plus a global
`on_event` handler captures **zero** events for a real run -- events flow
through per-send pipe-scoped `on_sse` or `add_monitor`, not the global
handler. `monitor` is therefore reimplemented as a **bounded poll of
`get_task_status`**, not event streaming.

State enum is an integer (the SDK docstring's string states are wrong):
``0 none, 1 starting, 2 initializing, 3 running, 4 stopping, 5 completed,
6 cancelled``. A task is terminal when ``state in {5, 6}`` OR
``status.get('completed')`` is truthy (ORed, not ANDed -- either signal is
sufficient). Long-lived sources (e.g. a webhook trigger) can sit at
``running(3)`` forever, so the poll is bounded by a wall-clock `timeout`
(via `time.monotonic()`, not wall-clock `datetime.now()`, so it's immune to
system clock adjustments) -- when the timeout elapses without a terminal
state, `monitor` returns the current (non-terminal) snapshot rather than
hanging. There is no synchronous `get_trace()` method in the SDK; the old
"trace" concept is absorbed into this snapshot.

`get_task_status` may raise on a terminated/unknown token (a live finding to
watch for). That exception is tolerated and normalized via
`errors.normalize_error` rather than left to crash the poll loop -- a hard
failure (connection/auth/timeout) still raises `HardError` and surfaces as
an MCP tool error, exactly as every other tool handler in this package
behaves.

Each individual `get_task_status` call is wrapped in its own
`asyncio.wait_for(..., timeout=_per_poll_timeout(...))` so one hung status
call cannot itself exceed the overall poll deadline. A single poll timing
out is not treated as a hard error: it breaks the loop and returns the
current (last-known) snapshot, same as the overall `timeout` elapsing.

On a terminal state, `monitor` also removes the token from the server-owned
`TaskRegistry` (`tasks.remove(token)`) -- once a task is terminal there is
nothing left to poll or terminate, and leaving it registered would leak
memory for the life of the process (see `registry.py`).

`list_running_pipelines` is a thin wrapper over the pre-existing
`client.list_tasks()` seam (the same one backing the `rocketride://status`
resource) -- server-authoritative, so it reflects reality identically
whether the connected engine is local or cloud.
"""

import asyncio
import time
from typing import Any, Dict

from ..apps import PIPELINES_TABLE_URI
from ..errors import _bad
from ..errors import _timeout
from ..errors import normalize_error
from ..tooling import ToolRegistry

DEFAULT_TIMEOUT_SECONDS = 30
DEFAULT_INTERVAL_SECONDS = 1

# Hard bounds on the caller-supplied poll parameters, enforced in the handler
# (not just the schema — the server must not depend on client-side schema
# validation): one `monitor` call must not busy-loop the engine (`interval: 0`)
# or hold the tool call open indefinitely (unbounded `timeout`).
MAX_TIMEOUT_SECONDS = 300
MIN_INTERVAL_SECONDS = 0.25

# Per-poll wall-clock budget for a single `get_task_status` call, so one hung
# call can't itself exceed the overall poll `timeout`. Floors at the
# caller's `interval` so a slow but valid poll cadence is never starved.
DEFAULT_PER_POLL_TIMEOUT_SECONDS = 5

_TERMINAL_STATES = {5, 6}

_STATE_LABELS = {
    0: 'none',
    1: 'starting',
    2: 'initializing',
    3: 'running',
    4: 'stopping',
    5: 'completed',
    6: 'cancelled',
}

_MONITOR_SCHEMA = {
    'type': 'object',
    'properties': {
        'task_token': {'type': 'string', 'description': 'Task token returned by run_pipeline'},
        'timeout': {
            'type': 'number',
            'minimum': 0,
            'maximum': MAX_TIMEOUT_SECONDS,
            'description': f'Maximum seconds to poll before returning the current snapshot (default 30, max {MAX_TIMEOUT_SECONDS})',
        },
        'interval': {
            'type': 'number',
            'minimum': MIN_INTERVAL_SECONDS,
            'description': 'Seconds to wait between polls (default 1)',
        },
    },
    'required': ['task_token'],
}


def _is_terminal(status: Dict[str, Any], state: int) -> bool:
    return state in _TERMINAL_STATES or bool(status.get('completed'))


def _snapshot(token: str, status: Dict[str, Any], polls: int) -> dict:
    state = status.get('state', 0)
    completed = bool(status.get('completed'))
    return {
        'ok': True,
        'task_token': token,
        'state': state,
        'state_label': _STATE_LABELS.get(state, 'none'),
        'completed': completed,
        'terminal': _is_terminal(status, state),
        'status': status,
        'counts': {
            'completedCount': status.get('completedCount', 0),
            'failedCount': status.get('failedCount', 0),
            'totalCount': status.get('totalCount', 0),
        },
        'errors': status.get('errors', []),
        'warnings': status.get('warnings', []),
        'polls': polls,
    }


async def _monitor(client, tasks, args: Dict[str, Any]) -> dict:
    token = args.get('task_token')
    if not token:
        return _bad('task_token is required', 'call run_pipeline first to obtain a task_token')

    try:
        timeout = float(args.get('timeout', DEFAULT_TIMEOUT_SECONDS))
        interval = float(args.get('interval', DEFAULT_INTERVAL_SECONDS))
    except (TypeError, ValueError):
        return _bad('timeout and interval must be numbers', 'omit them to use the defaults')
    timeout = max(0.0, min(timeout, MAX_TIMEOUT_SECONDS))
    interval = max(MIN_INTERVAL_SECONDS, interval)
    per_poll_timeout = max(interval, DEFAULT_PER_POLL_TIMEOUT_SECONDS)

    deadline = time.monotonic() + timeout
    polls = 0
    status: Dict[str, Any] = {}

    while True:
        try:
            status = await asyncio.wait_for(client.get_task_status(token), timeout=per_poll_timeout) or {}
        except asyncio.TimeoutError:
            # A single hung poll isn't a hard failure -- return the current
            # (last-known, necessarily non-terminal) snapshot rather than
            # blow through the caller's overall `timeout`. Marked so the
            # caller can tell "the poll timed out" from "state is none".
            snapshot = _snapshot(token, status, polls)
            snapshot['poll_timed_out'] = True
            return snapshot
        except Exception as exc:  # noqa: BLE001 - normalized below, HardError re-raises
            return normalize_error(exc)
        polls += 1

        state = status.get('state', 0)
        if _is_terminal(status, state):
            if tasks is not None:
                tasks.remove(token)
            return _snapshot(token, status, polls)

        if time.monotonic() >= deadline:
            return _snapshot(token, status, polls)

        await asyncio.sleep(interval)


async def _list_running_pipelines(client, tasks, args: Dict[str, Any]) -> dict:
    # Same wait_for + in-band envelope as every other blocking seam call: a
    # wedged engine connection must not hold the tool call open unbounded.
    try:
        running = await asyncio.wait_for(client.list_tasks(), timeout=DEFAULT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        return _timeout(
            'list_running_pipelines timed out waiting for the engine',
            'retry list_running_pipelines',
        )
    running = running or []
    return {'ok': True, 'tasks': running, 'count': len(running)}


def register(registry: ToolRegistry) -> None:
    """Register the visibility tools (`monitor`, `list_running_pipelines`) against ``registry``."""
    registry.register(
        'monitor',
        'Poll a running pipeline task (by task_token) until it reaches a terminal state or the '
        'timeout elapses, returning a status snapshot. Long-lived tasks (e.g. webhooks) may never '
        'reach a terminal state -- the snapshot returned at timeout has terminal=false.',
        _MONITOR_SCHEMA,
    )(_monitor)
    registry.register(
        'list_running_pipelines',
        'List running pipelines on the connected server with their task tokens, names, and state. '
        'Use the tokens with monitor, send_data, or terminate.',
        {'type': 'object', 'properties': {}},
        ui_resource_uri=PIPELINES_TABLE_URI,
    )(_list_running_pipelines)
