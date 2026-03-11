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
_PEEK_MAX_LEN = 500

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
        # Exact match — call memory.get and return the stored value directly
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
            # No format — serialize as string
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
    """Resolve ``{{memory.get:key[@format]}}`` references in a final answer.

    This is the public entry point used by the agent driver to expand
    memory references in the LLM's final answer before returning it
    to the caller.
    """
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


def _store_to_memory(key: str, result: Any, host: AgentHost) -> bool:
    """Store a tool result in memory via the host ``memory.put`` tool.

    Serializes non-string results to JSON before storing.  Returns
    ``True`` on success, ``False`` on failure (logged but not raised).
    """
    # Normalize the value to a string — memory.put expects strings
    try:
        value = result
        if not isinstance(value, str):
            value = json.dumps(result, ensure_ascii=False)
    except Exception:
        value = str(result)

    # Delegate to the memory node via the host tool control-plane
    try:
        host.tools.invoke('memory.put', {'key': key, 'value': value})
        return True
    except Exception as exc:
        error(f'rocketride wave memory.put key={key!r} failed: {exc}')
        return False


def _build_summary(call: Dict[str, Any], result: Any, host: AgentHost) -> str:
    """
    Build the wave-history summary line based on the result mode.

    For ``peek`` and ``store`` modes, stores the result via the host
    memory.put tool.
    """
    # --- store mode: silent, just the key and size ---
    store_key = call.get('store')
    if isinstance(store_key, str) and store_key:
        _store_to_memory(store_key, result, host)
        return f'stored to "{store_key}" ({_result_size_label(result)})'

    # --- peek mode: store + short preview ---
    peek_key = call.get('peek')
    if isinstance(peek_key, str) and peek_key:
        _store_to_memory(peek_key, result, host)
        preview = summarize_result(result, max_len=_PEEK_MAX_LEN)
        return f'[{peek_key}] {preview}'

    # --- result mode (default): full summary ---
    return summarize_result(result)


# ---------------------------------------------------------------------------
# Wave executor
# ---------------------------------------------------------------------------

def execute_wave(
    wave: List[Dict[str, Any]],
    *,
    host: AgentHost,
) -> List[Dict[str, Any]]:
    """
    Execute all tool calls in a wave in parallel and return the results.

    Args:
        wave: List of ``{"tool": str, "args": dict}`` dicts, each optionally
              containing one of ``"result"``, ``"peek"``, or ``"store"``.
        host: The agent host providing tool invocation via ``host.tools.invoke()``.

    Returns:
        List of result dicts (same order as wave), each containing:
          tool, args, result, summary, and optionally error.
    """
    if not wave:
        return []

    def _run_one(call: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a single tool call — runs inside a thread pool worker."""
        tool = call.get('tool', '')
        args = call.get('args') or {}
        if not isinstance(args, dict):
            args = {}

        # Replace any {{memory.get:key}} placeholders with actual stored
        # values before invoking the tool.
        args = _resolve_refs(args, host)

        debug(f'rocketride wave execute tool={tool!r}')
        try:
            # Invoke the tool through the host control-plane
            result = host.tools.invoke(tool, args)
            # Build a summary line for wave history based on the result mode
            # (store / peek / result) specified by the planner
            summary = _build_summary(call, result, host)
            return {'tool': tool, 'args': args, 'result': result, 'summary': summary}
        except Exception as exc:
            err_msg = f'{type(exc).__name__}: {exc}'
            error(f'rocketride wave execute tool={tool!r} error={err_msg}')
            return {'tool': tool, 'args': args, 'result': None, 'summary': '', 'error': err_msg}

    # Cap the thread pool at _MAX_WORKERS to avoid overwhelming the host
    n = min(_MAX_WORKERS, len(wave))

    # Pre-allocate a fixed-size list so results stay in the same order
    # as the original wave (as_completed returns in arbitrary order)
    results: List[Any] = [None] * len(wave)

    with ThreadPoolExecutor(max_workers=n) as pool:
        # Submit all calls and map each future back to its wave index
        future_to_idx = {pool.submit(_run_one, call): i for i, call in enumerate(wave)}
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                results[idx] = future.result(timeout=_TOOL_TIMEOUT_S)
            except Exception as exc:
                # Record the error in-place so the planner sees the failure
                call = wave[idx]
                results[idx] = {
                    'tool': call.get('tool', ''),
                    'args': call.get('args') or {},
                    'result': None,
                    'summary': '',
                    'error': f'{type(exc).__name__}: {exc}',
                }

    # Filter out any remaining None slots (shouldn't happen, but defensive)
    return [r for r in results if r is not None]
