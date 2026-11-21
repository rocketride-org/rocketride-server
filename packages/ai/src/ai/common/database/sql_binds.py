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

"""Bind and shape helpers for the raw ``execute`` path of the database nodes.

``to_sqlalchemy_text`` turns PostgreSQL-style ``$1..$n`` placeholders into
SQLAlchemy binds (the driver binds the values, nothing is inlined), and
``shape_execute_result`` turns a result into ``{rows, affected_rows}`` under a
row cap. Both are pure: the transaction that runs the statement is opened and
closed by the caller, inside one tool call (plan 4.1 rule 3).
"""

import re

from sqlalchemy import text
from sqlalchemy.sql.elements import TextClause


# Matched at a '$' while rewriting placeholders. Compiled once and matched in
# place (re.Pattern.match accepts a start offset) so a bulk INSERT with many
# placeholders does not copy the rest of the statement at every '$'.
_PLACEHOLDER_RE = re.compile(r'\$(\d+)')
_DOLLAR_TAG_RE = re.compile(r'\$([A-Za-z_][\w]*)?\$')


def _rewrite_placeholders(sql: str, params: list, binds: dict) -> str:
    """Rewrite $n → :bn outside strings, identifiers, and comments."""
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch == "'":  # single-quoted string ('' doubling; E'...' backslash)
            is_escape_string = out and out[-1] and out[-1][-1] in 'eE'
            j = i + 1
            while j < n:
                if is_escape_string and sql[j] == '\\':
                    j += 2
                    continue
                if sql[j] == "'":
                    if j + 1 < n and sql[j + 1] == "'":
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            out.append(sql[i:j])
            i = j
        elif ch == '"':  # quoted identifier ("" doubling)
            j = i + 1
            while j < n:
                if sql[j] == '"':
                    if j + 1 < n and sql[j + 1] == '"':
                        j += 2
                        continue
                    j += 1
                    break
                j += 1
            out.append(sql[i:j])
            i = j
        elif ch == '-' and sql[i : i + 2] == '--':
            j = sql.find('\n', i)
            j = n if j == -1 else j
            out.append(sql[i:j])
            i = j
        elif ch == '/' and sql[i : i + 2] == '/*':  # nested block comments
            depth, j = 1, i + 2
            while j < n and depth:
                if sql[j : j + 2] == '/*':
                    depth += 1
                    j += 2
                elif sql[j : j + 2] == '*/':
                    depth -= 1
                    j += 2
                else:
                    j += 1
            out.append(sql[i:j])
            i = j
        elif ch == '$':
            m = _PLACEHOLDER_RE.match(sql, i)
            if m:  # $<digits> is never a dollar-quote tag (tags cannot start with a digit)
                idx = int(m.group(1))
                if idx < 1 or idx > len(params):
                    raise ValueError(f'placeholder ${idx} out of range for {len(params)} param(s)')
                key = f'b{idx}'
                binds[key] = params[idx - 1]
                out.append(f':{key}')
                i = m.end()
                continue
            tag = _DOLLAR_TAG_RE.match(sql, i)
            if tag:  # dollar-quoted body — copy through to the closing tag
                delim = tag.group(0)
                end = sql.find(delim, i + len(delim))
                j = n if end == -1 else end + len(delim)
                out.append(sql[i:j])
                i = j
            else:
                out.append(ch)
                i += 1
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def to_sqlalchemy_text(sql: str, params: list | None) -> tuple[TextClause, dict]:
    """Convert Postgres-style ``$1..$n`` placeholders to SQLAlchemy binds.

    Server-side binding means we never inline/escape values into SQL — the
    client forwards parameter values and the database driver binds them.
    The rewrite is quote-aware: ``$n`` inside string literals, quoted
    identifiers, dollar-quoted bodies, and comments is left untouched, and an
    index past ``len(params)`` raises ``ValueError`` instead of corrupting.
    """
    if not params:
        return text(sql), {}
    binds: dict = {}
    return text(_rewrite_placeholders(sql, params, binds)), binds


def shape_execute_result(result, max_rows: int, row_mode: str = 'object') -> dict | None:
    """Shape a SQLAlchemy result into ``{'rows', 'affected_rows'}`` (or None).

    ``row_mode='array'`` returns each row as a positional list (column order =
    ``result.keys()``) instead of a dict — required by ORM clients (Drizzle)
    whose result mappers key columns by position, where dict rows would
    silently collapse duplicate column names in joins.
    """
    if result.returns_rows:
        rows = result.fetchmany(max_rows + 1)
        if len(rows) > max_rows:
            return None
        if row_mode == 'array':
            return {'rows': [list(row) for row in rows], 'affected_rows': 0}
        cols = result.keys()
        return {'rows': [dict(zip(cols, row)) for row in rows], 'affected_rows': 0}
    rc = result.rowcount
    return {'rows': [], 'affected_rows': rc if isinstance(rc, int) and rc >= 0 else 0}
