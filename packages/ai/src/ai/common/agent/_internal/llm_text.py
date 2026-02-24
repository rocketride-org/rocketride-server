from __future__ import annotations

from typing import Any, Dict, List, Union

from .utils import safe_str


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
    """Best-effort text extraction across engine response shapes."""
    try:
        if hasattr(result, 'getText') and callable(getattr(result, 'getText')):
            return (safe_str(result.getText()) or '').strip()  # type: ignore[attr-defined]
        if hasattr(result, 'getJson') and callable(getattr(result, 'getJson')):
            data = result.getJson()  # type: ignore[attr-defined]
            if isinstance(data, dict):
                for k in ('answer', 'content', 'text'):
                    if k in data and data[k] is not None:
                        return safe_str(data[k]).strip()
            return safe_str(data).strip()
        return safe_str(result).strip()
    except Exception:
        return safe_str(result).strip()


def truncate_at_stop_words(text: str, stop_words: Any) -> str:
    """Truncate `text` at the first occurrence of any stop word (best-effort)."""
    if not text:
        return ''
    if not isinstance(stop_words, list):
        return text
    for sw in stop_words:
        ssw = safe_str(sw)
        if ssw and ssw in text:
            return text.split(ssw)[0]
    return text

