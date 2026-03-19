/**
 * Windows compiler toolchain setup (Visual Studio C++ + ATL).
 * Used only when the engine must be compiled from source (pre-built binaries not available).
 * Finds or installs VS Build Tools, verifies vsvars, captures environment.
 * Saves build.vsPath, build.env, build.generatorName, build.setupAt to state so server tasks
 * use state only (no vswhere/vsvars in tasks).
 *
 * Call from server:setup-tools (Windows):
 *   const { runCompilerWindowsSetup } = require('../../../scripts/compiler-windows');
 *   const { vsPath, env, setupAt } = await runCompilerWindowsSetup({ autoinstall, onOutput });
 *
 * Integrated module only; not intended to be run from the shell.
 */
const path = require('path');
const fs = require('fs');
const { execCommand } = require('./lib/exec');
const { downloadFile } = require('./lib/download');
const { getState, setState } = require('./lib/state');

const PROJECT_ROOT = path.join(__dirname, '..');
const ProgramFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const VSWHERE = path.join(ProgramFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');

// Detection uses component IDs (vswhere -requires). Install uses workload + components:
// we add the workload Microsoft.VisualStudio.Workload.VCTools (Desktop development with C++)
// and optionally --add individual components (ATL, CMake). VC.CoreBuildTools is required by
// the workload so we don't add it explicitly; we use it for detection (reliable; VC.Tools.x86.x64
// often not reported for Build Tools per vswhere #320).
// Full VS (Enterprise/Community/Professional) uses VC.CoreIde for C++ in "Desktop development with C++",
// not VC.CoreBuildTools (that ID is only in the Build Tools product catalog). So we accept either.
const VS_REQUIRES_CPP = 'Microsoft.VisualStudio.Component.VC.CoreBuildTools';
const VS_REQUIRES_CPP_IDE = 'Microsoft.VisualStudio.Component.VC.CoreIde'; // full VS IDE C++ workload
const VS_REQUIRES_ATL = 'Microsoft.VisualStudio.Component.VC.ATL';
const VS_REQUIRES_CMAKENINJA = 'Microsoft.VisualStudio.Component.VC.CMake.Project';

const VS_BUILDTOOLS_URL = 'https://aka.ms/vs/17/release/vs_buildtools.exe';

/** CMake generator names by VS installation version (major). */
const VS_GENERATOR_BY_MAJOR = {
	15: 'Visual Studio 15 2017',
	16: 'Visual Studio 16 2019',
	17: 'Visual Studio 17 2022',
	18: 'Visual Studio 18 2026',
};

async function runVswhere(args) {
	if (!fs.existsSync(VSWHERE)) return null;
	try {
		const out = await execCommand(VSWHERE, args, { collect: true });
		const p = (out || '').trim();
		return p || null;
	} catch {
		return null;
	}
}

/** Returns VS installation path only if all required components are present: (CoreIde OR CoreBuildTools) AND ATL AND CMake.Project; otherwise null.
 * Accepts either VC.CoreBuildTools (Build Tools) or VC.CoreIde (full VS IDE), since the full IDE does not
 * register VC.CoreBuildTools in its catalog (see VS2019 Enterprise workload-component-id-vs-enterprise). */
async function getVsInstalled() {
	const commonArgs = ['-products', '*', '-all', '-latest', '-requires', VS_REQUIRES_ATL, '-requires', VS_REQUIRES_CMAKENINJA, '-property', 'installationPath'];
	for (const cppComponent of [VS_REQUIRES_CPP, VS_REQUIRES_CPP_IDE]) {
		const p = await runVswhere([...commonArgs, '-requires', cppComponent]);
		if (p) return p;
	}
	return null;
}

async function verifyVsvars(vsRoot) {
	const vcvars = path.join(vsRoot, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
	const vsDevCmd = path.join(vsRoot, 'Common7', 'Tools', 'VsDevCmd.bat');
	let batch = null;
	let batchArgs = '';
	if (fs.existsSync(vcvars)) {
		batch = vcvars;
	} else if (fs.existsSync(vsDevCmd)) {
		batch = vsDevCmd;
		batchArgs = ' -arch=amd64';
	}
	if (!batch) return false;
	// Use ""path"" so when OS quotes the whole /c argument, inner "" becomes one " and path stays one token
	const quotedBatch = batch.indexOf(' ') >= 0 ? `""${batch.replace(/"/g, '""')}""` : batch;
	const cmd = `call ${quotedBatch}${batchArgs} >nul 2>&1 & exit 0`;
	try {
		await execCommand('cmd', ['/c', cmd], { cwd: PROJECT_ROOT, collect: true });
		return true;
	} catch {
		return false;
	}
}

/** Return only env vars that are new or changed compared to base (default process.env). Used to store a minimal overlay in state. */
function envDiff(captured, base = process.env) {
	const out = {};
	for (const [k, v] of Object.entries(captured)) {
		if (v !== base[k]) out[k] = v;
	}
	return out;
}

/** Run vsvars.cmd (calls VS batch then SET); parse SET output into env object. Returns null on failure. */
async function captureVsEnvironment(vsRoot, options = {}) {
	const { verbose = false, onOutput = null } = options;
	const vsvarsPath = path.join(PROJECT_ROOT, 'scripts', 'vsvars.cmd');
	if (!fs.existsSync(vsvarsPath)) return null;

	try {
		const result = await execCommand(vsvarsPath, [vsRoot], { cwd: PROJECT_ROOT, collect: true, verbose, onOutput });
		const env = {};
		for (const line of (result || '').split(/\r?\n/)) {
			const idx = line.indexOf('=');
			if (idx > 0) {
				const key = line.substring(0, idx).trim();
				const value = line.substring(idx + 1).trim();
				if (key) env[key] = value;
			}
		}
		const hasVsEnv = (env.INCLUDE && (env.INCLUDE.includes('VC') || env.INCLUDE.includes('Windows'))) || (env.LIB && env.LIB.includes('VC'));
		if (!hasVsEnv) return null;
		return envDiff(env);
	} catch {
		return null;
	}
}

/** Get CMake generator name for this VS installation (e.g. "Visual Studio 17 2022"). */
async function getGeneratorName(vsRoot) {
	const ver = await runVswhere(['-path', vsRoot, '-property', 'installationVersion']);
	if (!ver) return 'Visual Studio 17 2022';
	const major = parseInt(ver.trim().split('.')[0], 10);
	if (!Number.isNaN(major) && VS_GENERATOR_BY_MAJOR[major]) return VS_GENERATOR_BY_MAJOR[major];
	if (!Number.isNaN(major) && major > 20) return `Visual Studio ${major} ${2028 + (major - 20)}`;
	return 'Visual Studio 17 2022';
}

async function installVs(log) {
	try {
		log.info('Downloading Visual Studio Build Tools bootstrapper...');
		const bootstrapperPath = await downloadFile(VS_BUILDTOOLS_URL, 'vs_buildtools.exe', null);
		log.info('Installing Visual Studio 2022 Build Tools (C++ + ATL + CMake/Ninja). This can take 10–20 minutes.');
		await execCommand(
			bootstrapperPath,
			[
				'--quiet',
				'--wait',
				'--add',
				'Microsoft.VisualStudio.Workload.VCTools', // install by workload; detection uses components above
				'--includeRecommended',
				'--add',
				VS_REQUIRES_ATL,
				'--add',
				VS_REQUIRES_CMAKENINJA,
			],
			{ cwd: PROJECT_ROOT, stdio: 'ignore' }
		);
	} catch {
		log.fail('VS Build Tools install failed. If a reboot was requested, reboot and run the builder again.');
		return false;
	}
	return true;
}

/**
 * Run Windows compiler toolchain setup. Call only when the engine
 * must be compiled from source (e.g. after determining pre-built binaries are not available).
 * Saves build.vsPath, build.env, build.generatorName, build.setupAt to state and returns them.
 *
 * @param {Object} options
 * @param {boolean} [options.autoinstall] - If true, install VS Build Tools (download vs_buildtools.exe and run) when not found.
 * @param {function(string)} [options.onOutput] - Called for each output line; if omitted, uses console.log.
 * @returns {Promise<{ vsPath: string, env: Object, setupAt: string }>} Resolves with vsPath, env, and setupAt (ISO date); throws on failure.
 */
async function runCompilerWindowsSetup(options = {}) {
	const { autoinstall = false, onOutput = null, verbose = false } = options;
	const out = (line) => (onOutput ? onOutput(line) : console.log(line));
	const log = {
		ok: (msg) => out('[OK] ' + msg),
		fail: (msg) => out('[X] ' + msg),
		info: (msg) => out('[ ] ' + msg),
	};

	const setupAt = new Date().toISOString();

	let vsRoot = await getState('build.vsPath');
	if (vsRoot && fs.existsSync(vsRoot)) {
		if (!(await verifyVsvars(vsRoot))) {
			log.fail('Visual Studio environment setup failed (vsvars).');
			throw new Error('Visual Studio environment setup failed (vsvars).');
		}
		log.ok('Visual Studio');
		let env = await getState('build.env');
		if (!env || typeof env !== 'object' || Object.keys(env).length === 0) {
			env = await captureVsEnvironment(vsRoot, { verbose, onOutput });
			if (env) await setState('build.env', env);
		}
		let generatorName = await getState('build.generatorName');
		if (!generatorName) {
			generatorName = await getGeneratorName(vsRoot);
			await setState('build.generatorName', generatorName);
		}
		const completedAt = (await getState('build.setupAt')) || setupAt;
		return { vsPath: vsRoot, env: env || {}, setupAt: completedAt };
	}

	vsRoot = await getVsInstalled();
	if (!vsRoot) {
		if (autoinstall) {
			try {
				await installVs(log);
			} catch {
				// Installer may return non-zero even when install succeeded (e.g. reboot recommended)
			}
			vsRoot = await getVsInstalled();
		}
		if (!vsRoot) {
			log.fail('Visual Studio not found (or missing required components).');
			const hasCppBuildTools = await runVswhere(['-products', '*', '-all', '-latest', '-requires', VS_REQUIRES_CPP, '-property', 'installationPath']);
			const hasCppIde = await runVswhere(['-products', '*', '-all', '-latest', '-requires', VS_REQUIRES_CPP_IDE, '-property', 'installationPath']);
			const hasCpp = hasCppBuildTools || hasCppIde;
			const hasAtl = await runVswhere(['-products', '*', '-all', '-latest', '-requires', VS_REQUIRES_ATL, '-property', 'installationPath']);
			const hasCmake = await runVswhere(['-products', '*', '-all', '-latest', '-requires', VS_REQUIRES_CMAKENINJA, '-property', 'installationPath']);
			if (!hasCpp) out('    - C++ build tools (VC.CoreBuildTools or VC.CoreIde): not installed');
			if (!hasAtl) out('    - C++ ATL: not installed');
			if (!hasCmake) out('    - C++ CMake/Ninja: not installed');
			out('    Install via Visual Studio Installer (Desktop development with C++) or run with --autoinstall.');
			out('    https://visualstudio.microsoft.com/downloads/');
			throw new Error('Visual Studio not found or missing required components.');
		}
	}

	if (!(await verifyVsvars(vsRoot))) {
		log.fail('Visual Studio environment setup failed.');
		throw new Error('Visual Studio environment setup failed.');
	}
	log.ok('Visual Studio');

	const env = await captureVsEnvironment(vsRoot, { verbose, onOutput });
	if (!env) {
		log.fail('Failed to capture Visual Studio environment.');
		throw new Error('Failed to capture Visual Studio environment.');
	}
	const generatorName = await getGeneratorName(vsRoot);

	await setState('build.vsPath', vsRoot);
	await setState('build.env', env);
	await setState('build.generatorName', generatorName);
	await setState('build.setupAt', setupAt);

	return { vsPath: vsRoot, env, setupAt };
}

module.exports = { runCompilerWindowsSetup };
