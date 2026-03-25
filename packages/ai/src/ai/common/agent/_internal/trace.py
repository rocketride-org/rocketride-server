"""
Tracing utilities for agent runs.

This module wraps the engine invoker function so `AgentBase` can record host tool
calls and attach them to the agent answer stack.

Multi-tool fan-out handling
---------------------------
``tool.query`` uses ``PreventDefault`` in each tool provider so the engine
iterates *all* connected tool nodes and accumulates descriptors on the shared
param object.  After the last node, the engine raises "No driver accepted …"
because every node raised ``PreventDefault``.  The tracing invoker catches that
specific error for ``tool.query`` and returns the param (which now carries the
full aggregated tool list).
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Callable, Dict, List, Tuple

from rocketlib import debug


def make_tracing_invoker(
    base_invoker: Callable[[str, Any], Any],
) -> Tuple[Callable[[str, Any], Any], List[Dict[str, Any]]]:
    """
    Wrap an engine invoker to record `tool.*` calls and their I/O.

    Returns (wrapped_invoker, tool_calls_list).

    Args:
        base_invoker: The engine invoker (typically `pSelf.instance.invoke`).

    Returns:
        A tuple of `(wrapped_invoker, tool_calls)` where `tool_calls` is a mutable
        list that accumulates entries for `tool.query`, `tool.validate`, and
        `tool.invoke` calls executed through the wrapped invoker.
    """
    tool_calls: List[Dict[str, Any]] = []

    def _get_field(obj: Any, name: str) -> Any:
        if obj is None:
            return None
        if isinstance(obj, dict):
            return obj.get(name)
        return getattr(obj, name, None)

    def invoker(class_type: str, p: Any) -> Any:
        if class_type == 'llm':
            t0 = time.perf_counter()
            try:
                return base_invoker(class_type, p)
            finally:
                elapsed_ms = (time.perf_counter() - t0) * 1000
                debug(f'[PERF] llm.invoke  elapsed={elapsed_ms:.0f}ms')
                tool_calls.append({
                    'call_id': str(uuid.uuid4()),
                    'op': 'llm.invoke',
                    'tool_name': None,
                    'input': None,
                    'output': None,
                    'elapsed_ms': round(elapsed_ms),
                })

        if class_type != 'tool':
            return base_invoker(class_type, p)
        op = _get_field(p, 'op')
        if not isinstance(op, str):
            return base_invoker(class_type, p)
        if op not in ('tool.query', 'tool.validate', 'tool.invoke'):
            return base_invoker(class_type, p)

        tool_name = _get_field(p, 'tool_name')
        tool_input = _get_field(p, 'input')
        call_id = str(uuid.uuid4())

        t0 = time.perf_counter()
        result: Any = None
        call_error: Any = None
        try:
            result = base_invoker(class_type, p)
            return result
        except Exception as e:
            if op == 'tool.query' and _is_no_driver_accepted(e):
                tools = _get_field(p, 'tools')
                if isinstance(tools, list) and len(tools) > 0:
                    result = p
                    return p
            call_error = {'type': type(e).__name__, 'message': str(e)}
            raise
        finally:
            elapsed_ms = (time.perf_counter() - t0) * 1000
            debug(f'[PERF] {op}  tool={tool_name}  elapsed={elapsed_ms:.0f}ms')
            tool_output = (
                _get_field(result, 'output') if (op == 'tool.invoke' and result is not None) else None
            )
            tool_calls.append(
                {
                    'call_id': call_id,
                    'op': op,
                    'tool_name': tool_name,
                    'input': tool_input,
                    'output': tool_output,
                    'elapsed_ms': round(elapsed_ms),
                    **({'error': call_error} if call_error is not None else {}),
                }
            )

    return invoker, tool_calls


def _is_no_driver_accepted(exc: Exception) -> bool:
    """Check if the exception is the engine's 'No driver accepted' error.

    This is raised by the C++ ``cb_control`` loop when every connected tool
    node raises ``PreventDefault`` — which is the expected outcome of our
    multi-tool ``tool.query`` accumulation pattern.
    """
    msg = str(exc).lower()
    return 'no driver accepted' in msg or 'no control listeners' in msg
