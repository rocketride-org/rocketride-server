"""
Internal helpers for agent framework drivers.

This module contains small, framework-agnostic utilities used by `AgentBase` and
the agent-as-tool adapter:
- run id / timestamp helpers
- transcript and text extraction helpers for host LLM responses
- attachment-to-tool-slot binding (path-by-reference) for multimodal tool calls
"""

from __future__ import annotations

import fnmatch
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Union

from ai.common.schema import Attachment
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


# ---------------------------------------------------------------------------
# Attachment -> tool-slot binding
#
# A tool's input schema declares attachment-typed properties via
# ``format: "rocketride-attachment"``. These helpers bind an Attachment from
# ``AgentContext.attachments`` to each such slot, respecting any
# ``x-rocketride-mimes`` patterns, and return the filestore path
# (path-by-reference); the dispatcher resolves it to bytes before invoking the
# tool method.
# ---------------------------------------------------------------------------
def _mime_matches_patterns(mime: str, patterns: Sequence[str]) -> bool:
    if not patterns:
        return True
    for pat in patterns:
        if fnmatch.fnmatchcase(mime, pat):
            return True
    return False


def pick_for_property(prop_schema: Dict[str, Any], candidates: Sequence[Attachment]) -> Optional[Attachment]:
    """Return the first candidate whose MIME matches the schema's patterns, or None.

    Returns ``None`` when the property is not attachment-typed
    (``format != "rocketride-attachment"``) or no candidate matches the
    declared ``x-rocketride-mimes`` patterns. Absent patterns accept any
    MIME.
    """
    if prop_schema.get('format') != 'rocketride-attachment':
        return None
    patterns = prop_schema.get('x-rocketride-mimes') or []
    for att in candidates:
        if _mime_matches_patterns(att.mime, patterns):
            return att
    return None


def pick_for_tool_call(input_schema: Dict[str, Any], candidates: Sequence[Attachment]) -> Dict[str, str]:
    """Return ``{prop_name: filestore_path}`` for every matched attachment slot.

    Top-level walk only — mirrors the dispatcher's resolution scope.
    Properties whose schema is not a dict, or that
    are not attachment-typed, or for which no candidate matches, are
    omitted from the returned mapping.
    """
    out: Dict[str, str] = {}
    props = (input_schema or {}).get('properties') or {}
    for prop_name, prop_schema in props.items():
        if not isinstance(prop_schema, dict):
            continue
        picked = pick_for_property(prop_schema, candidates)
        if picked is not None:
            out[prop_name] = picked.path
    return out
