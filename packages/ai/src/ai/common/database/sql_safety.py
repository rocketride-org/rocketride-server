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

"""
SQL safety validation shared across all relational database drivers.

``is_sql_safe`` is a **statement-shape check**, and only that. It filters out
LLM-generated SQL whose *form* is not a read query before that SQL reaches a
customer's database. It is a cheap first pass, not the read-only guarantee.

What it cannot do: ``SELECT`` is a statement shape, not a permission. A
statement that begins with ``SELECT`` can still kill sessions
(``pg_terminate_backend``), read files off the database host
(``pg_read_file``, ``LOAD_FILE``), open outbound connections (``dblink``),
advance a sequence (``nextval``), take row locks (``FOR UPDATE``) or burn the
server for an hour (``pg_sleep``). No check over statement text can separate
those from an ordinary query, because the difference lives in what the called
functions do, not in how the statement is spelled.

The actual read-only guarantee is enforced one layer down, by the database
itself: see ``DatabaseGlobalBase.read_only_connection``, which runs every
generated query inside a server-side read-only transaction with a statement
timeout. This module is defence in depth in front of that.
"""

import re

# Characters that open a string literal or a quoted identifier. Backticks are
# MySQL identifier quoting: without them a column legitimately named `into`
# would be read as an INTO clause and a valid query rejected.
_QUOTE_CHARS = ("'", '"', '`')

# Characters that end a line comment. CR counts as well as LF: a lone CR ends
# a comment for the server, so treating only LF as the terminator would mask
# past it and hide anything chained after it on the same physical line.
_LINE_TERMINATORS = ('\n', '\r')


def _mask_quoted_and_comments(sql: str) -> str:
    """Blank the contents of every literal, quoted identifier and comment.

    One left-to-right pass, because the ordering matters and two sequential
    regex passes are wrong in either order:

    - comments stripped first: a literal containing ``--`` swallows the rest
      of the statement. ``SELECT '--x' INTO OUTFILE '/tmp/f'`` collapses to
      ``SELECT '``, which then reads as an ordinary, harmless query and takes
      a file-writing statement straight past the gate.
    - literals masked first: a quote inside a comment opens a literal that
      runs on past the end of that comment and swallows real SQL after it.

    Delimiters are preserved and their contents replaced with spaces, so the
    result has the same length and the same token boundaries as the input and
    every check downstream sees only executable text. Newlines are preserved
    inside masked regions so line-oriented behaviour is unchanged.

    Handles ``'...'`` and ``"..."`` (doubled-delimiter escapes), MySQL
    backtick identifiers, ``--`` and ``#`` line comments, and ``/* */`` block
    comments (unterminated ones run to end of input).

    A backslash is NOT treated as an escape, deliberately. MySQL escapes with
    it; PostgreSQL does not, under the default ``standard_conforming_strings``.
    Honouring it would mask MORE of the statement, and on PostgreSQL that
    means a real ``INTO OUTFILE`` sitting after ``'it\\'`` would be masked
    out of sight and the write let through. Ignoring it can only close a
    literal early, which exposes more text to the checks and can at worst
    reject a valid MySQL query containing ``\\'``. Between a bypass and a
    false rejection, this takes the false rejection.
    """
    out: list[str] = []
    i = 0
    n = len(sql)

    while i < n:
        ch = sql[i]

        # Quoted region: keep the delimiters, blank what is between them.
        if ch in _QUOTE_CHARS:
            out.append(ch)
            i += 1
            while i < n:
                c = sql[i]
                if c == ch:
                    if i + 1 < n and sql[i + 1] == ch:
                        # A doubled delimiter is an escaped delimiter, not a close.
                        out.append('  ')
                        i += 2
                        continue
                    out.append(ch)
                    i += 1
                    break
                out.append(c if c in _LINE_TERMINATORS else ' ')
                i += 1
            continue

        # Line comment: -- or # up to a line terminator, which is NOT consumed.
        # Both CR and LF end a comment (PostgreSQL scans `--[^\n\r]*`, MySQL
        # likewise), so masking through a lone CR would hide whatever follows
        # it on the same physical line — including a chained statement.
        if sql.startswith('--', i) or ch == '#':
            while i < n and sql[i] not in _LINE_TERMINATORS:
                out.append(' ')
                i += 1
            continue

        # Block comment: /* through */.
        if sql.startswith('/*', i):
            end = sql.find('*/', i + 2)
            stop = n if end == -1 else end + 2
            for j in range(i, stop):
                out.append(sql[j] if sql[j] in _LINE_TERMINATORS else ' ')
            i = stop
            continue

        out.append(ch)
        i += 1

    return ''.join(out)


def is_sql_safe(sql: str) -> bool:
    """Return False if the SQL is not shaped like a read query.

    NOT a read-only guarantee — see the module docstring. Passing this check
    means the statement is a ``SELECT`` that does not obviously write; it does
    not mean the statement has no side effects.

    Uses a whitelist approach: only SELECT statements (optionally prefixed by
    EXPLAIN) are allowed. Everything else is rejected. This is safer than a
    blacklist because new or uncommon SQL commands (SET, COPY, PREPARE /
    EXECUTE, DO, HANDLER, etc.) are blocked by default.

    Empty / whitespace-only input passes vacuously (no statements means no
    statement to reject). Callers that want to forbid empty SQL must guard
    that at a higher layer.

    WITH (CTE) is deliberately NOT in the allowlist. PostgreSQL accepts
    CTE-into-mutation — e.g. ``WITH x AS (...) DELETE FROM t WHERE id IN
    (SELECT id FROM x)`` — so a naive `select|with` allowlist would let
    write operations through. If WITH support is needed later it must be
    matched with a stricter pattern that guarantees the trailing data
    operation is a SELECT, not a DELETE / INSERT / UPDATE.
    """
    # Mask literals, quoted identifiers and comments in one pass. Every check
    # below then runs on executable text only: a keyword inside a string or a
    # comment can neither trip a guard nor hide a clause from one, and a ';'
    # inside a literal cannot split one statement into two.
    masked = _mask_quoted_and_comments(sql)

    # Split on semicolons to check each individual statement separately.
    # A single input may contain multiple statements chained with ';'.
    statements = [s.strip() for s in re.split(r';\s*', masked.strip()) if s.strip()]

    # Only SELECT is allowed. EXPLAIN is permitted as a prefix.
    # WITH (CTE) is intentionally excluded — see docstring.
    allowed_pattern = re.compile(r'^\s*(explain\s+)?(select)\b', re.IGNORECASE)

    for stmt in statements:
        # Every statement must start with an allowed keyword.
        if not allowed_pattern.match(stmt):
            return False

        stmt_lower = stmt.lower()

        # SELECT ... INTO OUTFILE / INTO DUMPFILE can write arbitrary files on
        # the database server — block it even though it starts with SELECT.
        if re.search(r'\bselect\b.*\binto\s+(outfile|dumpfile)\b', stmt_lower, re.DOTALL):
            return False

        # INTO <table> writes too: PostgreSQL and SQL Server create a new
        # table from the result set. Same family as OUTFILE above, and the
        # same class of problem this check exists to catch — statement shape.
        if re.search(r'\bselect\b.*\binto\b', stmt_lower, re.DOTALL):
            return False

    return True
