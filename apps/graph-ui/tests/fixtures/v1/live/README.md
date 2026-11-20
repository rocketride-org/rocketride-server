# CONTRACT v1/v1.1 wire fixtures captured from the real tool path

Captured by `nodes/test/graph_wire_fixtures.py --live` from the real node tools
(read_query, dialect, get_schema, refresh_schema, error text) running on the real
neo4j 6.3.1 / falkordb 1.7.0 / psycopg2 drivers against the live test databases CI
starts (`nodes/test/db-services/graph.sh`): Neo4j 5.26.31 Community, FalkorDB 6.0.1,
PostgreSQL 16 with Apache AGE 1.5.0. Only the engine surface (rocketlib, config) is
stubbed.

CI checks these files: `nodes/test/test_graph_wire_fixtures_full.py`, in the
live-database pass of `nodes:test`, captures them again and compares, ignoring only
entity ids, `refreshed_at`, the scratch graph name and Neo4j schema entries from other
test data. Everything else must match exactly, including each server's version and
its own error text, so regenerate them only against those servers: the images in
`scripts/acceptance/graph-explorer/README.md` are CI's, and
`scripts/acceptance/graph-explorer/check_db_versions.py` says whether yours match.
From `nodes/`, with the live test databases up:

    ../dist/server/engine test/graph_wire_fixtures.py --live ../apps/graph-ui/tests/fixtures/v1/live

- `*_read_query_*.json`: exact envelopes (all 9 fields), incl. AGE duplicate column
  'a.name', AGE id 11821949021847553 (> 2^53) as string + number tag, path traversal vs
  stored direction, Neo4j byte[] -> bytes tag, truncation by rows.
- `*_dialect.json`: v1 dialect (engine/version/edition, database/graph, capabilities,
  limits, read_boundary, read_boundary_verified). No hosts or credentials.
- `*_get_schema.json`: legacy keys + schema v2 block. Neo4j's includes other test data
  present on the shared server (realistic noise).
- `age_refresh_schema_stale.json`: a failed refresh (budget forced to 0): last good
  schema kept, stale: true, error set.
- `*_errors.json`: str(exception) = "headline\ndetail" for refusals, AGE hints,
  timeouts, invalid input, DB errors, execute disabled.

Neo4j element ids embed the container's database UUID (a local throwaway value).
