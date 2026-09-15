# Copyright 2026 Aparavi Software AG. MIT License.
"""Shared helpers for MCP tool handlers."""

import asyncio
from typing import Any, Dict, Optional, Tuple

from ..errors import _timeout


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
