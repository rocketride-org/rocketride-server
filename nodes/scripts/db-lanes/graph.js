// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Graph Explorer's live database suites (registry notes: nodes/scripts/tasks.js;
 * servers: nodes/test/db-services/graph.sh).
 *
 * Suites that need a server: `test_rocketride_graph_full.py` and
 * `test_graph_age_full.py` (Apache AGE), `test_graph_neo4j_full.py` (Neo4j) and
 * `test_graph_falkordb_full.py` (FalkorDB). Two more need the real driver
 * packages: `test_graph_drivers_full.py` (real driver objects, no server) and
 * `test_graph_wire_fixtures_full.py`, which regenerates graph-ui's wire fixtures
 * (`apps/graph-ui/tests/fixtures/v1`) from the drivers and the live servers and
 * fails when they no longer match. These stub the engine surface themselves.
 * `test_graph_toolpath_full.py` does not: it starts the engine in `dist/server`
 * (build it first) with a stand-in for the cloud database broker, starts each
 * shipped Graph Explorer template (`apps/graph-ui/templates`) against the test
 * servers, and calls its graph tools through the Python SDK.
 * `test_rocketride_graph_full.py` exists on develop, where `nodes:test` leaves it out
 * (its mocked pass globs `*_full.py` away) and only `nodes:test-full` collects it.
 * Listing it below is this domain's deliberate CI change: it joins the unmocked live
 * pass, required on the Linux CI leg, and runs a second time through the AGE pooler.
 *
 * AGE pooler pass: with `RR_TEST_AGE_POOLER_DSN` set, the two AGE suites run a
 * second time through that transaction-mode pooler (`RR_TEST_AGE_DSN` is pointed
 * at it and `RR_TEST_AGE_ADMIN_DSN` at the database itself), the way the cloud
 * reaches tenant databases; CI runs PgBouncer in front of its AGE container for
 * this. Without the variable a required run still passes but leaves that pass out
 * (it says so in the task output). `scripts/acceptance/graph-explorer/validate_all.sh`
 * always sets it, to the `gx-pgbouncer` container from that folder's README unless
 * you point it elsewhere, so a local gate run includes the pass. The servers and
 * their variables (`RR_TEST_AGE_DSN`, `RR_TEST_PG_DSN`, `RR_TEST_NEO4J_URI`,
 * `RR_TEST_FALKORDB_URL`, ...) are the ones `.github/workflows/_build.yaml`
 * (Postgres) and `db-services/graph.sh` (the rest) start; run the same images
 * locally to reproduce a CI failure (`scripts/acceptance/graph-explorer/README.md`
 * has the commands, with Neo4j and FalkorDB pinned by the same digests).
 *
 * Wire fixtures: when a change to a graph node alters its wire output on purpose,
 * regenerate graph-ui's fixtures with `nodes/test/graph_wire_fixtures.py` (its
 * docstring has the commands) and commit them with the change. Regenerate only
 * against the CI images: the live captures record each server's version and its
 * own error text, so captures taken on another server version fail CI.
 * `scripts/acceptance/graph-explorer/check_db_versions.py` says whether your
 * servers match the committed captures; when `test_graph_wire_fixtures_full.py`
 * fails locally and the code did not change the wire output, run it before
 * regenerating anything (with `./engine` from `dist/server`; it imports the
 * database drivers, which a plain build does not install, so run it after
 * `nodes:test` or `nodes:test-db` has installed `nodes/test/requirements.txt`).
 *
 * The graph database drivers' pins (the versions the live suites were validated
 * with) live only in the nodes' own `requirements.txt`, and reach the test install
 * through the engine constraints.
 */
module.exports = {
	name: 'graph',
	suites: [
		// develop's AGE suite for the RocketRide graph node (see the header: a CI behavior change).
		'test_rocketride_graph_full.py',
		'test_graph_age_full.py',
		'test_graph_drivers_full.py',
		'test_graph_neo4j_full.py',
		'test_graph_falkordb_full.py',
		'test_graph_wire_fixtures_full.py',
		'test_graph_toolpath_full.py',
	],
	poolerSuites: ['test_rocketride_graph_full.py', 'test_graph_age_full.py'],
	poolerEnv: 'RR_TEST_AGE_POOLER_DSN',
	poolerMode: 'second-pass',
	// The suites reach AGE through the pooler; the admin work (DDL, graph setup) stays on the database itself.
	secondPassEnv: (poolerDsn, env) => ({
		RR_TEST_AGE_DSN: poolerDsn,
		RR_TEST_AGE_ADMIN_DSN: env.RR_TEST_AGE_DSN || 'postgresql://rruser:rrpass@localhost:55433/rrtenant',
	}),
	junit: 'junit-pooler.xml',
	poolerUnsetNote: 'RR_TEST_AGE_POOLER_DSN is not set: the transaction-mode pooler pass is not run',
};
