# =============================================================================
# MIT License
# Copyright (c) 2024 RocketRide Inc.
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OF OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Small agent-boundary utilities.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .types import CONTINUATION_TYPE


def extract_prompt(question: Any) -> str:
    """Extract the user prompt string from a Question-like object."""
    # Prefer the first QuestionText.text
    if hasattr(question, 'questions') and getattr(question, 'questions', None):
        first = question.questions[0]
        if hasattr(first, 'text'):
            text = (first.text or '').strip()
            if text:
                return text
    # Fallback: attempt best-effort string conversion
    text = str(question).strip()
    if not text:
        raise ValueError('No prompt provided in Question.questions[0].text')
    return text


def extract_continuation(context: Any) -> Optional[Dict[str, Any]]:
    """Extract a continuation record from Question.context (best-effort)."""
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
    """Generate a new run identifier."""
    return str(uuid.uuid4())


def now_iso() -> str:
    """Return current UTC timestamp as ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()


def safe_str(value: Any) -> str:
    """Best-effort stringify helper."""
    if value is None:
        return ''
    try:
        return str(value)
    except Exception:
        return ''


# -----------------------------------------------------------------------------
# Invoke / tool payload helpers (kept here to avoid cross-module drift)
# -----------------------------------------------------------------------------
def get_field(obj: Any, name: str) -> Any:
    """Get a field from a dict-like or attribute-like object (best-effort)."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def set_field(obj: Any, name: str, value: Any) -> None:
    """Set a field on a dict-like or attribute-like object (best-effort)."""
    if obj is None:
        return
    if isinstance(obj, dict):
        obj[name] = value
        return
    try:
        setattr(obj, name, value)
    except Exception:
        pass


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
    """Return True if tool_name looks like an agent-tool run entry: `<server>.run_agent`."""
    try:
        _server, bare = split_namespaced_tool_name(tool_name)
        return bare == 'run_agent'
    except Exception:
        return False


def extract_tool_names(tool_catalog: Any) -> List[str]:
    """Extract tool names from a host.tools.query response"""
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

