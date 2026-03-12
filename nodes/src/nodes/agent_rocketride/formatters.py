# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""
Data formatters for the RocketRide Wave agent.

Transforms raw data (typically stored in memory) into presentation formats
requested via the ``{{memory.get:key@format}}`` syntax.

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
# Individual formatters
# ---------------------------------------------------------------------------

def _to_rows(data: Any) -> Optional[List[Dict[str, Any]]]:
    """Try to interpret *data* as a list of dicts (table rows).

    Handles raw lists-of-dicts as well as the ``{"rows": [...]}`` shape
    returned by the database driver.  Returns ``None`` if the data is not
    tabular.
    """
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except (json.JSONDecodeError, ValueError):
            return None

    if isinstance(data, dict):
        # Unwrap {"rows": [...], ...} from DB results
        if 'rows' in data and isinstance(data['rows'], list):
            data = data['rows']
        else:
            # Single dict — treat as one-row table
            return [data]

    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data

    return None


def format_markdown_table(data: Any) -> Optional[str]:
    """Render tabular data as a Markdown table."""
    rows = _to_rows(data)
    if rows is None:
        return None

    headers = list(rows[0].keys())
    lines: List[str] = []

    # Header row
    lines.append('| ' + ' | '.join(str(h) for h in headers) + ' |')
    # Separator
    lines.append('| ' + ' | '.join('---' for _ in headers) + ' |')
    # Data rows
    for row in rows:
        cells = [str(row.get(h, '')) for h in headers]
        lines.append('| ' + ' | '.join(cells) + ' |')

    return '\n'.join(lines)


def format_html_table(data: Any) -> Optional[str]:
    """Render tabular data as an HTML table."""
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
    """Render tabular data as CSV."""
    rows = _to_rows(data)
    if rows is None:
        return None

    headers = list(rows[0].keys())
    buf = io.StringIO()
    writer = csv_mod.DictWriter(buf, fieldnames=headers)
    writer.writeheader()
    for row in rows:
        writer.writerow({h: row.get(h, '') for h in headers})
    return buf.getvalue().rstrip('\r\n')


def format_json(data: Any) -> Optional[str]:
    """Pretty-print data as JSON."""
    if isinstance(data, str):
        try:
            data = json.loads(data)
        except (json.JSONDecodeError, ValueError):
            return data  # already a string, return as-is
    try:
        return json.dumps(data, indent=2, ensure_ascii=False)
    except Exception:
        return str(data)


def format_text(data: Any) -> Optional[str]:
    """Render data as plain text — key: value pairs for dicts/rows."""
    rows = _to_rows(data)
    if rows is not None:
        lines: List[str] = []
        for i, row in enumerate(rows):
            if i > 0:
                lines.append('')
            for k, v in row.items():
                lines.append(f'{k}: {v}')
        return '\n'.join(lines)

    # Non-tabular: stringify
    if isinstance(data, str):
        return data
    try:
        return json.dumps(data, indent=2, ensure_ascii=False)
    except Exception:
        return str(data)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

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
    """Apply a built-in formatter.  Returns ``None`` if the format is unknown
    or the data shape is incompatible (caller should fall back to LLM)."""
    formatter = _FORMATTERS.get(fmt)
    if formatter is None:
        return None
    return formatter(data)
