# =============================================================================
# MIT License
# Copyright (c) 2026 Aparavi Software AG
# =============================================================================

"""Token-level read-path check used by Neo4j's read_query (defence in depth)."""

from __future__ import annotations

import pytest

from ai.common.graph.cypher_safety import (
    CypherInputError,
    CypherRefused,
    check_read_only_cypher,
    check_read_query_statement,
)
from ai.common.graph.graph_errors import GraphToolError

READS = [
    'MATCH (n) RETURN n LIMIT 25',
    'MATCH (a)-[r]->(b) RETURN a, r, b',
    'MATCH (a)--(b) RETURN count(*)',  # -- is a relationship, never a comment
    'OPTIONAL MATCH (n:Person) WITH n UNWIND [1, 2] AS x RETURN n, x',
    "MATCH (n) WHERE n.note = 'CREATE (x) DELETE y' RETURN n",
    'MATCH (n) WHERE n.note = "SET n.x = 1" RETURN n',
    "MATCH (n) WHERE n.note = 'it\\'s; DROP' RETURN n",
    'MATCH (n) // DELETE n\nRETURN n',
    'MATCH (n) /* MERGE (m) */ RETURN n',
    'MATCH (n) RETURN n.create, n.delete, n.set, n.remove',
    'MATCH (n:Create:Delete)-[:SET]->(m:`MERGE`) RETURN n',
    'RETURN {create: 1, set: 2, delete: 3} AS m',
    'MATCH (n) WHERE n.x = $create RETURN n',
    'MATCH (start)-[r]->(stop) RETURN start, stop',
    'MATCH (n) RETURN `CREATE` AS x',
    'CALL db.labels()',
    'CALL db.labels() YIELD label RETURN label',
    'call DB.LABELS() yield label return label',
    'CALL `db`.`labels`()',
    'CALL db.relationshipTypes()',
    'CALL db.propertyKeys()',
    'CALL db.schema.nodeTypeProperties()',
    'CALL db.schema.relTypeProperties()',
    'CALL db.schema.visualization()',
    'CALL db.labels',
    'CALL { MATCH (n) RETURN n } RETURN n',
    'MATCH (a) CALL (a) { MATCH (a)-->(b) RETURN b } RETURN b',
    'SHOW INDEXES',
    'SHOW ALL CONSTRAINTS',
    'SHOW PROCEDURES',
    'MATCH (é:Ünïcode) RETURN é',
]

WRITES = [
    ('CREATE (n)', 'CREATE'),
    ('create (n)', 'CREATE'),
    ('MATCH (n) SET n.x = 1', 'SET'),
    ('MATCH (n) DETACH DELETE n', 'DETACH'),
    ('MATCH (n) DELETE n', 'DELETE'),
    ('MERGE (n:P {k: 1})', 'MERGE'),
    ('MATCH (n) REMOVE n.x', 'REMOVE'),
    ('DROP INDEX i', 'DROP'),
    ('FOREACH (x IN [1] | CREATE (:N))', 'FOREACH'),
    ('INSERT (n:N)', 'INSERT'),
    ('MATCH (n) WITH n CALL { WITH n SET n.x = 1 } RETURN n', 'SET'),
    ('MATCH (n) WHERE n.x = "a" CREATE (m) RETURN m', 'CREATE'),
    ('MATCH (n) RETURN n // ok\rDELETE n', 'DELETE'),
]

REFUSED_OTHER = [
    ('LOAD CSV FROM "file:///x" AS row RETURN row', 'LOAD CSV'),
    ('GRANT ROLE reader TO bob', 'GRANT'),
    ('DENY READ ON GRAPH * TO bob', 'DENY'),
    ('REVOKE ROLE reader FROM bob', 'REVOKE'),
    ('STOP DATABASE neo4j', 'STOP DATABASE'),
    ('START DATABASE neo4j', 'START DATABASE'),
    ('ALTER USER bob SET PASSWORD "x"', 'ALTER USER'),
    ('RENAME ROLE a TO b', 'RENAME ROLE'),
    ('TERMINATE TRANSACTIONS "neo4j-1"', 'TERMINATE TRANSACTIONS'),
    ('USE system SHOW USERS', 'USE'),
    ('SHOW USERS', 'SHOW USERS'),
    ('SHOW DATABASES', 'SHOW DATABASES'),
    ('CALL db.createLabel("X")', 'db.createLabel'),
    ('CALL apoc.periodic.iterate("MATCH (n) RETURN n", "DELETE n", {})', 'apoc.periodic.iterate'),
    ('CALL `apoc`.`cypher`.`runWrite`("CREATE (n)", {})', 'apoc.cypher.runWrite'),
    ('CALL apoc.load.json("http://example.invalid")', 'apoc.load.json'),
    ('CALL db.schema.nodeTypeProperties2()', 'db.schema.nodeTypeProperties2'),
    ('CALL dbms.components()', 'dbms.components'),
    ('MATCH (n) CALL { CALL db.createLabel("X") } RETURN n', 'db.createLabel'),
    ('CALL db.`labels`.extra()', 'db.labels.extra'),
]


@pytest.mark.parametrize('cypher', READS)
def test_reads_pass(cypher):
    check_read_only_cypher(cypher)


@pytest.mark.parametrize('cypher,word', WRITES)
def test_writes_refused(cypher, word):
    with pytest.raises(CypherRefused) as err:
        check_read_only_cypher(cypher)
    assert err.value.headline.startswith('Refused: ')
    assert word in err.value.headline


@pytest.mark.parametrize('cypher,what', REFUSED_OTHER)
def test_admin_use_show_and_unlisted_procedures_refused(cypher, what):
    with pytest.raises(CypherRefused) as err:
        check_read_only_cypher(cypher)
    assert what.lower() in str(err.value).lower()


@pytest.mark.parametrize('cypher', ["MATCH (n) WHERE n.x = 'open", 'MATCH (n) /* open', 'MATCH (`open) RETURN 1'])
def test_unterminated_literals_refused(cypher):
    with pytest.raises(CypherRefused, match='unterminated'):
        check_read_only_cypher(cypher)


def test_refusal_is_a_graph_tool_error_with_headline_and_detail():
    with pytest.raises(GraphToolError) as err:
        check_read_only_cypher('CALL apoc.do.it()')
    headline, _, detail = str(err.value).partition('\n')
    assert headline == 'Refused: CALL apoc.do.it is not on the read-only procedure allowlist'
    assert detail.startswith('Allowed: db.labels, db.propertyKeys, db.relationshipTypes')


def test_custom_allowlist():
    check_read_only_cypher('CALL my.proc()', allowed_procedures=frozenset({'my.proc'}))
    with pytest.raises(CypherRefused):
        check_read_only_cypher('CALL db.labels()', allowed_procedures=frozenset({'my.proc'}))


# ---------------------------------------------------------------------------
# check_read_query_statement: the rule every driver's read_query applies
# ---------------------------------------------------------------------------

LOAD_CSV = [
    "LOAD CSV FROM 'https://example.invalid/x.csv' AS row RETURN row",
    'load csv with headers from $url as row return row',
    "MATCH (n) WITH 'https://example.invalid/?q=' + n.name AS u LOAD CSV FROM u AS row RETURN count(row)",
    "LOAD /* comment */ CSV FROM 'file:///x' AS r RETURN r",
    "CALL { LOAD CSV FROM 'file:///x' AS r RETURN r } RETURN 1",
]

NOT_LOAD_CSV = [
    'MATCH (n:Load) RETURN n.csv',
    'MATCH (n) RETURN n.load, n.LOAD',
    "RETURN 'LOAD CSV FROM x' AS s",
    'MATCH (load) RETURN load',
    'WITH 1 AS load RETURN load',
    'MATCH (n {load: 1}) RETURN n',
    'MATCH (n) RETURN `LOAD` AS csv',
    'MATCH (n) // LOAD CSV FROM x\nRETURN n',
    # Procedures and writes are each driver's own read boundary, not this check.
    'CALL db.labels()',
    'MATCH (n) SET n.x = 1',
]


@pytest.mark.parametrize('cypher', LOAD_CSV)
def test_read_query_statement_refuses_load_csv(cypher):
    with pytest.raises(CypherRefused) as err:
        check_read_query_statement(cypher)
    assert err.value.headline == 'Refused: LOAD CSV is not allowed on the read-only path'


@pytest.mark.parametrize('cypher', NOT_LOAD_CSV)
def test_read_query_statement_passes_everything_else(cypher):
    check_read_query_statement(cypher)


@pytest.mark.parametrize(
    'cypher,what',
    [
        ("MATCH (n) WHERE n.x = 'open", 'string literal'),
        ('MATCH (n) /* open', 'comment'),
        ('MATCH (`open) RETURN 1', 'back-quoted name'),
    ],
)
def test_read_query_statement_reports_unterminated_text_as_invalid_input(cypher, what):
    """Unterminated text is an input error, not a refusal (a "Refused:" headline reads as a refused write)."""
    with pytest.raises(GraphToolError) as err:
        check_read_query_statement(cypher)
    assert err.value.headline == f'Invalid read_query input: unterminated {what}'
    assert not isinstance(err.value, CypherRefused)
    assert isinstance(err.value, ValueError)


def test_read_query_statement_names_the_calling_tool():
    with pytest.raises(GraphToolError) as err:
        check_read_query_statement("RETURN 'open", tool='query')
    assert err.value.headline == 'Invalid query input: unterminated string literal'
    with pytest.raises(CypherRefused) as err:
        check_read_query_statement("LOAD CSV FROM 'file:///x' AS r RETURN r", tool='query', detail='Some detail.')
    assert str(err.value) == 'Refused: LOAD CSV is not allowed on the read-only path\nSome detail.'


def test_read_query_statement_default_detail_is_unchanged():
    with pytest.raises(CypherRefused) as err:
        check_read_query_statement("LOAD CSV FROM 'file:///x' AS r RETURN r")
    assert err.value.detail == 'read_query reads only the configured graph.'


# ---------------------------------------------------------------------------
# Numbers, line endings and block comments the read path does not guess at
# ---------------------------------------------------------------------------

# (statement, the number as written, the character it runs into)
NUMBER_RUNS_ON = [
    ('RETURN 7x AS y', '7', 'x'),
    ('RETURN 0.5x AS y', '0.5', 'x'),
    ('RETURN 1e3x AS y', '1e3', 'x'),
    ('RETURN 1. AS y', '1', '.'),
    ('RETURN .5x AS y', '5', 'x'),
    ('RETURN 0x1Fz AS y', '0x1F', 'z'),
    ('RETURN 0o7z AS y', '0o7', 'z'),
    ('RETURN 1_000z AS y', '1_000', 'z'),
    ('RETURN 1eX AS x', '1', 'e'),
    ('RETURN 1_ AS x', '1', '_'),
    ('RETURN 1.5.2 AS x', '1.5', '.'),
    ('RETURN 1.e3 AS x', '1', '.'),
    ('RETURN 0o8 AS x', '0', 'o'),
    ('RETURN 12é AS x', '12', 'é'),
]

NUMBERS = [
    'RETURN 0, 7, 017, 1_000, 0x1F, 0XfF, 0o17, 1.5, .5, 1e3, 1E-3, 1.5e+3 AS x',
    'MATCH (n)-[*1..3]->(m) RETURN m',
    'MATCH (n)-[*..3]->(m) RETURN m',
    'RETURN [1, 2, 3][0..2] AS x, [1, 2, 3][1..] AS y',
    'RETURN -1+2*3-4/5%6^7 AS x',
    'MATCH (n) WHERE n.v1 > 2 AND n.x2y <> $p1 RETURN n LIMIT 10',
    'RETURN {k1: 1}.k1 AS x',
]


@pytest.mark.parametrize('cypher,number,follower', NUMBER_RUNS_ON)
def test_a_number_running_into_what_follows_is_invalid_input(cypher, number, follower):
    """A number must end before a letter, underscore or single dot; read_query does not guess at such text."""
    with pytest.raises(CypherInputError) as err:
        check_read_query_statement(cypher)
    assert err.value.headline == f'Invalid read_query input: the number {number} runs into {follower!r}'


@pytest.mark.parametrize('cypher,number,follower', NUMBER_RUNS_ON)
def test_the_procedure_check_refuses_a_number_running_into_what_follows(cypher, number, follower):
    with pytest.raises(CypherRefused) as err:
        check_read_only_cypher(cypher)
    assert err.value.headline == f'Refused: the number {number} runs into {follower!r}'


@pytest.mark.parametrize('cypher', NUMBERS)
def test_numbers_written_in_full_pass(cypher):
    check_read_query_statement(cypher)
    check_read_only_cypher(cypher)


def test_a_long_number_is_shortened_in_the_headline():
    with pytest.raises(CypherInputError) as err:
        check_read_query_statement('RETURN ' + '9' * 40 + 'x')
    assert err.value.headline == f"Invalid read_query input: the number {'9' * 24}... runs into 'x'"


@pytest.mark.parametrize(
    'cypher',
    [
        'MATCH (n) // note\r\nRETURN n',
        "MATCH (n) // it's\r\nRETURN n",
        'MATCH (n) //\rRETURN n',
        "MATCH (n) // a\rRETURN n // it's",
    ],
)
def test_line_comments_ending_in_cr_or_lf_pass(cypher):
    check_read_query_statement(cypher)


def test_text_that_reads_differently_at_a_lone_cr_is_invalid_input():
    """A // comment may end at a lone CR or at the LF; text unreadable either way is refused."""
    with pytest.raises(CypherInputError) as err:
        check_read_query_statement("MATCH (n) //\r'\nRETURN n")
    assert err.value.headline == 'Invalid read_query input: unterminated string literal'


def test_text_one_ending_cannot_read_is_invalid_input():
    """Read with the comment ending at the CR the text is fine; ending at the LF it leaves a quote open."""
    cypher = "MATCH (n) //\r'x\n' RETURN n"
    check_read_only_cypher(cypher)
    with pytest.raises(CypherInputError) as err:
        check_read_query_statement(cypher)
    assert err.value.headline == 'Invalid read_query input: unterminated string literal'


BLOCK_COMMENT_SLASH = [
    'MATCH (n) /* a/b */ RETURN n',
    'MATCH (n) /*/ x */ RETURN n',
    'MATCH (n) /* see https://example.invalid */ RETURN n',
    'MATCH (n) /*/*/ RETURN n',
    "MATCH (n) /*'/ x '*/ RETURN n",
    'MATCH (n) /*`/ x `*/ RETURN n',
]

BLOCK_COMMENTS = [
    'MATCH (n) /**/ RETURN n',
    'MATCH (n) /***/ RETURN n',
    'MATCH (n) /* note */ RETURN n',
    'MATCH (n) /* note **/ RETURN n',
    "MATCH (n) /* it's * */ RETURN n",
    'MATCH (n) /* a\r\nb */ RETURN n',
    'MATCH (n) WHERE n.x = 1/*c*/ RETURN n',
    'RETURN 4 / /* c */ 2 AS x',
    "RETURN '/*/' AS x, `/* a/b */` AS y",
    'MATCH (n) // a /* b/c\nRETURN n',
]


@pytest.mark.parametrize('cypher', BLOCK_COMMENT_SLASH)
def test_a_slash_inside_a_block_comment_is_invalid_input(cypher):
    """Write a // comment for text such as a URL."""
    with pytest.raises(CypherInputError) as err:
        check_read_query_statement(cypher)
    assert err.value.headline == "Invalid read_query input: '/' inside a block comment"


@pytest.mark.parametrize('cypher', BLOCK_COMMENT_SLASH)
def test_the_procedure_check_refuses_a_slash_inside_a_block_comment(cypher):
    with pytest.raises(CypherRefused) as err:
        check_read_only_cypher(cypher)
    assert err.value.headline == "Refused: '/' inside a block comment"


@pytest.mark.parametrize('cypher', BLOCK_COMMENTS)
def test_block_comments_without_a_slash_pass(cypher):
    check_read_query_statement(cypher)
    check_read_only_cypher(cypher)


def test_non_ascii_names_and_comments_pass():
    check_read_query_statement('MATCH (é:Ünïcode) RETURN é // café')
