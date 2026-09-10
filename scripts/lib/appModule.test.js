/**
 * Regression tests for publishedCarriesBuild's snapshot lookup.
 *
 * The bug: the store keeps a `v<N>-<sha>.json` record beside every
 * `v<N>-<sha>/` snapshot directory, and the lookup matched both by name. When it
 * picked a record, it hashed `<record>.json/dist/remoteEntry.js` — a path that
 * cannot exist — got an empty digest, and reported a published build as "not
 * published", so a seed that had nothing to do ran anyway.
 *
 * Zero-dependency built-in runner, like sync.test.js. Run:
 *     node --test scripts/lib/appModule.test.js
 */
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { publishedCarriesBuild } = require('./appModule');

const APP_ID = 'rocketride.sample';
const BUNDLE = 'export const answer = 42;\n';

let root;
let savedStore;

/**
 * Lay out one published snapshot in the store: `v<N>-<sha>/dist/remoteEntry.js`.
 * @param {string} name - Snapshot directory name, e.g. 'v000002-abcd1234'
 * @param {string} content - The published remoteEntry.js bytes
 */
function publish(name, content) {
	const dist = path.join(root, 'store', 'orgs', 'org-1', 'files', '.deployments', APP_ID, name, 'dist');
	fs.mkdirSync(dist, { recursive: true });
	fs.writeFileSync(path.join(dist, 'remoteEntry.js'), content);
}

/**
 * Write the JSON record the store keeps beside a snapshot directory.
 * @param {string} name - Record file name, e.g. 'v000002-abcd1234.json'
 */
function record(name) {
	const dir = path.join(root, 'store', 'orgs', 'org-1', 'files', '.deployments', APP_ID);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, name), '{}');
}

/**
 * Stage a built bundle where the seeder copies it from.
 * @param {string} content - The staged remoteEntry.js bytes
 * @returns {string} The dist apps directory to pass to publishedCarriesBuild
 */
function stage(content) {
	const distApps = path.join(root, 'dist-apps');
	fs.mkdirSync(path.join(distApps, APP_ID), { recursive: true });
	fs.writeFileSync(path.join(distApps, APP_ID, 'remoteEntry.js'), content);
	return distApps;
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-appmodule-test-'));
	savedStore = process.env.ROCKETLIB_STORE;
	process.env.ROCKETLIB_STORE = path.join(root, 'store');
});

afterEach(() => {
	if (savedStore === undefined) delete process.env.ROCKETLIB_STORE;
	else process.env.ROCKETLIB_STORE = savedStore;
	fs.rmSync(root, { recursive: true, force: true });
});

test('a snapshot beside its own JSON record is still found', () => {
	publish('v000002-abcd1234', BUNDLE);
	record('v000002-abcd1234.json');

	assert.strictEqual(publishedCarriesBuild(APP_ID, stage(BUNDLE)), true);
});

test('a record newer than any snapshot directory is not mistaken for one', () => {
	// The deterministic form of the bug: readdir order no longer matters when
	// the only v3 entry is a file.
	publish('v000002-abcd1234', BUNDLE);
	record('v000002-abcd1234.json');
	record('v000003-ef567890.json');

	assert.strictEqual(publishedCarriesBuild(APP_ID, stage(BUNDLE)), true);
});

test('a staged build the newest snapshot does not carry still needs a seed', () => {
	publish('v000002-abcd1234', BUNDLE);
	record('v000002-abcd1234.json');

	assert.strictEqual(publishedCarriesBuild(APP_ID, stage('export const answer = 43;\n')), false);
});

test('records alone are not a publication', () => {
	record('v000001-abcd1234.json');

	assert.strictEqual(publishedCarriesBuild(APP_ID, stage(BUNDLE)), false);
});
