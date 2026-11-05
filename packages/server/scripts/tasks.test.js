/**
 * Tests for where server:download finds a prebuilt engine (tasks.js).
 *
 * The engine-cache release is tried before the stable release and the
 * prerelease, and each of them must match the local source hash and vcpkg
 * version in full. The network, the state file and archive extraction are
 * stubbed: the shared library and the vcpkg module are swapped in the require
 * cache before tasks.js loads, since it destructures them at load time.
 *
 * Run:
 *     node --test packages/server/scripts/tasks.test.js
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIB = require.resolve('../../../scripts/lib');
const VCPKG = require.resolve('../../vcpkg/scripts/tasks');

// What the stubs read and record, reset before each test
let world;

// tasks.js reads DOWNLOADS_DIR once, when it loads
const DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-server-download-'));

const realLib = require(LIB);
require.cache[LIB].exports = {
	...realLib,
	getState: async (key) => world.state.get(key) ?? null,
	setState: async (key, value) => {
		world.state.set(key, value);
	},
	cachedContentHash: async () => world.localHash,
	downloadGitHubFile: async (tag, filename) => {
		world.fetched.push(`${tag}/${filename}`);
		const asset = world.releases[tag]?.[filename.endsWith('.manifest.json') ? 'manifest' : 'archive'];
		if (!asset) return null;
		// Named as the real downloads/ cache names them
		const file = path.join(DOWNLOADS, `${tag}_${filename}`);
		fs.writeFileSync(file, filename.endsWith('.manifest.json') ? JSON.stringify(asset) : 'archive');
		return file;
	},
	extractArchive: async (file) => {
		world.extracted.push(path.basename(file));
	},
	removeMatching: async (dir, predicate) => {
		assert.strictEqual(dir, DOWNLOADS);
		world.pruned.push(...fs.readdirSync(dir).filter((name) => predicate(name)));
	},
	DOWNLOADS_DIR: DOWNLOADS,
};

const realVcpkg = require(VCPKG);
require.cache[VCPKG].exports = { ...realVcpkg, getVcpkgVersion: async () => world.vcpkgVersion };

const server = require('./tasks');
const { version } = require('../../../package.json');

const HASH = 'a'.repeat(16) + 'b'.repeat(48);
const VCPKG_VERSION = '2026.07.29';
const RELEASE = `server-v${version}`;
const PRERELEASE = `server-v${version}-prerelease`;

/** A manifest as the package step writes it, trimmed to what is read. */
function manifest(buildHash = HASH, vcpkgVersion = VCPKG_VERSION) {
	return {
		server: { buildHash },
		vcpkg: { version: vcpkgVersion },
		nodes: { ocr: { buildHash: 'n1', buildType: 'Release' } },
	};
}

/** Run server:download with these options against the current world. */
async function download(options = {}) {
	const { action } = server.actions.find((a) => a.name === 'server:download');
	const ctx = {};
	const outputs = [];
	const task = {
		set output(line) {
			outputs.push(line);
		},
	};
	await action(options).run(ctx, task);
	return { ctx, outputs };
}

/** The engine-cache names looked up, which carry the platform. */
function cacheLookups() {
	return world.fetched.filter((f) => f.startsWith('engine-cache/'));
}

after(() => fs.rmSync(DOWNLOADS, { recursive: true, force: true }));

beforeEach(() => {
	for (const name of fs.readdirSync(DOWNLOADS)) fs.rmSync(path.join(DOWNLOADS, name));
	world = {
		localHash: HASH,
		vcpkgVersion: VCPKG_VERSION,
		state: new Map(),
		releases: {},
		fetched: [],
		extracted: [],
		pruned: [],
	};
});

test('a hit in the engine cache is downloaded and the releases are not consulted', async () => {
	world.releases['engine-cache'] = { manifest: manifest(), archive: true };
	world.releases[PRERELEASE] = { manifest: manifest(), archive: true };

	const { ctx } = await download();

	const [manifestLookup, archiveLookup] = cacheLookups();
	assert.match(manifestLookup, /^engine-cache\/rocketride-engine-a{16}-[a-z0-9-]+\.manifest\.json$/);
	assert.match(archiveLookup, /^engine-cache\/rocketride-engine-a{16}-[a-z0-9-]+\.(tar\.gz|zip)$/);
	assert.deepStrictEqual(
		world.fetched.filter((f) => !f.startsWith('engine-cache/')),
		[],
		'stable and prerelease are only tried when the cache misses'
	);
	assert.deepStrictEqual(world.extracted, [`engine-cache_${archiveLookup.slice('engine-cache/'.length)}`]);
	assert.strictEqual(world.state.get('server.buildHash'), HASH);
	assert.strictEqual(world.state.get('server.downloadHash'), HASH);
	assert.strictEqual(world.state.get('nodes.ocr.buildHash'), 'n1');
	assert.strictEqual(world.state.get('nodes.ocr.from'), 'release');
	assert.strictEqual(ctx.serverReady, true);
	assert.strictEqual(ctx.serverDownloaded, true);
});

test('a cache hit drops the archives of other hashes but keeps manifests and its own', async () => {
	world.releases['engine-cache'] = { manifest: manifest(), archive: true };
	const stale = 'engine-cache_rocketride-engine-0123456789abcdef-linux-x64.tar.gz';
	const staleManifest = 'engine-cache_rocketride-engine-0123456789abcdef-linux-x64.manifest.json';
	const unrelated = `${PRERELEASE}_rocketride-${RELEASE}-linux-x64.tar.gz`;
	for (const name of [stale, staleManifest, unrelated]) fs.writeFileSync(path.join(DOWNLOADS, name), '');

	await download();

	assert.deepStrictEqual(world.pruned, [stale]);
});

test('a cache entry whose full hash differs is rejected and the prerelease is used', async () => {
	// Same first 16 characters, so the same asset name
	world.releases['engine-cache'] = { manifest: manifest('a'.repeat(16) + 'c'.repeat(48)), archive: true };
	world.releases[PRERELEASE] = { manifest: manifest(), archive: true };

	const { ctx } = await download();

	assert.strictEqual(cacheLookups().length, 1, 'only the cache manifest is fetched');
	assert.strictEqual(world.extracted.length, 1);
	assert.ok(world.extracted[0].startsWith(`${PRERELEASE}_rocketride-${RELEASE}-`));
	assert.deepStrictEqual(world.pruned, [], 'a release download leaves the cache archives alone');
	assert.strictEqual(world.state.get('server.downloadHash'), HASH);
	assert.strictEqual(ctx.serverDownloaded, true);
});

test('a cache entry built with another vcpkg is rejected', async () => {
	world.releases['engine-cache'] = { manifest: manifest(HASH, '2025.01.01'), archive: true };

	const { ctx, outputs } = await download();

	assert.deepStrictEqual(world.extracted, []);
	assert.strictEqual(world.state.get('server.downloadHash'), null);
	assert.strictEqual(ctx.serverReady, false);
	assert.ok(outputs.includes('Source differs from all releases — will compile'));
});

test('no cache release and no releases falls through to compiling', async () => {
	const { ctx, outputs } = await download();

	assert.strictEqual(cacheLookups().length, 1);
	assert.ok(world.fetched.some((f) => f.startsWith(`${RELEASE}/`)));
	assert.ok(world.fetched.some((f) => f.startsWith(`${PRERELEASE}/`)));
	assert.deepStrictEqual(world.extracted, []);
	assert.strictEqual(world.state.get('server.downloadHash'), null);
	assert.strictEqual(ctx.serverReady, false);
	assert.ok(outputs.includes('No releases available - will compile'));
});

test('a cache manifest without its archive falls through to compiling', async () => {
	world.releases['engine-cache'] = { manifest: manifest() };

	const { ctx } = await download();

	assert.deepStrictEqual(world.extracted, []);
	assert.strictEqual(world.state.get('server.downloadHash'), null);
	assert.strictEqual(ctx.serverReady, false);
});

test('a named release is the only one tried', async () => {
	world.releases['engine-cache'] = { manifest: manifest(), archive: true };
	world.releases[`${RELEASE}-workshop`] = { manifest: manifest(), archive: true };

	await download({ suffix: 'workshop' });

	assert.deepStrictEqual(cacheLookups(), []);
	assert.ok(world.fetched.every((f) => f.startsWith(`${RELEASE}-workshop/`)));
	assert.strictEqual(world.extracted.length, 1);
});

test('--nodownload looks nowhere', async () => {
	world.releases['engine-cache'] = { manifest: manifest(), archive: true };

	const { ctx } = await download({ nodownload: true });

	assert.deepStrictEqual(world.fetched, []);
	assert.strictEqual(ctx.serverReady, false);
});

test('an engine already downloaded from the cache is not fetched again', async () => {
	world.releases['engine-cache'] = { manifest: manifest(), archive: true };
	world.state.set('server.downloadHash', HASH);

	const { ctx } = await download();

	assert.strictEqual(cacheLookups().length, 1, 'the manifest only');
	assert.deepStrictEqual(world.extracted, []);
	assert.strictEqual(ctx.serverReady, true);
	assert.strictEqual(ctx.serverDownloaded, true);
});
