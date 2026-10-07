/**
 * Shared Toolchain Utilities
 *
 * The C/C++ build environment a native build runs in: the Visual Studio
 * installation on Windows, the LLVM overlay on Linux. server:setup-tools
 * discovers it and writes the build.* state these read.
 */
const os = require('os');
const path = require('path');
const { getState } = require('./state');
const { exists } = require('./fs');
const { isWindows, isLinux } = require('./platform');

let windowsToolchainCache = null;
let vsEnvCache = null;
let llvmOverlayLogged = false;
let dumpSymsWarned = false;

async function getWindowsToolchain() {
	if (windowsToolchainCache) return windowsToolchainCache;
	const vsRoot = await getState('build.vsPath');
	if (!vsRoot || !(await exists(vsRoot))) {
		throw new Error(
			'Visual Studio build path not set. ' +
				'Run server:setup-tools first (e.g. run builder server:setup-tools --autoinstall).'
		);
	}
	const ninjaPath = path.join(
		vsRoot,
		'Common7',
		'IDE',
		'CommonExtensions',
		'Microsoft',
		'CMake',
		'Ninja',
		'ninja.exe'
	);
	const ninjaExists = await exists(ninjaPath);
	const generatorName = (await getState('build.generatorName')) || 'Visual Studio 17 2022';
	windowsToolchainCache = { vsRoot, ninjaPath: ninjaExists ? ninjaPath : null, generatorName };
	return windowsToolchainCache;
}

async function getVsEnvironment() {
	if (vsEnvCache) return vsEnvCache;
	if (!isWindows()) return process.env;
	const buildEnv = await getState('build.env');
	if (!buildEnv || typeof buildEnv !== 'object' || Object.keys(buildEnv).length === 0) {
		throw new Error(
			'Visual Studio environment not in state. ' +
				'Run server:setup-tools first (e.g. run builder server:setup-tools --autoinstall).'
		);
	}
	vsEnvCache = { ...process.env, ...buildEnv };
	return vsEnvCache;
}

// Invoking user's home — resolve SUDO_USER so a sudo build finds the toolchain the
// installer placed in the real user's home, not /root.
function invokingHome() {
	const su = process.env.SUDO_USER;
	if (su && su !== 'root') {
		try {
			const line = require('fs')
				.readFileSync('/etc/passwd', 'utf8')
				.split('\n')
				.find((l) => l.startsWith(`${su}:`));
			if (line && line.split(':')[5]) return line.split(':')[5];
		} catch {
			/* fall back to os.homedir() */
		}
	}
	return os.homedir();
}

// LLVM toolchain env overlay (Fedora fallback in ~/toolchains/llvm-18), or null.
async function llvmToolchainOverlay() {
	if (!isLinux()) return null;
	const root = path.join(invokingHome(), 'toolchains', 'llvm-18');
	if (!(await exists(path.join(root, 'bin', 'clang++')))) return null;
	const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-gnu`;
	const joinp = (...p) => p.filter(Boolean).join(path.delimiter);
	return {
		LLVM18: root,
		PATH: joinp(path.join(root, 'bin'), process.env.PATH),
		CC: path.join(root, 'bin', 'clang'),
		CXX: path.join(root, 'bin', 'clang++'),
		LD_LIBRARY_PATH: joinp(
			path.join(root, 'lib-compat'),
			path.join(root, 'lib', triple),
			process.env.LD_LIBRARY_PATH
		),
	};
}

// Always warn (once) if dump_syms isn't on the build PATH — shipped builds get no symbols.
async function warnIfNoDumpSyms(env) {
	if (isWindows() || dumpSymsWarned) return;
	for (const d of (env.PATH || '').split(path.delimiter)) {
		if (d && (await exists(path.join(d, 'dump_syms')))) return;
	}
	dumpSymsWarned = true;
	console.warn(
		'WARNING: dump_syms not found — crash symbols will NOT be generated (run with --autoinstall to fetch it).'
	);
}

// Build-tool env: VS env on Windows; on Linux the LLVM overlay (tarball) + ~/toolchains/bin.
async function getBuildBaseEnv(task) {
	if (isWindows()) return await getVsEnvironment();
	const overlay = await llvmToolchainOverlay();
	const toolsBin = path.join(invokingHome(), 'toolchains', 'bin');
	const hasTools = await exists(toolsBin);
	const env = { ...process.env, ...(overlay || {}) };
	if (hasTools) env.PATH = [toolsBin, env.PATH].filter(Boolean).join(path.delimiter);
	// System-clang case (no tarball overlay): point vcpkg's compiler detection at
	// clang, not the distro default cc (gcc).
	if (isLinux() && !overlay) {
		env.CC = env.CC || 'clang';
		env.CXX = env.CXX || 'clang++';
	}
	if (!llvmOverlayLogged && (overlay || hasTools)) {
		const bits = [];
		if (overlay) bits.push(`LLVM ${overlay.LLVM18}`);
		if (hasTools) bits.push(`tools ${toolsBin}`);
		const msg = `Using local build env (${bits.join(', ')})`;
		if (task) task.output = msg;
		else console.log(msg);
		llvmOverlayLogged = true;
	}
	await warnIfNoDumpSyms(env);
	return env;
}

module.exports = {
	getWindowsToolchain,
	getVsEnvironment,
	invokingHome,
	llvmToolchainOverlay,
	getBuildBaseEnv,
};
