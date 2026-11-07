/**
 * Current-directory handle probe for pytest runs on Windows (issue #3046).
 *
 * When ROCKETRIDE_TEST_CWD_PROBE names a directory, every pytest run the builder
 * starts gets rr_test_cwd_probe.py plus a pytest11 entry point in the engine's
 * site-packages. pytest loads the entry point in every pytest process (xdist workers
 * included), and the module watches that process's cwd handle and writes a report
 * into the directory when the handle is closed. With the variable unset, or on a
 * platform other than Windows, nothing is installed. The files are removed when the
 * last pytest run that uses them has finished.
 */
const fs = require('fs');
const path = require('path');

const PROBE_DIR_VAR = 'ROCKETRIDE_TEST_CWD_PROBE';
const MODULE_NAME = 'rr_test_cwd_probe';
const DIST_INFO_NAME = `${MODULE_NAME}-0.0.0.dist-info`;

const METADATA = `Metadata-Version: 2.1\nName: ${MODULE_NAME.replace(/_/g, '-')}\nVersion: 0.0.0\n`;
const ENTRY_POINTS = `[pytest11]\n${MODULE_NAME} = ${MODULE_NAME}\n`;

/**
 * Find the engine's site-packages directory.
 *
 * @param {string} serverDir - dist/server
 * @returns {string|null} The directory, or null when the engine has none
 */
function findSitePackages(serverDir) {
	const lib = path.join(serverDir, 'lib');
	const candidates = [path.join(lib, 'site-packages')];
	try {
		for (const entry of fs.readdirSync(lib)) {
			if (/^python3\.\d+$/.test(entry)) candidates.push(path.join(lib, entry, 'site-packages'));
		}
	} catch {
		return null;
	}
	return candidates.find((dir) => fs.existsSync(dir)) ?? null;
}

// Runs that currently use the probe, so the files stay until the last one ends.
let activeUsers = 0;

/**
 * Install the probe for one pytest run when ROCKETRIDE_TEST_CWD_PROBE is set.
 *
 * @param {string} serverDir - dist/server, the folder of the engine that runs pytest
 * @param {object} env - The environment pytest will start with
 * @param {string} [platform] - The platform to install for, process.platform by default
 * @returns {{release: Function}|null} A function to call when the run has ended, or
 *   null when the probe is off or cannot be installed
 */
function installCwdProbe(serverDir, env, platform = process.platform) {
	const reportDir = env?.[PROBE_DIR_VAR];
	if (!reportDir || platform !== 'win32') return null;

	const sitePackages = findSitePackages(serverDir);
	if (!sitePackages) {
		console.error(`[pytest] cwd probe off: no site-packages under ${serverDir}`);
		return null;
	}

	const distInfo = path.join(sitePackages, DIST_INFO_NAME);
	try {
		fs.mkdirSync(reportDir, { recursive: true });
		fs.copyFileSync(path.join(__dirname, `${MODULE_NAME}.py`), path.join(sitePackages, `${MODULE_NAME}.py`));
		fs.mkdirSync(distInfo, { recursive: true });
		fs.writeFileSync(path.join(distInfo, 'METADATA'), METADATA);
		fs.writeFileSync(path.join(distInfo, 'entry_points.txt'), ENTRY_POINTS);
	} catch (err) {
		console.error(`[pytest] cwd probe off: ${err.message}`);
		return null;
	}

	activeUsers++;
	let released = false;
	return {
		release() {
			if (released) return;
			released = true;
			if (--activeUsers > 0) return;
			fs.rmSync(path.join(sitePackages, `${MODULE_NAME}.py`), { force: true });
			fs.rmSync(distInfo, { recursive: true, force: true });
			const cacheDir = path.join(sitePackages, '__pycache__');
			try {
				for (const entry of fs.readdirSync(cacheDir)) {
					if (entry.startsWith(`${MODULE_NAME}.`)) fs.rmSync(path.join(cacheDir, entry), { force: true });
				}
			} catch {
				// No cache folder: nothing to remove.
			}
		},
	};
}

module.exports = { PROBE_DIR_VAR, findSitePackages, DIST_INFO_NAME, installCwdProbe };
