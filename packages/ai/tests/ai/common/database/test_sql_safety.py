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
    """On PostgreSQL a ;-chain can end the read-only transaction or lift its time limit, so this check must stop it."""
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize('sql', ['SELECT 1; SELECT 2', 'SELECT 1;\nSELECT 2;\n', 'EXPLAIN SELECT 1; SELECT 2'])
def test_rejects_more_than_one_statement_even_reads(sql):
    """A generated query is one statement; a chain of reads is refused too."""
    assert is_sql_safe(sql) is False


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
        "SELECT 'a' INTO new_t FROM t -- '",
        # A dollar-quoted string hides a quote from a reader that does not know dollar quoting
        "SELECT $$'$$ INTO new_t FROM t",
    ],
)
def test_literals_and_comments_cannot_hide_a_clause(sql):
    """Masking follows each database's reading of quotes and comments, so nothing real is hidden."""
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
    """SELECT INTO creates a table (PostgreSQL) or a file (MySQL); FOR UPDATE / SHARE take row locks."""
    assert is_sql_safe(sql) is False


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
    """Quoted text, identifiers and comments that only look like a clause do not reject a read."""
    assert is_sql_safe(sql) is True
