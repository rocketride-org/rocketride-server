/**
 * Docs Build Module
 *
 * Co-located documentation site. Discovered by the build orchestrator at
 * packages/docs/scripts/tasks.js; exposes `docs:build` (gather -> index ->
 * compile), `docs:dev`, `docs:serve`, `docs:test`, and `docs:clean`. Bare
 * `builder build` includes docs:build via global-command expansion because it
 * carries a description.
 */
const path = require('path');
const { readdir } = require('node:fs/promises');
const { execCommand, exists, mkdir, rm, setState, parallel, PROJECT_ROOT, BUILD_ROOT, DIST_ROOT } = require('../../../scripts/lib');

// Light, in-tree reference generators that deposit before gather collects them.
// Heavier emitters (Python SDKs, engine) refresh via their own :build under
// global `builder build`; gather then collects whatever is present in-tree.
const DOC_GENERATORS = ['nodes:docs-generate', 'client-typescript:docs-generate'];

const DOCS_DIR = path.join(__dirname, '..');
const CONTENT_STATIC_DIR = path.join(DOCS_DIR, 'content-static');
const STATIC_DIR = path.join(DOCS_DIR, 'static');

// Assembled content tree Docusaurus reads (gather populates it).
const CONTENT_DIR = path.join(BUILD_ROOT, 'docs-content');
// Final static site output.
const SITE_OUT = path.join(DIST_ROOT, 'docs');

const GATHER_HASH_KEY = 'docs.gatherHash';

/** Build env for Docusaurus: content path + metadata threaded from CLI flags. */
function docsEnv(options = {}) {
	return {
		...process.env,
		ROCKETRIDE_DOCS_CONTENT: CONTENT_DIR,
		DOCS_VERSION: options.buildVersion || '',
		DOCS_HASH: options.buildHash || '',
		DOCS_STAMP: options.buildStamp || '',
		DOCS_SAAS: options.saas ? '1' : ''
	};
}

function makeGatherAction(mode = 'copy') {
	return {
		run: async (ctx, task) => {
			const { gather } = require('./lib/gather');
			await gather({ projectRoot: PROJECT_ROOT, contentStaticDir: CONTENT_STATIC_DIR, contentDir: CONTENT_DIR, staticDir: STATIC_DIR, mode, task });
		}
	};
}

function makeIndexAction() {
	return {
		run: async (ctx, task) => {
			const { buildIndex } = require('./lib/llms');
			await buildIndex({ contentDir: CONTENT_DIR, staticDir: STATIC_DIR, task });
		}
	};
}

function makeCompileAction(options = {}) {
	return {
		run: async (ctx, task) => {
			await mkdir(SITE_OUT);
			await execCommand('pnpm', ['exec', 'docusaurus', 'build', '--out-dir', SITE_OUT], { task, cwd: DOCS_DIR, env: docsEnv(options) });
			task.output = `Built docs site at ${SITE_OUT}`;
		}
	};
}

function makeDevStartAction(options = {}) {
	return {
		run: async (ctx, task) => {
			await execCommand('pnpm', ['exec', 'docusaurus', 'start'], { task, cwd: DOCS_DIR, env: docsEnv(options), stdio: 'inherit' });
		}
	};
}

/**
 * Preview the built static site from SITE_OUT. `docusaurus serve` defaults to
 * packages/docs/build, but the pipeline emits to SITE_OUT (dist/docs), so point
 * --dir there. Fails fast with an actionable message when nothing is built yet.
 *
 * The `serve` script in package.json mirrors this with a path relative to
 * packages/docs (`../../dist/docs`), which resolves to the same repo-root
 * dist/docs as the absolute SITE_OUT here.
 */
function makeServeAction() {
	return {
		description: 'Serve built docs',
		run: async (ctx, task) => {
			if (!(await exists(SITE_OUT))) {
				throw new Error(`No built docs at ${SITE_OUT}. Run 'builder docs:build' first.`);
			}
			await execCommand('pnpm', ['exec', 'docusaurus', 'serve', '--dir', SITE_OUT, '--port', '3000'], { task, cwd: DOCS_DIR, stdio: 'inherit' });
		}
	};
}

/** Recursively collect `*.test.mjs` files under `dir` (absolute paths). */
async function findTestFiles(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await findTestFiles(full)));
		} else if (entry.name.endsWith('.test.mjs')) {
			files.push(full);
		}
	}
	return files;
}

/** Run unit tests for the docs site's pure helpers via Node's test runner. */
function makeTestAction() {
	return {
		description: 'Test docs helpers',
		run: async (ctx, task) => {
			const srcDir = path.join(DOCS_DIR, 'src');
			const testFiles = (await findTestFiles(srcDir)).map((f) => path.relative(DOCS_DIR, f));
			if (testFiles.length === 0) {
				task.output = 'No test files found under src/';
				return;
			}
			await execCommand('node', ['--test', '--test-reporter=spec', ...testFiles], { task, cwd: DOCS_DIR });
		}
	};
}

function makeCleanAction() {
	return {
		description: 'Clean docs',
		run: async (ctx, task) => {
			await rm(CONTENT_DIR);
			await rm(SITE_OUT);
			await rm(path.join(DOCS_DIR, '.docusaurus'));
			await rm(path.join(DOCS_DIR, 'build'));
			await setState(GATHER_HASH_KEY, null);
			task.output = 'Cleaned docs';
		}
	};
}

module.exports = {
	name: 'docs',
	description: 'Documentation site',
	_root: PROJECT_ROOT,

	actions: [
		// Internal actions
		{ name: 'docs:gather', action: () => makeGatherAction('copy') },
		{ name: 'docs:gather-dev', action: () => makeGatherAction('symlink') },
		{ name: 'docs:index', action: makeIndexAction },
		{ name: 'docs:compile', action: makeCompileAction },
		{ name: 'docs:dev-start', action: makeDevStartAction },

		// docs:build is intentionally description-less. The aggregate `builder build`
		// only expands to actions that carry a `description` (see the
		// `actionObj?.description` gate in scripts/lib/registry.js `listCommands` and
		// scripts/build.js `expandGlobalCommands`), so omitting one keeps the docs
		// site out of `builder build` — it is built on its own cadence and deployed
		// by .github/workflows/docs.yml. CAVEAT: this overloads `description` as both
		// "public/help-listed" and "part of aggregate build", so adding a description
		// here to make it discoverable would silently RE-COUPLE it to `builder build`.
		// Run it explicitly with `builder docs:build`.
		{
			name: 'docs:build',
			action: () => ({
				steps: [parallel(DOC_GENERATORS, 'Generate reference docs'), 'docs:gather', 'docs:index', 'docs:compile']
			})
		},

		// Public actions (have descriptions)
		{
			name: 'docs:dev',
			action: () => ({
				description: 'Start docs dev server',
				steps: ['docs:gather-dev', 'docs:dev-start']
			})
		},
		{
			name: 'docs:serve',
			action: makeServeAction
		},
		{
			name: 'docs:test',
			action: makeTestAction
		},
		{
			name: 'docs:clean',
			action: makeCleanAction
		}
	]
};
