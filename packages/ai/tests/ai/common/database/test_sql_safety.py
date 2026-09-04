"""
Unit tests for ai.common.database.sql_safety.is_sql_safe.

is_sql_safe is the dialect-agnostic gate that filters LLM-generated SQL before
the relational-DB drivers run it. Only SELECT and WITH (CTE) statements are
allowed; everything else (mutation, DDL, file IO, CALL, etc.) must be rejected.
These tests exercise the allowlist, the comment / multi-statement stripping, and
the SELECT INTO OUTFILE / DUMPFILE side-channel guard.
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
        'SELECT 1; SELECT 2',
        'SELECT 1;\nSELECT 2;\n',
        'SELECT 1;',
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
# SELECT ... INTO <table>
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT * INTO stolen_users FROM users',
        'select id, email into exfil from users where 1=1',
        'SELECT a INTO other_schema.copy FROM t',
        'EXPLAIN SELECT * INTO copy FROM t',
    ],
)
def test_select_into_table_is_blocked(sql):
    """``SELECT ... INTO <table>`` creates a table on PostgreSQL and SQL Server.

    Same family as the ``INTO OUTFILE`` guard above and the same class of
    problem this check exists to catch — a statement whose shape writes,
    despite the leading SELECT.
    """
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        "SELECT 'shipped into market' AS phrase",
        "SELECT 'into' AS w, 'outfile' AS x FROM t",
        'SELECT into_count FROM t',
        'SELECT point_into FROM t',
        'SELECT "into" FROM t',
        "SELECT id FROM t WHERE note = 'moved into storage'",
    ],
)
def test_into_as_data_or_identifier_is_not_blocked(sql):
    """The word must be a clause, not a value or part of a name.

    String literals are blanked before the INTO checks run, so ordinary rows
    that happen to contain the word stay queryable.
    """
    assert is_sql_safe(sql) is True


def test_shape_check_does_not_claim_to_be_read_only():
    """Statements with side effects still pass — by design, documented as such.

    ``is_sql_safe`` is a shape check. These are all genuinely dangerous and
    all shaped like reads; the read-only guarantee comes from
    ``DatabaseGlobalBase.read_only_connection``, not from this function. The
    test exists so nobody re-reads this gate as a security boundary.
    """
    side_effecting = [
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity',
        'SELECT pg_sleep(3600)',
        'SELECT pg_read_file(:path)',
        'SELECT nextval(:seq)',
        'SELECT * FROM users FOR UPDATE',
        'SELECT SLEEP(3600)',
    ]
    assert all(is_sql_safe(sql) for sql in side_effecting)


# ---------------------------------------------------------------------------
# Lexing: literals, quoted identifiers and comments in one pass
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'sql',
    [
        "SELECT '--x' INTO OUTFILE '/tmp/export'",
        "SELECT '--' INTO DUMPFILE '/tmp/export'",
        "SELECT '/*' INTO OUTFILE '/tmp/export'",
        "SELECT '#x' INTO OUTFILE '/tmp/export'",
    ],
)
def test_comment_marker_inside_a_literal_cannot_hide_a_write(sql):
    """A literal containing a comment marker must not swallow the clause after it.

    Stripping comments before masking literals turned
    ``SELECT '--x' INTO OUTFILE '/tmp/f'`` into ``SELECT '`` — an ordinary
    read as far as the gate was concerned, taking a file-writing statement
    straight through. Both are now masked in a single left-to-right pass.
    """
    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'sql',
    [
        'SELECT `into` FROM t',
        'SELECT `into`, id FROM `orders`',
        'SELECT `select` FROM `from`',
    ],
)
def test_backtick_identifiers_are_not_read_as_clauses(sql):
    """MySQL quotes identifiers with backticks; a column named `into` is valid SQL."""
    assert is_sql_safe(sql) is True


def test_semicolon_inside_a_literal_does_not_split_the_statement():
    """Statement splitting runs on masked text, so data cannot fake a chain."""
    assert is_sql_safe("SELECT 'a;DROP TABLE t' FROM x") is True


def test_quote_inside_a_comment_does_not_open_a_literal():
    """The reverse ordering bug: a comment's apostrophe must not eat later SQL."""
    assert is_sql_safe("SELECT 1 -- it's fine\n") is True


def test_backslash_is_not_treated_as_an_escape():
    """A backslash must not hide a clause, even though MySQL escapes with it.

    MySQL treats a backslash-quote pair as an escaped quote; PostgreSQL, under
    the default ``standard_conforming_strings``, does not. Honouring the escape
    would mask the ``INTO OUTFILE`` that follows and let a PostgreSQL write
    through. Ignoring it can only end a literal early and expose more text to
    the checks — a false rejection at worst, never a bypass.
    """
    backslash = chr(92)
    sql = "SELECT 'it" + backslash + "' INTO OUTFILE '/tmp/f'"

    # Guard the fixture itself: an earlier version of this test lost its
    # backslash to escaping and passed without exercising anything.
    assert backslash in sql

    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'terminator',
    [chr(10), chr(13), chr(13) + chr(10)],
)
def test_line_comment_ends_at_cr_as_well_as_lf(terminator):
    """A lone CR ends a line comment for the server, so it must end one here.

    Masking through a CR hides whatever follows it on the same physical line.
    ``SELECT 1 -- x<CR>; DROP TABLE t`` then looks like a bare SELECT while the
    server sees a chained DROP.
    """
    sql = 'SELECT 1 -- x' + terminator + '; DROP TABLE t'

    assert is_sql_safe(sql) is False


@pytest.mark.parametrize(
    'terminator',
    [chr(10), chr(13), chr(13) + chr(10)],
)
def test_comment_still_hides_its_own_content_up_to_any_terminator(terminator):
    """Ending at CR must not stop comments from doing their job."""
    sql = '-- DROP TABLE t' + terminator + 'SELECT 1'

    assert is_sql_safe(sql) is True
