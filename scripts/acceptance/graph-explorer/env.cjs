// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Settings shared by the Node acceptance scripts and browser lanes, read from
 * the environment. Defaults point at the disposable local containers and the
 * fixture pipelines described in README.md. The credentials are throwaway
 * LOCAL-ONLY test values for those containers, not secrets.
 */
'use strict';

const path = require('path');

const env = process.env;

const ENGINE_URL = env.ENGINE_URL || 'http://127.0.0.1:5580';
// An OSS engine started without ROCKETRIDE_APIKEY accepts any non-empty key.
const API_KEY = env.RR_TEST_APIKEY || 'local-acceptance-key';
const OUT_DIR = env.OUT_DIR || path.join(__dirname, 'out'); // git-ignored
const CLIENT_TS_DIR = env.CLIENT_TS_DIR || path.resolve(__dirname, '../../../packages/client-typescript');

const NEO4J = {
	uri: env.NEO4J_URI || 'bolt://127.0.0.1:57687',
	user: env.NEO4J_USER || 'neo4j',
	password: env.NEO4J_PASSWORD || 'gxlocal-test-pass',
};
const FALKORDB = { host: env.FALKORDB_HOST || '127.0.0.1', port: Number(env.FALKORDB_PORT || 56379) };
const ACCEPT_GRAPH = env.ACCEPT_GRAPH || 'gx_accept';
// FalkorDB graph of the write-enabled fixture (start_fixtures.py), where lane_graph's write console steps write.
const WRITE_GRAPH = env.WRITE_GRAPH || 'gx_accept_write';
const RUN_LABEL = env.RUN_LABEL || 'GxAcc';
const DEMO_SQL_PREFIX = env.DEMO_SQL_PREFIX || 'demo_';

// Display names of the fixture pipelines started by start_fixtures.py (keep in sync).
const FIXTURES = {
	age: 'gx-local Graph (AGE)',
	neo4j: 'gx-local Graph (Neo4j)',
	falkordb: 'gx-local Graph (FalkorDB)',
	falkordbPerf: 'gx-local Graph perf (FalkorDB)',
	sqlWrite: 'gx-local SQL write-enabled (pgvector)',
	falkordbWrite: 'gx-local Graph write-enabled (FalkorDB)',
};

/**
 * Load Playwright from PLAYWRIGHT_DIR (a folder whose node_modules has it) when
 * set, else from browser/node_modules (`npm install --no-package-lock` there).
 */
function loadPlaywright() {
	const roots = env.PLAYWRIGHT_DIR ? [env.PLAYWRIGHT_DIR] : [path.join(__dirname, 'browser')];
	for (const root of roots) {
		try {
			return require(path.join(root, 'node_modules', 'playwright'));
		} catch {
			// try the next location
		}
	}
	throw new Error(
		`playwright not found under ${roots.join(', ')}: ` +
			'run `npm install --no-package-lock` in browser/, or set PLAYWRIGHT_DIR'
	);
}

/** Sign in to the served shell with the local test key and wait for the connection. */
async function signIn(page, base = ENGINE_URL) {
	await page.goto(base + '/');
	await page
		.getByRole('button', { name: /sign in/i })
		.first()
		.click();
	await page.getByPlaceholder('API key').fill(API_KEY);
	await page.getByPlaceholder('API key').press('Enter');
	await page
		.getByText(/connected/i)
		.first()
		.waitFor({ timeout: 20000 });
}

module.exports = {
	ENGINE_URL,
	API_KEY,
	OUT_DIR,
	CLIENT_TS_DIR,
	NEO4J,
	FALKORDB,
	ACCEPT_GRAPH,
	WRITE_GRAPH,
	RUN_LABEL,
	DEMO_SQL_PREFIX,
	FIXTURES,
	loadPlaywright,
	signIn,
};
