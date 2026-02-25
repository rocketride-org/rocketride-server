from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union

from ..types import CONTINUATION_TYPE


def extract_prompt(question: Any) -> str:
    """Extract the user prompt string from a Question-like object."""
    if hasattr(question, 'questions') and getattr(question, 'questions', None):
        first = question.questions[0]
        if hasattr(first, 'text'):
            text = (first.text or '').strip()
            if text:
                return text
    text = str(question).strip()
    if not text:
        raise ValueError('No prompt provided in Question.questions[0].text')
    return text


def extract_continuation(context: Any) -> Optional[Dict[str, Any]]:
    """Extract a continuation record from Question.context."""
    if not context or not isinstance(context, list):
        return None

    for item in context:
        if not isinstance(item, str):
            continue
        s = item.strip()
        if not s:
            continue
        try:
            obj = json.loads(s)
        except Exception:
            continue
        if isinstance(obj, dict) and obj.get('type') == CONTINUATION_TYPE:
            return obj
    return None


def new_run_id() -> str:
    """Return a new UUID string for an agent run."""
    return str(uuid.uuid4())


def now_iso() -> str:
    """Return current UTC timestamp as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def safe_str(value: Any) -> str:
    """Convert `value` to a string (never raises an exception)."""
    if value is None:
        return ''
    try:
        return str(value)
    except Exception:
        return ''


def get_field(obj: Any, name: str) -> Any:
    """Get `name` from a dict-like or attribute-like object."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def split_namespaced_tool_name(tool_name: Any) -> tuple[str, str]:
    """Split `<server>.<tool>` into `(server, tool)`; raise on invalid input."""
    if not isinstance(tool_name, str) or not tool_name.strip():
        raise ValueError('agent tool: tool_name must be a non-empty string')
    s = tool_name.strip()
    if '.' not in s:
        raise ValueError(
            'agent tool: tool_name must be namespaced as `<serverName>.<toolName>`; '
            f'got {tool_name!r}'
        )
    server_name, bare_tool = s.split('.', 1)
    server_name = server_name.strip()
    bare_tool = bare_tool.strip()
    if not server_name or not bare_tool:
        raise ValueError(
            'agent tool: tool_name must be namespaced as `<serverName>.<toolName>`; '
            f'got {tool_name!r}'
        )
    return server_name, bare_tool


def is_agent_run_tool_name(tool_name: Any) -> bool:
    """Return True if `tool_name` looks like `<server>.run_agent`."""
    try:
        _server, bare = split_namespaced_tool_name(tool_name)
        return bare == 'run_agent'
    except Exception:
        return False


def extract_tool_names(tool_catalog: Any) -> List[str]:
    """Extract tool names from a host tool catalog response."""
    try:
        tools_obj = None
        if isinstance(tool_catalog, list):
            tools_obj = tool_catalog
        elif hasattr(tool_catalog, 'tools'):
            tools_obj = getattr(tool_catalog, 'tools')
        elif isinstance(tool_catalog, dict):
            tools_obj = tool_catalog.get('tools')

        if not isinstance(tools_obj, list):
            return []

        names: List[str] = []
        for t in tools_obj:
            if isinstance(t, str):
                names.append(t.strip())
                continue
            if isinstance(t, dict):
                n = t.get('name') or t.get('tool_name') or t.get('toolName')
                if isinstance(n, str):
                    names.append(n.strip())
                continue
            if hasattr(t, 'name'):
                n = getattr(t, 'name')
                if isinstance(n, str):
                    names.append(n.strip())

        out: List[str] = []
        seen = set()
        for n in names:
            if n and n not in seen:
                seen.add(n)
                out.append(n)
        return out
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Tool invocation payload normalization
# ---------------------------------------------------------------------------
def _best_effort_pydantic_dump(value: Any) -> Any:
    """
    Unwrap pydantic-ish models to dict.

    - Pydantic v2: model_dump()
    - Pydantic v1: dict()
    """
    if value is None:
        return None
    if isinstance(value, (dict, list, tuple, str, int, float, bool)):
        return value

    if hasattr(value, 'model_dump') and callable(getattr(value, 'model_dump')):
        try:
            return value.model_dump()
        except Exception:
            return value

    if hasattr(value, 'dict') and callable(getattr(value, 'dict')):
        try:
            return value.dict()
        except Exception:
            return value

    return value


def normalize_invocation_payload(*, input: Any = None, kwargs: Optional[Dict[str, Any]] = None) -> Any:
    """
    Normalize tool invocation payload shapes across frameworks.

    Supported input forms:
    - Direct dict payload
    - Pydantic-ish model payloads (best-effort to dict)
    - `{ "input": X }` wrapper (unwrapped)
    - `{ "input": { ... }, ...extras }` wrapper (extras merged into inner dict; extras override)
    - `input=<payload>, **kwargs` (kwargs merged into payload dict when possible)
    - kwargs-only invocations (payload becomes kwargs)
    """
    kw = kwargs or {}

    payload: Any
    if input is not None:
        payload = _best_effort_pydantic_dump(input)
        if kw:
            if isinstance(payload, dict):
                payload = {**payload, **kw}
            else:
                payload = {'input': payload, **kw}
    elif kw:
        payload = kw
    else:
        payload = {}

    payload = _best_effort_pydantic_dump(payload)

    if isinstance(payload, dict) and 'input' in payload:
        if len(payload) == 1:
            return _best_effort_pydantic_dump(payload.get('input'))

        inner = _best_effort_pydantic_dump(payload.get('input'))
        if isinstance(inner, dict):
            extras = {k: v for k, v in payload.items() if k != 'input'}
            return {**inner, **extras}

    return payload

# ---------------------------------------------------------------------------
# LLM transcript/text normalization
# ---------------------------------------------------------------------------
def messages_to_transcript(messages: Union[str, List[Dict[str, str]]]) -> str:
    """Normalize CrewAI-style messages into a single transcript string."""
    if isinstance(messages, str):
        return messages

    parts: List[str] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = safe_str(m.get('role') or 'user') or 'user'
        content = safe_str(m.get('content') or '')
        if content:
            parts.append(f'{role}: {content}')
    return '\n'.join(parts)


def extract_text(result: Any) -> str:
    """Text extraction from engine response shapes."""
    try:
        if hasattr(result, 'getText') and callable(getattr(result, 'getText')):
            return (safe_str(result.getText()) or '').strip()
        if hasattr(result, 'getJson') and callable(getattr(result, 'getJson')):
            data = result.getJson()
            if isinstance(data, dict):
                for k in ('answer', 'content', 'text'):
                    if k in data and data[k] is not None:
                        return safe_str(data[k]).strip()
            return safe_str(data).strip()
        return safe_str(result).strip()
    except Exception:
        return safe_str(result).strip()


def truncate_at_stop_words(text: str, stop_words: Any) -> str:
    """Truncate `text` at the first occurrence of any stop word."""
    if not text:
        return ''
    if not isinstance(stop_words, list):
        return text
    for sw in stop_words:
        ssw = safe_str(sw)
        if ssw and ssw in text:
            return text.split(ssw)[0]
    return text
