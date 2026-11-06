/**
 * Tests for the stack dump hook installer (stackdumps.js).
 *
 * Run:
 *     node --test scripts/lib/stackdumps.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DUMP_DIR_VAR, findSitePackages, withDumpVarsAllowed, installStackDumps } = require('./stackdumps');

function makeServerDir(sub) {
	const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-stackdumps-test-'));
	fs.mkdirSync(path.join(serverDir, ...sub), { recursive: true });
	return serverDir;
}

test('nothing is installed without the variable', () => {
	const serverDir = makeServerDir(['lib', 'site-packages']);
	assert.strictEqual(installStackDumps(serverDir, {}), null);
	assert.deepStrictEqual(fs.readdirSync(path.join(serverDir, 'lib', 'site-packages')), []);
});

test('finds the Windows and the POSIX site-packages', () => {
	const win = makeServerDir(['lib', 'site-packages']);
	assert.strictEqual(findSitePackages(win), path.join(win, 'lib', 'site-packages'));
	const posix = makeServerDir(['lib', 'python3.12', 'site-packages']);
	assert.strictEqual(findSitePackages(posix), path.join(posix, 'lib', 'python3.12', 'site-packages'));
	assert.strictEqual(findSitePackages(path.join(win, 'missing')), null);
});

test('RR_SUBPROCESS_ENV is appended to, never replaced', () => {
	assert.strictEqual(withDumpVarsAllowed(undefined), `${DUMP_DIR_VAR}*`);
	assert.strictEqual(withDumpVarsAllowed('GH_*, FOO'), `GH_*,FOO,${DUMP_DIR_VAR}*`);
	assert.strictEqual(withDumpVarsAllowed('*'), '*');
});

test('installs the hook, and the last release removes it', () => {
	const serverDir = makeServerDir(['lib', 'site-packages']);
	const sitePackages = path.join(serverDir, 'lib', 'site-packages');
	const env = { [DUMP_DIR_VAR]: path.join(serverDir, 'dumps') };

	const a = installStackDumps(serverDir, env);
	const b = installStackDumps(serverDir, env);
	assert.deepStrictEqual(fs.readdirSync(sitePackages).sort(), [
		'rr_test_stack_dumps.py',
		'zz_rr_test_stack_dumps.pth',
	]);
	assert.ok(fs.existsSync(path.join(serverDir, 'dumps')));
	assert.strictEqual(a.env.RR_SUBPROCESS_ENV, `${DUMP_DIR_VAR}*`);

	a.release();
	a.release();
	assert.strictEqual(fs.readdirSync(sitePackages).length, 2);
	b.release();
	assert.deepStrictEqual(fs.readdirSync(sitePackages), []);
});
