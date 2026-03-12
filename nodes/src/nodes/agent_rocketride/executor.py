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
    """
    Retrieve a stored value from the agent host memory for the given key.
    
    Returns:
        The stored value if found, `None` if the key is missing or an error occurs.
    """
    try:
        result = host.tools.invoke('memory.get', {'key': key})
        if isinstance(result, dict) and result.get('ok'):
            return result.get('value')
    except Exception:
        pass
    return None


def _format_value(value: Any, fmt: str, host: AgentHost) -> str:
    """
    Format a value according to a format specifier, using an LLM fallback when built-in formatting is unavailable.
    
    Attempts to format `value` using available formatters; if that fails, requests formatting from the host LLM. If the LLM request fails, returns the original value converted to a string (non-strings are serialized to JSON).
    
    Parameters:
        value (Any): The value to format.
        fmt (str): The format specification or instruction.
    
    Returns:
        str: The formatted value as a string, or the original value represented as a string on fallback.
    """
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
    Resolve memory reference tokens of the form {{memory.get:key}} and {{memory.get:key@format}} within an arbitrary value using the provided host.
    
    Exact-match strings that are a single reference are replaced with the stored memory value (preserving the original value's type when present). References embedded inside larger strings are replaced with formatted/stringified values so the surrounding text remains a string. Missing memory keys resolve to `None` for exact-match strings and to an empty string for inline substitutions. The function recurses into dicts and lists; non-string scalar values are returned unchanged.
    
    Parameters:
        value: The value to scan and transform; may be a string, dict, list, or scalar.
    
    Returns:
        The transformed value with memory references resolved: exact-token strings return the stored value, inline-token strings return a string with substitutions, dicts/lists are returned with their contents recursively resolved, and other scalars are returned unchanged.
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
    """
    Resolve `{{memory.get:key[@format]}}` references in a final LLM answer.
    
    If `answer` is not a string or contains no reference tokens, it is returned unchanged.
    
    Returns:
        The answer string with memory references substituted.
    """
    if not isinstance(answer, str) or not _REF_PATTERN.search(answer):
        return answer
    return _resolve_refs(answer, host)


# ---------------------------------------------------------------------------
# Result-mode helpers
# ---------------------------------------------------------------------------

def _result_size_label(result: Any) -> str:
    """
    Return a human-readable size label for the given result.
    
    Returns:
        label (str): Size formatted as "<N> B" when under 1024 bytes, otherwise as "<X.X> KB".
    """
    try:
        n = len(json.dumps(result, ensure_ascii=False).encode())
    except Exception:
        n = len(str(result).encode())
    if n < 1024:
        return f'{n} B'
    return f'{n / 1024:.1f} KB'


def _store_to_memory(key: str, result: Any, host: AgentHost) -> bool:
    """
    Store a tool result in memory under the given key using the host's `memory.put` tool.
    
    Non-string results are serialized to JSON (with a fallback to str(result) on serialization error). Failures are logged and do not raise.
    
    Returns:
        `True` if the value was stored successfully, `False` otherwise.
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
    Execute a list of tool calls in parallel, resolving memory references and producing per-call results in the original order.
    
    Parameters:
        wave (List[Dict[str, Any]]): Sequence of call dictionaries with keys: "tool" (str), "args" (dict), and optionally a mode key "result", "peek", or "store" to control result handling (peek/store will persist values to memory).
    
    Returns:
        List[Dict[str, Any]]: List of per-call result dictionaries in the same order as `wave`. Each entry contains `tool`, `args`, `result`, `summary`, and may include `error` if the call failed.
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
