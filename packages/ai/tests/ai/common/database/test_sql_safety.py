"""
Unit tests for ai.common.database.sql_safety.is_sql_safe.

is_sql_safe is the shape check that filters LLM-generated SQL before the
relational-DB drivers run it. Only SELECT (optionally behind EXPLAIN) is
allowed; everything else (mutation, DDL, WITH, file IO, CALL, etc.) must be
rejected, and so must a SELECT with INTO or a row lock. These tests exercise
the allowlist, the masking of literals and comments under PostgreSQL and MySQL
rules, multi-statement input, and the clauses that make a SELECT write.
"""

import pytest

from ai.common.database.sql_safety import _mask_clickhouse, is_sql_safe


# ---------------------------------------------------------------------------
# Allowed statements
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT 1',
        'select 1',
        '   SELECT col FROM t   ',
        'SELECT a, b, c FROM t WHERE a = 1',
        'SELECT * FROM users JOIN accounts ON users.id = accounts.user_id',
        'EXPLAIN SELECT 1',
        'explain select 1',
        'SELECT 1;',
        'SELECT 1;\n',
    ],
)
def test_allows_select_variants(sql):
    """Every SELECT / EXPLAIN-SELECT form must be accepted."""
    assert is_sql_safe(sql) is True


@pytest.mark.parametrize('sql', ['', '   ', '\n', ';;;'])
def test_empty_input_passes_vacuously(sql):
    """
    Empty / whitespace-only / pure-separator input has no statements.

    The implementation iterates statements and returns False on the first
    disallowed one. With zero statements there is nothing to reject, so the
    function returns True. Callers that want to forbid empty SQL must guard
    that at a higher layer (documented in the module docstring).
    """
    assert is_sql_safe(sql) is True


# ---------------------------------------------------------------------------
# Disallowed statements (mutation / DDL / file / control / CTE)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        'INSERT INTO t VALUES (1)',
        'UPDATE t SET a = 1',
        'DELETE FROM t',
        'DROP TABLE t',
        'CREATE TABLE t (id INT)',
        'ALTER TABLE t ADD COLUMN c INT',
        'TRUNCATE TABLE t',
        'GRANT SELECT ON t TO public',
        'REVOKE ALL ON t FROM public',
        'SET search_path = public',
        'CALL stored_proc()',
        'COPY t FROM stdin',
        'PREPARE x AS SELECT 1',
        'EXECUTE x',
        'DO $$ BEGIN END $$',
        'HANDLER t OPEN',
        'LOAD DATA INFILE "x" INTO TABLE t',
        # WITH (CTE) is intentionally rejected. PostgreSQL allows
        # CTE-into-mutation (e.g. `WITH x AS (...) DELETE FROM t WHERE ...`)
        # so a naive WITH allowlist would let writes through. See the
        # is_sql_safe docstring for the design note.
        'WITH cte AS (SELECT 1) SELECT * FROM cte',
        'with cte as (select 1) select * from cte',
    ],
)
def test_rejects_non_read_only(sql):
    """Any statement that does not start with SELECT (or EXPLAIN SELECT) is rejected."""
    assert is_sql_safe(sql) is False


# ---------------------------------------------------------------------------
# Multi-statement chains where ONE statement is bad
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT 1; DROP TABLE t',
        'SELECT 1; DELETE FROM t',
        'SELECT 1;\nUPDATE t SET a = 1',
        'WITH x AS (SELECT 1) SELECT * FROM x; INSERT INTO t VALUES (1)',
    ],
)
def test_rejects_chain_with_any_unsafe_statement(sql):
    """If any statement in a ;-chain is unsafe, the whole input is rejected."""
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        'COMMIT; INSERT INTO t VALUES (1)',
        'ROLLBACK; INSERT INTO t VALUES (1)',
        'END; DELETE FROM t',
        'SELECT 1; COMMIT; INSERT INTO t VALUES (1)',
        'SET TRANSACTION READ WRITE; INSERT INTO t VALUES (1)',
        'SET default_transaction_read_only = off; COMMIT; DELETE FROM t',
        'SET statement_timeout = 0; SELECT pg_sleep(100)',
        "SELECT 1; SELECT set_config('statement_timeout', '0', false); SELECT pg_sleep(100)",
    ],
)
def test_rejects_a_chain_that_would_get_around_a_postgres_read_only_transaction(sql):
    """On PostgreSQL a ;-chain can end the read-only transaction or lift its time limit, so this check must stop it.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize('sql', ['SELECT 1; SELECT 2', 'SELECT 1;\nSELECT 2;\n', 'EXPLAIN SELECT 1; SELECT 2'])
def test_rejects_more_than_one_statement_even_reads(sql):
    """A generated query is one statement; a chain of reads is refused too.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        # PostgreSQL reads a$$x$ as one name (a name may hold $), so no dollar quote hides the ';', and the #
        # hides the rest from the MySQL reading
        'SELECT 1 #2 AS a$$x$; SELECT 2 AS b$$x$',
        'SELECT 1 #2 AS a$$x$; COMMIT; INSERT INTO t VALUES (1); SELECT 2 AS b$$x$',
        # A name may hold any non-ASCII character: a no-break space, an arrow, a letter
        'SELECT 1 #2 AS a\u00a0$x$; COMMIT; INSERT INTO t VALUES (1); SELECT 2 AS b\u00a0$x$',
        'SELECT 1 #2 AS a\u2192$x$; COMMIT; INSERT INTO t VALUES (1); SELECT 2 AS b\u2192$x$',
        'SELECT 1 #2 AS a\u00e9$x$; COMMIT; INSERT INTO t VALUES (1); SELECT 2 AS b\u00e9$x$',
        # A dollar-quote tag may hold non-ASCII characters
        "SELECT $\u00e9$'$\u00e9$; SELECT 'second'",
        "SELECT $\u00e9$'$\u00e9$; COMMIT; INSERT INTO t VALUES (1); SELECT 'x' -- '",
        "SELECT $\u00a0$'$\u00a0$; COMMIT; INSERT INTO t VALUES (1); SELECT 'x' -- '",
        # An E that continues a name starts no E'...' string, so the backslash escapes nothing
        "SELECT 1 #2, x\u00a0E'a\\'; COMMIT; INSERT INTO t VALUES (1); SELECT 1 -- '",
        "SELECT 1 #2, x$E'a\\'; COMMIT; INSERT INTO t VALUES (1); SELECT 1 -- '",
        # With standard_conforming_strings off, \' is a quote in any string
        "SELECT 1 #2, 'a\\''; COMMIT; INSERT INTO t VALUES (1); SELECT 'x' -- '",
    ],
)
def test_postgres_names_tags_and_string_settings_cannot_hide_a_statement(sql):
    """The PostgreSQL reading follows its lexer (scan.l) for names, dollar-quote tags and both string settings.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT 1 AS a$$x$',
        'SELECT a\u00a0$x$ FROM t',
        'SELECT col$1 FROM t',
        "SELECT 'a;b'",
        'SELECT $$a$$',
        "SELECT $\u00e9$'$\u00e9$ AS q",
        "SELECT E'a\\'b' AS q",
        "SELECT 'C:\\path' AS p",
    ],
)
def test_postgres_names_with_dollar_or_non_ascii_still_pass(sql):
    """A name with $ or non-ASCII characters, a non-ASCII tag and a backslash in a string do not reject a read.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is True


# ---------------------------------------------------------------------------
# Comment-based bypass attempts
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        '/* DROP TABLE t */ SELECT 1',
        'SELECT 1 -- DROP TABLE t',
        'SELECT 1 -- ; DROP TABLE t',
        '/* multi\nline */ SELECT 1',
        '-- DROP TABLE t\nSELECT 1',
    ],
)
def test_comments_are_stripped_and_do_not_unsafe_safe_sql(sql):
    """Comments must be removed before pattern matching so SELECT survives."""
    assert is_sql_safe(sql) is True


@pytest.mark.parametrize(
    'sql',
    [
        '/* SELECT 1 */ DROP TABLE t',
        '-- SELECT 1\nDROP TABLE t',
    ],
)
def test_comments_do_not_make_unsafe_sql_safe(sql):
    """Wrapping the SELECT in a comment must not save a following DROP."""
    assert is_sql_safe(sql) is False


# ---------------------------------------------------------------------------
# SELECT ... INTO OUTFILE / DUMPFILE side channel
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        "SELECT * FROM t INTO OUTFILE '/tmp/x'",
        "SELECT * FROM t INTO DUMPFILE '/tmp/x'",
        "select * from t into outfile '/tmp/x'",
        "SELECT a FROM t WHERE a = 1 INTO OUTFILE '/tmp/x'",
    ],
)
def test_select_into_outfile_is_blocked(sql):
    """SELECT INTO OUTFILE / DUMPFILE writes server-side files; must be rejected."""
    assert is_sql_safe(sql) is False


def test_into_inside_string_does_not_false_positive():
    """The word 'into' in a string literal should not trigger the OUTFILE block."""
    # Plain SELECT with 'into' as data, not as a clause keyword.
    sql = "SELECT 'shipped into market' AS phrase"
    assert is_sql_safe(sql) is True


# ---------------------------------------------------------------------------
# Literal- and dialect-aware masking (#2087)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        # A '--' inside a literal used to strip the rest of the statement, INTO OUTFILE included
        "SELECT '--x' INTO OUTFILE '/tmp/export'",
        "SELECT '--' INTO DUMPFILE '/tmp/x'",
        # PostgreSQL ends a line comment at a lone CR, so the DROP after it runs
        'SELECT 1 -- x\r; DROP TABLE t',
        # MySQL reads --1 as minus minus one, not a comment
        "SELECT 1--1 INTO OUTFILE '/tmp/f'",
        # MySQL runs the body of /*! */ and /*M! */, and a /*+ */ hint can lift the time limit
        "SELECT 1 /*! INTO OUTFILE '/tmp/f' */",
        "SELECT 1 /*M! INTO OUTFILE '/tmp/f' */",
        'SELECT /*+ SET_VAR(max_execution_time=0) */ SLEEP(100)',
        # A backslash closes nothing in a PostgreSQL string, so the INTO here is real on PostgreSQL
        "SELECT 'a\\' INTO new_t FROM t -- '",
        # A dollar-quoted string hides a quote from a reader that does not know dollar quoting
        "SELECT $$'$$ INTO new_t FROM t",
    ],
)
def test_literals_and_comments_cannot_hide_a_clause(sql):
    """Masking follows each database's reading of quotes and comments, so nothing real is hidden.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT * INTO new_t FROM t',
        'SELECT * INTO new_t FROM t WHERE a > 1',
        'SELECT a INTO @v FROM t',
        'SELECT * FROM t FOR UPDATE',
        'SELECT * FROM t FOR NO KEY UPDATE',
        'SELECT * FROM t FOR SHARE',
        'SELECT * FROM t LOCK IN SHARE MODE',
    ],
)
def test_select_that_writes_or_locks_is_rejected(sql):
    """SELECT INTO creates a table (PostgreSQL) or a file (MySQL); FOR UPDATE / SHARE take row locks.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT 1 SETTINGS max_execution_time = 0',
        'select count() from t settings max_threads=1, max_execution_time=0',
        'SELECT * FROM (SELECT 1 SETTINGS max_execution_time = 0)',
        'SELECT 1 SETTINGS\n  max_execution_time\n  = 0',
        'SELECT 1 SETTINGS/* x */max_execution_time = 0',
        'SELECT 1 SETTINGS `max_execution_time` = 0',
        'SELECT 1 SETTINGS "max_execution_time" = 0',
        'EXPLAIN SELECT 1 SETTINGS max_execution_time = 0',
    ],
)
def test_a_clickhouse_settings_clause_is_rejected(sql):
    """ClickHouse's SETTINGS clause lets a readonly=2 user lift the time limit the node sets.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT settings FROM t',
        "SELECT * FROM settings WHERE name = 'x'",
        'SELECT * FROM settings s WHERE s.id = 1',
        'SELECT a FROM t JOIN settings ON t.id = settings.id',
        'SELECT a FROM t WHERE settings = 1',
        "SELECT 'SETTINGS max_execution_time = 0' AS q",
        'SELECT 1 -- SETTINGS max_execution_time = 0',
        'SELECT my_settings x FROM t',
    ],
)
def test_the_word_settings_alone_is_not_a_settings_clause(sql):
    """A table, column or text named settings is not the clause.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is True


# ---------------------------------------------------------------------------
# The ClickHouse reading
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        pytest.param("SELECT \u2018'\u2019 AS s SETTINGS max_execution_time = 0 --'", id='curly-string'),
        pytest.param('SELECT 1 SETTINGS \u201cmax_execution_time\u201d = 0', id='curly-name'),
        pytest.param('SELECT 1 SETTINGS`max_execution_time`=0', id='backtick-name-after-the-keyword'),
        pytest.param('SELECT 1 SETTINGS"max_execution_time"=0', id='quoted-name-after-the-keyword'),
        pytest.param("SELECT 1 // '\nSETTINGS max_execution_time = 0 --'", id='slash-comment'),
        pytest.param("SELECT $1$'$1$ SETTINGS max_execution_time = 0 --'", id='heredoc-tag-starting-with-a-digit'),
        pytest.param("SELECT \u2018'\u2019 AS s INTO OUTFILE 'f' --'", id='curly-string-into'),
        pytest.param("SELECT \u2018'\u2019; SELECT 2 --'", id='curly-string-chain'),
        pytest.param('SELECT 1 SETTINGS a$b = 0', id='name-with-dollar'),
        pytest.param('SELECT $1$x$1$SETTINGS max_execution_time = 0', id='keyword-right-after-a-heredoc'),
    ],
)
def test_the_clickhouse_reading_sees_what_clickhouse_runs(sql):
    """ClickHouse reads the clause in each of these as code, where the PostgreSQL and MySQL readings see a literal.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        "SELECT \u2018it's\u2019 AS s",
        'SELECT \u201ccol\u201d FROM t',
        'SELECT \u201csettings\u201d FROM t',
        'SELECT $1$x$1$ AS s',
        'SELECT 1 // 2',
        'SELECT 1 # comment',
        'SELECT 1e-1, 0x1p-1, a$b FROM t',
        "SELECT x'1F', b'01'",
        'SELECT * FROM settings s',
        'SELECT a$settings = 1, settings$b = 2 FROM t',
        # PostgreSQL and MySQL read a letter glued to settings as part of one name
        'SELECT \u00e9settings x = 1',
    ],
)
def test_clickhouse_quotes_comments_and_heredocs_still_pass(sql):
    """Curly quotes, heredocs, ClickHouse comments and numbers do not reject a read.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is True


@pytest.mark.parametrize(
    ('sql', 'visible'),
    [
        # Backslash and doubled-quote escapes in strings and in both kinds of quoted name
        ("a 'b\\'c' d", ['a', "'", "'", 'd']),
        ('a "b\\"c" d', ['a', '"', '"', 'd']),
        ('a `b\\`c` d', ['a', '`', '`', 'd']),
        ("a 'b''c' d", ['a', "'", "'", 'd']),
        # Curly quotes: a string and a name, written as ASCII quotes; an unclosed one runs to the end
        ('a \u2018b\u2019 d', ['a', "'", "'", 'd']),
        ('a \u201cb\u201d d', ['a', '"', '"', 'd']),
        ('a \u2018b c', ['a', "'"]),
        # Heredocs: a tag of ASCII word characters, a digit first too; none without a closing tag
        ('a $x$b$x$ d', ['a', '$x$', '$x$', 'd']),
        ('a $1$b$1$ d', ['a', '$1$', '$1$', 'd']),
        ('a $$b$$ d', ['a', '$$', '$$', 'd']),
        ('a $\u00e9$b$\u00e9$ d', ['a', '$\u00e9$b$\u00e9$', 'd']),
        ('a $x$b d', ['a', '$x$b', 'd']),
        # A bare word takes $, a number does not
        ('a x$y$b$y$ d', ['a', 'x$y$b$y$', 'd']),
        ('a 1$y$b$y$ d', ['a', '1$y$', '$y$', 'd']),
        # Line comments end at LF only; '#' is a comment only before a space or '!'
        ('a -- b\nc', ['a', 'c']),
        ('a // b\nc', ['a', 'c']),
        ('a # b\nc', ['a', 'c']),
        ('a #!b\nc', ['a', 'c']),
        ('a #b', ['a', '#b']),
        ('a -- b\rc', ['a']),
        ('a /* b /* c */ d */ e', ['a', 'e']),
        # A number takes the sign of its exponent, so the -- after it is no comment
        ('a 1e--1 b', ['a', '1e--1', 'b']),
        ('a 0x1p--1 b', ['a', '0x1p--1', 'b']),
        ('a 0b1e--1 b', ['a', '0b1e--1', 'b']),
        ('a 1--1 b', ['a', '1']),
        ('a x--1 b', ['a', 'x']),
    ],
)
def test_the_clickhouse_mask_follows_its_lexer(sql, visible):
    """The ClickHouse mask blanks what ClickHouse's lexer (Lexer.cpp) reads as a literal, a quoted name or a comment.

    Args:
        sql: The text to mask.
        visible: What stays readable, split on whitespace.
    """
    masked = _mask_clickhouse(sql)
    assert len(masked) == len(sql)
    assert masked.split() == visible


@pytest.mark.parametrize(
    'sql',
    [
        "SELECT 'it''s' AS q",
        "SELECT E'it's' AS q",
        "SELECT $$'$$ AS q",
        'SELECT 5 # 3',
        'SELECT `into` FROM t',
        'SELECT "into" FROM t',
        "SELECT 'a; DROP TABLE t' AS q",
        "SELECT name FROM t WHERE note = 'for update'",
        'SELECT 1 -- INTO OUTFILE\nFROM t',
    ],
)
def test_ordinary_reads_with_quotes_and_comments_pass(sql):
    """Quoted text, identifiers and comments that only look like a clause do not reject a read.

    Args:
        sql: The SQL under test.
    """
    assert is_sql_safe(sql) is True
