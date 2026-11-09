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
SQL shape check shared across all relational database drivers.

``is_sql_safe`` filters LLM-generated SQL before it reaches a client's
database: only a statement shaped like a read (``SELECT``, optionally behind
``EXPLAIN``) passes. It is a cheap first pass, not the read-only guarantee.
A ``SELECT`` can still call functions with side effects that no check over
statement text can tell apart from ordinary ones: on PostgreSQL
``pg_read_file`` reads server files and ``pg_terminate_backend`` ends other
sessions; on MySQL ``LOAD_FILE`` reads files. The guarantee is one layer
down: ``DatabaseGlobalBase.read_only_connection`` runs the query in a
transaction the database itself keeps read-only, with a time limit. For file
reads and other sessions the control is a database role without those
privileges. One exception: on PostgreSQL psycopg2 sends a ``;``-chain as
one string, and a later statement of it can end that transaction (``COMMIT``)
or lift the time limit (``set_config()``), so there this check's refusal of
more than one statement is part of the guarantee. Keep it. The same holds
for ClickHouse's ``SETTINGS`` clause: a user whose profile has
``readonly=2`` may change settings, and the node cannot stop that, so
this check's refusal of the clause is what keeps the time limit.

Literals and comments are masked before any check, so a keyword inside a
string cannot trip a check and a comment cannot hide a clause from one. How
a server reads quotes and comments depends on the database: MySQL escapes a
quote with a backslash and starts a comment with ``#``; PostgreSQL does
neither, but nests block comments and has dollar quoting, and a server with
``standard_conforming_strings`` off escapes a quote with a backslash in every
string. ClickHouse escapes with a backslash in quoted names too, reads
``‘...’`` as a string and ``“...”`` as a name, starts a comment with ``//``
and ``# ``, and lets a heredoc tag start with a digit. Masking by the wrong
rules can hide real SQL behind a misread quote, so the SQL is checked under
PostgreSQL rules with that setting on, again with it off, under MySQL rules
and under ClickHouse rules, and must pass all four. The PostgreSQL rules
follow its lexer (``scan.l``): a name may hold ``$`` and any non-ASCII
character, so ``a$$x$`` is one name, not a name and a dollar quote. The
ClickHouse rules follow ``Lexer.cpp``.
"""

import re

# A PostgreSQL dollar-quote delimiter: $$ or $tag$; a tag may hold any non-ASCII character (scan.l dolq_start, dolq_cont)
_DOLLAR_TAG = re.compile(r'\$(?:[A-Za-z_\x80-\U0010ffff][A-Za-z0-9_\x80-\U0010ffff]*)?\$')

# MySQL block comments whose body the server runs: /*! version comments, MariaDB /*M!, and optimizer
# hints /*+ (a hint can lift the statement time limit)
_MYSQL_EXECUTED_COMMENTS = ('/*!', '/*M!', '/*+')

# ClickHouse comments that run to the end of the line (Lexer.cpp: '#' only before a space or '!')
_CLICKHOUSE_LINE_COMMENTS = ('--', '//', '# ', '#!')

# ClickHouse curly quotes: opening quote -> (closing quote, the ASCII quote the mask writes in their place)
_CLICKHOUSE_CURLY_QUOTES = {'\u2018': ('\u2019', "'"), '\u201c': ('\u201d', '"')}

# A ClickHouse heredoc tag: ASCII letters, digits and _, possibly empty
_CLICKHOUSE_TAG = re.compile(r'[A-Za-z0-9_]*')

# A ClickHouse number or bare word, as long as Lexer.cpp reads it: a number takes the sign of its exponent and
# any word characters after it, a bare word takes $. Inside either, a '-', a '$' or a quote starts nothing.
_CLICKHOUSE_WORD = re.compile(
    r'0[xX][0-9A-Fa-f][0-9A-Fa-f_]*(?:\.[0-9A-Fa-f_]*)?(?:[pP][+-]?[0-9_]*)?[A-Za-z0-9_]*'
    r'|0[bB][01][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]*)?[A-Za-z0-9_]*'
    r'|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]*)?[A-Za-z0-9_]*'
    r'|\$[A-Za-z0-9_][A-Za-z0-9_$]*'
    r'|[A-Za-z_][A-Za-z0-9_$]*'
)

# Only SELECT is allowed, EXPLAIN as a prefix. WITH (CTE) is excluded: PostgreSQL accepts CTE-into-mutation
# (WITH x AS (...) DELETE ...), so allowing WITH needs a check that the trailing operation is a SELECT.
_ALLOWED_STATEMENT = re.compile(r'^\s*(explain\s+)?(select)\b', re.IGNORECASE)

# Clauses that make a SELECT write or lock: INTO (a new table on PostgreSQL, a file with OUTFILE /
# DUMPFILE on MySQL) and row locks
_WRITING_CLAUSE = re.compile(
    r'\binto\b|\bfor\s+(?:no\s+key\s+)?update\b|\bfor\s+(?:key\s+)?share\b|\block\s+in\s+share\s+mode\b',
    re.IGNORECASE,
)

# ClickHouse's SETTINGS clause, which changes settings for the query, such as its time limit (ParserSetQuery.cpp): the
# keyword, then names separated by commas, each with an optional '= value'. A name without a value can only set a Bool
# to true, and the time limit is not a Bool, so the clause counts once any name gets a value. A quoted name needs no
# space after the keyword, a $ right after the keyword makes it part of a longer name, and a name may be compound (a.b).
_SETTINGS_KEYWORD = re.compile(r'\bsettings(?![\w$])', re.IGNORECASE)
_SETTING_NAME = r'(?:[a-z0-9_$]+|`[^`]*`|"[^"]*")(?:\s*\.\s*(?:[a-z0-9_$]+|`[^`]*`|"[^"]*"))*'
_SETTINGS_ASSIGNMENT = re.compile(rf'\s*(?:{_SETTING_NAME}\s*,\s*)*{_SETTING_NAME}\s*=', re.IGNORECASE)

# Right after the statement's first SELECT (and DISTINCT), a comma or an opening parenthesis, the word settings is a
# column for ClickHouse too. Elsewhere select and distinct can be aliases, and a clause can follow them.
_COLUMN_POSITION = re.compile(r'(?:^\s*(?:explain\s+)?select(?:\s+distinct)?|[,(])\s*$', re.IGNORECASE)


def _mask_quoted(sql: str, i: int, quote: str, backslash: bool, out: list[str]) -> int:
    """Copy a quoted region that starts at ``sql[i]`` to ``out``, its contents blanked.

    Args:
        sql: The statement text.
        i: Index of the opening quote.
        quote: The quote character; it closes the region, and doubled it is an escaped quote.
        backslash: Whether a backslash escapes the next character.
        out: Receives the quotes and a space for each character between them (line breaks kept).

    Returns:
        The index after the closing quote, or the end of ``sql`` when the region is not closed.
    """
    n = len(sql)
    out.append(quote)
    i += 1
    while i < n:
        c = sql[i]
        if backslash and c == '\\':
            out.append(' ' * min(2, n - i))
            i += 2
        elif c == quote and i + 1 < n and sql[i + 1] == quote:
            out.append('  ')
            i += 2
        elif c == quote:
            out.append(quote)
            return i + 1
        else:
            out.append(c if c in '\r\n' else ' ')
            i += 1
    return n


def _mask_to(sql: str, i: int, stop: int, out: list[str]) -> int:
    """Blank ``sql[i:stop]`` into ``out``, keeping line breaks.

    Args:
        sql: The statement text.
        i: Start of the region.
        stop: End of the region (exclusive).
        out: Receives the blanked text.

    Returns:
        ``stop``.
    """
    out.extend(c if c in '\r\n' else ' ' for c in sql[i:stop])
    return stop


def _line_end(sql: str, i: int, terminators: str) -> int:
    """Return where a line comment that starts at ``i`` ends.

    Args:
        sql: The statement text.
        i: Index of the comment start.
        terminators: The characters that end a line comment for this database.

    Returns:
        The index of the first terminator at or after ``i`` (not part of the comment), or the end of ``sql``.
    """
    ends = [k for k in (sql.find(t, i) for t in terminators) if k != -1]
    return min(ends) if ends else len(sql)


def _block_comment_end(sql: str, i: int) -> int:
    """Return where a PostgreSQL block comment that starts at ``i`` ends; PostgreSQL nests ``/* */``.

    Args:
        sql: The statement text.
        i: Index of the opening ``/*``.

    Returns:
        The index after the ``*/`` that closes it, or the end of ``sql`` when it is not closed.
    """
    depth, j = 1, i + 2
    while j < len(sql) and depth:
        if sql.startswith('/*', j):
            depth, j = depth + 1, j + 2
        elif sql.startswith('*/', j):
            depth, j = depth - 1, j + 2
        else:
            j += 1
    return j


def _mask_dollar_quoted(sql: str, i: int, tag: str, out: list[str]) -> int:
    """Copy a dollar-quoted string that starts at ``sql[i]`` to ``out``, its body blanked.

    Args:
        sql: The statement text.
        i: Index of the opening tag.
        tag: The tag, ``$$`` or ``$name$``; the same tag closes the string.
        out: Receives the tags and a space for each character between them (line breaks kept).

    Returns:
        The index after the closing tag, or the end of ``sql`` when the string is not closed.
    """
    body = i + len(tag)
    end = sql.find(tag, body)
    out.append(tag)
    if end == -1:
        return _mask_to(sql, body, len(sql), out)
    _mask_to(sql, body, end, out)
    out.append(tag)
    return end + len(tag)


def _pg_name_char(c: str) -> bool:
    """Return True if PostgreSQL reads ``c`` as part of a name that is already under way (scan.l ident_cont).

    Args:
        c: One character, or ``''`` at the start of the text.

    Returns:
        Whether ``c`` is an ASCII letter or digit, ``_``, ``$`` or any non-ASCII character.
    """
    return bool(c) and (c in '_$' or not c.isascii() or c.isalnum())


def _mask_postgres(sql: str, backslash_strings: bool) -> str:
    """Blank literals, quoted identifiers and comments as PostgreSQL reads them.

    ``'...'`` (``''`` escape; an ``E'...'`` string also takes backslash escapes), ``"..."`` identifiers,
    ``$tag$...$tag$``, ``--`` to the end of the line (CR or LF), and nested ``/* */``. A ``$`` or an ``E``
    that continues a name (see ``_pg_name_char``) starts nothing. MySQL backtick identifiers are masked too.

    Args:
        sql: The statement text.
        backslash_strings: Whether every ``'...'`` string takes backslash escapes, as on a server with
            ``standard_conforming_strings`` off.

    Returns:
        Text of the same length with only the executable parts left.
    """
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        before = sql[i - 1] if i else ''
        dollar = _DOLLAR_TAG.match(sql, i) if ch == '$' and not _pg_name_char(before) else None
        if ch == "'":
            # E'...' (the E not ending a longer name) takes backslash escapes
            escape_string = backslash_strings or (before in ('e', 'E') and not (i > 1 and _pg_name_char(sql[i - 2])))
            i = _mask_quoted(sql, i, "'", escape_string, out)
        elif ch in ('"', '`'):
            # A backtick is an operator character to PostgreSQL, which ships no operator with one, so the statement
            # that holds it fails before any after it runs: masking a MySQL `identifier` here hides nothing it runs
            i = _mask_quoted(sql, i, ch, False, out)
        elif dollar:
            i = _mask_dollar_quoted(sql, i, dollar.group(0), out)
        elif sql.startswith('--', i):
            i = _mask_to(sql, i, _line_end(sql, i, '\r\n'), out)
        elif sql.startswith('/*', i):
            i = _mask_to(sql, i, _block_comment_end(sql, i), out)
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def _mask_mysql(sql: str) -> str | None:
    """Blank literals, quoted identifiers and comments as MySQL reads them.

    ``'...'`` and ``"..."`` (backslash and doubled-quote escapes), backtick identifiers, ``#`` and ``--``
    followed by a space or a control character up to the next LF, and ``/* */`` (not nested).

    Args:
        sql: The statement text.

    Returns:
        Text of the same length with only the executable parts left, or None when a block comment is one
        the server runs (``/*!``, ``/*M!``, ``/*+``), which masking would hide.
    """
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        ch = sql[i]
        if ch in ("'", '"', '`'):
            i = _mask_quoted(sql, i, ch, ch != '`', out)
        elif ch == '#' or (sql.startswith('--', i) and (i + 2 == n or sql[i + 2].isspace() or sql[i + 2] < ' ')):
            i = _mask_to(sql, i, _line_end(sql, i, '\n'), out)
        elif sql.startswith(_MYSQL_EXECUTED_COMMENTS, i):
            return None
        elif sql.startswith('/*', i):
            end = sql.find('*/', i + 2)
            i = _mask_to(sql, i, n if end == -1 else end + 2, out)
        else:
            out.append(ch)
            i += 1
    return ''.join(out)


def _clickhouse_heredoc_tag(sql: str, i: int) -> str | None:
    """Return the heredoc tag that starts at ``sql[i]``, or None when ClickHouse reads no heredoc there.

    Args:
        sql: The statement text.
        i: Index of a ``$``.

    Returns:
        ``$tag$`` when the tag holds only ASCII letters, digits and ``_`` and the same tag appears again later
        to close it; otherwise None.
    """
    tag_end = sql.find('$', i + 1)
    if tag_end == -1 or not _CLICKHOUSE_TAG.fullmatch(sql, i + 1, tag_end):
        return None
    tag = sql[i : tag_end + 1]
    return tag if sql.find(tag, tag_end + 1) != -1 else None


def _mask_curly_quoted(sql: str, i: int, out: list[str]) -> int:
    """Copy a ClickHouse ``‘...’`` string or ``“...”`` name that starts at ``sql[i]`` to ``out``, its contents blanked.

    The mask writes ``'`` and ``"`` for the curly quotes, so the clause checks read them as they read ASCII quotes.
    ClickHouse takes no escapes between curly quotes.

    Args:
        sql: The statement text.
        i: Index of the opening curly quote.
        out: Receives the quotes and a space for each character between them (line breaks kept).

    Returns:
        The index after the closing quote, or the end of ``sql`` when the quote is not closed.
    """
    close, ascii_quote = _CLICKHOUSE_CURLY_QUOTES[sql[i]]
    end = sql.find(close, i + 1)
    out.append(ascii_quote)
    if end == -1:
        return _mask_to(sql, i + 1, len(sql), out)
    _mask_to(sql, i + 1, end, out)
    out.append(ascii_quote)
    return end + 1


def _clickhouse_token(sql: str, i: int, out: list[str]) -> int:
    """Copy the ClickHouse token that starts at ``sql[i]`` to ``out``, blanked if it is a literal, quoted name or comment.

    Args:
        sql: The statement text.
        i: Where the token starts.
        out: Receives the token, or its blanked form.

    Returns:
        The index after the token.
    """
    ch = sql[i]
    if ch in ("'", '"', '`'):
        return _mask_quoted(sql, i, ch, True, out)
    if ch in _CLICKHOUSE_CURLY_QUOTES:
        return _mask_curly_quoted(sql, i, out)
    if sql.startswith(_CLICKHOUSE_LINE_COMMENTS, i):
        return _mask_to(sql, i, _line_end(sql, i, '\n'), out)
    if sql.startswith('/*', i):
        return _mask_to(sql, i, _block_comment_end(sql, i), out)
    tag = _clickhouse_heredoc_tag(sql, i) if ch == '$' else None
    if tag:
        return _mask_dollar_quoted(sql, i, tag, out)
    word = _CLICKHOUSE_WORD.match(sql, i)
    end = word.end() if word else i + 1
    out.append(sql[i:end])
    return end


def _mask_clickhouse(sql: str) -> str:
    """Blank literals, quoted names and comments as ClickHouse reads them (``Lexer.cpp``).

    ``'...'``, ``"..."`` and backtick names (backslash and doubled-quote escapes), ``‘...’`` strings and
    ``“...”`` names, ``$tag$...$tag$`` heredocs (a tag of ASCII letters, digits and ``_``, which may start with a
    digit), ``--``, ``//``, ``# `` and ``#!`` to the next LF, and nested ``/* */``. A ``$``, a ``-`` or a quote
    inside a number or a bare word starts nothing.

    Args:
        sql: The statement text.

    Returns:
        Text of the same length with only the executable parts left.
    """
    out: list[str] = []
    i, n = 0, len(sql)
    while i < n:
        i = _clickhouse_token(sql, i, out)
    return ''.join(out)


def _has_settings_clause(statement: str) -> bool:
    """Return True if the statement holds a ClickHouse SETTINGS clause that gives a setting a value.

    Each ``settings`` keyword is checked on its own, so a column named settings cannot hide a clause after it.

    Args:
        statement: One statement with literals and comments blanked.

    Returns:
        Whether a keyword outside a column position starts a list in which some name gets a value.
    """
    return any(
        _SETTINGS_ASSIGNMENT.match(statement, keyword.end())
        and not _COLUMN_POSITION.search(statement, 0, keyword.start())
        for keyword in _SETTINGS_KEYWORD.finditer(statement)
    )


def _is_read_shaped(masked: str | None) -> bool:
    """Return True if the masked text holds at most one statement, a SELECT that does not write, lock or change settings.

    Args:
        masked: The statement text with literals and comments blanked, or None if masking refused it.

    Returns:
        Whether the text passes.
    """
    if masked is None:
        return False
    # A ';' inside a literal or a comment is blanked, so this splits real statements only
    statements = [part.strip() for part in masked.split(';') if part.strip()]
    if len(statements) > 1:
        return False
    return all(
        _ALLOWED_STATEMENT.match(statement)
        and not _WRITING_CLAUSE.search(statement)
        and not _has_settings_clause(statement)
        for statement in statements
    )


def is_sql_safe(sql: str) -> bool:
    """Return False unless the SQL is one statement shaped like a read: ``SELECT``, optionally behind ``EXPLAIN``.

    A whitelist: anything else (SET, COPY, PREPARE / EXECUTE, DO, HANDLER, WITH, ...) is rejected, and so
    is a SELECT with ``INTO``, a row lock (``FOR UPDATE``, ``FOR SHARE``, ``LOCK IN SHARE MODE``) or a
    ClickHouse ``SETTINGS`` clause, which can lift the time limit. So is
    a ``;``-chain of more than one statement, reads included: on PostgreSQL a later statement could end
    the read-only transaction or lift its time limit, and a generated query is one statement. A trailing
    ``;`` is fine. The text is read under PostgreSQL rules with ``standard_conforming_strings`` on and off,
    and under MySQL and ClickHouse rules (see the module docstring), and must pass all four.

    Not a read-only guarantee: see the module docstring. Empty or whitespace-only input passes, as there is
    no statement to reject; a caller that must forbid empty SQL guards that itself.

    Args:
        sql: The generated SQL.

    Returns:
        Whether the SQL may be sent to the database.
    """
    return (
        _is_read_shaped(_mask_postgres(sql, backslash_strings=False))
        and _is_read_shaped(_mask_postgres(sql, backslash_strings=True))
        and _is_read_shaped(_mask_mysql(sql))
        and _is_read_shaped(_mask_clickhouse(sql))
    )
