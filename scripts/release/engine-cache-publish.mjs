#!/usr/bin/env node

// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Publish the engines a CI build packaged to the `engine-cache` release, named
 * by the server source hash they were built from, and prune it to the newest
 * hashes.
 *
 * `builder server:download` (packages/server/scripts/tasks.js) looks there
 * before the stable release and the prerelease. Those two slots only hold the
 * latest build, so a pull request whose packages/server matched an older
 * develop commit, or stage, compiled the engine (a ~54 min build, not ~31).
 *
 * Input is the directory the build's `server-artifacts-*` were downloaded to:
 * `rocketride-server-v<version>-<platform>.manifest.json` beside its
 * `.tar.gz` / `.zip`. Each pair is uploaded as
 * `rocketride-engine-<first 16 hex of server.buildHash>-<platform>.*`, archive
 * first, so a manifest that can be read always has its archive. A second run
 * for the same hash replaces the assets (--clobber); a race between two runs
 * is retried, and an asset another run already pruned is not an error.
 *
 * Usage:
 *   node scripts/release/engine-cache-publish.mjs <artifacts-dir> [--keep=16] [--dry-run]
 *
 * Needs `gh`, GH_TOKEN with contents: write, and GH_REPO (owner/name).
 * --dry-run prints the uploads and deletions without making them.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const ENGINE_CACHE_TAG = 'engine-cache';
export const DEFAULT_KEEP = 16;

const TITLE = 'Engine cache (CI only)';
const NOTES = [
	'Internal CI cache, not a release. Do not download from here: use the `server-v*` releases.',
	'',
	'Holds the engines CI compiled for develop and stage, named `rocketride-engine-<hash>-<platform>`,',
	'where `<hash>` is the first 16 hex characters of the server source hash.',
	'`builder server:download` checks here before the stable release and the prerelease.',
	'',
	'Published by `.github/workflows/prerelease.yaml` (`scripts/release/engine-cache-publish.mjs`),',
	`which keeps the newest ${DEFAULT_KEEP} hashes.`,
].join('\n');

const PLATFORMS = ['linux-x64', 'win64', 'darwin-arm64', 'darwin-x64'];
const MANIFEST_RE = new RegExp(`^rocketride-server-v.+-(${PLATFORMS.join('|')})\\.manifest\\.json$`);
const ASSET_RE = /^rocketride-engine-([0-9a-f]{16})-(.+?)\.(manifest\.json|tar\.gz|zip)$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/** The asset name an engine file is published under. */
export function engineAssetName(hash, platform, ext) {
	return `rocketride-engine-${hash.slice(0, 16)}-${platform}.${ext}`;
}

/** The hash prefix and platform of an engine-cache asset, or null for anything else. */
export function parseEngineAssetName(name) {
	const match = name.match(ASSET_RE);
	return match ? { hash16: match[1], platform: match[2], ext: match[3] } : null;
}

/**
 * The packaged engines in a directory, one per platform manifest.
 *
 * @returns {Promise<Array<Object>>} Each {platform, hash, vcpkg, manifest,
 *   archive, ext}: the two paths, and the archive's extension
 */
export async function collectArtifacts(dir) {
	const names = await fs.readdir(dir);
	const artifacts = [];

	for (const name of names.sort()) {
		const match = name.match(MANIFEST_RE);
		if (!match) continue;
		const platform = match[1];
		const manifest = path.join(dir, name);

		const state = JSON.parse(await fs.readFile(manifest, 'utf8'));
		const hash = state?.server?.buildHash;
		if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
			throw new Error(`${name}: server.buildHash is not a SHA-256 hex digest (${JSON.stringify(hash)})`);
		}
		const vcpkg = state?.vcpkg?.version ?? null;

		const base = name.slice(0, -'.manifest.json'.length);
		const ext = ['tar.gz', 'zip'].find((e) => names.includes(`${base}.${e}`));
		if (!ext) throw new Error(`${name}: no ${base}.tar.gz or .zip beside it`);

		artifacts.push({ platform, hash, vcpkg, manifest, archive: path.join(dir, `${base}.${ext}`), ext });
	}

	if (!artifacts.length) throw new Error(`No rocketride-server-v*-<platform>.manifest.json in ${dir}`);
	return artifacts;
}

/**
 * Which engine-cache assets to delete so only the newest hashes remain.
 *
 * A hash is as new as its newest asset, so one published again moves back to
 * the front. Assets not named like an engine are never touched.
 *
 * @param {Array<{id: number, name: string, created_at: string}>} assets - The release's assets
 * @param {number} keep - How many hashes to keep
 * @param {Iterable<string>} [protect] - Hash prefixes kept whatever their age (the ones just published)
 * @returns {{kept: string[], remove: Array<{id: number, name: string, created_at: string}>}}
 */
export function planPrune(assets, keep, protect = []) {
	const newest = new Map();
	for (const asset of assets) {
		const parsed = parseEngineAssetName(asset.name);
		if (!parsed) continue;
		const seen = newest.get(parsed.hash16);
		if (!seen || asset.created_at > seen) newest.set(parsed.hash16, asset.created_at);
	}

	const byAge = [...newest.keys()].sort((a, b) => newest.get(b).localeCompare(newest.get(a)) || a.localeCompare(b));
	const kept = new Set([...byAge.slice(0, keep), ...[...protect].filter((h) => newest.has(h))]);

	return {
		kept: byAge.filter((h) => kept.has(h)),
		remove: assets.filter((asset) => {
			const parsed = parseEngineAssetName(asset.name);
			return parsed && !kept.has(parsed.hash16);
		}),
	};
}

/** Run gh and resolve with its stdout; the error carries gh's stderr. */
export function runGh(args) {
	return new Promise((resolve, reject) => {
		execFile('gh', args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`gh ${args.slice(0, 2).join(' ')}: ${String(stderr).trim() || error.message}`));
			} else {
				resolve(String(stdout));
			}
		});
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Try a few times: two runs replacing the same asset collide (422 already_exists). */
async function withRetry(what, fn, { attempts = 3, delayMs = 10_000, wait = sleep, log }) {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fn();
		} catch (error) {
			if (attempt >= attempts) throw error;
			log(`${what} failed (attempt ${attempt}/${attempts}), retrying: ${error.message}`);
			await wait(delayMs * attempt);
		}
	}
}

async function releaseExists(gh, repo) {
	try {
		await gh(['release', 'view', ENGINE_CACHE_TAG, '--repo', repo, '--json', 'tagName']);
		return true;
	} catch (error) {
		if (/release not found|HTTP 404|Not Found/i.test(error.message)) return false;
		throw error;
	}
}

/** Create the release on first use. Never "latest": it is not a release anyone should install. */
async function ensureRelease(gh, repo, { dryRun, log }) {
	if (await releaseExists(gh, repo)) return;
	if (dryRun) {
		log(`[dry-run] would create release ${ENGINE_CACHE_TAG}`);
		return;
	}
	try {
		await gh([
			'release',
			'create',
			ENGINE_CACHE_TAG,
			'--repo',
			repo,
			'--prerelease',
			'--latest=false',
			'--title',
			TITLE,
			'--notes',
			NOTES,
		]);
		log(`Created release ${ENGINE_CACHE_TAG}`);
	} catch (error) {
		// Another run may have created it in between
		if (!(await releaseExists(gh, repo))) throw error;
	}
}

/** Every asset of the release, all pages. */
async function listAssets(gh, repo) {
	const id = (await gh(['api', `repos/${repo}/releases/tags/${ENGINE_CACHE_TAG}`, '--jq', '.id'])).trim();
	const out = await gh([
		'api',
		'--paginate',
		`repos/${repo}/releases/${id}/assets?per_page=100`,
		'--jq',
		'.[] | [.id, .name, .created_at] | @tsv',
	]);
	return out
		.split('\n')
		.filter(Boolean)
		.map((line) => {
			const [assetId, name, createdAt] = line.split('\t');
			return { id: Number(assetId), name, created_at: createdAt };
		});
}

/**
 * Publish every engine in `dir` and prune the release.
 *
 * @param {Object} opts
 * @param {string} opts.dir - Directory holding the build's server artifacts
 * @param {string} opts.repo - owner/name
 * @param {number} [opts.keep] - Hashes to keep after pruning
 * @param {boolean} [opts.dryRun] - Print the writes instead of making them
 * @param {Function} [opts.gh] - Runs gh with an argument list, resolves with stdout
 * @param {Function} [opts.log]
 * @param {Function} [opts.wait] - Sleep between retries
 * @returns {Promise<{published: string[], removed: string[], failed: string[]}>}
 */
export async function publish({
	dir,
	repo,
	keep = DEFAULT_KEEP,
	dryRun = false,
	gh = runGh,
	log = console.log,
	wait = sleep,
}) {
	const artifacts = await collectArtifacts(dir);
	for (const a of artifacts) log(`${a.platform}: buildHash ${a.hash}, vcpkg ${a.vcpkg}`);

	try {
		await ensureRelease(gh, repo, { dryRun, log });
	} catch (error) {
		// A dry run without credentials still shows what it would upload
		if (!dryRun) throw error;
		log(`[dry-run] cannot read release ${ENGINE_CACHE_TAG}: ${error.message}`);
	}

	// gh names an asset after its file, so the upload names are links in a
	// directory beside the artifacts (same filesystem, no 1 GB copy)
	const staging = await fs.mkdtemp(path.join(dir, '.engine-cache-'));
	const published = [];
	const failed = [];
	try {
		await Promise.all(
			artifacts.map(async (a) => {
				const archive = path.join(staging, engineAssetName(a.hash, a.platform, a.ext));
				const manifest = path.join(staging, engineAssetName(a.hash, a.platform, 'manifest.json'));
				await linkOrCopy(a.archive, archive);
				await linkOrCopy(a.manifest, manifest);

				try {
					// The archive first: a manifest that can be read means its archive is there
					for (const file of [archive, manifest]) {
						const args = ['release', 'upload', ENGINE_CACHE_TAG, file, '--repo', repo, '--clobber'];
						if (dryRun) {
							log(`[dry-run] would upload ${path.basename(file)}`);
							continue;
						}
						await withRetry(`Upload of ${path.basename(file)}`, () => gh(args), { wait, log });
						log(`Uploaded ${path.basename(file)}`);
					}
					published.push(a.hash.slice(0, 16));
				} catch (error) {
					log(`::error::${a.platform}: ${error.message}`);
					failed.push(a.platform);
				}
			})
		);
	} finally {
		await fs.rm(staging, { recursive: true, force: true });
	}

	const removed = await prune(gh, repo, keep, new Set(artifacts.map((a) => a.hash.slice(0, 16))), { dryRun, log });
	return { published: [...new Set(published)], removed, failed };
}

async function prune(gh, repo, keep, protect, { dryRun, log }) {
	let assets;
	try {
		assets = await listAssets(gh, repo);
	} catch (error) {
		// A dry run before the release exists has nothing to prune
		if (dryRun) {
			log(`[dry-run] cannot list ${ENGINE_CACHE_TAG} assets: ${error.message}`);
			return [];
		}
		throw error;
	}

	const { kept, remove } = planPrune(assets, keep, protect);
	log(`Keeping ${kept.length} hash(es): ${kept.join(', ')}`);

	const removed = [];
	for (const asset of remove) {
		if (dryRun) {
			log(`[dry-run] would delete ${asset.name}`);
			removed.push(asset.name);
			continue;
		}
		try {
			await gh(['api', '-X', 'DELETE', `repos/${repo}/releases/assets/${asset.id}`]);
			log(`Deleted ${asset.name}`);
		} catch (error) {
			// A concurrent run pruned it first
			if (!/HTTP 404|Not Found/i.test(error.message)) throw error;
		}
		removed.push(asset.name);
	}
	return removed;
}

async function linkOrCopy(from, to) {
	try {
		await fs.link(from, to);
	} catch {
		await fs.copyFile(from, to);
	}
}

/** Parse argv, publish, and set the exit code. */
async function main() {
	const args = process.argv.slice(2);
	const dir = args.find((a) => !a.startsWith('--'));
	const dryRun = args.includes('--dry-run');
	const keepArg = args.find((a) => a.startsWith('--keep='));
	const keep = keepArg ? Number(keepArg.slice('--keep='.length)) : DEFAULT_KEEP;
	const repo = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;

	if (!dir || !repo || !Number.isInteger(keep) || keep < 1) {
		console.error('Usage: GH_REPO=owner/name engine-cache-publish.mjs <artifacts-dir> [--keep=N] [--dry-run]');
		process.exitCode = 2;
		return;
	}

	const { published, removed, failed } = await publish({ dir, repo, keep, dryRun });
	console.log(
		`Published ${published.length} hash(es), removed ${removed.length} asset(s)${dryRun ? ' (dry run)' : ''}.`
	);
	if (failed.length) {
		console.error(`Failed to publish: ${failed.join(', ')}`);
		process.exitCode = 1;
	}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	await main();
}
