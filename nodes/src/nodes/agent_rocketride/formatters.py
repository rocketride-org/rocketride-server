# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Data formatters for the RocketRide Wave agent.

Transforms raw data (typically stored in memory) into presentation formats
requested via the ``{{memory.ref:key:format}}`` or ``{{memory.ref:key:format:path}}`` syntax.

Supported formats:
  - ``markdown_table`` — Markdown table with headers and alignment
  - ``html_table``     — HTML ``<table>`` with ``<thead>`` and ``<tbody>``
  - ``csv``            — Comma-separated values with header row
  - ``json``           — Pretty-printed JSON
  - ``text``           — Plain-text key: value pairs

Unknown format strings fall through to an LLM-based formatter that asks the
model to render the data in the requested style.
"""

from __future__ import annotations

import csv as csv_mod
import io
import json
from typing import Any, Callable, Dict, List, Optional


# ---------------------------------------------------------------------------
# Individual formatters
# ---------------------------------------------------------------------------

def _to_rows(data: Any) -> Optional[List[Dict[str, Any]]]:
    """Try to interpret *data* as a list of dicts (table rows).

    Handles several common shapes returned by tool nodes so callers don't
    need to know the exact structure of the stored result:

    1. A JSON string — parsed first, then treated as one of the shapes below.
    2. ``{"rows": [...]}`` — the standard shape returned by database drivers.
    3. Any dict with exactly one list-of-dicts value — a common API response
       pattern where the table is nested under an arbitrary key.
    4. A single dict — treated as a one-row table (useful for single-record
       API responses like a geocoding result).
    5. A bare list of dicts — already the target shape, returned as-is.

    Returns ``None`` if the data cannot be interpreted as tabular rows,
    signalling the caller to fall back to a non-table renderer.
    """
    if isinstance(data, str):
        # Try to parse JSON strings — callers may pass serialized data
        try:
            data = json.loads(data)
        except (json.JSONDecodeError, ValueError):
            return None

    if isinstance(data, dict):
        # Unwrap {"rows": [...]} — the standard database driver output shape
        if 'rows' in data and isinstance(data['rows'], list):
            data = data['rows']
        else:
            # Look for any single list-of-dicts value (e.g. {"results": [...]})
            list_values = [v for v in data.values() if isinstance(v, list) and v and isinstance(v[0], dict)]
            if len(list_values) == 1:
                data = list_values[0]
            else:
                # No recognisable table structure — treat the whole dict as one row.
                # This handles single-record responses (weather current conditions, etc.)
                return [data]

    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data

    # Non-tabular data — signal the caller to use a different renderer
    return None


def format_markdown_table(data: Any) -> Optional[str]:
    """Render tabular data as a Markdown table.

    Uses _to_rows() to normalise the input shape before rendering.
    Column headers are derived from the keys of the first row.
    Returns None if the data is not tabular (caller falls back to LLM).
    """
    rows = _to_rows(data)
    if rows is None:
        return None

    # Use the first row's keys as column headers.  This assumes all rows
    # share the same schema, which holds for DB results and most API responses.
    headers = list(rows[0].keys())
    lines: List[str] = []

    # Header row
    lines.append('| ' + ' | '.join(str(h) for h in headers) + ' |')
    # Separator row — standard Markdown table alignment markers
    lines.append('| ' + ' | '.join('---' for _ in headers) + ' |')
    # Data rows — missing keys render as empty string rather than raising
    for row in rows:
        cells = [str(row.get(h, '')) for h in headers]
        lines.append('| ' + ' | '.join(cells) + ' |')

    return '\n'.join(lines)


def format_html_table(data: Any) -> Optional[str]:
    """Render tabular data as an HTML table with thead/tbody structure.

    Returns None if the data is not tabular.
    """
    rows = _to_rows(data)
    if rows is None:
        return None

    headers = list(rows[0].keys())
    parts: List[str] = ['<table>', '<thead><tr>']
    for h in headers:
        parts.append(f'<th>{h}</th>')
    parts.append('</tr></thead>')
    parts.append('<tbody>')
    for row in rows:
        parts.append('<tr>')
        for h in headers:
            parts.append(f'<td>{row.get(h, "")}</td>')
        parts.append('</tr>')
    parts.append('</tbody></table>')
    return ''.join(parts)


def format_csv(data: Any) -> Optional[str]:
    """Render tabular data as CSV with a header row.

    Uses Python's csv.DictWriter for correct quoting/escaping.
    Returns None if the data is not tabular.
    """
    rows = _to_rows(data)
    if rows is None:
        return None

    headers = list(rows[0].keys())
    buf = io.StringIO()
    writer = csv_mod.DictWriter(buf, fieldnames=headers)
    writer.writeheader()
    for row in rows:
        # extrasaction='ignore' would silently drop extra keys — using the
        # headers-only subset via get() is explicit and safe with sparse rows.
        writer.writerow({h: row.get(h, '') for h in headers})
    # Strip trailing newline for clean embedding in answers
    return buf.getvalue().rstrip('\r\n')


def format_json(data: Any) -> Optional[str]:
    """Pretty-print data as JSON.

    If *data* is a JSON string, parses and re-serialises for consistent
    indentation.  Always returns a string — never None — so it serves as
    a reliable last-resort formatter before the LLM fallback.
    """
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except (json.JSONDecodeError, ValueError):
            # Already a plain string — return as-is
            return data
    try:
        return json.dumps(data, indent=2, ensure_ascii=False)
    except Exception:
        return str(data)


def format_text(data: Any) -> Optional[str]:
    """Render data as plain text — key: value pairs for dicts/rows.

    For tabular data, each row is rendered as a block of ``key: value`` lines
    with a blank line between rows.  For non-tabular data, falls back to
    JSON pretty-printing so the output is at least readable.
    """
    rows = _to_rows(data)
    if rows is not None:
        lines: List[str] = []
        for i, row in enumerate(rows):
            # Blank line between rows for readability
            if i > 0:
                lines.append('')
            for k, v in row.items():
                lines.append(f'{k}: {v}')
        return '\n'.join(lines)

    # Non-tabular: pass through strings, JSON-encode everything else
    if isinstance(data, str):
        return data
    try:
        return json.dumps(data, indent=2, ensure_ascii=False)
    except Exception:
        return str(data)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

# Maps format name strings (as the LLM writes them in {{memory.ref:key:format}})
# to their formatter functions.  Unknown names fall through to the LLM formatter
# in _format_value() in executor.py.
_FORMATTERS: Dict[str, Callable[[Any], Optional[str]]] = {
    'markdown_table': format_markdown_table,
    'html_table': format_html_table,
    'csv': format_csv,
    'json': format_json,
    'text': format_text,
}


def get_builtin_formatter(fmt: str) -> Optional[Callable[[Any], Optional[str]]]:
    """Look up a built-in formatter by name.  Returns ``None`` if unknown."""
    return _FORMATTERS.get(fmt)


def format_data(data: Any, fmt: str) -> Optional[str]:
    """Apply a built-in formatter to *data*.

    Returns ``None`` if the format name is unknown or the data shape is
    incompatible with the requested format — the caller (executor._format_value)
    should then fall back to the LLM-based formatter.
    """
    formatter = _FORMATTERS.get(fmt)
    if formatter is None:
        # Unknown format name — signal caller to use LLM fallback
        return None
    return formatter(data)
