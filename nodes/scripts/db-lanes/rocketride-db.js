// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Live database suites that predate the registry: the RocketRide cloud DB
 * nodes (`rocketride_sql`, `rocketride_vector`, `rocketride_graph`) on the
 * PostgreSQL containers `.github/workflows/_build.yaml` starts (pgvector at
 * RR_TEST_PG_DSN, Apache AGE at RR_TEST_AGE_DSN).
 *
 * A domain that adds suites of its own (Graph Explorer, Vector Explorer, ...)
 * registers them in its own file in this folder; see the registry notes in
 * `nodes/scripts/tasks.js`. A domain may name suites registered here in its
 * `poolerSuites`, which is how the Vector and Graph lanes put these suites
 * through their poolers without editing this file.
 */
module.exports = {
	name: 'rocketride-db',
	suites: [
		'test_rocketride_db_full.py',
		'test_rocketride_graph_full.py',
		'test_rocketride_vector_tools_full.py',
		'test_vector_store_listing_full.py',
		'test_vector_store_writes_full.py',
		// Not named *_full, so without a registration the mocked pass would collect it.
		'test_pgvector_search.py',
	],
};
