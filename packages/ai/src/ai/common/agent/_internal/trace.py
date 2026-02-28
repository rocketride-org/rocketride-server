from __future__ import annotations

import uuid
from typing import Any, Callable, Dict, List, Tuple


def make_tracing_invoker(
    base_invoker: Callable[[str, Any], Any],
) -> Tuple[Callable[[str, Any], Any], List[Dict[str, Any]]]:
    """
    Wrap an engine invoker to record tool.* calls and their I/O.

    Returns (wrapped_invoker, tool_calls_list).
    """
    tool_calls: List[Dict[str, Any]] = []

    def _get_field(obj: Any, name: str) -> Any:
        if obj is None:
            return None
        if isinstance(obj, dict):
            return obj.get(name)
        return getattr(obj, name, None)

    def invoker(class_type: str, p: Any) -> Any:
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

        result: Any = None
        call_error: Any = None
        try:
            result = base_invoker(class_type, p)
            return result
        except Exception as e:
            call_error = {'type': type(e).__name__, 'message': str(e)}
            raise
        finally:
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
                    **({'error': call_error} if call_error is not None else {}),
                }
            )

    return invoker, tool_calls
