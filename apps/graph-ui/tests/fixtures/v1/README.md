# CONTRACT v1 goldens: driver-generated rows

Rows are produced by the real normalizer from real driver objects (Neo4j entities via
the neo4j 6.3.1 driver's own Bolt hydration, FalkorDB values via falkordb-py 1.7.0's
reply parser, AGE values from agtype text as psycopg2 returns it). Generator:
`nodes/test/graph_wire_fixtures.py` (`driver_fixtures()`, built on the row builders in
`nodes/test/test_graph_drivers_full.py`).

The envelope fields (`row_limit`, `truncated`, `truncated_by`, `element_limit`, ...)
follow `read_query` semantics but are filled in by the generator (`truncated` false,
`truncated_by` null); they do not come from a tool call. What the real tool path
returns is in `live/`.

CI checks these files: `nodes/test/test_graph_wire_fixtures_full.py`, in the
live-database pass of `nodes:test`, regenerates them and fails when they differ. When
a change alters the wire output on purpose, regenerate them from `nodes/` and commit
them with the change:

    ../dist/server/engine test/graph_wire_fixtures.py ../apps/graph-ui/tests/fixtures/v1

Logical graph (the same as `../provisional/`): Alice (Person, Employee on Neo4j and
FalkorDB; Person on AGE), Bob, Acme; KNOWS x2 parallel, reverse KNOWS, LIKES self-loop,
WORKS_AT; path p walks k1 backwards (nodes in traversal order, relationship start/end =
stored direction). The AGE fixture has a duplicate 'name' column. `*_types.json` cover
typed values per driver.
