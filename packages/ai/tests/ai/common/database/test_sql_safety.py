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

from ai.common.database.sql_safety import is_sql_safe


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


# ---------------------------------------------------------------------------
# Session state a rollback does not undo
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT pg_advisory_lock(42)',
        'select PG_TRY_ADVISORY_LOCK(42)',
        'SELECT pg_advisory_lock_shared(42)',
        'SELECT pg_try_advisory_lock_shared(42)',
        "SELECT GET_LOCK('k', 0)",
        'SELECT @x := 1',
        'SELECT id, @x := id FROM t',
    ],
)
def test_session_scoped_state_is_rejected(sql):
    """A session lock or user variable outlives the rollback, so a generated SELECT may not take one."""
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT pg_advisory_xact_lock(42)',
        'SELECT @x',
        'SELECT count(*) FROM t',
    ],
)
def test_transaction_scoped_lock_and_variable_reads_still_pass(sql):
    """The transaction-scoped lock ends with the rollback, and reading a variable sets nothing."""
    assert is_sql_safe(sql) is True


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT "pg_advisory_lock"(42)',
        'SELECT "PG_ADVISORY_LOCK"(42)',
        'SELECT "pg_try_advisory_lock_shared"(42)',
    ],
)
def test_a_quoted_lock_function_name_is_rejected(sql):
    """PostgreSQL folds a quoted identifier to lower case, so quoting does not make it another function."""
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT @x.y := 1',
        "SELECT @'my-var' := 1",
        'SELECT @`my-var` := 1',
    ],
)
def test_every_mysql_user_variable_name_form_is_rejected(sql):
    """MySQL accepts dotted and quoted variable names; all of them set session state."""
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        "SELECT 'pg_advisory_lock(42)'",
        'SELECT "plain identifier" FROM t',
    ],
)
def test_a_literal_or_identifier_that_names_the_function_still_passes(sql):
    """Only a quoted name used as a call is refused; a string or a plain identifier is not."""
    assert is_sql_safe(sql) is True


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT "pg_advisory_lock"/* a comment */(42)',
        'SELECT "pg_advisory_lock" -- a comment\n(42)',
        'SELECT "pg_try_advisory_lock_shared" /*a*/ --b\n (42)',
    ],
)
def test_a_comment_between_a_quoted_name_and_its_parenthesis_is_rejected(sql):
    """PostgreSQL treats the comment as whitespace, so the call still happens."""
    assert is_sql_safe(sql) is False


def test_a_backtick_quoted_mysql_lock_name_is_rejected():
    """MySQL resolves a backtick-quoted built-in name, and masking removes it."""
    assert is_sql_safe("SELECT `GET_LOCK`('k', 0)") is False


def test_a_unicode_escaped_postgresql_lock_name_is_rejected():
    """A U&"..." escape names the same function."""
    assert is_sql_safe('SELECT U&"pg_advisory_\\006cock"(42)') is False


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT "plain_name"(1)',
        'SELECT `plain_name`(1)',
        'SELECT "pg_advisory_lock"',
    ],
)
def test_ordinary_quoted_names_still_pass(sql):
    """Only the lock family is refused: a quoted name is not a call on its own."""
    assert is_sql_safe(sql) is True
