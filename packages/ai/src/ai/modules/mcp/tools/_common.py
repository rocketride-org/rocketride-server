# Copyright 2026 Aparavi Software AG. MIT License.
"""Shared helpers for MCP tool handlers."""

import asyncio
from typing import Any, Dict, Optional, Tuple

from ..errors import _bad, _timeout

# The paging inputs and the description clause of every tool that returns rows in pages.
PAGED = 'Returns as many rows as fit. When next_offset is not null, call again with offset set to it.'
PAGING_PROPS = {
    'offset': {
        'type': 'integer',
        'minimum': 0,
        'description': 'Row to start at (default 0): next_offset of the last call',
    },
    'limit': {'type': 'integer', 'minimum': 1, 'description': 'Most rows to return (default: as many as fit)'},
}


def load_pipeline(args: Dict[str, Any]) -> Dict[str, Any]:
    """Resolve a pipeline object from tool arguments.

    Inline-only by design: a server-side ``filepath`` read would let any MCP
    caller read files off the server's disk, so file paths are not accepted —
    the MCP client reads local files itself and sends the definition inline.
    Unwraps a ``{'pipeline': {...}}`` wrapper, matching the SDK's own
    ``use()``/``validate()`` auto-unwrap behavior.

    Args:
        args: Tool arguments dict; expected to carry ``pipeline``.

    Returns:
        The resolved pipeline object (a JSON object / dict).

    Raises:
        ValueError: if ``pipeline`` is not supplied, or the resolved value is
            not a JSON object.
    """
    pipeline = args.get('pipeline')
    if pipeline is None:
        raise ValueError('load_pipeline requires an inline "pipeline" object')

    resolved = pipeline.get('pipeline', pipeline) if isinstance(pipeline, dict) else pipeline

    if not isinstance(resolved, dict):
        raise ValueError('load_pipeline resolved a non-object pipeline value')

    return resolved


DEFAULT_TIMEOUT_SECONDS = 30


async def engine_call(coro: Any, tool_name: str) -> Tuple[Any, Optional[dict]]:
    """Await ``coro`` under the standard seam timeout.

    Returns ``(result, None)`` or ``(None, timeout_envelope)`` — one
    wait_for + in-band Timeout contract shared by every tool group, so no
    seam call can hold a tool call open unbounded.
    """
    try:
        return await asyncio.wait_for(coro, timeout=DEFAULT_TIMEOUT_SECONDS), None
    except asyncio.TimeoutError:
        return None, _timeout(f'{tool_name} timed out waiting for the engine', f'retry {tool_name}')


def whole_number(value: Any, least: int) -> bool:
    """True for a whole number of at least ``least``. A bool is not one."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= least


def paging_args(args: Dict[str, Any]) -> Tuple[int, Optional[int], Optional[dict]]:
    """Read ``offset`` and ``limit`` from tool arguments.

    Returns ``(offset, limit, None)``, with offset 0 and limit None when they
    are left out, or ``(0, None, BadRequest)`` for a value that is not allowed.
    """
    offset = args.get('offset')
    limit = args.get('limit')
    if offset is None:
        offset = 0
    if not whole_number(offset, 0):
        return 0, None, _bad('offset must be a whole number, 0 or more', 'pass next_offset from the last call, or 0')
    if limit is not None and not whole_number(limit, 1):
        return 0, None, _bad('limit must be a whole number, 1 or more', 'leave limit out to get as many rows as fit')
    return offset, limit, None
