# =============================================================================
# MIT License
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

"""Dialect briefing and schema formatting for Hotdata NL-to-SQL.

The dialect text below is the crux of this node. Hotdata runs Apache DataFusion
54 behind the *PostgreSQL parser dialect*, which is a genuinely unusual
combination: an LLM told only "Postgres" will confidently emit ``->>``,
``jsonb_*``, ``pg_catalog`` lookups and ``age()``, none of which exist. An LLM
told only "DataFusion" will not know it can use ``::`` casts, ``DISTINCT ON`` or
``ILIKE``. Both failure modes are silent until the query errors.

Content came from the Hotdata team directly, then was checked against the live
API. Two of their claims did not hold and have been corrected here: ``SHOW
TABLES`` and ``SHOW FUNCTIONS`` both work, and the ``DESCRIBE`` / ``SHOW
COLUMNS`` failure is about a table having no data yet, not about the syntax
being unsupported. Everything else was confirmed, including the absence of
``to_number`` and the presence of ``arrow_typeof``.
"""

from __future__ import annotations

from typing import Any, Dict, List

#: The dialect contract, injected into every NL-to-SQL prompt and returned
#: verbatim by the ``dialect`` tool.
DIALECT_BRIEFING = """Hotdata runs Apache DataFusion 54 with the PostgreSQL parser dialect.
Treat that as "Postgres syntax, DataFusion semantics and function library" - NOT as Postgres.

SYNTAX (Postgres-compatible):
- :: casts, double-quoted identifiers, CTEs including RECURSIVE, window functions,
  DISTINCT ON, SIMILAR TO, ILIKE, INTERVAL '1 day', EXTRACT(... FROM ...),
  LATERAL (except on FULL OUTER / RIGHT joins).
- Unquoted identifiers fold to lowercase. Any column or table whose real name has
  uppercase letters or spaces MUST be double-quoted, e.g. "CustomerID".
- One statement per request. No semicolon-separated batches.

READ-ONLY SURFACE:
- Only SELECT-shaped statements run in SQL. INSERT/UPDATE/DELETE, COPY TO and all DDL
  (CREATE/DROP/ALTER, including CREATE VIEW and temp tables) are rejected before
  execution, as are SET / PREPARE / BEGIN / COMMIT.
- There are no transactions, no session variables and no search_path.
- EXPLAIN, EXPLAIN ANALYZE, DESCRIBE <table> and VALUES are allowed.

FUNCTIONS - DataFusion's library, not Postgres's:
- The common core matches: string, math, date_trunc/date_part, aggregates, window
  functions, array_* / make_array, string_agg, generate_series, regexp_match /
  regexp_replace / regexp_like, coalesce/nullif/greatest/least.
- These Postgres extras DO NOT EXIST: any JSON/JSONB function or operator
  (->, ->>, jsonb_*), pg_catalog / pg_* introspection, to_number, age(),
  regexp_split_to_table/array, width_bucket, mode(), percentile_disc.
- DataFusion-only helpers that DO exist and are often the right answer. Use these
  exact signatures - guessing the arity or argument types fails at planning time:
  - arrow_typeof(expr) -> the expression's real Arrow type as text.
  - arrow_cast(expr, 'Int64') -> cast using an exact Arrow type name, quoted.
  - date_bin(INTERVAL '15 minutes', ts_expr, TIMESTAMP '1970-01-01') -> time buckets.
  - approx_percentile_cont(numeric_expr, fraction) -> two arguments only.
  - approx_distinct(expr).
- approx_percentile_cont and approx_distinct are AGGREGATES over rows. The
  argument must be a numeric column spanning rows, never an array: passing
  make_array(...) yields List(Int64) and fails with "Unsupported CAST from
  List(Int64) to Float64". To aggregate over a literal set, generate rows first
  and aggregate the column, e.g.
  SELECT approx_percentile_cont(v, 0.95) FROM (SELECT unnest(generate_series(1, 100)) AS v).

TYPES are Arrow types, not Postgres types:
- Utf8/LargeUtf8, Int8..Int64, Float64, Decimal128(p,s), Timestamp(unit, tz),
  Date32, List/Struct/Map.
- There is no native JSON, UUID, ENUM or geometry type; JSON arrives as a string.
- Cast targets accept SQL names (BIGINT, TEXT, TIMESTAMP) or exact Arrow names
  via arrow_cast.

NAMES are three-part: catalog.schema.table. Every query runs inside exactly one
database scope; the database's own catalog answers to `default` and any attached
catalog answers to its alias. The system catalog is `hotdata`.

INTROSPECTION:
- SELECT * FROM information_schema.tables / .columns / .schemata / .catalogs works
  and is the reliable route - prefer it.
- information_schema.views, .routines and .parameters exist but ALWAYS return zero
  rows, so you cannot list available functions that way.
- DESCRIBE <table> and SHOW COLUMNS FROM <table> fail on a table that has been
  declared but never loaded ("declared but has no data"). Load data first, or use
  information_schema, which works on an empty table.

ENGINE-SPECIFIC FUNCTIONS (no Postgres equivalent):
- bm25_search('catalog.schema.table', 'column', 'query text') - full-text search
  table function; rows come back scored, highest first.
- vector_search('catalog.schema.table', 'column', 'query text') - semantic search
  table function; the server embeds the text with the index's own provider and metric.
- vector_distance(col, 'query text') - distance expression for ORDER BY, ascending
  = closest. Requires a fully-qualified column reference.
- ~57 PostGIS-named spatial functions (ST_Area, ST_Distance, ST_Intersects,
  ST_GeomFromText, ST_MakePoint, ST_X/ST_Y, ST_Simplify, ST_Centroid, ...) - a
  subset of PostGIS, not all of it.
- Both search functions resolve only catalogs attached to the current database; a
  raw connection id or __db_<id> prefix will error.

When unsure whether a function exists, prefer the plain-SQL construction over a
Postgres-specific shortcut. Unknown-function errors name the closest match, so read
the error and retry rather than guessing a second variant."""


def get_dialect_prompt_text() -> str:
    """The dialect contract as prompt text."""
    return DIALECT_BRIEFING


def format_schema_for_prompt(tables: List[Dict[str, Any]]) -> str:
    """Render an information_schema payload as compact prompt context.

    Tolerant of shape: the REST payload nests columns under each table, but a
    flat column list is accepted too.
    """
    if not tables:
        return 'No tables have been created in this database yet.'

    lines: List[str] = ['Tables available in this database:']
    for entry in tables:
        if not isinstance(entry, dict):
            continue
        name = entry.get('table') or entry.get('table_name') or entry.get('name') or '?'
        schema = entry.get('schema') or entry.get('table_schema') or ''
        catalog = entry.get('catalog') or entry.get('table_catalog') or ''
        qualified = '.'.join([p for p in (catalog, schema, name) if p])

        columns = entry.get('columns') or []
        rendered: List[str] = []
        for col in columns:
            if isinstance(col, dict):
                col_name = col.get('name') or col.get('column_name') or '?'
                col_type = col.get('type') or col.get('data_type') or ''
                rendered.append(f'{col_name} {col_type}'.strip())
            elif isinstance(col, str):
                rendered.append(col)

        if rendered:
            lines.append(f'  {qualified} ({", ".join(rendered)})')
        else:
            lines.append(f'  {qualified}')
    return '\n'.join(lines)


def strip_sql_fences(text: str) -> str:
    """Remove markdown fences an LLM may wrap around generated SQL."""
    cleaned = (text or '').strip()
    if not cleaned.startswith('```'):
        return cleaned
    lines = cleaned.split('\n')
    end = len(lines) - 1 if lines[-1].strip() == '```' else len(lines)
    return '\n'.join(lines[1:end]).strip()
