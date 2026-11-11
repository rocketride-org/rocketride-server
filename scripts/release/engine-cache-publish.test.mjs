// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Tests for the engine-cache publisher. gh is replaced by a fake release that
 * records every call, so nothing reaches GitHub.
 *
 * Run:
 *     node --test scripts/release/engine-cache-publish.test.mjs
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
	collectArtifacts,
	engineAssetName,
	parseEngineAssetName,
	planPrune,
	publish,
	stampUsage,
} from './engine-cache-publish.mjs';

const HASH = 'a'.repeat(16) + 'b'.repeat(48);
const REPO = 'owner/repo';

/** A directory laid out like the downloaded server-artifacts-* of one build. */
async function artifactsDir({ hash = HASH, platforms = ['linux-x64', 'win64', 'darwin-arm64'] } = {}) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-engine-cache-'));
	for (const platform of platforms) {
		const base = path.join(dir, `rocketride-server-v3.6.0-${platform}`);
		await fs.writeFile(
			`${base}.manifest.json`,
			JSON.stringify({ server: { buildHash: hash }, vcpkg: { version: '2026.07.29' } })
		);
		await fs.writeFile(`${base}.${platform === 'win64' ? 'zip' : 'tar.gz'}`, `engine for ${platform}`);
	}
	// Other files the build uploads alongside
	await fs.writeFile(path.join(dir, 'licenses.json'), '{}');
	return dir;
}

/** An asset of the release as the API lists it. */
function asset(id, hash16, minute, ext = 'tar.gz', platform = 'linux-x64') {
	return {
		id,
		name: `rocketride-engine-${hash16}-${platform}.${ext}`,
		created_at: `2026-11-05T10:${String(minute).padStart(2, '0')}:00Z`,
	};
}

/**
 * A fake gh over an in-memory release. `failures` makes the named call fail
 * that many times first; deleting an id in `gone` answers 404.
 */
function fakeGh({ exists = true, assets = [], gone = [], failures = {}, createRace = false } = {}) {
	const calls = [];
	const uploaded = [];
	const state = { exists };
	const gh = async (args) => {
		calls.push(args);
		const key = args.slice(0, 2).join(' ');
		if (failures[key] > 0) {
			failures[key]--;
			throw new Error(`gh ${key}: HTTP 422: Validation Failed (already_exists)`);
		}
		if (key === 'release view') {
			if (!state.exists) throw new Error('gh release view: release not found');
			return '{"tagName":"engine-cache"}';
		}
		if (key === 'release create') {
			state.exists = true;
			if (createRace) throw new Error('gh release create: a release with the same tag name already exists');
			return '';
		}
		if (key === 'release upload') {
			// The file must exist under its asset name when gh reads it
			await fs.access(args[3]);
			uploaded.push(path.basename(args[3]));
			return '';
		}
		if (args[0] === 'api' && args.includes('-X')) {
			const id = Number(args.at(-1).split('/').at(-1));
			if (gone.includes(id)) throw new Error('gh api: Not Found (HTTP 404)');
			return '';
		}
		if (args[0] === 'api' && args.includes('--paginate')) {
			const listed = [
				...assets,
				...uploaded.map((name, i) => ({ id: 1000 + i, name, created_at: '2026-11-05T11:00:00Z' })),
			];
			return listed
				.map((a) => `${a.id}\t${a.name}\t${a.created_at}\t${a.download_count ?? 0}\t${a.label ?? ''}\n`)
				.join('');
		}
		if (args[0] === 'api') return '4242\n';
		throw new Error(`unexpected gh ${args.join(' ')}`);
	};
	return { gh, calls, uploaded, state };
}

const quiet = () => {};
const noWait = async () => {};

describe('asset names', () => {
	it('round-trip through the first 16 characters of the hash', () => {
		const name = engineAssetName(HASH, 'darwin-arm64', 'tar.gz');
		assert.equal(name, 'rocketride-engine-aaaaaaaaaaaaaaaa-darwin-arm64.tar.gz');
		assert.deepEqual(parseEngineAssetName(name), {
			hash16: 'a'.repeat(16),
			platform: 'darwin-arm64',
			ext: 'tar.gz',
		});
		assert.deepEqual(parseEngineAssetName(engineAssetName(HASH, 'win64', 'manifest.json')), {
			hash16: 'a'.repeat(16),
			platform: 'win64',
			ext: 'manifest.json',
		});
	});

	it('ignore anything not named like an engine', () => {
		assert.equal(parseEngineAssetName('rocketride-server-v3.6.0-linux-x64.tar.gz'), null);
		assert.equal(parseEngineAssetName('rocketride-engine-short-linux-x64.tar.gz'), null);
		assert.equal(parseEngineAssetName('notes.txt'), null);
	});
});

describe('collectArtifacts', () => {
	it('pairs each platform manifest with its archive and reads the hash', async () => {
		const dir = await artifactsDir();
		const found = await collectArtifacts(dir);
		assert.deepEqual(
			found.map(({ platform, hash, ext, vcpkg }) => ({ platform, hash, ext, vcpkg })),
			[
				{ platform: 'darwin-arm64', hash: HASH, ext: 'tar.gz', vcpkg: '2026.07.29' },
				{ platform: 'linux-x64', hash: HASH, ext: 'tar.gz', vcpkg: '2026.07.29' },
				{ platform: 'win64', hash: HASH, ext: 'zip', vcpkg: '2026.07.29' },
			]
		);
	});

	it('refuses a manifest without a full hash', async () => {
		const dir = await artifactsDir({ hash: 'abc', platforms: ['linux-x64'] });
		await assert.rejects(collectArtifacts(dir), /not a SHA-256 hex digest/);
	});

	it('refuses a manifest without its archive', async () => {
		const dir = await artifactsDir({ platforms: ['linux-x64'] });
		await fs.rm(path.join(dir, 'rocketride-server-v3.6.0-linux-x64.tar.gz'));
		await assert.rejects(collectArtifacts(dir), /no .*\.tar\.gz or \.zip beside it/);
	});

	it('refuses a directory with no engines', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rr-engine-cache-'));
		await assert.rejects(collectArtifacts(dir), /No rocketride-server-v\*/);
	});
});

describe('planPrune', () => {
	const hashes = Array.from({ length: 18 }, (_, i) => i.toString(16).padStart(16, '0'));

	it('keeps the newest hashes and deletes every asset of the rest', () => {
		const assets = hashes.flatMap((h, i) => [asset(i * 2, h, i), asset(i * 2 + 1, h, i, 'manifest.json')]);
		const { kept, remove } = planPrune(assets, 16);
		assert.equal(kept.length, 16);
		assert.equal(kept[0], hashes[17], 'newest first');
		assert.deepEqual(
			remove.map((a) => a.id),
			[0, 1, 2, 3]
		);
	});

	it('dates a hash by its newest asset, so one published again moves to the front', () => {
		const assets = [asset(1, hashes[0], 1), asset(2, hashes[1], 2), asset(3, hashes[0], 3, 'zip', 'win64')];
		assert.deepEqual(
			planPrune(assets, 1).remove.map((a) => a.id),
			[2]
		);
	});

	it('ranks a hash by its last download, so one still in use outlives newer ones', () => {
		const assets = [{ ...asset(1, hashes[0], 1), used_at: '2026-11-05T12:00:00Z' }, asset(2, hashes[1], 2)];
		assert.deepEqual(planPrune(assets, 1).kept, [hashes[0]]);
	});

	it('never deletes a protected hash or a foreign asset', () => {
		const assets = [
			asset(1, hashes[0], 1),
			asset(2, hashes[1], 2),
			{ id: 9, name: 'README.txt', created_at: '2020-01-01T00:00:00Z' },
		];
		const { kept, remove } = planPrune(assets, 1, [hashes[0]]);
		assert.deepEqual(kept, [hashes[1], hashes[0]]);
		assert.deepEqual(remove, []);
	});
});

describe('stampUsage', () => {
	const NOW = '2026-11-05T12:00:00Z';
	const name = (h) => `rocketride-engine-${h}-linux-x64.tar.gz`;

	it('stamps an asset whose download count grew, and keeps the last stamp otherwise', () => {
		const assets = [
			{
				...asset(1, 'a'.repeat(16), 1),
				download_count: 3,
				label: `${name('a'.repeat(16))} (downloads 2 as of 2026-11-05T10:30:00Z)`,
			},
			{
				...asset(2, 'b'.repeat(16), 2),
				download_count: 2,
				label: `${name('b'.repeat(16))} (downloads 2 as of 2026-11-05T10:30:00Z)`,
			},
			{ ...asset(3, 'c'.repeat(16), 3), download_count: 0, label: '' },
			{ ...asset(4, 'd'.repeat(16), 4), download_count: 5, label: '' },
		];
		const { assets: stamped, relabel } = stampUsage(assets, NOW);
		assert.deepEqual(
			stamped.map((a) => a.used_at),
			[NOW, '2026-11-05T10:30:00Z', '2026-11-05T10:03:00Z', NOW]
		);
		assert.deepEqual(relabel, [
			{ id: 1, label: `${name('a'.repeat(16))} (downloads 3 as of ${NOW})` },
			{ id: 4, label: `${name('d'.repeat(16))} (downloads 5 as of ${NOW})` },
		]);
	});
});

describe('publish', () => {
	it('creates the release once, as a prerelease that is never latest', async () => {
		const dir = await artifactsDir({ platforms: ['linux-x64'] });
		const fake = fakeGh({ exists: false });
		await publish({ dir, repo: REPO, gh: fake.gh, log: quiet, wait: noWait });

		const create = fake.calls.find((c) => c[1] === 'create');
		assert.ok(create.includes('--prerelease'));
		assert.ok(create.includes('--latest=false'));
		assert.equal(create[create.indexOf('--title') + 1], 'Engine cache (CI only)');
		assert.equal(fake.calls.filter((c) => c[1] === 'create').length, 1);
	});

	it('carries on when a concurrent run created the release first', async () => {
		const dir = await artifactsDir({ platforms: ['linux-x64'] });
		const fake = fakeGh({ exists: false, createRace: true });
		const { failed } = await publish({ dir, repo: REPO, gh: fake.gh, log: quiet, wait: noWait });
		assert.deepEqual(failed, []);
		assert.equal(fake.uploaded.length, 2);
	});

	it('uploads each archive before its manifest, under the hash names, replacing what is there', async () => {
		const dir = await artifactsDir();
		const fake = fakeGh();
		const { published, failed } = await publish({ dir, repo: REPO, gh: fake.gh, log: quiet, wait: noWait });

		assert.deepEqual(published, ['a'.repeat(16)]);
		assert.deepEqual(failed, []);
		for (const platform of ['linux-x64', 'win64', 'darwin-arm64']) {
			const ext = platform === 'win64' ? 'zip' : 'tar.gz';
			const archive = fake.uploaded.indexOf(engineAssetName(HASH, platform, ext));
			const manifest = fake.uploaded.indexOf(engineAssetName(HASH, platform, 'manifest.json'));
			assert.ok(archive >= 0 && manifest > archive, `${platform}: archive, then manifest`);
		}
		const uploads = fake.calls.filter((c) => c[1] === 'upload');
		assert.ok(uploads.every((c) => c.includes('--clobber') && c[c.indexOf('--repo') + 1] === REPO));
		// The renamed links are gone afterwards
		assert.deepEqual(
			(await fs.readdir(dir)).filter((n) => n.startsWith('.engine-cache-')),
			[]
		);
	});

	it('retries an upload that collided with another run', async () => {
		const dir = await artifactsDir({ platforms: ['linux-x64'] });
		const fake = fakeGh({ failures: { 'release upload': 1 } });
		const { failed } = await publish({ dir, repo: REPO, gh: fake.gh, log: quiet, wait: noWait });
		assert.deepEqual(failed, []);
		assert.equal(fake.uploaded.length, 2);
	});

	it('reports a platform whose upload keeps failing without uploading its manifest', async () => {
		const dir = await artifactsDir({ platforms: ['linux-x64'] });
		const fake = fakeGh({ failures: { 'release upload': 99 } });
		const { failed, published } = await publish({ dir, repo: REPO, gh: fake.gh, log: quiet, wait: noWait });
		assert.deepEqual(failed, ['linux-x64']);
		assert.deepEqual(published, []);
		assert.deepEqual(fake.uploaded, []);
	});

	it('prunes to the newest hashes, keeps the one just published, and tolerates an asset already gone', async () => {
		const dir = await artifactsDir({ platforms: ['linux-x64'] });
		// 17 older hashes: with the one published, two over the limit
		const old = Array.from({ length: 17 }, (_, i) => asset(i + 1, i.toString(16).padStart(16, '0'), i));
		// Listed, but a concurrent run deletes it first
		old.push(asset(99, '0'.repeat(16), 0, 'manifest.json'));
		const fake = fakeGh({ assets: old, gone: [99] });

		const { removed } = await publish({ dir, repo: REPO, gh: fake.gh, log: quiet, wait: noWait, keep: 16 });

		assert.deepEqual(removed.sort(), [
			'rocketride-engine-0000000000000000-linux-x64.manifest.json',
			'rocketride-engine-0000000000000000-linux-x64.tar.gz',
			'rocketride-engine-0000000000000001-linux-x64.tar.gz',
		]);
		const deletes = fake.calls.filter((c) => c.includes('DELETE')).map((c) => c.at(-1));
		assert.deepEqual(
			deletes.sort(),
			[1, 2, 99].map((id) => `repos/${REPO}/releases/assets/${id}`)
		);
	});

	it('makes no writes in a dry run', async () => {
		const dir = await artifactsDir();
		const old = Array.from({ length: 17 }, (_, i) => asset(i + 1, i.toString(16).padStart(16, '0'), i));
		const fake = fakeGh({ exists: false, assets: old });
		const lines = [];
		const { removed } = await publish({
			dir,
			repo: REPO,
			gh: fake.gh,
			dryRun: true,
			log: (l) => lines.push(l),
			wait: noWait,
		});

		const writes = fake.calls.filter((c) => ['create', 'upload'].includes(c[1]) || c.includes('DELETE'));
		assert.deepEqual(writes, []);
		assert.ok(lines.includes('[dry-run] would create release engine-cache'));
		assert.ok(
			lines.some((l) => l.startsWith('[dry-run] would upload rocketride-engine-aaaaaaaaaaaaaaaa-win64.zip'))
		);
		assert.deepEqual(removed, ['rocketride-engine-0000000000000000-linux-x64.tar.gz']);
	});
});
