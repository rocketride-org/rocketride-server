"""
Internal helpers for agent framework drivers.

This module contains small, framework-agnostic utilities used by `AgentBase` and
the agent-as-tool adapter:
- prompt extraction from `Question`
- run id / timestamp helpers
- tool invocation payload normalization across frameworks
- transcript and text extraction helpers for host LLM responses
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union


def extract_prompt(question: Any) -> str:
    """
    Extract the full prompt text from a Question-like object.

    Prefer `Question.getPrompt()` when available so conversation history and
    other structured fields (instructions/examples/context) are preserved.
    """
    get_prompt = getattr(question, 'getPrompt', None)
    if callable(get_prompt):
        try:
            text = safe_str(get_prompt()).strip()
            if text:
                return text
        except Exception:
            pass
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

# ---------------------------------------------------------------------------
# Tool invocation payload normalization
# ---------------------------------------------------------------------------
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

    Args:
        input: Framework tool input value, often passed as a single `input=...` param.
        kwargs: Extra keyword args captured by framework wrappers.

    Returns:
        A normalized payload object to pass to `host.tools.invoke(...)`.
    """

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
    """
    Normalize messages into a single transcript string.

    Args:
        messages: Either a raw string or a list of `{role, content}` dicts.

    Returns:
        A newline-separated transcript string.
    """
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
    """
    Extract response text from common engine return shapes.

    Supports:
    - objects with `getText()`
    - objects with `getJson()` that include `answer`/`content`/`text`
    - any other object via `str(...)`
    """
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
    """
    Truncate `text` at the first occurrence of any stop word.

    Args:
        text: Model output text.
        stop_words: Optional list of stop word strings.

    Returns:
        Possibly truncated text.
    """
    if not text:
        return ''
    if not isinstance(stop_words, list):
        return text
    for sw in stop_words:
        ssw = safe_str(sw)
        if ssw and ssw in text:
            return text.split(ssw)[0]
    return text
