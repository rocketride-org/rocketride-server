# =============================================================================
# RocketRide Engine
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

"""Cypher safety checks shared by every graph database node.

Mirrors ``ai.common.database.sql_safety`` for the graph side.

This is a client-side guard, not the primary defence. A driver whose engine can
refuse writes server-side should rely on that instead and use this only as
defence-in-depth: a regex cannot be made airtight against every Cypher dialect.
The implemented example is FalkorDB, whose ``GRAPH.RO_QUERY`` rejects writes at
the server; a future Neo4j driver on this base should open sessions in READ
access mode for the same guarantee.
"""

from __future__ import annotations

import re

from .graph_errors import GraphToolError

# The leading ``(?<![\w.])`` refuses a match when the keyword is preceded by a
# word character or a dot, so a property or map read like ``n.delete`` or
# ``n.create`` is not mistaken for the DELETE / CREATE clause. Bare reserved
# words still match, which is correct: Cypher requires such identifiers to be
# back-quoted, and back-quoted spans are stripped before this runs.
_UNSAFE_CYPHER = re.compile(
    r'(?<![\w.])(?:CREATE|MERGE|DELETE|DETACH\s+DELETE|SET|REMOVE|DROP|FOREACH|LOAD\s+CSV|'
    r'CALL\s+apoc\.(?:create|merge|delete|periodic\.commit|refactor|load))\b',
    re.IGNORECASE,
)

# Comments and string / back-quoted-identifier literals, matched in one pass.
# Whichever span opens first at a given position wins, so a ``//`` inside a
# string is consumed as string content and a quote inside a comment is consumed
# as comment content. That single left-to-right scan is what closes the
# cross-boundary bypass a chain of independent strippers allows (e.g. an
# unbalanced quote in a comment swallowing a trailing write keyword). An
# unterminated string or block comment does not match, so its keywords survive
# and the statement is rejected, which is the safe direction.
#
# A line comment ends at a carriage return as well as a line feed. Stopping only
# at ``\n`` would let ``// ...\rDELETE`` be read as one long comment here while
# Cypher ends the comment at the ``\r`` and runs the DELETE.
_STRIP_LITERALS = re.compile(
    r"""
      //[^\r\n]*           # line comment
    | /\*.*?\*/            # block comment
    | '(?:\\.|[^'\\])*'    # single-quoted string
    | "(?:\\.|[^"\\])*"    # double-quoted string
    | `[^`]*`              # back-quoted identifier
    """,
    re.DOTALL | re.VERBOSE,
)


def strip_cypher_literals(cypher: str) -> str:
    """Return ``cypher`` with comments, string literals and back-quoted identifiers removed.

    Keyword scans run on the result, so a keyword that is only data (a
    commented-out DELETE, or ``n.op = "CREATE"``) is not seen as a clause.
    Each removed span becomes a space: a comment separates tokens in Cypher, so
    ``n/**/DELETE`` must still read as two words.
    """
    return _STRIP_LITERALS.sub(' ', cypher)


def is_cypher_safe(cypher: str) -> bool:
    """Return True when the Cypher statement is read-only (MATCH/RETURN/schema CALLs).

    Args:
        cypher (str): The Cypher statement to inspect.

    Returns:
        bool: ``True`` if the statement contains no write or admin clauses.
    """
    # Literals are removed first, so data can neither trip the gate nor
    # smuggle a live write past it.
    return not bool(_UNSAFE_CYPHER.search(strip_cypher_literals(cypher)))


# ---------------------------------------------------------------------------
# Read-path statement check (read_query on drivers without a server-side
# read-only command, i.e. Neo4j)
# ---------------------------------------------------------------------------
#
# This is defence in depth, not the boundary: on Neo4j the boundary is a
# read-only database role (and, on a single instance, the READ-mode session).
# It works on tokens, not on a regex over raw text: comments and string
# literals never produce keywords, a back-quoted name is an identifier (its
# text unescaped), and a word used as a label, relationship type, property,
# map key or parameter is not a clause.

# A numeric literal: hexadecimal, octal, or decimal with an optional fraction
# and exponent (digits may be grouped with single underscores). Matched at an
# ASCII digit.
_NUMBER = re.compile(
    r"""
      0[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*
    | 0[oO][0-7](?:_?[0-7])*
    | [0-9](?:_?[0-9])*(?:\.[0-9](?:_?[0-9])*)?(?:[eE][+-]?[0-9]+)?
    """,
    re.VERBOSE,
)
# A ``\r`` with no ``\n`` after it.
_LONE_CR = re.compile(r'\r(?!\n)')


def _runs_on(text: str, end: int) -> bool:
    """True when the numeric literal ending at ``end`` runs straight into more text.

    A number must be followed by something that cannot continue it: not a
    letter, digit or underscore, and no ``.`` other than the range operator
    ``..``. Text such as ``1x`` or ``1.`` has no single reading, so the read
    path does not guess at one.
    """
    ch = text[end : end + 1]
    return ch.isalnum() or ch == '_' or (ch == '.' and text[end + 1 : end + 2] != '.')


class CypherRefused(GraphToolError, ValueError):
    """A statement the read path will not run (``str()`` is "<headline>\\n<detail>")."""


class CypherInputError(GraphToolError, ValueError):
    """Statement text the read path will not read as Cypher (unterminated or ambiguous)."""


class _Unreadable(CypherRefused):
    """The tokenizer's error for text it will not read; ``problem`` says why."""

    def __init__(self, problem: str) -> None:
        self.problem = problem
        super().__init__(f'Refused: {problem}')


class _Unterminated(_Unreadable):
    """An unterminated string, comment or back-quoted name; ``what`` names the construct."""

    def __init__(self, what: str) -> None:
        self.what = what
        super().__init__(f'unterminated {what}')


# Read-only Neo4j procedures read_query may CALL (CONTRACT v1 §1 item 8). Names
# are compared case-insensitively after back-quote unescaping; there is no
# wildcard, so a future db.schema.* procedure needs a reviewed addition here.
NEO4J_READ_PROCEDURES = frozenset(
    {
        'db.labels',
        'db.relationshiptypes',
        'db.propertykeys',
        'db.schema.nodetypeproperties',
        'db.schema.reltypeproperties',
        'db.schema.visualization',
    }
)

# Clauses that write data or schema wherever they appear in code.
_WRITE_WORDS = frozenset({'CREATE', 'MERGE', 'DELETE', 'DETACH', 'SET', 'REMOVE', 'DROP', 'FOREACH', 'INSERT'})
# Administration verbs that are never legitimate on a read path.
_ADMIN_WORDS = frozenset({'GRANT', 'DENY', 'REVOKE'})
# Verbs that are only administration when followed by one of these objects;
# alone they are ordinary names (``MATCH (start)``) and must not be refused.
_ADMIN_PAIRS = {
    'START': {'DATABASE', 'DATABASES', 'SERVER'},
    'STOP': {'DATABASE', 'DATABASES', 'SERVER'},
    'ALTER': {'USER', 'CURRENT', 'DATABASE', 'SERVER', 'ALIAS', 'ROLE'},
    'RENAME': {'USER', 'ROLE', 'DATABASE', 'SERVER', 'ALIAS'},
    'TERMINATE': {'TRANSACTION', 'TRANSACTIONS'},
    'ENABLE': {'SERVER'},
    'DEALLOCATE': {'DATABASE', 'DATABASES'},
    'REALLOCATE': {'DATABASE', 'DATABASES'},
    'LOAD': {'CSV'},
}
# SHOW is allowed only for these database-scoped listings.
_SHOW_ALLOWED = frozenset(
    {'INDEX', 'INDEXES', 'CONSTRAINT', 'CONSTRAINTS', 'FUNCTION', 'FUNCTIONS', 'PROCEDURE', 'PROCEDURES'}
)
_SHOW_MODIFIERS = frozenset(
    {
        'ALL',
        'BUILT',
        'IN',
        'USER',
        'DEFINED',
        'RANGE',
        'TEXT',
        'POINT',
        'LOOKUP',
        'FULLTEXT',
        'VECTOR',
        'UNIQUE',
        'EXIST',
        'EXISTENCE',
        'NODE',
        'RELATIONSHIP',
        'KEY',
        'PROPERTY',
        'TYPE',
        'BTREE',
    }
)


class _Tok:
    __slots__ = ('kind', 'text', 'upper')

    def __init__(self, kind: str, text: str) -> None:
        self.kind = kind  # 'word' | 'ident' (back-quoted) | 'param' | 'punct' | 'num'
        self.text = text
        self.upper = text.upper()


def _tokenize(cypher: str, *, cr_ends_comment: bool = True) -> list:
    """Code tokens of a Cypher statement; comments and string literals dropped.

    ``cr_ends_comment`` picks where a ``//`` comment ends: at ``\r`` or
    ``\n``, or only at ``\n``.

    Raises _Unreadable for an unterminated string, comment or back-quoted
    name, for a number that runs into the text after it (see
    :func:`_runs_on`) and for a block comment whose text holds a ``/``:
    the statement has no single reading, so it is refused rather than
    guessed at.
    """
    toks: list = []
    i, n = 0, len(cypher)
    comment_ends = '\r\n' if cr_ends_comment else '\n'
    while i < n:
        c = cypher[i]
        if c.isspace():
            i += 1
        elif cypher.startswith('//', i):
            j = i + 2
            while j < n and cypher[j] not in comment_ends:
                j += 1
            i = j
        elif cypher.startswith('/*', i):
            j = cypher.find('*/', i + 2)
            if j < 0:
                raise _Unterminated('comment')
            # Only a block comment whose text holds no '/' has one reading.
            if '/' in cypher[i + 2 : j]:
                raise _Unreadable("'/' inside a block comment")
            i = j + 2
        elif c in '\'"':
            j = i + 1
            while j < n and cypher[j] != c:
                j += 2 if cypher[j] == '\\' else 1
            if j >= n:
                raise _Unterminated('string literal')
            i = j + 1
        elif c == '`':
            parts = []
            j = i
            # ``a``b`` is one name containing a back-quote.
            while j < n and cypher[j] == '`':
                k = cypher.find('`', j + 1)
                if k < 0:
                    raise _Unterminated('back-quoted name')
                parts.append(cypher[j + 1 : k])
                j = k + 1
            toks.append(_Tok('ident', '`'.join(parts)))
            i = j
        elif c == '$':
            j = i + 1
            while j < n and (cypher[j].isalnum() or cypher[j] == '_'):
                j += 1
            toks.append(_Tok('param', cypher[i:j]))
            i = j
        elif c.isalpha() or c == '_':
            j = i + 1
            while j < n and (cypher[j].isalnum() or cypher[j] == '_'):
                j += 1
            toks.append(_Tok('word', cypher[i:j]))
            i = j
        elif '0' <= c <= '9':
            j = _NUMBER.match(cypher, i).end()
            if _runs_on(cypher, j):
                number = cypher[i:j] if j - i <= 24 else cypher[i : i + 24] + '...'
                raise _Unreadable(f'the number {number} runs into {cypher[j]!r}')
            toks.append(_Tok('num', cypher[i:j]))
            i = j
        else:
            toks.append(_Tok('punct', c))
            i += 1
    return toks


def _readings(cypher: str) -> list:
    """Token lists for every reading of the statement.

    One list, unless the text has a ``\r`` with no ``\n`` after it: a ``//``
    comment may end at that ``\r`` or run on to the next ``\n``, so the
    statement is tokenized with each end and both lists are returned.
    Raises _Unreadable when either cannot be read.
    """
    readings = [_tokenize(cypher)]
    if _LONE_CR.search(cypher):
        readings.append(_tokenize(cypher, cr_ends_comment=False))
    return readings


def _is_clause_word(toks: list, i: int) -> bool:
    """True when the bare word at ``i`` is used as a keyword, not as a name."""
    tok = toks[i]
    if tok.kind != 'word':
        return False
    prev = toks[i - 1] if i > 0 else None
    nxt = toks[i + 1] if i + 1 < len(toks) else None
    # n.create / :Delete label or type / {set: 1} map key
    if prev is not None and prev.kind == 'punct' and prev.text in '.:':
        return False
    if nxt is not None and nxt.kind == 'punct' and nxt.text == ':':
        return False
    return True


def check_read_only_cypher(cypher: str, *, allowed_procedures=NEO4J_READ_PROCEDURES) -> None:
    """Refuse a statement that writes, administers, switches database or CALLs an unlisted procedure.

    Raises:
        CypherRefused: with a "Refused: ..." headline naming the construct.
    """
    toks = _tokenize(cypher)
    for i, tok in enumerate(toks):
        if not _is_clause_word(toks, i):
            continue
        word = tok.upper
        nxt = toks[i + 1] if i + 1 < len(toks) else None
        if word in _WRITE_WORDS:
            raise CypherRefused(
                f'Refused: read_query is read-only; this statement writes ({word})',
                'Use the write console (execute) on a node with allow_execute enabled.',
            )
        if word in _ADMIN_WORDS or (word in _ADMIN_PAIRS and nxt is not None and nxt.upper in _ADMIN_PAIRS[word]):
            command = word + (f' {nxt.upper}' if word not in _ADMIN_WORDS and nxt is not None else '')
            raise CypherRefused(f'Refused: {command} is not allowed on the read-only path')
        if word == 'USE':
            raise CypherRefused("Refused: USE is not allowed; read_query runs against the node's configured database")
        if word == 'SHOW':
            j = i + 1
            while j < len(toks) and toks[j].upper in _SHOW_MODIFIERS:
                j += 1
            target = toks[j].upper if j < len(toks) else ''
            if target not in _SHOW_ALLOWED:
                raise CypherRefused(
                    f'Refused: SHOW {target or ""} is not allowed on the read-only path'.replace('  ', ' '),
                    'Only SHOW INDEXES, CONSTRAINTS, FUNCTIONS and PROCEDURES are allowed.',
                )
        if word == 'CALL':
            if nxt is None:
                raise CypherRefused('Refused: incomplete CALL')
            # CALL { ... } and CALL (vars) { ... } are subqueries: their bodies
            # are part of this token stream and checked like everything else.
            if nxt.kind == 'punct' and nxt.text in '{(':
                continue
            name, j = [], i + 1
            while j < len(toks) and toks[j].kind in ('word', 'ident'):
                name.append(toks[j].text)
                if j + 1 < len(toks) and toks[j + 1].kind == 'punct' and toks[j + 1].text == '.':
                    j += 2
                    continue
                break
            procedure = '.'.join(name)
            if procedure.lower() not in allowed_procedures:
                raise CypherRefused(
                    f'Refused: CALL {procedure or "(unknown)"} is not on the read-only procedure allowlist',
                    'Allowed: ' + ', '.join(sorted(_display_procedure(p) for p in allowed_procedures)),
                )


def check_read_query_statement(
    cypher: str,
    *,
    tool: str = 'read_query',
    detail: str = 'read_query reads only the configured graph.',
) -> None:
    """The statement rule every driver's ``read_query`` applies before its own read boundary.

    ``read_query`` reads the configured graph and nothing else, so ``LOAD CSV``
    (which reads a file or URL) is refused on every engine, including those
    whose read-only command would run it. Writes, administration and
    procedure calls stay with each driver's own read boundary (a read-only
    command, transaction or role, plus Neo4j's :func:`check_read_only_cypher`).
    Another read-only tool may apply the same rule; ``tool`` names it in the
    input-error headline and ``detail`` is the refusal's second line.

    Text without a single reading is never guessed at: a number that runs
    into the text after it and a block comment whose text holds a ``/`` are
    invalid input, and a ``//`` comment whose end is not certain is checked
    with each end (see :func:`_readings`).

    Raises:
        CypherRefused: for ``LOAD CSV`` ("Refused: ..." headline).
        CypherInputError: for text whose comments, strings or back-quoted
            names do not terminate, for a number that runs into the text
            after it and for a ``/`` inside a block comment ("Invalid
            <tool> input: ..." headline): a syntax problem, not a refusal,
            and what the database would make of it cannot be known, so it
            is not sent.
    """
    try:
        readings = _readings(cypher)
    except _Unreadable as e:
        raise CypherInputError(f'Invalid {tool} input: {e.problem}') from None
    for toks in readings:
        for i, tok in enumerate(toks):
            if tok.upper != 'LOAD' or not _is_clause_word(toks, i):
                continue
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            if nxt is not None and nxt.kind == 'word' and nxt.upper == 'CSV':
                raise CypherRefused('Refused: LOAD CSV is not allowed on the read-only path', detail)


_PROCEDURE_DISPLAY = {
    'db.labels': 'db.labels',
    'db.relationshiptypes': 'db.relationshipTypes',
    'db.propertykeys': 'db.propertyKeys',
    'db.schema.nodetypeproperties': 'db.schema.nodeTypeProperties',
    'db.schema.reltypeproperties': 'db.schema.relTypeProperties',
    'db.schema.visualization': 'db.schema.visualization',
}


def _display_procedure(name: str) -> str:
    return _PROCEDURE_DISPLAY.get(name, name)
