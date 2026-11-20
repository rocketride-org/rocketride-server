/**
 * Stack dumps for task child processes in test runs.
 *
 * When ROCKETRIDE_TEST_STACK_DUMPS names a directory, every test server the
 * builder starts gets a hook: rr_test_stack_dumps.py plus a .pth file in the
 * engine's site-packages, and the variable is passed on to task children
 * (RR_SUBPROCESS_ENV). The hook makes each child write periodic Python stack
 * dumps to <dir>/stacks_<pid>.txt. With the variable unset nothing is installed.
 * The hook files are removed when the last server that uses them has exited.
 */
const fs = require('fs');
const path = require('path');

const DUMP_DIR_VAR = 'ROCKETRIDE_TEST_STACK_DUMPS';
const MODULE_NAME = 'rr_test_stack_dumps';
const PTH_NAME = 'zz_rr_test_stack_dumps.pth';

// Runs in every Python start of the engine; a no-op unless the variable is set.
const PTH_LINE = `import os; os.environ.get('${DUMP_DIR_VAR}') and __import__('${MODULE_NAME}')\n`;

// Servers that currently use the hook, so the files stay until the last one exits.
let activeUsers = 0;

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

/**
 * Add the names the hook needs to RR_SUBPROCESS_ENV, keeping what is there.
 *
 * @param {string|undefined} current - The current RR_SUBPROCESS_ENV value
 * @returns {string} The value that also lets the dump variables reach task children
 */
function withDumpVarsAllowed(current) {
	const names = (current ?? '').split(/[\s,]+/).filter(Boolean);
	if (names.includes('*')) return current;
	return [...names, `${DUMP_DIR_VAR}*`].join(',');
}

/**
 * Install the hook for one test server when ROCKETRIDE_TEST_STACK_DUMPS is set.
 *
 * @param {string} serverDir - dist/server
 * @param {object} baseEnv - The environment the server will start with
 * @returns {{env: object, release: Function}|null} Variables to add to the server's
 *   environment and a function to call when the server has exited, or null when the
 *   hook is off or cannot be installed
 */
function installStackDumps(serverDir, baseEnv) {
	const dumpDir = baseEnv[DUMP_DIR_VAR];
	if (!dumpDir) return null;

	const sitePackages = findSitePackages(serverDir);
	if (!sitePackages) {
		console.error(`[server] stack dumps off: no site-packages under ${serverDir}`);
		return null;
	}

	try {
		fs.mkdirSync(dumpDir, { recursive: true });
		fs.copyFileSync(path.join(__dirname, `${MODULE_NAME}.py`), path.join(sitePackages, `${MODULE_NAME}.py`));
		fs.writeFileSync(path.join(sitePackages, PTH_NAME), PTH_LINE);
	} catch (err) {
		console.error(`[server] stack dumps off: ${err.message}`);
		return null;
	}

	activeUsers++;
	let released = false;
	return {
		env: { RR_SUBPROCESS_ENV: withDumpVarsAllowed(baseEnv.RR_SUBPROCESS_ENV) },
		release() {
			if (released) return;
			released = true;
			if (--activeUsers > 0) return;
			for (const name of [`${MODULE_NAME}.py`, PTH_NAME]) {
				fs.rmSync(path.join(sitePackages, name), { force: true });
			}
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

module.exports = { DUMP_DIR_VAR, findSitePackages, withDumpVarsAllowed, installStackDumps };
