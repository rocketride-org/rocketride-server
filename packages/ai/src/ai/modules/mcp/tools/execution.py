# Copyright 2026 Aparavi Software AG. MIT License.
"""Token-based execution tools: `run_pipeline`, `run_dropper_pipe`, `send_data`,
`terminate`, `send_files`.

Token-based execution, no sessions: `use()` returns a task token -- the
single run identity -- and the server-owned `TaskRegistry` (`registry.py`)
tracks `{token -> metadata}` since the SDK keeps none of its own. One-shot
runs let the token expire via `ttl`; long-lived runs keep the token and call
`send_data` repeatedly (`use_existing`). `terminate` tears the task down and
is also the stop-runaway-task path.

Server-imposed timeout: neither the SDK's `use()` nor `send()` has a
wall-clock timeout unless the client itself is built with a
`request_timeout` -- a slow/wedged engine connection would otherwise hang a
tool call indefinitely. Every blocking seam call in this module is wrapped
in `asyncio.wait_for(..., timeout=DEFAULT_TIMEOUT_SECONDS)`. A bare
`asyncio.TimeoutError` is caught locally rather than left to propagate to
`errors.normalize_error`: that normalizer treats the `TimeoutError` type name
as a hard, non-self-correctable failure (`HARD_EXC_NAMES`) and raises
`HardError`, which surfaces as an MCP tool error -- appropriate for a lost
connection, but not for "this one call happened to run long." Timing out a
single `send`/`use` doesn't mean the task itself is dead (it may still be
running engine-side), so we report it as a structured, self-correctable
`{ok: False, error_type: 'Timeout', ...}` result instead, using a distinct
error_type ('Timeout', not 'TimeoutError') so it never collides with the
normalizer's hard-failure set.
"""

import asyncio
from typing import Any, Dict
from urllib.parse import urlencode

from ..apps import DROPPER_URI
from ..errors import _bad, _timeout
from ..tooling import ToolRegistry

# Default wall-clock budget for a single blocking `use`/`send`/`terminate`/
# `send_files` seam call. Chosen as a generous-but-bounded default for
# document-processing pipelines; not user-configurable in v1.
DEFAULT_TIMEOUT_SECONDS = 120

_OPTIONAL_USE_KWARGS = ('ttl', 'use_existing', 'source', 'threads', 'pipelineTraceLevel')

_RUN_PIPELINE_SCHEMA = {
    'type': 'object',
    'properties': {
        'pipeline': {'type': 'object', 'description': 'Inline pipeline definition'},
        'inputs': {'type': 'string', 'description': 'Data to send to the pipeline immediately after starting it'},
        'ttl': {'type': 'integer', 'description': 'Task time-to-live in seconds; 0 = no timeout'},
        'use_existing': {'type': 'boolean', 'description': 'Reuse an existing task instead of starting a new one'},
        'source': {'type': 'string', 'description': 'Optional source label forwarded to use()'},
        'threads': {'type': 'integer', 'description': 'Optional thread count forwarded to use()'},
        'pipelineTraceLevel': {
            'type': 'string',
            'enum': ['none', 'metadata', 'summary', 'full'],
            'description': 'Capture the per-node trace stream at this detail level (default "summary" — required for log_traces/log_trace to have content; pass "none" to disable)',
        },
    },
    'required': ['pipeline'],
}

_RUN_DROPPER_PIPE_SCHEMA = {
    'type': 'object',
    'properties': {
        'pipeline': {'type': 'object', 'description': 'Inline pipeline definition'},
        'ttl': {'type': 'integer', 'description': 'Task time-to-live in seconds; 0 = no timeout'},
        'use_existing': {'type': 'boolean', 'description': 'Reuse an existing task instead of starting a new one'},
        'source': {'type': 'string', 'description': 'Optional source label forwarded to use()'},
        'threads': {'type': 'integer', 'description': 'Optional thread count forwarded to use()'},
        'pipelineTraceLevel': {
            'type': 'string',
            'enum': ['none', 'metadata', 'summary', 'full'],
            'description': 'Capture the per-node trace stream at this detail level (default "summary" — required for log_traces/log_trace to have content; pass "none" to disable)',
        },
    },
    'required': ['pipeline'],
}

_SEND_DATA_SCHEMA = {
    'type': 'object',
    'properties': {
        'task_token': {'type': 'string', 'description': 'Task token returned by run_pipeline'},
        'input': {'type': 'string', 'description': 'Data to send to the running task'},
    },
    'required': ['task_token', 'input'],
}

_TERMINATE_SCHEMA = {
    'type': 'object',
    'properties': {
        'task_token': {'type': 'string', 'description': 'Task token returned by run_pipeline'},
    },
    'required': ['task_token'],
}

_SEND_FILES_SCHEMA = {
    'type': 'object',
    'properties': {
        'task_token': {'type': 'string', 'description': 'Task token returned by run_pipeline'},
        'files': {
            'type': 'array',
            'items': {'type': 'string'},
            'minItems': 1,
            'description': 'Store-relative file paths to upload to the running task',
        },
    },
    'required': ['task_token', 'files'],
}


async def _start_task(client, args: Dict[str, Any], tool_name: str):
    """Shared start path for `run_pipeline` / `run_dropper_pipe`: input check,
    use() kwargs (incl. the `pipelineTraceLevel: 'summary'` default), and the
    wait_for-wrapped engine call. Returns ``(started, None)`` on success or
    ``(None, error_envelope)`` — keeping the default trace level and the
    timeout contract in one place so a change can't land in one copy only.
    """
    # Inline-only by design: a server-side filepath read would let any MCP
    # caller read files off the server's disk. Pipelines are small JSON — the
    # MCP client reads local files itself and sends the definition inline.
    pipeline = args.get('pipeline')
    if not pipeline:
        return None, _bad('pipeline is required', 'pass an inline pipeline object')

    kwargs: Dict[str, Any] = {'pipeline': pipeline}
    for key in _OPTIONAL_USE_KWARGS:
        if args.get(key) is not None:
            kwargs[key] = args[key]

    kwargs.setdefault('pipelineTraceLevel', 'summary')

    try:
        started = await asyncio.wait_for(client.use(**kwargs), timeout=DEFAULT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        return None, _timeout(
            f'{tool_name} timed out waiting for the engine to start the task',
            'the task may still be starting; call monitor once a task_token is known, or retry',
        )
    return started or {}, None


async def _run_pipeline(client, tasks, args: Dict[str, Any]) -> dict:
    started, err = await _start_task(client, args, 'run_pipeline')
    if err:
        return err

    token = started.get('token')
    if not token:
        return _bad(
            'engine did not return a task token',
            'the pipeline may have failed to start, or the engine response was malformed',
        )
    tasks.add(token, pipeline_ref='<inline>')

    result_payload: Dict[str, Any] = {'ok': True, 'task_token': token}
    result_payload['projectId'] = started.get('projectId')
    result_payload['source'] = started.get('source')

    inputs = args.get('inputs')
    if inputs is not None:
        try:
            result = await asyncio.wait_for(
                client.send(token, inputs),
                timeout=DEFAULT_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            return _timeout(
                'run_pipeline started the task but timed out waiting for the initial send() result',
                f'the task_token is {token}; call monitor or send_data to check on it',
            )
        result_payload['result'] = result
        # One-shot run: inputs were sent and a result came back synchronously,
        # so this token is done -- drop it rather than leak it in the
        # registry for the life of the process (see registry.py).
        tasks.remove(token)

    return result_payload


async def _run_dropper_pipe(client, tasks, args: Dict[str, Any]) -> dict:
    """Start a pipeline and return a self-contained upload URL.

    Bytes cannot ride the MCP tool call (transport payload limits), so this
    tool returns an HTTP endpoint an out-of-band uploader POSTs files to. The
    URL embeds only the task's public auth key (``pk_``) — ``/task/data``
    resolves the task from it, so it needs no ``Authorization`` header and no
    routing token. The ``tk_`` control token deliberately never appears in a
    URL: query strings land in access logs, browser history, and ``Referer``
    headers. Unlike ``run_pipeline`` there is no inline-send path.
    """
    started, err = await _start_task(client, args, 'run_dropper_pipe')
    if err:
        return err

    token = started.get('token')
    public_token = started.get('publicToken')
    if not token:
        return _bad(
            'engine did not return a task token for the dropper URL',
            'the pipeline may have failed to start, or the engine response was malformed',
        )
    if not public_token:
        # The task is already running engine-side and the caller gets no
        # token back to terminate with -- tear it down rather than orphan it
        # until its ttl expires (or forever, when ttl is 0).
        try:
            await asyncio.wait_for(client.terminate(token), timeout=DEFAULT_TIMEOUT_SECONDS)
        except Exception:  # noqa: BLE001 - best-effort cleanup on an already-failed call
            pass
        return _bad(
            'engine did not return public auth for the dropper URL',
            'the pipeline may lack a data-ingress source, or the engine response was malformed',
        )
    tasks.add(token, pipeline_ref='<inline>')

    base_url = str(client.base_url).rstrip('/')
    result_payload: Dict[str, Any] = {
        'ok': True,
        'task_token': token,
        'upload_url': f'{base_url}/task/data?{urlencode({"auth": public_token})}',
        'dropper_url': f'{base_url}/dropper?{urlencode({"auth": public_token})}',
        'projectId': started.get('projectId'),
        'source': started.get('source'),
    }

    return result_payload


async def _send_data(client, tasks, args: Dict[str, Any]) -> dict:
    # token/data aliases: the SDK validates only the request envelope, not
    # per-tool inputSchema, so alias-only calls from lenient hosts do land
    # here. The schema stays strict as the advertised contract.
    token = args.get('task_token') or args.get('token')
    data = args.get('input')
    if data is None:
        data = args.get('data')

    if not token:
        return _bad('task_token is required', 'call run_pipeline first to obtain a task_token')
    if data is None:
        return _bad('input is required', 'pass the data to send to the running task')

    try:
        result = await asyncio.wait_for(
            client.send(token, data),
            timeout=DEFAULT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        return _timeout(
            'send_data timed out waiting for the pipeline result',
            'the task may still be processing; retry send_data or call monitor',
        )

    return {'ok': True, 'result': result}


async def _terminate(client, tasks, args: Dict[str, Any]) -> dict:
    token = args.get('task_token')
    if not token:
        return _bad('task_token is required', 'pass the token returned by run_pipeline')

    try:
        await asyncio.wait_for(client.terminate(token), timeout=DEFAULT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        return _timeout(
            'terminate timed out waiting for the engine to tear down the task',
            'the task may still be shutting down; retry terminate',
        )

    tasks.remove(token)
    return {'ok': True, 'terminated': token}


async def _send_files(client, tasks, args: Dict[str, Any]) -> dict:
    token = args.get('task_token')
    files = args.get('files')
    if not token:
        return _bad('task_token is required', 'pass the token returned by run_pipeline')
    if not files:
        return _bad('files is required and must be a non-empty array', 'pass one or more file paths to upload')

    try:
        # SDK arg order is (files, token) -- token second, not first.
        result = await asyncio.wait_for(client.send_files(files, token), timeout=DEFAULT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        return _timeout(
            'send_files timed out waiting for the upload result',
            'the upload may still be in progress; retry send_files or call monitor',
        )

    return {'ok': True, 'result': result}


def register(registry: ToolRegistry) -> None:
    """Register the 5 token-based execution tools against ``registry``."""
    registry.register(
        'run_pipeline',
        'Start a RocketRide pipeline from an inline definition or filepath, returning a task_token. '
        'Pass inputs to also send data immediately and get a result back in the same call. '
        'Result includes projectId and source for use with log_traces/log_trace.',
        _RUN_PIPELINE_SCHEMA,
    )(_run_pipeline)

    registry.register(
        'run_dropper_pipe',
        'Start a RocketRide pipeline and return two self-contained URLs for getting files in over a '
        'separate HTTP data channel (file bytes cannot ride the MCP tool call): upload_url for a '
        'programmatic multipart POST, and dropper_url for a human to drag-drop files in a browser. '
        'Same inputs as run_pipeline, minus the inline-send path. '
        'Result includes projectId and source for use with log_traces/log_trace.',
        _RUN_DROPPER_PIPE_SCHEMA,
        ui_resource_uri=DROPPER_URI,
    )(_run_dropper_pipe)

    registry.register(
        'send_data',
        'Send data to a running pipeline task (by task_token) and return its result.',
        _SEND_DATA_SCHEMA,
    )(_send_data)

    registry.register(
        'terminate',
        'Terminate a running pipeline task by task_token -- also the stop-runaway-task path.',
        _TERMINATE_SCHEMA,
    )(_terminate)

    registry.register(
        'send_files',
        'Upload one or more store-relative file paths to a running pipeline task by task_token.',
        _SEND_FILES_SCHEMA,
    )(_send_files)
