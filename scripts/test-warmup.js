/**
 * Test warm-up module
 *
 * warmup:test-deps installs what the test suites would otherwise install while
 * they run, once, before they start in parallel. It lives outside packages/server
 * so that changing it leaves the server's content hash, and with it the engine a
 * build downloads, untouched.
 */
const path = require('path');
const { glob } = require('glob');
const { parallel, execCommand } = require('./lib');
const paths = require('./lib/paths');

// Each suite's own test requirements (ai:run-pytest, client-python:setup-test-deps,
// nodes:install-test-deps), as globs from the repo root.
const TEST_HARNESS_GLOBS = ['packages/*/tests/requirements*.txt', 'nodes/test/requirements*.txt'];

// The requirement files the test engines load at startup, as globs from the repo
// root: rocketlib, every ai requirements file, and the nodes base file. The model
// folders stay out: they hold torch, transformers, whisper and the like, which
// only a test that loads a model installs. The engines load these packages from
// their source paths, and a satisfied verdict is kept per absolute path, so these
// are the paths to warm.
const TEST_STARTUP_GLOBS = [
	'packages/server/engine-lib/rocketlib-python/lib/rocketlib/requirements*.txt',
	'packages/ai/src/ai/**/requirements*.txt',
	'nodes/src/nodes/requirements*.txt',
];
const TEST_STARTUP_IGNORE = [
	'packages/ai/src/ai/common/models/**',
	'packages/ai/src/ai/common/torch/**',
	'**/node_modules/**',
];

/**
 * Absolute paths of the files the globs match, in import order.
 *
 * Each glob's matches are sorted by folder, then by name: a package's file comes
 * before its subpackages' files, and opencv's requirements_1.txt before its
 * requirements_2.txt, the order the imports install them in.
 *
 * @param {string[]} patterns - Globs relative to the repo root
 * @param {string[]} [ignore] - Globs to leave out
 * @returns {Promise<string[]>} Matching files
 */
async function requirementFiles(patterns, ignore = []) {
	const byFolderThenName = (a, b) =>
		path.dirname(a).localeCompare(path.dirname(b)) || path.basename(a).localeCompare(path.basename(b));
	const files = [];
	for (const pattern of patterns) {
		const matches = await glob(pattern, { cwd: paths.PROJECT_ROOT, absolute: true, nodir: true, ignore });
		files.push(...matches.sort(byFolderThenName));
	}
	return files;
}

/**
 * Install requirement files through depends(), one engine process per pass.
 *
 * Each install leaves the satisfied verdicts recorded before it stale, so a second
 * pass resolves those files again and records them against the final installed
 * set. It runs in a new process because depends() skips files it already handled.
 * The engine is the one in DIST_ROOT, read at run time so an overlay build's
 * --overlay-root is already applied.
 *
 * @param {object} task - Builder task, for output
 * @param {string[]} files - Requirement files, in install order
 * @param {number} passes - 1 to install, 2 to also refresh the verdicts
 */
async function installRequirementFiles(task, files, passes) {
	const distDir = path.join(paths.DIST_ROOT, 'server');
	const unique = [...new Set(files.map((file) => path.resolve(file)))];
	const script =
		'import os, sys; from depends import depends; ' + '[depends(os.path.realpath(p)) for p in sys.argv[1:]]';
	for (let pass = 1; pass <= passes; pass++) {
		task.output = `Installing ${unique.length} requirement files, pass ${pass} of ${passes}...`;
		await execCommand(path.join(distDir, 'engine'), ['-c', script, ...unique], { task, cwd: distDir });
	}
}

// Every suite that starts an engine lists warmup:test-deps; the runner runs a
// named step once and the other suites wait for it. An install changes the
// installed set, and that makes every recorded satisfied verdict stale, so an
// install during the suites sends each engine process back to resolving under the
// engine-global install.lock, one process at a time. With everything installed up
// front, a process holds the lock only long enough to read its verdict. The node
// files come from nodes:list-test-requirements, so they are the nodes the
// selected tests load; that collection imports the test harness, so the harness
// installs first. stopServer() names any requirement file that still installed
// during a run.
function makeWarmTestDepsAction() {
	return {
		description: 'Install the test suites requirements before they start',
		steps: [
			parallel(['nodes:build', 'ai:build'], 'Build dependencies'),
			{
				name: 'warmup:test-harness',
				action: {
					run: async (ctx, task) =>
						installRequirementFiles(task, await requirementFiles(TEST_HARNESS_GLOBS), 1),
				},
			},
			'nodes:list-test-requirements',
			{
				name: 'warmup:test-deps-install',
				action: {
					run: async (ctx, task) => {
						const files = [
							...(await requirementFiles(TEST_STARTUP_GLOBS, TEST_STARTUP_IGNORE)),
							...(ctx.nodeTestRequirements || []),
							...(await requirementFiles(TEST_HARNESS_GLOBS)),
						];
						await installRequirementFiles(task, files, 2);
					},
				},
			},
		],
	};
}

module.exports = {
	name: 'warmup',
	description: 'Test suite warm-up',

	actions: [{ name: 'warmup:test-deps', action: makeWarmTestDepsAction }],
};
