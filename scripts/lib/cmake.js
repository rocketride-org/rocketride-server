/**
 * Shared CMake Utilities
 *
 * The arguments our configures and builds are made of: the generator, the
 * directories, the build type and the job count.
 */
const os = require('os');
const path = require('path');
const { exists, readFile } = require('./fs');
const { isWindows } = require('./platform');
const { getWindowsToolchain } = require('./toolchain');

function getParallelJobs() {
	return os.cpus().length || 4;
}

async function detectGenerator() {
	if (isWindows()) {
		try {
			await getWindowsToolchain();
			return ['-G', 'Ninja'];
		} catch {
			return [];
		}
	}
	const pathEnv = process.env.PATH || '';
	const name = 'ninja';
	for (const dir of pathEnv.split(':')) {
		if (await exists(path.join(dir.trim(), name))) return ['-G', 'Ninja'];
	}
	return ['-G', 'Unix Makefiles'];
}

/**
 * If CMakeCache.txt exists, return generator args that match the existing
 * config (avoids generator mismatch). Never use cache for Ninja.
 */
async function getCachedGeneratorArgs(buildDir) {
	const cachePath = path.join(buildDir, 'CMakeCache.txt');
	if (!(await exists(cachePath))) return null;
	try {
		const content = await readFile(cachePath, 'utf8');
		let generator = null;
		let generatorPlatform = null;
		for (const line of content.split('\n')) {
			const genMatch = /^CMAKE_GENERATOR:INTERNAL=(.+)$/.exec(line.trim());
			if (genMatch) generator = genMatch[1].trim();
			const platformMatch = /^CMAKE_GENERATOR_PLATFORM:INTERNAL=(.+)$/.exec(line.trim());
			if (platformMatch) generatorPlatform = platformMatch[1].trim();
		}
		if (!generator) return null;
		if (/^Ninja$/i.test(generator)) return null;
		if (/^Visual Studio\s+\d+\s+\d{4}$/.test(generator) && (!generatorPlatform || generatorPlatform === '')) {
			return null;
		}
		const args = ['-G', generator];
		if (/^Visual Studio\s+\d+\s+\d{4}$/.test(generator)) {
			args.push('-A', generatorPlatform || 'x64');
		}
		return args;
	} catch {
		return null;
	}
}

/**
 * `cmake` arguments that configure buildDir from srcDir. An existing build tree
 * keeps the generator it was made with; a new one gets the one we detect.
 */
async function getConfigureArgs(srcDir, buildDir, cmakeConfig) {
	const generator = (await getCachedGeneratorArgs(buildDir)) ?? (await detectGenerator());

	return ['-B', buildDir, '-S', srcDir, ...generator, `-DCMAKE_BUILD_TYPE=${cmakeConfig}`];
}

/**
 * `cmake` arguments that build buildDir - everything by default, or one target.
 * Pass jobs: 0 for a target that is not worth parallelising.
 */
function getBuildArgs(buildDir, cmakeConfig, { target, jobs = getParallelJobs() } = {}) {
	return [
		'--build',
		buildDir,
		'--config',
		cmakeConfig,
		...(target ? ['--target', target] : []),
		...(jobs ? ['--parallel', String(jobs)] : []),
	];
}

/**
 * `cmake` arguments that remove what a build of buildDir produced. The clean
 * target deletes the outputs, not the configuration - the build tree stays
 * configured, so the next build needs no reconfigure.
 */
function getCleanArgs(buildDir) {
	return ['--build', buildDir, '--target', 'clean'];
}

module.exports = {
	getParallelJobs,
	detectGenerator,
	getCachedGeneratorArgs,
	getConfigureArgs,
	getBuildArgs,
	getCleanArgs,
};
