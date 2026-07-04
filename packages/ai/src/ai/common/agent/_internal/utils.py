"""
Internal helpers for agent framework drivers.

This module contains small, framework-agnostic utilities used by `AgentBase` and
the agent-as-tool adapter:
- run id / timestamp helpers
- transcript and text extraction helpers for host LLM responses
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Union

from ai.common.utils import safe_str  # re-imported so the helpers below can use it


def new_run_id() -> str:
    """Return a new UUID string for an agent run."""
    return str(uuid.uuid4())


def now_iso() -> str:
    """Return current UTC timestamp as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


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
    Truncate `text` at the first exact occurrence of any stop word.

    This is the backstop behind API-level `stop_sequences` (now primary): the provider
    already stops generating at the marker, so this only trims a fabricated ReAct tail on
    the rare miss. Matching is exact and case-sensitive on purpose — a fuzzy/anchored
    match would over-truncate legitimate answers that merely contain the marker text
    (e.g. "My key observation: ...").

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
