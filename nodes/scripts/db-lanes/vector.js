// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Vector Explorer's live database suites (registry notes: nodes/scripts/tasks.js;
 * servers: nodes/test/db-services/vector.sh).
 *
 * `test_store_postgres_full.py` (PostgreSQL with pgvector), `test_store_qdrant_full.py`
 * (Qdrant) and `test_store_chroma_full.py` (Chroma) drive the shared drivers behind
 * the vector stores on new and legacy-shaped collections; they stub the engine
 * surface themselves. The suites that exist on develop and this domain changed
 * (`test_rocketride_db_full.py`, `test_rocketride_vector_tools_full.py`,
 * `test_vector_store_writes_full.py`, `test_vector_store_listing_full.py` and
 * `test_pgvector_search.py`) are listed below: a deliberate CI change of this PR. On
 * develop `nodes:test` leaves the four `*_full.py` suites out (its mocked pass globs them
 * away; only `nodes:test-full` collects them) and runs `test_pgvector_search.py` in its
 * mocked pass; here all five run in the unmocked live pass, required on the Linux CI leg.
 * `test_vector_toolpath_full.py` does not stub: it starts the
 * engine in `dist/server` (build it first) with a stand-in for the cloud database
 * broker, starts each shipped Vector Explorer template (`apps/vector-ui/templates`)
 * against the test servers, and calls its store and `embed` tools through the Python
 * SDK (its first start installs the embedding node's requirements and loads
 * all-MiniLM-L6-v2). `test_vector_wire_fixtures_full.py` regenerates vector-ui's wire
 * fixtures (`apps/vector-ui/tests/fixtures/v1/live`) the same way and compares them.
 * None needs the test server, but none can run in the mocked pass: `nodes/test/mocks`
 * replaces `psycopg2`, `pgvector` and the vector store clients for the whole engine.
 * A deliberate `NOT RUN:` skip here is a legacy-shaped table or collection the CI
 * servers are not seeded with.
 *
 * pgvector pooler cases: the pgvector suites (`test_store_postgres_full.py` and the
 * `rocketride_vector` cases of `test_rocketride_db_full.py`) also run through a
 * transaction-mode pooler, the way the cloud reaches tenant databases. With
 * `RR_TEST_PGVECTOR_POOLER_DSN` set (CI points it at a PgBouncer in front of its
 * pgvector container) each case runs once directly and once through the pooler, in
 * the same live pass, and a required run fails unless both suites passed at least one
 * pooled case; without it those cases skip with `NOT RUN:` and the task output says
 * so. `scripts/acceptance/vector-explorer/validate_all.sh` always sets it, to the
 * `vx-pgbouncer` container from that folder's README unless you point it elsewhere,
 * so a local gate run includes the pooled cases.
 *
 * The servers and their variables (`RR_TEST_PG_DSN`, `RR_TEST_PGVECTOR_DSN` for the
 * toolpath and wire-fixture suites, `RR_TEST_PGVECTOR_POOLER_DSN`, `RR_TEST_QDRANT_URL`,
 * `RR_TEST_CHROMA_URL`, ...) are the ones `.github/workflows/_build.yaml` (Postgres) and
 * `db-services/vector.sh` (the rest) start; run the same images locally to reproduce a
 * CI failure (`scripts/acceptance/vector-explorer/containers/start.sh` starts them, with
 * Qdrant, Chroma and PgBouncer pinned by the same digests and pgvector by the same tag).
 */
module.exports = {
	name: 'vector',
	suites: [
		// develop's pgvector suites (see the header: a CI behavior change).
		'test_rocketride_db_full.py',
		'test_rocketride_vector_tools_full.py',
		'test_vector_store_listing_full.py',
		'test_vector_store_writes_full.py',
		'test_pgvector_search.py',
		'test_store_postgres_full.py',
		'test_store_qdrant_full.py',
		'test_store_chroma_full.py',
		'test_vector_toolpath_full.py',
		'test_vector_wire_fixtures_full.py',
	],
	// These suites parametrise their cases over the database and the pooler named by
	// RR_TEST_PGVECTOR_POOLER_DSN, so the live pass runs the pooled cases itself.
	poolerSuites: ['test_rocketride_db_full.py', 'test_store_postgres_full.py'],
	poolerEnv: 'RR_TEST_PGVECTOR_POOLER_DSN',
	poolerMode: 'in-suite',
	poolerUnsetNote: 'RR_TEST_PGVECTOR_POOLER_DSN is not set: the pgvector suites leave out their pooled cases',
};
