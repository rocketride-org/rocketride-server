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
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

"""
Pure in-memory engine for the platform list-API convention.

Every list endpoint accepts the same request arguments and returns the same
envelope — the rows returned ARE the endpoint's shape (clients derive their
available columns from the row keys):

Request arguments::

    page       1-based page number (default 1)
    page_size  rows per page (clamped 1..max, default 50)
    search     free text — case-insensitive contains over the endpoint's
               designated searchable keys (any key matching passes the row)
    sort       [{'field': <wire key>, 'dir': 'asc'|'desc'}, ...]
    filters    flat {key: value} record where value is a STRING or an ARRAY:
               a string is coerced from the ROW VALUE's type (string→contains,
               boolean/number→equality, arrays/objects→text contains); an
               ARRAY means set membership — the row value must equal (or, for
               array-valued rows, contain) ANY of the elements.
               ``<key>__gte`` / ``<key>__lte`` carry datetime/number range
               bounds (a date-only __lte is end-of-day inclusive; arrays are
               invalid on range keys). Unknown keys are skipped with a debug
               log.

Response envelope::

    {'rows': [...], 'total': int, 'page': int, 'pageSize': int}

This module is the PURE-python half of the convention: it operates on
already-materialized dict rows — the equivalent of WHERE + ORDER BY +
LIMIT/OFFSET for endpoints whose data does not live in a SQL table (live
server state, external APIs such as Stripe). The handler builds the full row
set once, then :func:`paginate_rows` performs the same four steps a database
would — search, filter, sort, slice — as plain Python list operations.

The SQL half (SQLAlchemy condition builders, LIKE escaping, typed column
coercion) lives with the extension's database layer and mirrors these
semantics exactly, so a grid cannot tell whether an endpoint is DB-backed or
memory-backed. Nothing here may import SQLAlchemy.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

from rocketlib import debug

# Suffixes carrying range operators in filter keys (e.g. createdAt__gte).
RANGE_SUFFIXES: Tuple[str, ...] = ('__gte', '__lte')


# =============================================================================
# VALUE COERCION
# =============================================================================


def coerce_bool(value: str) -> bool:
    """
    Coerce a filter string to a boolean.

    Args:
        value: Client-provided filter value.

    Returns:
        True for the usual truthy spellings.
    """
    return str(value).strip().lower() in ('1', 'true', 'yes', 'on')


def parse_datetime_bound(value: str, *, end_inclusive: bool) -> Optional[datetime]:
    """
    Parse an ISO datetime/date filter bound. A date-only upper bound is made
    end-of-day inclusive so `until 2026-07-15` covers that whole day.

    Args:
        value: ISO 8601 date or datetime string.
        end_inclusive: True for __lte bounds.

    Returns:
        A datetime, or None if the value does not parse.
    """
    try:
        parsed = datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None
    if end_inclusive and len(str(value)) == 10:
        parsed = parsed + timedelta(days=1) - timedelta(microseconds=1)
    return parsed


def split_range_suffix(key: str) -> Tuple[str, str]:
    """
    Split a filter key into (base key, range suffix).

    Args:
        key: Raw filter key (e.g. 'createdAt__gte').

    Returns:
        ('createdAt', '__gte') — or (key, '') when no suffix is present.
    """
    for suffix in RANGE_SUFFIXES:
        if key.endswith(suffix):
            return key[: -len(suffix)], suffix
    return key, ''


# =============================================================================
# PAGING + SERIALIZATION
# =============================================================================


def clamp_paging(args: Dict[str, Any], *, default_size: int = 50, max_size: int = 100) -> Tuple[int, int]:
    """
    Clamp the paging arguments.

    Args:
        args: Request arguments.
        default_size: Page size when absent.
        max_size: Upper page-size bound.

    Returns:
        (page, page_size) — page is 1-based; the caller applies
        ``.offset((page - 1) * page_size).limit(page_size)``.
    """
    # `or` (not a default arg) so an explicit null / 0 / '' from client JSON
    # falls back to the default instead of raising int(None) / clamping to a
    # nonsense page — malformed paging degrades to the clamped default.
    page = max(1, int(args.get('page') or 1))
    page_size = min(max_size, max(1, int(args.get('page_size') or default_size)))
    return page, page_size


def json_safe(value: Any) -> Any:
    """
    Make one row value JSON-safe (datetimes to ISO, Decimals to float).

    Args:
        value: Raw row value.

    Returns:
        The JSON-safe value.
    """
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    return value


# =============================================================================
# IN-MEMORY PAGINATOR
# =============================================================================


def _row_sort_key(value: Any) -> Tuple[int, Any]:
    """
    Sort key tolerant of None and mixed types (None sorts first ascending).

    Args:
        value: A row field value.

    Returns:
        A (type-rank, comparable) tuple.
    """
    if value is None:
        return (0, 0)
    if isinstance(value, bool):
        return (1, int(value))
    if isinstance(value, (int, float)):
        return (1, value)
    return (2, str(value).lower())


def _row_matches_filter(row_value: Any, value: Any, suffix: str) -> bool:
    """
    Evaluate one filter entry against one materialized row value, mirroring
    the SQL semantics (contains for strings, equality for bools/numbers,
    set membership for ARRAY values, range bounds for __gte/__lte).

    Args:
        row_value: The row's value for the filter's base key.
        value: The filter value (string, or array = set membership).
        suffix: '' or a range suffix.

    Returns:
        True when the row passes this filter.
    """
    # Array value: set membership (checklist filters); invalid on ranges.
    if isinstance(value, (list, tuple)):
        if suffix:
            return True
        items = {str(item).lower() for item in value if str(item) != ''}
        if not items:
            return True
        if isinstance(row_value, (list, tuple)):
            # Row holds an array (e.g. permissions): match ANY element.
            return any(str(element).lower() in items for element in row_value)
        if isinstance(row_value, bool):
            return str(row_value).lower() in items or ('true' if row_value else 'false') in items
        return str(row_value).lower() in items

    if suffix:
        # Range bounds: numeric when the value is numeric, else ISO-string.
        if isinstance(row_value, (int, float)) and not isinstance(row_value, bool):
            try:
                bound = float(value)
            except ValueError:
                return True
            return row_value >= bound if suffix == '__gte' else row_value <= bound
        left = str(row_value or '')
        bound_dt = parse_datetime_bound(value, end_inclusive=(suffix == '__lte'))
        if bound_dt is None:
            return True
        return (left >= bound_dt.isoformat()) if suffix == '__gte' else (left <= bound_dt.isoformat())

    if isinstance(row_value, bool):
        return row_value == coerce_bool(value)
    if isinstance(row_value, (int, float)):
        try:
            return float(row_value) == float(value)
        except ValueError:
            return True
    # Strings, arrays, and objects match by case-insensitive containment of
    # their text rendering — same behavior as the SQL text-cast path.
    return str(value).lower() in str(row_value).lower()


def paginate_rows(
    rows: Iterable[Dict[str, Any]],
    args: Dict[str, Any],
    *,
    searchable_keys: Sequence[str] = (),
    default_sort: Tuple[str, str] = ('createdAt', 'desc'),
    tiebreak_key: str = 'id',
    max_size: int = 100,
) -> Dict[str, Any]:
    """
    Apply the full list-API convention (search / filters / sort / paging) to
    already-materialized dict rows and return the standard envelope. This is
    the equivalent of WHERE + ORDER BY + LIMIT/OFFSET for endpoints whose
    data does not live in a database (live server state, Stripe promo codes):
    the handler fetches the full set once, then this does the same four steps
    as the database would — as plain Python list operations.

    Args:
        rows: The complete materialized row set.
        args: Request arguments per the convention.
        searchable_keys: Keys participating in free-text search.
        default_sort: (field, dir) when no valid sorter is supplied.
        tiebreak_key: Deterministic tiebreak field.
        max_size: Upper page-size bound.

    Returns:
        The standard {rows, total, page, pageSize} envelope.
    """
    working = list(rows)
    page, page_size = clamp_paging(args, max_size=max_size)

    # Step 1: free-text search over the designated keys. Only None/missing
    # values collapse to '' — valid falsy values (0, False) must stay
    # searchable, so no `or ''` coercion on either side.
    term_raw = args.get('search')
    term = str(term_raw if term_raw is not None else '').strip().lower()
    if term and searchable_keys:
        working = [
            row
            for row in working
            if any(term in ('' if row.get(key) is None else str(row.get(key)).lower()) for key in searchable_keys)
        ]

    # Step 2: filters (same key/operator convention as the SQL path).
    for raw_key, raw_value in (args.get('filters') or {}).items():
        # String or array — empty either way means "filter off".
        if isinstance(raw_value, (list, tuple)):
            value: Any = [str(item) for item in raw_value if str(item) != '']
            if not value:
                continue
        else:
            value = str(raw_value)
            if value == '':
                continue
        base_key, suffix = split_range_suffix(raw_key)
        if working and base_key not in working[0]:
            debug(f'[list_rows] skipping unknown filter key: {raw_key!r}')
            continue
        working = [row for row in working if _row_matches_filter(row.get(base_key), value, suffix)]

    total = len(working)

    # Step 3: sort (whitelisted against row keys), tiebreak least-significant.
    sorters = [
        s
        for s in (args.get('sort') or [])
        if (s or {}).get('field') and (not working or (s or {}).get('field') in working[0])
    ]
    if not sorters:
        sorters = [{'field': default_sort[0], 'dir': default_sort[1]}]
    working.sort(key=lambda row: _row_sort_key(row.get(tiebreak_key)))
    for sorter in reversed(sorters):
        field = sorter.get('field', '')
        reverse = str(sorter.get('dir', 'asc')).lower() == 'desc'
        working.sort(key=lambda row: _row_sort_key(row.get(field)), reverse=reverse)

    # Step 4: the page slice (LIMIT/OFFSET) + envelope.
    start = (page - 1) * page_size
    return {
        'rows': working[start : start + page_size],
        'total': total,
        'page': page,
        'pageSize': page_size,
    }
