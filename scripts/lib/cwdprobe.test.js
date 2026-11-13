/**
 * Tests for the cwd handle probe installer (cwdprobe.js).
 *
 * Run:
 *     node --test scripts/lib/cwdprobe.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PROBE_DIR_VAR, DIST_INFO_NAME, findSitePackages, installCwdProbe } = require('./cwdprobe');

function makeServerDir() {
	const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cwdprobe-test-'));
	fs.mkdirSync(path.join(serverDir, 'lib', 'site-packages'), { recursive: true });
	return serverDir;
}

test('finds the Windows and the POSIX site-packages', () => {
	const win = makeServerDir();
	assert.strictEqual(findSitePackages(win), path.join(win, 'lib', 'site-packages'));
	const posix = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cwdprobe-test-'));
	fs.mkdirSync(path.join(posix, 'lib', 'python3.12', 'site-packages'), { recursive: true });
	assert.strictEqual(findSitePackages(posix), path.join(posix, 'lib', 'python3.12', 'site-packages'));
	assert.strictEqual(findSitePackages(path.join(win, 'missing')), null);
});

test('nothing is installed without the variable', () => {
	const serverDir = makeServerDir();
	assert.strictEqual(installCwdProbe(serverDir, {}, 'win32'), null);
	assert.strictEqual(installCwdProbe(serverDir, undefined, 'win32'), null);
	assert.deepStrictEqual(fs.readdirSync(path.join(serverDir, 'lib', 'site-packages')), []);
});

test('nothing is installed outside Windows', () => {
	const serverDir = makeServerDir();
	assert.strictEqual(installCwdProbe(serverDir, { [PROBE_DIR_VAR]: path.join(serverDir, 'r') }, 'linux'), null);
	assert.deepStrictEqual(fs.readdirSync(path.join(serverDir, 'lib', 'site-packages')), []);
});

test('nothing is installed when the engine has no site-packages', () => {
	const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-cwdprobe-test-'));
	assert.strictEqual(installCwdProbe(serverDir, { [PROBE_DIR_VAR]: path.join(serverDir, 'r') }, 'win32'), null);
});

test('installs the module and the pytest11 entry point, and the last release removes them', () => {
	const serverDir = makeServerDir();
	const sitePackages = path.join(serverDir, 'lib', 'site-packages');
	const env = { [PROBE_DIR_VAR]: path.join(serverDir, 'reports') };

	const a = installCwdProbe(serverDir, env, 'win32');
	const b = installCwdProbe(serverDir, env, 'win32');
	assert.deepStrictEqual(fs.readdirSync(sitePackages).sort(), [DIST_INFO_NAME, 'rr_test_cwd_probe.py']);
	assert.ok(fs.existsSync(path.join(serverDir, 'reports')));
	const entryPoints = fs.readFileSync(path.join(sitePackages, DIST_INFO_NAME, 'entry_points.txt'), 'utf8');
	assert.strictEqual(entryPoints, '[pytest11]\nrr_test_cwd_probe = rr_test_cwd_probe\n');
	assert.match(
		fs.readFileSync(path.join(sitePackages, DIST_INFO_NAME, 'METADATA'), 'utf8'),
		/^Name: rr-test-cwd-probe$/m
	);

	a.release();
	a.release();
	assert.strictEqual(fs.readdirSync(sitePackages).length, 2);
	b.release();
	assert.deepStrictEqual(fs.readdirSync(sitePackages), []);
});

test('release also removes the compiled module', () => {
	const serverDir = makeServerDir();
	const cache = path.join(serverDir, 'lib', 'site-packages', '__pycache__');
	const probe = installCwdProbe(serverDir, { [PROBE_DIR_VAR]: path.join(serverDir, 'r') }, 'win32');
	fs.mkdirSync(cache);
	fs.writeFileSync(path.join(cache, 'rr_test_cwd_probe.cpython-312.pyc'), '');
	fs.writeFileSync(path.join(cache, 'other.cpython-312.pyc'), '');
	probe.release();
	assert.deepStrictEqual(fs.readdirSync(cache), ['other.cpython-312.pyc']);
});
