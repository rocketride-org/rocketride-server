# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Parallel wave executor for the RocketRide Wave.

Each wave is a list of tool calls that are dispatched concurrently
to the host tool infrastructure via ``host.tools.invoke()``.

Template references (e.g. ``"{{memory.ref:key}}"`` ) are resolved before
tool invocation and in the final answer.  An optional format and JMESPath
path can be appended using colon delimiters:

  - ``{{memory.ref:key}}``                       — raw value substitution
  - ``{{memory.ref:key:format}}``                — format the full value
  - ``{{memory.ref:key:format:path}}``           — extract path, then format

Supported formats: markdown_table, html_table, csv, json, text, or any
custom description (falls back to LLM formatting).

The path component is a JMESPath expression and may itself contain colons
(e.g. ``rows[0:5].city``), since it is always the last segment.
"""

from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List

import jmespath

from rocketlib import debug, error

from rocketlib.types import IInvokeLLM

from ai.common.agent import extract_text
from ai.common.agent.types import AgentHost
from ai.common.schema import Question

from .formatters import format_data

# Maximum number of concurrent tool executions per wave.  Keeping this at 8
# prevents runaway thread counts when the LLM issues many parallel calls.
_MAX_WORKERS = 8

# Hard timeout per individual tool call (seconds).  Prevents a slow external
# API from blocking the entire wave indefinitely.
_TOOL_TIMEOUT_S = 120

# Indentation used by _describe() when rendering nested structures.
_INDENT = '  '

# Maximum array items returned by a memory.peek tool call with a JMESPath path.
# Raised to 50 to give the LLM enough data to work with for typical result sets
# (e.g. forecast periods, DB rows) without issuing individual indexed peeks.
_PEEK_MAX_ARRAY_ITEMS = 50

# Default chunk size for offset/length-based raw text reads via memory.peek.
# 8000 characters is comfortably below typical LLM context constraints while
# covering most single-record API responses in one read.
_PEEK_DEFAULT_LENGTH = 8000

# Compiled regex for {{memory.ref:key:format:path}} template tags.
#
# Capture groups:
#   group(1) — key:    [^}:]+  no colons, no closing brace
#   group(2) — format: [^}:]+  no colons, no closing brace (optional)
#   group(3) — path:   [^}]+   may contain colons (JMESPath slices like rows[0:5])
#
# The path group uses [^}]+ rather than [^}:]+ precisely so that JMESPath
# slice notation (which uses colons) is captured correctly.  Since path is
# always the last segment before }}, no ambiguity arises.
_REF_PATTERN = re.compile(r'\{\{memory\.ref:([^}:]+)(?::([^}:]+))?(?::([^}]+))?\}\}')


# ---------------------------------------------------------------------------
# Structural summary (_describe)
# ---------------------------------------------------------------------------


def _describe(value: Any, depth: int = 0) -> str:
    """Return a compact structural summary of *value* for LLM context.

    The summary is shown in the "Previous tool results" section of the prompt
    so the LLM can understand the shape of stored data without loading it.
    It shows field names, array lengths, and sample values — enough for the
    LLM to formulate a correct JMESPath path for memory.peek.

    Design decisions:
    - Strings longer than 80 chars are truncated with a char count so the LLM
      knows it is a large value and should use chunked reading if needed.
    - Lists of dicts show field names and the first two rows so the LLM can
      see both the schema and representative data.
    - Lists of primitives show a short sample (first 3 items).
    - Depth is tracked so nested structures are indented readably.
    """
    pad = _INDENT * depth
    if value is None:
        return 'null'
    if isinstance(value, bool):
        # bool must be checked before int because bool is a subclass of int
        return str(value).lower()
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        if len(value) <= 80:
            return f'"{value}"'
        # Show prefix and total length so the LLM knows it can page through with offset/length
        return f'"{value[:80]}..." ({len(value)} chars)'
    if isinstance(value, list):
        n = len(value)
        if n == 0:
            return '[] (0 items)'
        first = value[0]
        if isinstance(first, dict):
            # Collect field names from up to 5 rows to handle sparse rows
            # where early rows may be missing fields that appear later.
            keys = list(dict.fromkeys(k for row in value[:5] if isinstance(row, dict) for k in row))
            lines = [f'{n} items, fields: {keys}']
            # Show first 2 rows as sample data so the LLM can see real values
            for i, row in enumerate(value[:2]):
                lines.append(f'{pad}{_INDENT}row[{i}]:\n{_describe_dict(row, depth + 1)}')
            return '\n'.join(lines)
        # Non-dict list — show a short JSON sample
        sample = json.dumps(value[:3], ensure_ascii=False)
        return f'{n} items, sample: {sample}'
    if isinstance(value, dict):
        return _describe_dict(value, depth)
    return str(value)


def _describe_dict(d: dict, depth: int) -> str:
    """Render a dict as indented key: value lines using _describe for values."""
    pad = _INDENT * depth
    lines = []
    for k, v in d.items():
        desc = _describe(v, depth + 1)
        if '\n' in desc:
            # Multi-line value — put it on its own line below the key
            lines.append(f'{pad}{k}:\n{desc}')
        else:
            lines.append(f'{pad}{k}: {desc}')
    return '\n'.join(lines)


# ---------------------------------------------------------------------------
# Template resolution
# ---------------------------------------------------------------------------


def _memory_get(key: str, host: AgentHost) -> Any:
    """Fetch a raw value from the memory store.

    Returns ``None`` on missing key, failed lookup, or any error — callers
    treat None as "key not found" and substitute an empty string or None
    in the template output.
    """
    try:
        result = host.memory.get(key)
        # Memory store returns {ok: bool, value: Any} — only unwrap on success
        if isinstance(result, dict) and result.get('ok'):
            return result.get('value')
    except Exception:
        pass
    return None


def _format_value(value: Any, fmt: str, host: AgentHost) -> str:
    """Apply a named formatter to *value*, falling back to LLM for unknown formats.

    Built-in formatters (markdown_table, html_table, csv, json, text) are
    handled by format_data() without an LLM call.  For any other format string
    (e.g. "bullet list", "prose summary"), we fire a secondary LLM call that
    takes the raw data as context and asks the model to render it.

    The LLM fallback enables open-ended formatting without maintaining an
    ever-growing list of built-in formatters.
    """
    formatted = format_data(value, fmt)
    if formatted is not None:
        return formatted

    # Unknown format — ask the LLM to render it
    debug(f'rocketride wave format fallback fmt={fmt!r}')
    raw = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    q = Question(role='You are a data formatting assistant.')
    q.addContext(raw)
    q.addQuestion(f'Format the data above as: {fmt}. Output ONLY the formatted result, nothing else.')
    try:
        result = host.llm.invoke(IInvokeLLM.Ask(question=q))
        return extract_text(result)
    except Exception as exc:
        debug(f'rocketride wave format LLM fallback failed: {exc}')
        # Last resort: return the raw value rather than crashing
        return raw


def _resolve_refs(value: Any, host: AgentHost) -> Any:
    """
    Recursively walk *value* and replace ``{{memory.ref:key}}``,
    ``{{memory.ref:key:format}}``, or ``{{memory.ref:key:format:path}}``
    tokens by fetching from memory, optionally extracting a JMESPath, and
    optionally applying a formatter.

    Two resolution modes:
    1. Exact match — the entire string is a single template tag.  The result
       is returned as its native type (dict, list, etc.) rather than coerced
       to a string.  This lets structured data flow through intact when a
       tool argument is entirely a memory reference.
    2. Substring substitution — the string contains one or more template tags
       mixed with literal text.  Each tag is replaced with its string
       representation and the surrounding text is preserved.
    """
    if isinstance(value, str):
        # Check for an exact full-string match first — avoids unnecessary
        # regex search on strings that don't contain any template tags.
        exact = _REF_PATTERN.fullmatch(value)
        if exact:
            key = exact.group(1)
            fmt = exact.group(2)
            path = exact.group(3)
            v = _memory_get(key, host)
            if v is None:
                return None
            # Apply JMESPath extraction before formatting so format receives
            # the narrowed slice, not the full stored object.
            if path:
                try:
                    v = jmespath.search(path, v)
                except Exception:
                    pass  # Bad path — fall through with the full value
            if fmt:
                return _format_value(v, fmt, host)
            # No format requested — return native type intact
            return v

        # Fast exit — no template tags anywhere in the string
        if not _REF_PATTERN.search(value):
            return value

        # Substring substitution — replace each tag in-place within the string
        def _sub(m: re.Match) -> str:
            key = m.group(1)
            fmt = m.group(2)
            path = m.group(3)
            v = _memory_get(key, host)
            if v is None:
                return ''  # Missing key → empty string, don't break the surrounding text
            if path:
                try:
                    v = jmespath.search(path, v)
                except Exception:
                    # Bad path — fall through with the original value so surrounding text still renders
                    pass
            if fmt:
                return _format_value(v, fmt, host)
            # No format — serialize to string for embedding in text
            if isinstance(v, str):
                return v
            try:
                return json.dumps(v, ensure_ascii=False)
            except Exception:
                return str(v)

        return _REF_PATTERN.sub(_sub, value)

    # Recurse into dicts and lists so template tags nested inside tool
    # argument objects are resolved before the tool is invoked.
    if isinstance(value, dict):
        return {k: _resolve_refs(v, host) for k, v in value.items()}

    if isinstance(value, list):
        return [_resolve_refs(v, host) for v in value]

    # Non-string scalar — nothing to resolve
    return value


def resolve_answer_refs(answer: str, host: AgentHost) -> str:
    """Resolve ``{{memory.ref:key[:format][:path]}}`` references in a final answer.

    Called by the agent driver after the LLM emits done=true so that any
    bulk data the LLM referenced (but never loaded into context) is fetched,
    optionally JMESPath-extracted, formatted, and substituted before the
    answer is delivered to the user.
    """
    if not isinstance(answer, str) or not _REF_PATTERN.search(answer):
        # Fast exit — no template references to resolve
        return answer
    return _resolve_refs(answer, host)


# ---------------------------------------------------------------------------
# Wave result storage
# ---------------------------------------------------------------------------


def _auto_key(wave_name: str, idx: int) -> str:
    """Generate a memory key scoped to a wave and call index.

    Keys follow the pattern ``<wave_name>.r<idx>`` (e.g. ``wave-0.r2``).
    This makes keys human-readable in traces and unique across waves,
    so the LLM can reference specific results from previous iterations.
    """
    return f'{wave_name}.r{idx}'


def _store_and_preview(tool: str, key: str, result: Any, host: AgentHost) -> Dict[str, Any]:
    """Store *result* in memory under *key* and return a compact summary dict.

    The summary dict is what gets recorded in the wave history and injected
    into the next planning prompt as "Previous tool results".  It contains:
    - tool: which tool produced the result (for display/debugging)
    - key: the memory key the LLM should use when referencing this result
    - summary: a compact structural description produced by _describe()

    The full result is stored as a native Python object in memory so that
    memory.peek can later extract specific fields via JMESPath without
    re-parsing a JSON string.
    """
    try:
        host.memory.put(key, result)
    except Exception as exc:
        error(f'rocketride wave memory.put key={key!r} failed: {exc}')
        raise

    summary = _describe(result)
    return {'tool': tool, 'key': key, 'summary': summary}


# ---------------------------------------------------------------------------
# Wave executor
# ---------------------------------------------------------------------------


def _execute_wave_calls(
    wave: List[Dict[str, Any]],
    *,
    host: AgentHost,
    wave_name: str = 'wave-0',
) -> List[Dict[str, Any]]:
    """Execute all tool calls in a wave in parallel and return result dicts.

    Each call in *wave* is a ``{"tool": str, "args": dict}`` entry emitted
    by the LLM.  Before execution, template references in args are resolved
    so the LLM can compose tool inputs from previously stored results.

    Results are returned in the same order as *wave* regardless of completion
    order — the pre-allocated results list and index mapping guarantee ordering
    even when futures complete out of sequence.
    """
    if not wave:
        return []

    # Tag each call with its auto-generated memory key before parallelism so
    # the key assignment is deterministic and order-preserving.
    tagged: List[Dict[str, Any]] = [{**call, '_key': _auto_key(wave_name, i)} for i, call in enumerate(wave)]

    def _run_one(call: Dict[str, Any]) -> Dict[str, Any]:
        """Execute a single tool call and return a result dict."""
        tool = call.get('tool', '')
        key = call['_key']
        args = call.get('args') or {}
        if not isinstance(args, dict):
            args = {}

        # Resolve any {{memory.ref:...}} template references in the args
        # before passing them to the tool.  This lets the LLM compose tool
        # inputs from previously stored results without extra peek calls.
        args = _resolve_refs(args, host)

        debug(f'rocketride wave execute tool={tool!r} key={key!r}')
        try:
            # memory.peek is handled entirely within the executor rather than
            # being routed through the tool pipeline.  Reasons:
            # 1. It reads from the host's memory store directly — there is no
            #    external service to invoke.
            # 2. It needs custom logic (JMESPath, chunking, array capping) that
            #    is specific to the Wave agent and not part of the generic tool
            #    protocol.
            # 3. peek results are NOT stored back into memory — they are
            #    ephemeral "read" results shown in context and then evicted via
            #    the remove field once the LLM has captured their data in scratch.
            if tool == 'memory.peek':
                mem_key = args.get('key', '')
                path = args.get('path', '')
                mem_result = host.memory.get(mem_key)
                if not (isinstance(mem_result, dict) and mem_result.get('ok')):
                    return {'tool': tool, 'key': key, 'error': f'key {mem_key!r} not found'}

                value = mem_result.get('value')

                if path:
                    # JMESPath mode — extract a specific field or slice from
                    # the stored object and return it as a preview string.
                    try:
                        value = jmespath.search(path, value)
                    except Exception as exc:
                        return {'tool': tool, 'key': key, 'error': f'JMESPath error: {exc}'}

                    # Cap large arrays to avoid flooding the prompt context.
                    # The LLM is told about truncation via returned_items/total_items
                    # so it can decide to use indexed paths or {{memory.ref}} template
                    # in the answer instead.
                    if isinstance(value, list) and len(value) > _PEEK_MAX_ARRAY_ITEMS:
                        total_items = len(value)
                        preview = json.dumps(value[:_PEEK_MAX_ARRAY_ITEMS], ensure_ascii=False)
                        return {
                            'tool': tool,
                            'key': key,
                            'path': path,
                            'preview': preview,
                            'truncated': True,
                            'returned_items': _PEEK_MAX_ARRAY_ITEMS,
                            'total_items': total_items,
                        }
                    preview = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                    return {'tool': tool, 'key': key, 'path': path, 'preview': preview}

                # No path — chunked raw text read.
                # Serialise non-string values to JSON first so offset/length
                # arithmetic works on a stable string representation.
                if not isinstance(value, str):
                    value = json.dumps(value, ensure_ascii=False, indent=2)
                offset = int(args.get('offset', 0))
                length = int(args.get('length', _PEEK_DEFAULT_LENGTH))
                chunk = value[offset : offset + length]
                return {
                    'tool': tool,
                    'key': key,
                    'preview': chunk,
                    'offset': offset,
                    'length': len(chunk),
                    'total_chars': len(value),
                }

            # Regular tool — route through the host's tool pipeline which
            # dispatches to the appropriate node via the control-plane invoke seam.
            result = host.tools.invoke(tool, args)

            # Store the result in memory and return a structural summary.
            # The summary is what gets injected into the next planning prompt;
            # the full result stays in memory for later memory.peek access.
            return _store_and_preview(tool, key, result, host)

        except Exception as exc:
            err_msg = f'{type(exc).__name__}: {exc}'
            error(f'rocketride wave execute tool={tool!r} error={err_msg}')
            # Return an error dict rather than propagating — the LLM sees the
            # error in the next prompt and can decide how to recover.
            return {'tool': tool, 'key': key, 'error': err_msg}

    # Cap workers to the actual number of calls — no point spinning up idle threads.
    n = min(_MAX_WORKERS, len(tagged))

    # Pre-allocate the results list so we can place results by index regardless
    # of which future completes first (as_completed() returns in arbitrary order).
    results: List[Any] = [None] * len(tagged)

    with ThreadPoolExecutor(max_workers=n) as pool:
        # Build a future→index mapping so we can place each result correctly.
        future_to_idx = {pool.submit(_run_one, call): i for i, call in enumerate(tagged)}
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                results[idx] = future.result()
            except Exception as exc:
                # future.result() should not raise since _run_one catches all
                # exceptions internally, but handle defensively just in case.
                call = tagged[idx]
                results[idx] = {
                    'tool': call.get('tool', ''),
                    'key': call['_key'],
                    'error': f'{type(exc).__name__}: {exc}',
                }

    # Filter out any None slots (shouldn't happen, but guards against bugs)
    return [r for r in results if r is not None]


def execute_wave(
    wave: List[Dict[str, Any]],
    *,
    host: AgentHost,
    wave_name: str = 'wave-0',
) -> List[Dict[str, Any]]:
    """Execute all tool calls in a wave concurrently.

    Every result is stored in memory under ``<wave_name>.r<idx>`` and a
    compact entry dict is returned containing:
      tool, key, summary — or tool, key, error on failure.

    Args:
        wave: List of ``{"tool": str, "args": dict}`` dicts.
        host: The agent host providing tool invocation via ``host.tools.invoke()``.
        wave_name: Name prefix for generated memory keys (e.g. ``"wave-0"``).

    Returns:
        List of result dicts (same order as wave).
    """
    return _execute_wave_calls(wave, host=host, wave_name=wave_name)
