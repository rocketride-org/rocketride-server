# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Parallel wave executor for the RocketRide Wave.

Each wave is a list of tool calls that are dispatched concurrently
to the host tool infrastructure via ``host.tools.invoke()``.

Result handling modes (per call):
  - ``"result": true``  — full result summary in wave history.
  - ``"peek": "<key>"`` — store result in memory, show a short preview in wave history.
  - ``"store": "<key>"``— (default) store result in memory silently.

Template references (e.g. ``"{{memory.get:key}}"``) are resolved before
tool invocation.  An optional ``@format`` suffix triggers data formatting:

  - ``{{memory.get:key}}``                — raw value substitution
  - ``{{memory.get:key@markdown_table}}`` — format as Markdown table
  - ``{{memory.get:key@html_table}}``     — format as HTML table
  - ``{{memory.get:key@csv}}``            — format as CSV
  - ``{{memory.get:key@json}}``           — format as pretty-printed JSON
  - ``{{memory.get:key@text}}``           — format as plain text
  - ``{{memory.get:key@<other>}}``        — LLM fallback formatting
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List

from rocketlib import debug, error

from rocketlib.types import IInvokeLLM

from ai.common.agent import extract_text
from ai.common.agent.types import AgentHost
from ai.common.schema import Question

from .formatters import format_data
from .planner import summarize_result

_MAX_WORKERS = 8
_TOOL_TIMEOUT_S = 120
_PREVIEW_MAX_LEN = 500

# Matches {{memory.get:key}} and {{memory.get:key@format}}
_REF_PATTERN = re.compile(r'\{\{memory\.get:([^}@]+)(?:@([^}]+))?\}\}')


# ---------------------------------------------------------------------------
# Template resolution
# ---------------------------------------------------------------------------

def _memory_get(key: str, host: AgentHost) -> Any:
    """Fetch a value from memory.  Returns ``None`` on missing key or error."""
    try:
        result = host.tools.invoke('memory.get', {'key': key})
        if isinstance(result, dict) and result.get('ok'):
            return result.get('value')
    except Exception:
        pass
    return None



def _format_value(value: Any, fmt: str, host: AgentHost) -> str:
    """Apply a formatter to a value.  Falls back to LLM for unknown formats."""
    # Try built-in formatter first
    formatted = format_data(value, fmt)
    if formatted is not None:
        return formatted

    # LLM fallback — ask the model to format the data
    debug(f'rocketride wave format fallback fmt={fmt!r}')
    raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    q = Question(role='You are a data formatting assistant.')
    q.addContext(raw)
    q.addQuestion(f'Format the data above as: {fmt}. Output ONLY the formatted result, nothing else.')
    try:
        result = host.llm.invoke(IInvokeLLM(op='ask', question=q))
        return extract_text(result)
    except Exception as exc:
        debug(f'rocketride wave format LLM fallback failed: {exc}')
        return raw


def _resolve_refs(value: Any, host: AgentHost) -> Any:
    """
    Recursively walk *value* and replace ``{{memory.get:key}}`` or
    ``{{memory.get:key@format}}`` tokens by fetching from memory and
    optionally applying a formatter.

    - If the entire value is a single reference string, it is replaced with
      the stored value (preserving type where possible).
    - If a reference appears inside a larger string, it is substituted as
      a formatted string.
    - Missing keys resolve to ``None``.
    """
    if isinstance(value, str):
        # Exact match — return the stored value directly (preserving type)
        exact = _REF_PATTERN.fullmatch(value)
        if exact:
            key = exact.group(1)
            fmt = exact.group(2)  # None if no @format
            v = _memory_get(key, host)
            if v is None:
                return None
            if fmt:
                return _format_value(v, fmt, host)
            return v

        # Inline substitution — the string contains one or more refs mixed
        # with other text.  Each ref is replaced with its formatted/serialized
        # string so the surrounding text stays coherent.
        if not _REF_PATTERN.search(value):
            return value  # fast path: no refs to resolve

        def _sub(m: re.Match) -> str:
            """Replace a single {{memory.get:key[@format]}} match."""
            key = m.group(1)
            fmt = m.group(2)  # None if no @format
            v = _memory_get(key, host)
            if v is None:
                return ''
            if fmt:
                return _format_value(v, fmt, host)
            if isinstance(v, str):
                return v
            try:
                return json.dumps(v, ensure_ascii=False)
            except Exception:
                return str(v)

        return _REF_PATTERN.sub(_sub, value)

    # Recurse into dicts and lists to resolve nested refs
    if isinstance(value, dict):
        return {k: _resolve_refs(v, host) for k, v in value.items()}

    if isinstance(value, list):
        return [_resolve_refs(v, host) for v in value]

    # Non-string scalars (int, float, bool, None) pass through unchanged
    return value


def resolve_answer_refs(answer: str, host: AgentHost) -> str:
    """Resolve ``{{memory.get:key[@format]}}`` references in a final answer."""
    if not isinstance(answer, str) or not _REF_PATTERN.search(answer):
        return answer
    return _resolve_refs(answer, host)


# ---------------------------------------------------------------------------
# Result-mode helpers
# ---------------------------------------------------------------------------

def _result_size_label(result: Any) -> str:
    """Human-readable byte-size label for a result."""
    try:
        n = len(json.dumps(result, ensure_ascii=False).encode())
    except Exception:
        n = len(str(result).encode())
    if n < 1024:
        return f'{n} B'
    return f'{n / 1024:.1f} KB'


def _auto_key(wave_name: str, idx: int) -> str:
    """Generate a memory key scoped to a wave and call index."""
    return f'{wave_name}.r{idx}'


def _store_and_preview(key: str, result: Any, host: AgentHost) -> str:
    """Store *result* in memory under *key* and return a summary line.

    Always stores the full result and returns a preview of up to
    _PREVIEW_MAX_LEN characters so the LLM can read the data inline.
    The summary includes the key and full size so the LLM can decide
    whether to reference the stored value in a later wave or the answer.
    """
    # MemoryStore is string-only by design (see memory.py MemoryStore.put).
    # Non-string results are JSON-serialized so callers can json.loads() them to
    # recover structure. Passing result directly would invoke str() on dicts/lists,
    # producing unstructured text. Do not change this serialization.
    try:
        value = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
    except Exception:
        value = str(result)

    try:
        host.tools.invoke('memory.put', {'key': key, 'value': value})
    except Exception as exc:
        error(f'rocketride wave memory.put key={key!r} failed: {exc}')
        raise  # Re-raise — caller must record this as a failed tool call, not a success

    size = _result_size_label(result)
    preview = summarize_result(result, max_len=_PREVIEW_MAX_LEN)
    return f'[key: "{key}", {size}] {preview}'


# ---------------------------------------------------------------------------
# Wave executor
# ---------------------------------------------------------------------------

def _execute_wave_calls(
    wave: List[Dict[str, Any]],
    *,
    host: AgentHost,
    wave_name: str = 'wave-0',
) -> List[Dict[str, Any]]:
    """Execute all tool calls in a wave in parallel.

    Each call's result is automatically stored in memory under an
    auto-generated key and a preview is returned inline so the LLM
    can read the data without a separate fetch.
    """
    if not wave:
        return []

    # Assign wave-scoped keys before dispatch so each worker knows its key
    tagged: List[Dict[str, Any]] = [
        {**call, '_key': _auto_key(wave_name, i)}
        for i, call in enumerate(wave)
    ]

    def _run_one(call: Dict[str, Any]) -> Dict[str, Any]:
        tool = call.get('tool', '')
        key = call['_key']
        args = call.get('args') or {}
        if not isinstance(args, dict):
            args = {}
        args = _resolve_refs(args, host)

        debug(f'rocketride wave execute tool={tool!r} key={key!r}')
        try:
            result = host.tools.invoke(tool, args)
            summary = _store_and_preview(key, result, host)
            return {'tool': tool, 'args': args, 'key': key, 'result': result, 'summary': summary}
        except Exception as exc:
            err_msg = f'{type(exc).__name__}: {exc}'
            error(f'rocketride wave execute tool={tool!r} error={err_msg}')
            return {'tool': tool, 'args': args, 'key': key, 'result': None, 'summary': '', 'error': err_msg}

    n = min(_MAX_WORKERS, len(tagged))
    results: List[Any] = [None] * len(tagged)

    with ThreadPoolExecutor(max_workers=n) as pool:
        future_to_idx = {pool.submit(_run_one, call): i for i, call in enumerate(tagged)}
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                # future is already complete when as_completed() yields it — a timeout here
                # is a no-op. Tools are responsible for enforcing their own timeouts internally.
                results[idx] = future.result()
            except Exception as exc:
                call = tagged[idx]
                results[idx] = {
                    'tool': call.get('tool', ''),
                    'args': call.get('args') or {},
                    'key': call['_key'],
                    'result': None,
                    'summary': '',
                    'error': f'{type(exc).__name__}: {exc}',
                }

    return [r for r in results if r is not None]


def execute_wave(
    wave: List[Dict[str, Any]],
    *,
    host: AgentHost,
    wave_name: str = 'wave-0',
) -> List[Dict[str, Any]]:
    """Execute all tool calls in a wave concurrently.

    Every result is automatically stored in memory under a key of the form
    ``<wave_name>.r<idx>`` (e.g. ``wave-0.r0``) and a preview is returned inline.

    Args:
        wave: List of ``{"tool": str, "args": dict}`` dicts.
        host: The agent host providing tool invocation via ``host.tools.invoke()``.
        wave_name: Name prefix for generated memory keys (e.g. ``"wave-0"``).

    Returns:
        List of result dicts (same order as wave), each containing:
          tool, args, key, result, summary, and optionally error.
    """
    return _execute_wave_calls(wave, host=host, wave_name=wave_name)
