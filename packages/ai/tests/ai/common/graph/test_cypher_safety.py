"""
Unit tests for ai.common.graph.cypher_safety.is_cypher_safe.

is_cypher_safe is the shared read-only gate for every graph node (called from
graph_instance_base for FalkorDB today and any future driver on that base). Only
read clauses (MATCH / RETURN / schema CALLs) are allowed; write and admin clauses
(CREATE, MERGE, DELETE, SET, REMOVE, DROP, FOREACH, LOAD CSV, apoc write procs)
must be rejected.

Two failure modes get the most coverage here:
  - false positives: a property or map key that happens to share a name with a
    write keyword (n.delete), or a keyword that only appears as string / comment
    data (n.op = "CREATE"), must NOT be rejected;
  - bypasses: a comment or string must never hide a live write from the gate.
"""

import pytest

from ai.common.graph.cypher_safety import is_cypher_safe


# ---------------------------------------------------------------------------
# Allowed read-only statements
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'cypher',
    [
        'MATCH (n) RETURN n',
        'match (n) return n',
        '   MATCH (n) RETURN count(n)   ',
        'MATCH (n:Person) WHERE n.age > 30 RETURN n.name',
        'MATCH (a)-[r]->(b) RETURN a, r, b',
        'CALL db.labels()',
        'CALL db.schema.visualization()',
    ],
)
def test_allows_read_only(cypher):
    """Read clauses and schema CALLs must be accepted."""
    assert is_cypher_safe(cypher) is True


@pytest.mark.parametrize('cypher', ['', '   ', '\n'])
def test_empty_input_passes_vacuously(cypher):
    """Empty / whitespace-only input has no write clause, so it is not rejected."""
    assert is_cypher_safe(cypher) is True


# ---------------------------------------------------------------------------
# Property / identifier names that collide with write keywords (the #1375 bug)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'cypher',
    [
        'MATCH (n) WHERE n.delete = true RETURN n',
        'MATCH (n) RETURN n.create',
        'MATCH (n) RETURN n.create, n.set, n.remove, n.drop',
        'MATCH (n) WHERE n.merge IS NOT NULL RETURN n',
        'MATCH (n) RETURN n.foreach',
    ],
)
def test_dotted_property_named_like_keyword_is_allowed(cypher):
    """A ``.keyword`` property read is not the write clause and must be allowed."""
    assert is_cypher_safe(cypher) is True


# ---------------------------------------------------------------------------
# Keywords that appear only as data (string literals / comments)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'cypher',
    [
        'MATCH (n) WHERE n.name = "CREATE" RETURN n',
        "MATCH (n) WHERE n.note = 'please DELETE this later' RETURN n",
        'MATCH (n) WHERE n.name = "DROP the beat" RETURN n',
        '// DELETE this query someday\nMATCH (n) RETURN n',
        '/* CREATE was here */ MATCH (n) RETURN n',
        'MATCH (n) RETURN n  // remember to SET things up',
    ],
)
def test_keyword_only_as_data_is_allowed(cypher):
    """A write keyword inside a string or comment is data, not a clause."""
    assert is_cypher_safe(cypher) is True


# ---------------------------------------------------------------------------
# Write / admin clauses must be rejected
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'cypher',
    [
        'CREATE (n:Person {name: "x"})',
        'MERGE (n:Person {id: 1})',
        'MATCH (n) DELETE n',
        'MATCH (n) DETACH DELETE n',
        'MATCH (n) SET n.age = 31',
        'MATCH (n) REMOVE n:Person',
        'DROP INDEX ON :Person(name)',
        'MATCH (n) FOREACH (x IN n.items | SET x.seen = true)',
        'LOAD CSV FROM "file:///data.csv" AS row CREATE (:Row)',
        'CALL apoc.create.node(["Person"], {name: "x"})',
        'CALL apoc.periodic.commit("MATCH (n) DELETE n", {})',
        'match (n) delete n',
    ],
)
def test_rejects_write_clauses(cypher):
    """Any write or admin clause must be rejected regardless of case."""
    assert is_cypher_safe(cypher) is False


# ---------------------------------------------------------------------------
# Comments / strings must not hide a live write (bypass guard)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    'cypher',
    [
        'MATCH (n) /* harmless */ DELETE n',
        '/* SELECT-ish */ MATCH (n) SET n.x = 1',
        "MATCH (n {name: 'safe'}) DELETE n",
        'MATCH (n) WHERE n.x = "CREATE" CREATE (m)',
    ],
)
def test_comment_or_string_does_not_hide_live_write(cypher):
    """Stripping a comment or string literal must not blind the gate to a real write."""
    assert is_cypher_safe(cypher) is False


def test_unbalanced_quote_in_comment_cannot_hide_write():
    """
    Regression for the chained-stripper bypass.

    An unbalanced quote inside a line comment must not swallow a write keyword on
    the following line. The single-pass strip consumes the comment only to the
    newline, so the DELETE on the next line stays visible and is rejected.
    """
    cypher = "MATCH (n) // note: don't forget\nDELETE n"
    assert is_cypher_safe(cypher) is False


@pytest.mark.parametrize(
    'cypher',
    [
        'MATCH (n) // hide me\rDELETE n',
        'MATCH (n) //\rCREATE (m)',
    ],
)
def test_carriage_return_ends_line_comment(cypher):
    """
    A line comment ends at a carriage return, not only a line feed.

    Cypher stops the ``//`` comment at the ``\\r`` and executes what follows, so
    the strip must too, otherwise a write hidden after a lone ``\\r`` slips past.
    """
    assert is_cypher_safe(cypher) is False
