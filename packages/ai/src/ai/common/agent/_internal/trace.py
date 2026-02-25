from __future__ import annotations

import uuid
from typing import Any, Callable, Dict, List, Tuple

from ..types import AGENT_TOOL_CALLS_TYPE, AgentEnvelope
from .utils import get_field


def make_tracing_invoker(
    base_invoker: Callable[[str, Any], Any],
) -> Tuple[Callable[[str, Any], Any], List[Dict[str, Any]]]:
    """
    Wrap an engine invoker to record tool.* calls and their I/O.

    Returns (wrapped_invoker, tool_calls_list).
    """
    tool_calls: List[Dict[str, Any]] = []

    def invoker(class_type: str, p: Any) -> Any:
        if class_type != 'tool':
            return base_invoker(class_type, p)
        op = get_field(p, 'op')
        if not isinstance(op, str):
            return base_invoker(class_type, p)
        if op not in ('tool.query', 'tool.validate', 'tool.invoke'):
            return base_invoker(class_type, p)

        tool_name = get_field(p, 'tool_name')
        tool_input = get_field(p, 'input')
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
                get_field(result, 'output') if (op == 'tool.invoke' and result is not None) else None
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


def attach_tool_calls_artifact(envelope: AgentEnvelope, tool_calls: List[Dict[str, Any]]) -> None:
    """Append tool-call trace data to `envelope.artifacts` (best-effort)."""
    try:
        if not tool_calls:
            return
        artifacts = envelope.get('artifacts') if isinstance(envelope, dict) else None
        if isinstance(artifacts, list):
            artifacts.append({'kind': AGENT_TOOL_CALLS_TYPE, 'name': 'host.tools', 'payload': tool_calls})
    except Exception:
        return
