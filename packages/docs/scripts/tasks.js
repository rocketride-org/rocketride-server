/**
 * Docs Build Module
 *
 * Co-located documentation site. Discovered by the build orchestrator at
 * packages/docs/scripts/tasks.js; exposes `docs:build` (gather -> index ->
 * compile), `docs:dev`, and `docs:clean`. Bare `builder build` includes
 * docs:build via global-command expansion because it carries a description.
 */
const path = require('path');
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

// Preview the built static site. docusaurus serve defaults to packages/docs/build,
// but the pipeline emits to SITE_OUT (dist/docs), so point --dir there.
function makeServeAction() {
	return {
		description: 'Serve built docs',
		run: async (ctx, task) => {
			await execCommand('pnpm', ['exec', 'docusaurus', 'serve', '--dir', SITE_OUT, '--port', '3000'], { task, cwd: DOCS_DIR, stdio: 'inherit' });
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

		// Public actions (have descriptions)
		{
			name: 'docs:build',
			action: () => ({
				description: 'Build docs',
				steps: [parallel(DOC_GENERATORS, 'Generate reference docs'), 'docs:gather', 'docs:index', 'docs:compile']
			})
		},
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
			name: 'docs:clean',
			action: makeCleanAction
		}
	]
};
