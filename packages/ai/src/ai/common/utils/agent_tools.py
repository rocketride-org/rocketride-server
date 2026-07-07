# =============================================================================
# MIT License
#
# Copyright (c) 2026 Aparavi Software AG
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
# =============================================================================

"""
Shared helpers for LangChain-based agent drivers (agent_langchain, agent_deepagent).

Both drivers used to ship near-identical local copies of these helpers. They
live here so a bug fix or behaviour decision only has to land once.

These helpers do **not** import LangChain at module load — the imports are
deferred so test environments without ``langchain_core`` installed can still
import this module.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List

from .string_utils import safe_str


def normalize_bound_tools(tools: Any) -> List[Dict[str, Any]]:
    """Normalise a LangChain tool or list of tools into plain descriptor dicts.

    Each entry carries the tool's real JSON Schema (not ``str(<class 'X'>)``)
    so the LLM sees the actual argument names when it renders the tool-call
    envelope — without this, models routinely guess wrong arg names on tools
    like ``task`` (e.g. emit ``prompt`` instead of ``description``).

    Args:
        tools: A single LangChain tool, a list of tools, or ``None`` / falsy.

    Returns:
        A list of plain dicts with ``name``, ``description``, ``args_schema``,
        and (when present) ``input_schema`` keys. Empty list for falsy input.
    """
    if not tools:
        return []
    if not isinstance(tools, list):
        tools = [tools]

    out: List[Dict[str, Any]] = []
    for t in tools:
        schema = getattr(t, 'args_schema', None)
        input_schema = getattr(t, '_rr_input_schema', None)

        entry: Dict[str, Any] = {
            'name': safe_str(getattr(t, 'name', '')),
            'description': safe_str(getattr(t, 'description', '')),
            'args_schema': _tool_args_schema(schema),
        }
        if isinstance(input_schema, dict):
            entry['input_schema'] = input_schema
        out.append(entry)
    return out


def langchain_messages_to_transcript(messages: Any) -> str:
    """Convert a LangChain message list (or plain string/dict) to a transcript.

    Each message becomes one ``role: content`` line. ``AIMessage`` tool calls
    are rendered as JSON-encoded ``tool_call`` envelopes appended to the
    content so the transcript captures what the model actually emitted, not
    just its text.

    Args:
        messages: ``None``, a string (returned as-is), a dict (returned as
            JSON), a list of LangChain message objects (rendered as a
            multi-line transcript), or anything else (best-effort ``str()``).

    Returns:
        The transcript as a single string. Empty string for ``None`` or
        empty list.
    """
    try:
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
    except Exception:
        # Sentinel class — NOT ``object``. ``isinstance(m, object)`` is True for
        # every message, which would make the first branch below (SystemMessage)
        # silently swallow every message as ``role='system'``. A unique class
        # makes the isinstance checks correctly return False when langchain_core
        # is not installed, letting the loop fall through to the bare-user path.
        class _MissingLangChainMessage:
            pass

        AIMessage = HumanMessage = SystemMessage = ToolMessage = _MissingLangChainMessage  # type: ignore

    if messages is None:
        return ''
    if isinstance(messages, str):
        return messages
    if isinstance(messages, dict):
        return json.dumps(messages, default=str)
    if not isinstance(messages, list):
        try:
            return str(messages)
        except Exception:
            return ''

    lines: List[str] = []
    for m in messages:
        role = 'user'
        content = ''
        try:
            content = safe_str(getattr(m, 'content', ''))
        except Exception:
            content = safe_str(m)

        if isinstance(m, SystemMessage):
            role = 'system'
        elif isinstance(m, HumanMessage):
            role = 'user'
        elif isinstance(m, ToolMessage):
            role = 'tool'
            try:
                name = safe_str(getattr(m, 'name', ''))
                # Carry the tool_call_id so each result stays paired with the
                # specific call that produced it. Without this, a turn that
                # replays *parallel* calls to the same tool loses the
                # call->result mapping and the model can mis-attribute results.
                call_id = safe_str(getattr(m, 'tool_call_id', ''))
                label = f'{name}#{call_id}' if name and call_id else (name or call_id)
                if label:
                    role = f'tool[{label}]'
            except Exception:
                pass
        elif isinstance(m, AIMessage):
            role = 'assistant'
            try:
                tool_calls = [tc for tc in (getattr(m, 'tool_calls', None) or []) if isinstance(tc, dict)]
                if tool_calls:
                    calls = [
                        {
                            'id': safe_str(tc.get('id', '')),
                            'name': safe_str(tc.get('name', '')),
                            'args': tc.get('args', {}),
                        }
                        for tc in tool_calls
                    ]
                    # Preserve the original grouping and per-call ids so a replayed
                    # turn is unambiguous. A single call renders as the singular
                    # envelope; multiple parallel calls render as ONE plural
                    # ``tool_calls`` envelope (the same shape the model emitted)
                    # rather than being flattened into separate single-call lines,
                    # which erased both the grouping and the id->result pairing.
                    if len(calls) == 1:
                        envelope: Dict[str, Any] = {'type': 'tool_call', **calls[0]}
                    else:
                        envelope = {'type': 'tool_calls', 'calls': calls}
                    rendered = json.dumps(envelope, ensure_ascii=False, default=str)
                    content = '\n'.join(filter(None, [content, rendered]))
            except Exception:
                pass

        lines.append(f'{role}: {content}')

    return '\n'.join(lines).strip()


def _tool_args_schema(schema: Any) -> Any:
    """Return a JSON-Schema dict for a tool's ``args_schema``, or a string fallback.

    Pydantic v2 models expose ``model_json_schema()``; older models expose
    ``schema()``. When neither works, falls back to ``str(schema)`` so the LLM
    still sees *something* identifying the expected shape.
    """
    if schema is None:
        return ''
    for attr in ('model_json_schema', 'schema'):
        fn = getattr(schema, attr, None)
        if callable(fn):
            try:
                result = fn()
                if isinstance(result, dict):
                    return result
            except Exception:
                continue
    return safe_str(schema)
