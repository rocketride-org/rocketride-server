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
 * vcpkg Build Module
 *
 * Handles downloading and bootstrapping vcpkg.
 */
const os = require('os');
const path = require('path');
const { glob } = require('glob');
const {
	withLock,
	getState,
	setState,
	execCommand,
	removeDirs,
	PROJECT_ROOT,
	BUILD_ROOT,
	exists,
	readJson,
	mkdir,
	getExecName,
	isWindows,
	isMac,
	isLinux,
} = require('../../../scripts/lib');

// Paths
const VCPKG_DIR = path.join(BUILD_ROOT, 'vcpkg');
const VCPKG_BOOTSTRAP_SCRIPT = path.join(VCPKG_DIR, isWindows() ? 'bootstrap-vcpkg' : 'bootstrap-vcpkg.sh');
const VCPKG_EXECUTABLE = path.join(VCPKG_DIR, getExecName('vcpkg'));
const VCPKG_INSTALLED_ROOT = path.join(BUILD_ROOT, 'vcpkg_installed');

// Read vcpkg version from package.json (loaded async in tasks)
let VCPKG_VERSION = null;

async function getVcpkgVersion() {
	if (!VCPKG_VERSION) {
		const packageJson = await readJson(path.join(PROJECT_ROOT, 'package.json'));
		VCPKG_VERSION = packageJson.vcpkg?.version || '2024.11.16';
	}
	return VCPKG_VERSION;
}

const VCPKG_REPO = 'https://github.com/microsoft/vcpkg.git';

// =============================================================================
// Helpers
// =============================================================================

function getVcpkgTriplet(options = {}) {
	const arch = options.arch || os.arch();
	if (isWindows()) return 'x64-windows-msvc-rocketride';
	if (isLinux()) return 'x64-linux-clang-rocketride';
	if (isMac()) return arch === 'arm64' ? 'arm64-osx-appleclang-rocketride' : 'x64-osx-appleclang-rocketride';
	throw new Error('Unsupported platform');
}

async function getVcpkgInstalledDir(options = {}) {
	return path.join(VCPKG_INSTALLED_ROOT, getVcpkgTriplet(options));
}

async function getPythonVersion() {
	let pythonVersion = await getState('vcpkg.pythonVersion');
	if (pythonVersion !== undefined) return pythonVersion;

	const vcpkgJsonPath = path.join(VCPKG_DIR, 'ports', 'python3', 'vcpkg.json');
	if (!(await exists(vcpkgJsonPath))) throw new Error('Python port not found');

	const vcpkgJson = await readJson(vcpkgJsonPath);
	if (!vcpkgJson || !vcpkgJson.version) throw new Error(`Python version not found in ${vcpkgJsonPath}`);

	// Get major.minor from manifest version (e.g., "3.12.9" -> "3.12")
	const match = /^(\d+\.\d+)/.exec(vcpkgJson.version);
	if (!match) throw new Error(`Unexpected Python version format: ${vcpkgJson.version}`);

	pythonVersion = match[1];
	await setState('vcpkg.pythonVersion', pythonVersion);
	return pythonVersion;
}

async function getPatchelf() {
	const [vcpkgPatchelf] = await glob('downloads/tools/patchelf/*/bin/patchelf', { cwd: VCPKG_DIR, absolute: true });
	return vcpkgPatchelf ?? 'patchelf';
}

function getVcpkgEnv(baseEnv = process.env) {
	return { ...baseEnv, VCPKG_ROOT: VCPKG_DIR };
}

/**
 * The -D flags a CMake project needs to build against our vcpkg.
 *
 * @param {object} options
 *   overlayPorts    - the consumer's overlay ports directory
 *   overlayTriplets - the consumer's overlay triplets directory
 *   arch            - target architecture, for the triplet
 *   manifest        - true installs from the project's vcpkg.json (the server);
 *                     false consumes the already installed tree (a node)
 */
function getVcpkgCmakeArgs(options = {}) {
	const triplet = getVcpkgTriplet(options);
	const args = [
		`-DCMAKE_TOOLCHAIN_FILE=${path.join(VCPKG_DIR, 'scripts', 'buildsystems', 'vcpkg.cmake')}`,
		`-DVCPKG_TARGET_TRIPLET=${triplet}`,
		`-DVCPKG_HOST_TRIPLET=${triplet}`,
	];

	if (options.overlayPorts) args.push(`-DVCPKG_OVERLAY_PORTS=${options.overlayPorts}`);
	if (options.overlayTriplets) args.push(`-DVCPKG_OVERLAY_TRIPLETS=${options.overlayTriplets}`);

	if (options.manifest === false) {
		args.push(`-DVCPKG_INSTALLED_DIR=${VCPKG_INSTALLED_ROOT}`, '-DVCPKG_MANIFEST_MODE=OFF');
		return args;
	}

	// Opt-in (CI / small-disk hosts): drop each port's buildtree + package
	// staging right after it builds so peak disk stays low across the whole
	// from-source build. Without it, the final link accumulates every port's
	// scratch and can run out of disk on a small runner ("final link failed:
	// No space left"). Off by default so local rebuilds keep their buildtrees.
	if (process.env.VCPKG_CLEAN_AFTER_BUILD === '1') {
		args.push('-DVCPKG_INSTALL_OPTIONS=--clean-buildtrees-after-build;--clean-packages-after-build');
	}

	return args;
}

// =============================================================================
// Action Factories
// =============================================================================

function makeCloneVcpkgAction(options = {}) {
	return {
		locks: ['vcpkg'],
		outputLines: 1,
		run: async (ctx, task) => {
			const version = await getVcpkgVersion();
			const vcpkgVersion = await getState('vcpkg.version');

			// Skip if already cloned
			if (!options.force && (await exists(path.join(VCPKG_DIR, '.git'))) && vcpkgVersion === version) {
				task.output = `v${version} already cloned`;
				return;
			}

			task.output = `Cloning v${version}...`;

			await withLock('vcpkg-clone', async () => {
				await removeDirs([VCPKG_DIR, VCPKG_INSTALLED_ROOT]);
				await mkdir(BUILD_ROOT);

				try {
					await execCommand('git', ['clone', '--depth', '1', '--branch', version, VCPKG_REPO, VCPKG_DIR], {
						task,
					});
				} catch {
					// Fallback: clone without depth and checkout
					await execCommand('git', ['clone', '--depth', '100', VCPKG_REPO, VCPKG_DIR], { task });
					await execCommand('git', ['checkout', version], { cwd: VCPKG_DIR, task });
				}

				await setState('vcpkg.state', 'cloned');
				await setState('vcpkg.version', version);
			});

			task.output = `Cloned v${version}`;
		},
	};
}

function makeBootstrapVcpkgAction(options = {}) {
	return {
		locks: ['vcpkg'],
		run: async (ctx, task) => {
			const vcpkgState = await getState('vcpkg.state');

			// Skip if already bootstrapped
			if (!options.force && vcpkgState === 'bootstrapped' && (await exists(VCPKG_EXECUTABLE))) {
				task.output = 'Already bootstrapped';
				return;
			}

			task.output = 'Bootstrapping...';

			await withLock('vcpkg-bootstrap', async () => {
				await execCommand(VCPKG_BOOTSTRAP_SCRIPT, ['-disableMetrics'], { cwd: VCPKG_DIR, task });
				await execCommand(VCPKG_EXECUTABLE, ['--version'], { cwd: VCPKG_DIR, task });
				await setState('vcpkg.state', 'bootstrapped');
			});

			task.output = 'Bootstrapped';
		},
	};
}

// =============================================================================
// Module Definition
// =============================================================================

module.exports = {
	name: 'vcpkg',
	description: 'C++ Package Manager',

	actions: [
		// Internal actions
		{ name: 'vcpkg:clone', action: makeCloneVcpkgAction },
		{ name: 'vcpkg:bootstrap', action: makeBootstrapVcpkgAction },

		// Submodule actions (called by server:build-core / server:clean-all)
		{
			name: 'vcpkg:submodule-build',
			action: () => ({
				steps: ['vcpkg:clone', 'vcpkg:bootstrap'],
			}),
		},
		{
			name: 'vcpkg:submodule-clean',
			action: () => ({
				run: async (ctx, task) => {
					await withLock('vcpkg-setup', async () => {
						await removeDirs([VCPKG_DIR, VCPKG_INSTALLED_ROOT]);
						await setState('vcpkg.state', null);
						await setState('vcpkg.version', null);
					});
					task.output = 'Cleaned vcpkg';
				},
			}),
		},
	],
};

// Export for direct use
module.exports.VCPKG_DIR = VCPKG_DIR;
module.exports.getVcpkgVersion = getVcpkgVersion;
module.exports.getVcpkgTriplet = getVcpkgTriplet;
module.exports.getVcpkgInstalledDir = getVcpkgInstalledDir;
module.exports.getVcpkgEnv = getVcpkgEnv;
module.exports.getVcpkgCmakeArgs = getVcpkgCmakeArgs;
module.exports.getPythonVersion = getPythonVersion;
module.exports.getPatchelf = getPatchelf;
