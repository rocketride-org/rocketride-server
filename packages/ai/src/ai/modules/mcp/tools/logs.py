# Copyright 2026 Aparavi Software AG. MIT License.
"""DVR run-log tools: chapters, paged events, and per-object traces.

Backed by the engine's persisted continuum (``rrext_log``) — works for past
and live runs, keyed by (projectId, source[, teamId]), never task tokens.
The scope is the kind: a ``teamId`` addresses that team's deploy continuum,
omitting it addresses your own dev stream.
Runs recorded with pipelineTraceLevel 'none' have no flow events: chapters
and console still exist, but traces come back empty.
"""

import asyncio
from typing import Any, Dict

from ..engine import LogNotFound
from ..errors import _bad, _timeout
from ..tooling import ToolRegistry

DEFAULT_TIMEOUT_SECONDS = 30
LOG_READ_MAX_EVENTS = 200
# Total-byte bound per log_read page, forwarded to the SDK's max_bytes. The
# event cap alone is not a size bound: 200 events x 64KiB values is ~12.5MiB,
# and handlers.py holds the result, its JSON text, and the parsed
# structured_content at once.
LOG_READ_MAX_BYTES = 1_048_576
# Bound on concurrent log_read calls: each in-flight page can pin
# ~3x LOG_READ_MAX_BYTES (result + JSON text + structured_content), so
# unbounded concurrency multiplies worst-case memory.
_LOG_READ_CONCURRENCY = asyncio.Semaphore(4)
LOG_TRACES_MIN_N = 1
LOG_TRACES_MAX_N = 100
LOG_TRACES_DEFAULT_N = 20

_RETENTION_HINT = (
    'runs are evicted after 7 days (dev) / 30 days (deploy), or earlier under '
    'segment/chapter caps; re-run the pipeline to produce a fresh trace'
)
_ADDRESSING_HINT = 'use the projectId and source returned by run_pipeline / run_dropper_pipe'
_KEY_SCHEMA = {
    'projectId': {'type': 'string', 'description': 'Pipeline project id (returned by run tools)'},
    'source': {'type': 'string', 'description': 'Source component id (returned by run tools)'},
    'teamId': {
        'type': 'string',
        'description': "Team id addressing that team's deploy continuum; omit for your own dev runs",
    },
}


def _require_key(args: Dict[str, Any]):
    project_id = args.get('projectId')
    source = args.get('source')
    if not project_id or not source:
        missing = 'projectId' if not project_id else 'source'
        return None, _bad(f'{missing} is required', _ADDRESSING_HINT)
    return (project_id, source, args.get('teamId') or ''), None


def _context(project_id: str, source: str, team_id: str) -> Dict[str, Any]:
    """Echo the log-keying identity so UI widgets can key follow-up calls."""
    ctx: Dict[str, Any] = {'projectId': project_id, 'source': source}
    if team_id:
        ctx['teamId'] = team_id
    return ctx


async def _log_chapters(client, tasks, args: Dict[str, Any]) -> dict:
    key, err = _require_key(args)
    if err:
        return err
    project_id, source, team_id = key
    try:
        result = await asyncio.wait_for(
            client.log_chapters(project_id, source, team_id), timeout=DEFAULT_TIMEOUT_SECONDS
        )
    except asyncio.TimeoutError:
        return _timeout('log_chapters timed out waiting for the engine', 'retry log_chapters')
    except LogNotFound:
        # Same envelope as the empty-chapters case below: one shape for
        # "this run log doesn't exist", whether the seam signals it with an
        # exception or an empty list.
        return {
            'ok': False,
            'error_type': 'NotFound',
            'message': 'no recorded runs for this projectId/source',
            'hint': _ADDRESSING_HINT,
        }
    chapters = (result or {}).get('chapters') or []
    if not chapters:
        return {
            'ok': False,
            'error_type': 'NotFound',
            'message': 'no recorded runs for this projectId/source',
            'hint': _ADDRESSING_HINT,
        }
    return {'ok': True, 'chapters': chapters, 'horizonSeq': (result or {}).get('horizonSeq')}


async def _log_read(client, tasks, args: Dict[str, Any]) -> dict:
    key, err = _require_key(args)
    if err:
        return err
    project_id, source, team_id = key
    # Floored to >=1 (a caller-supplied 0 or negative maxEvents would
    # otherwise reach the engine as-is) and still capped at LOG_READ_MAX_EVENTS.
    try:
        max_events = max(1, min(int(args.get('maxEvents') or LOG_READ_MAX_EVENTS), LOG_READ_MAX_EVENTS))
    except (TypeError, ValueError):
        return _bad('maxEvents must be an integer', 'omit it to use the default')
    try:
        async with _LOG_READ_CONCURRENCY:
            result = await asyncio.wait_for(
                client.log_read(
                    project_id,
                    source,
                    team_id,
                    from_seq=args.get('fromSeq'),
                    cursor=args.get('cursor'),
                    max_events=max_events,
                    max_bytes=LOG_READ_MAX_BYTES,
                    types=args.get('types'),
                ),
                timeout=DEFAULT_TIMEOUT_SECONDS,
            )
    except asyncio.TimeoutError:
        return _timeout(
            'log_read timed out waiting for the engine',
            'retry log_read, optionally with a smaller maxEvents',
        )
    except LogNotFound:
        return {
            'ok': False,
            'error_type': 'NotFound',
            'message': 'no run log for this projectId/source, or it expired',
            'hint': _RETENTION_HINT,
        }
    result = result or {}
    return {
        'ok': True,
        'events': result.get('events') or [],
        'nextCursor': result.get('nextSeq'),
        'truncatedAtSeq': result.get('truncatedAtSeq'),
    }


async def _log_traces(client, tasks, args: Dict[str, Any]) -> dict:
    key, err = _require_key(args)
    if err:
        return err
    project_id, source, team_id = key
    chapter_begin_seq = args.get('chapterBeginSeq')
    try:
        n = max(LOG_TRACES_MIN_N, min(int(args.get('n') or LOG_TRACES_DEFAULT_N), LOG_TRACES_MAX_N))
        chapter_begin_seq = int(chapter_begin_seq) if chapter_begin_seq is not None else None
    except (TypeError, ValueError):
        return _bad('n and chapterBeginSeq must be integers', 'omit n to use the default')
    try:
        result = await asyncio.wait_for(
            client.log_traces(
                project_id,
                source,
                team_id,
                n=n,
                chapter_begin_seq=chapter_begin_seq,
            ),
            timeout=DEFAULT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        return _timeout('log_traces timed out waiting for the engine', 'retry log_traces')
    except LogNotFound:
        target = f'chapter {chapter_begin_seq}' if chapter_begin_seq is not None else 'the latest run'
        return {
            'ok': False,
            'error_type': 'NotFound',
            'message': f'{target} was not found or expired',
            'hint': _RETENTION_HINT,
        }
    result = result or {}
    closed = result.get('closed') or []
    open_traces = result.get('open') or []
    payload = {'ok': True, 'traces': closed, 'open': open_traces, 'context': _context(project_id, source, team_id)}
    if not closed and not open_traces:
        payload['note'] = (
            'no traces recorded — the run may have been submitted with '
            "pipelineTraceLevel 'none' (MCP run tools default to 'summary')"
        )
    return payload


async def _log_trace(client, tasks, args: Dict[str, Any]) -> dict:
    key, err = _require_key(args)
    if err:
        return err
    project_id, source, team_id = key
    begin_seq = args.get('beginSeq')
    if begin_seq is None:
        return _bad('beginSeq is required', 'get it from log_traces (each trace summary carries beginSeq)')
    try:
        begin_seq = int(begin_seq)
    except (TypeError, ValueError):
        return _bad('beginSeq must be an integer', 'get it from log_traces (each trace summary carries beginSeq)')
    try:
        result = await asyncio.wait_for(
            client.log_trace(project_id, source, team_id, begin_seq=begin_seq),
            timeout=DEFAULT_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        return _timeout('log_trace timed out waiting for the engine', 'retry log_trace')
    except LogNotFound:
        return {
            'ok': False,
            'error_type': 'TraceExpired',
            'message': f'trace {begin_seq} is below the retention horizon',
            'hint': _RETENTION_HINT,
        }
    result = result or {}
    return {
        'ok': True,
        'beginSeq': int(begin_seq),
        'summary': result.get('summary'),
        'events': result.get('events') or [],
        'context': _context(project_id, source, team_id),
    }


def register(registry: ToolRegistry) -> None:
    """Register the DVR run-log tools (`log_chapters`, `log_read`, `log_traces`, `log_trace`)."""
    registry.register(
        'log_chapters',
        'List recorded runs (chapters) for a pipeline from the persistent run log — begin/end '
        'times, beginSeq, outcome. Works for past and live runs.',
        {'type': 'object', 'properties': _KEY_SCHEMA, 'required': ['projectId', 'source']},
    )(_log_chapters)
    registry.register(
        'log_read',
        'Read raw run-log events for a pipeline, cursor-paged. types=["output"] returns console '
        'lines only. Pass nextCursor back as cursor to continue.',
        {
            'type': 'object',
            'properties': {
                **_KEY_SCHEMA,
                'fromSeq': {'type': 'integer', 'description': 'Sequence number to start reading from'},
                'cursor': {'type': 'integer', 'description': 'Opaque cursor from a previous nextCursor'},
                'maxEvents': {
                    'type': 'integer',
                    'description': f'Max events to return, capped at {LOG_READ_MAX_EVENTS}',
                },
                'types': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': 'Filter to these event types, e.g. ["output"] for console lines only',
                },
            },
            'required': ['projectId', 'source'],
        },
    )(_log_read)
    registry.register(
        'log_traces',
        'List per-object trace summaries (one per file/document that traveled the pipeline) for '
        'recent runs. Each carries beginSeq — the permanent trace id. `traces` holds finished '
        'runs; `open` holds ones still in flight. By default returns the latest run; pass '
        'chapterBeginSeq (from log_chapters) to address a specific past run instead.',
        {
            'type': 'object',
            'properties': {
                **_KEY_SCHEMA,
                'n': {
                    'type': 'integer',
                    'description': f'Max number of traces to return (default {LOG_TRACES_DEFAULT_N}, '
                    f'clamped to {LOG_TRACES_MIN_N}-{LOG_TRACES_MAX_N})',
                },
                'chapterBeginSeq': {
                    'type': 'integer',
                    'description': 'Address a specific past run by its chapter beginSeq (from log_chapters) '
                    'instead of the latest/live run',
                },
            },
            'required': ['projectId', 'source'],
        },
    )(_log_traces)
    registry.register(
        'log_trace',
        "Fetch one object's full begin-to-end journey through the pipeline by its beginSeq: a "
        'summary plus every component enter/leave with lane data, plus node narration.',
        {
            'type': 'object',
            'properties': {
                **_KEY_SCHEMA,
                'beginSeq': {'type': 'integer', 'description': 'Trace id, from log_traces'},
            },
            'required': ['projectId', 'source', 'beginSeq'],
        },
    )(_log_trace)
