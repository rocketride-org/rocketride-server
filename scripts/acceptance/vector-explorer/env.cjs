// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/*
 * Settings shared by the Vector Explorer Node scripts and browser lanes, read
 * from the environment. Defaults point at the disposable local containers, the
 * fake broker, the stub LLM and the fixture pipelines described in README.md.
 * The credentials are throwaway LOCAL-ONLY test values for those containers,
 * not secrets.
 */
'use strict';

const path = require('path');

const env = process.env;

const ENGINE_URL = env.ENGINE_URL || 'http://127.0.0.1:5590';
// An OSS engine started without ROCKETRIDE_APIKEY accepts any non-empty key.
const API_KEY = env.RR_TEST_APIKEY || 'local-acceptance-key';
const OUT_DIR = env.OUT_DIR || path.join(__dirname, 'out'); // git-ignored
const CLIENT_TS_DIR = env.CLIENT_TS_DIR || path.resolve(__dirname, '../../../packages/client-typescript');
const TEMPLATES_DIR = env.VX_TEMPLATES_DIR || path.resolve(__dirname, '../../../apps/vector-ui/templates');

// Local stand-ins (see README.md).
const BROKER = {
	url: env.VX_BROKER_URL || 'http://127.0.0.1:18788/provision',
	token: env.VX_BROKER_TOKEN || 'local-broker-placeholder',
};
const STUB_LLM_URL = env.VX_STUB_LLM_URL || 'http://127.0.0.1:18901/v1';
// Every answer of the stub starts with this tag.
const STUB_LLM_TAG = '[STUB-LLM]';

// Disposable containers, published on 127.0.0.1 only.
const PGVECTOR = {
	host: env.VX_PG_HOST || '127.0.0.1',
	port: Number(env.VX_PG_PORT || 55432),
	user: env.VX_PG_USER || 'rruser',
	password: env.VX_PG_PASSWORD || 'rrpass',
	database: env.VX_PG_DATABASE || 'rrtenant',
};
// PgBouncer in transaction mode in front of gx-pgvector (the pooled pass).
const PGVECTOR_POOLER_PORT = Number(env.VX_PG_POOLER_PORT || 56434);
const QDRANT = {
	host: env.VX_QDRANT_HOST || '127.0.0.1',
	port: Number(env.VX_QDRANT_PORT || 56333),
	grpcPort: Number(env.VX_QDRANT_GRPC_PORT || 56334),
};
const CHROMA = { host: env.VX_CHROMA_HOST || '127.0.0.1', port: Number(env.VX_CHROMA_PORT || 58000) };
const COLLECTION = env.VX_COLLECTION || 'vx_demo_docs';
const PAGER_DOCUMENTS = 1500;

// Display names and project ids of the fixture pipelines (vx_fixtures.py FIXTURES; a selftest keeps them in sync).
const FIXTURES = {
	postgres: { name: 'vx-local Vector (pgvector)', projectId: '00000000-0000-4000-8000-00000000d1a1' },
	rocketride_vector: {
		name: 'vx-local Vector (RocketRide Vector)',
		projectId: '00000000-0000-4000-8000-00000000d1a2',
	},
	qdrant: { name: 'vx-local Vector (Qdrant)', projectId: '00000000-0000-4000-8000-00000000d1a3' },
	chroma: { name: 'vx-local Vector (Chroma)', projectId: '00000000-0000-4000-8000-00000000d1a4' },
	// The read-only case: webhook ingest and chat, no Tools source.
	stock_rag: { name: 'vx-local Stock RAG (pgvector)', projectId: '00000000-0000-4000-8000-00000000d1a5' },
	// 1,500 one-chunk documents, for the directory's background paging.
	qdrant_pager: { name: 'vx-local 1,500 documents (Qdrant)', projectId: '00000000-0000-4000-8000-00000000d1a6' },
};
// The display name start_fixtures.py --llm stub gives the LLM node.
const STUB_LLM_NODE_NAME = 'Local stub LLM';

// What demo/gen_corpus.py plants in the demo corpus (seeded under DEMO_PREFIX by demo/seed_demo.sh;
// selftest/test_corpus.py keeps these in sync with the generator).
const DEMO_PREFIX = 'C:/demo/';
const DEMO_CORPUS = {
	nearDuplicates: [
		['handbooks/falcon_handbook.md', 'handbooks/falcon_handbook_rev2.md'],
		['field/kestrel_field_guide.md', 'archive/kestrel_field_guide_copy.md'],
	],
	// The OCR-junk page: the sparsest neighbourhood of the corpus (its chunks are the sample's first outliers).
	outlier: 'scans/ocr_scan_0417.txt',
	longManual: 'manuals/long_manual.md',
};
const WATER_QUESTION = 'Where does Falcon Station get its drinking water?';

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
	TEMPLATES_DIR,
	BROKER,
	STUB_LLM_URL,
	STUB_LLM_TAG,
	STUB_LLM_NODE_NAME,
	DEMO_PREFIX,
	DEMO_CORPUS,
	WATER_QUESTION,
	PGVECTOR,
	PGVECTOR_POOLER_PORT,
	QDRANT,
	CHROMA,
	COLLECTION,
	PAGER_DOCUMENTS,
	FIXTURES,
	loadPlaywright,
	signIn,
};
