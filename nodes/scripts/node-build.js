// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * How a C++ node is built
 *
 * One node, one builder module: `<node>:build` compiles it against the engine
 * and stages its library, so a node can be developed on its own. This is the
 * JS side of cmake's rocketride_add_node - a node's tasks.js says which node it
 * is and nothing more, and `makeNodeModule` supplies the rest.
 */
const path = require('path');
const crypto = require('crypto');
const {
	exists,
	readFile,
	readDirSafe,
	readJson,
	syncFile,
	cachedContentHash,
	getState,
	setState,
	getSharedName,
	getSymName,
	execCommand,
	getBuildBaseEnv,
	formatSyncStats,
	PROJECT_ROOT,
	BUILD_ROOT,
	DIST_ROOT,
	OVERLAY_ROOT,
} = require('../../scripts/lib');
const cmake = require('../../scripts/lib/cmake');
const vcpkg = require('../../packages/vcpkg/scripts/tasks');

/** The cmake a c++ node is built by (rocketride-node.cmake and what it includes) */
const SERVER_CMAKE_DIR = path.join(PROJECT_ROOT, 'packages', 'server', 'cmake');

/** Where cmake leaves the c++ node binaries */
const BUILD_NODES_DIR = path.join(BUILD_ROOT, 'nodes');

/** Where the engine loads a node from */
const DIST_NODES_DIR = path.join(DIST_ROOT, 'server', 'nodes');

/**
 * In a node's directory, but never a source of its library: docs, assets, and
 * the target/ an IDE builds a node's pom into
 */
const EXCLUDE_SOURCES = ['target', 'README.md', '.svg'];

// =============================================================================
// Module Factory
// =============================================================================

/**
 * A builder module for one C++ node: `<node>:build` is the whole development
 * cycle for it, and the steps are separately runnable.
 *
 * `extraSteps` lets a node that builds more than a library - parse, with its
 * java one - add its own, keeping this module's shape.
 */
function makeNodeModule({ name, srcDir, description, extraSteps = [] }) {
	return {
		name,
		description: description || `C++ Node (${name})`,

		actions: [
			// Internal actions
			{ name: `${name}:compile`, action: (options) => makeCompileNodeAction({ name, srcDir }, options) },
			{ name: `${name}:stage`, action: () => makeStageNodeAction({ name, srcDir }) },

			// Public actions (have descriptions)
			{
				name: `${name}:build`,
				action: () => ({
					description: `Build node ${name}`,
					steps: [
						'vcpkg:submodule-build',
						'java:setup-jdk',
						'server:build-core',
						`${name}:compile`,
						`${name}:stage`,
						...extraSteps,
					],
				}),
			},
		],
	};
}

// =============================================================================
// Action Factories
// =============================================================================

/** Configures the node's own CMake project and builds its library */
function makeCompileNodeAction(node, options = {}) {
	return {
		locks: ['cmake'],
		run: async (ctx, task) => {
			// The manifest, the ports and the triplets defined by the server
			const { VCPKG_DIRS } = require('../../packages/server/scripts/tasks');

			const { name, srcDir } = node;
			const nodeDir = path.join(srcDir, name);
			const cmakeConfig = options.cmakeConfig || 'Release';
			const nodeBuildDir = path.join(BUILD_NODES_DIR, name);

			const triplet = vcpkg.getVcpkgTriplet(options);

			task.output = `Computing ${name} source hash...`;
			const srcHash = await nodeSourceHash(name, nodeDir, triplet);
			const configured = await isNodeConfigured(nodeBuildDir, cmakeConfig, triplet);

			if (!options.force && (await builtAlready(name, nodeDir, srcHash, cmakeConfig, configured))) {
				task.output = 'Up to date';
				return;
			}

			const env = vcpkg.getVcpkgEnv(await getBuildBaseEnv(task));

			if (options.force || !configured) {
				task.output = `Configuring ${name}...`;
				const configureArgs = [
					...(await cmake.getConfigureArgs(nodeDir, nodeBuildDir, cmakeConfig)),
					// Pass the server-defined manifest and overlays dirs
					...vcpkg.getVcpkgCmakeArgs({ ...options, ...VCPKG_DIRS }),
					`-DROCKETRIDE_PACKAGES_DIR=${path.join(PROJECT_ROOT, 'packages')}`,
					`-DROCKETRIDE_SERVER_BUILD_DIR=${BUILD_ROOT}`,
				];
				if (OVERLAY_ROOT) {
					configureArgs.push(`-DROCKETRIDE_OVERLAY_ROOT=${OVERLAY_ROOT}`);
				}
				await execCommand('cmake', configureArgs, { task, env, verbose: options.verbose });
			}

			task.output = `Building ${name}...`;
			await execCommand('cmake', cmake.getBuildArgs(nodeBuildDir, cmakeConfig), {
				task,
				env,
				verbose: options.verbose,
			});

			// Store build info
			await setState(`nodes.${name}.buildHash`, srcHash);
			await setState(`nodes.${name}.buildType`, cmakeConfig);
			await setState(`nodes.${name}.from`, 'local');
			ctx[`${name}.compiled`] = true;
			task.output = `Built ${name}`;
		},
	};
}

/**
 * Puts the library this build tree holds beside the node's own files in the
 * dist, where the engine loads it from. The node's sources are staged by
 * nodes:sync, with every other node's - this is the one artifact a standalone
 * node build produces.
 */
function makeStageNodeAction(node) {
	return {
		run: async (ctx, task) => {
			const { name, srcDir } = node;
			task.output = await stageNodeLibrary(name, path.join(srcDir, name));
		},
	};
}

/**
 * Stages what this build tree holds, and only that: a library a distribution
 * shipped is the one to keep, since a build tree left from an earlier compile
 * is not this engine's. Returns what the caller reports.
 */
async function stageNodeLibrary(name, nodeDir, stats = {}) {
	if ((await getState(`nodes.${name}.from`)) !== 'local') return 'Shipped with the server';

	const lib = await nodeLibrary(name, nodeDir);
	if (!lib) return 'Nothing to stage';

	for (const file of libraryFiles(lib)) {
		const built = path.join(BUILD_NODES_DIR, name, file);
		if (!(await exists(built))) continue;

		await syncFile(built, path.join(DIST_NODES_DIR, name, file), { package: true }, stats);
	}

	return formatSyncStats(stats);
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * The library a node's services*.json name, or null for one that names none.
 * The node builds exactly one, which several services may share, so they are
 * read as a group.
 */
async function nodeLibrary(name, srcDir) {
	const libs = new Set();

	for (const file of await readDirSafe(srcDir)) {
		if (!/^services.*\.json$/.test(file)) continue;

		const services = await readJson(path.join(srcDir, file));
		if (services.node !== 'cpp') continue;

		if (typeof services.path !== 'string' || !services.path)
			throw new Error(`${path.join(srcDir, file)}: ` + 'a cpp service needs a library name in "path"');

		libs.add(services.path);
	}

	if (libs.size > 1) throw new Error(`The node ${name} names more than one library: ` + [...libs].join(', '));

	return libs.values().next().value ?? null;
}

/**
 * What a node's library is built from: its own sources, the cmake that builds
 * it, the engine whose ABI it imports, and the target it is built for.
 *
 * Content, not timestamps, so the value means the same on every machine - a
 * distribution publishes it (see server:download) and a node can tell whether
 * the library that came with one was built from the sources it has.
 */
async function nodeSourceHash(name, nodeDir, triplet) {
	const [nodeHash, cmakeHash, engineHash] = await Promise.all([
		cachedContentHash(nodeDir, `nodes.${name}.sourceHash`, { exclude: EXCLUDE_SOURCES }),
		cachedContentHash(SERVER_CMAKE_DIR, 'server.cmakeHash'),
		getState('server.buildHash'),
	]);

	return crypto.createHash('sha256').update(`${nodeHash}:${cmakeHash}:${engineHash}:${triplet}`).digest('hex');
}

/**
 * A node's build tree is configured for one build type and one target, and
 * CMake records both - a reconfigure is only needed when either changes.
 */
async function isNodeConfigured(nodeBuildDir, cmakeConfig, triplet) {
	const cachePath = path.join(nodeBuildDir, 'CMakeCache.txt');
	if (!(await exists(cachePath))) return false;

	const cache = await readFile(cachePath, 'utf8');
	const cached = (entry, value) => new RegExp(`^${entry}:\\w+=${value}$`, 'm').test(cache);

	return cached('CMAKE_BUILD_TYPE', cmakeConfig) && cached('VCPKG_TARGET_TRIPLET', triplet);
}

/** The library files a built node leaves behind, the symbols one included */
function libraryFiles(lib) {
	return [getSharedName(lib), getSymName(lib)].filter(Boolean);
}

/**
 * Whether a library built from these sources is already to hand - this build
 * tree's, or the one a distribution shipped, which needs no compiler to use.
 */
async function builtAlready(name, srcDir, srcHash, cmakeConfig, configured) {
	if (srcHash !== (await getState(`nodes.${name}.buildHash`))) return false;

	const lib = await nodeLibrary(name, srcDir);
	if (!lib) return true;

	if ((await getState(`nodes.${name}.buildType`)) !== cmakeConfig) return false;

	if ((await getState(`nodes.${name}.from`)) !== 'local') {
		return exists(path.join(DIST_NODES_DIR, name, getSharedName(lib)));
	}

	const built = path.join(BUILD_NODES_DIR, name, getSharedName(lib));
	const shipped = path.join(DIST_NODES_DIR, name, getSharedName(lib));
	return (configured && (await exists(built))) || (await exists(shipped));
}

module.exports = {
	SERVER_CMAKE_DIR,
	BUILD_NODES_DIR,
	DIST_NODES_DIR,
	nodeLibrary,
	libraryFiles,
	stageNodeLibrary,
	nodeSourceHash,
	isNodeConfigured,
	makeNodeModule,
};
