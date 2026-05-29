// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * One-shot icon migration script.
 *
 * Moves every SVG from `packages/shared-ui/src/assets/nodes/` into the
 * directories of the service JSONs that reference it. Same icon may be
 * referenced by multiple nodes — in that case we copy it into each owning
 * directory (byte-identical duplicates by design).
 *
 * Special cases:
 *   - `unknown.svg` is not referenced by any service JSON (it is the
 *     runtime fallback). It is copied to `nodes/src/nodes/core/`.
 *   - Any legacy SVG that is not referenced anywhere AND is not `unknown.svg`
 *     is reported as an orphan; it will NOT be deleted automatically.
 *
 * After the moves are made, the original SVGs in the legacy dir are deleted
 * (only those that were successfully relocated).
 *
 * Run:  node scripts/migrate-icons.mjs
 */

import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const NODES_DIR = path.join(REPO_ROOT, 'nodes', 'src', 'nodes');
const LEGACY_DIR = path.join(
	REPO_ROOT,
	'packages',
	'shared-ui',
	'src',
	'assets',
	'nodes',
);
const FALLBACK_TARGET = path.join(NODES_DIR, 'core');
const FALLBACK_NAME = 'unknown.svg';

function rel(p) {
	return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

/**
 * Strip JSONC-style comments (// line, /* block *\/) and trailing commas.
 * Good enough for the service JSON files in this repo, which only use
 * top-of-file comments and trailing commas inside arrays/objects.
 */
function parseJsonc(text) {
	const stripped = text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')
		.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(stripped);
}

async function* walk(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (e) {
		if (e.code === 'ENOENT') return;
		throw e;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === '__pycache__' || entry.name === 'node_modules') continue;
			yield* walk(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

// ---------------------------------------------------------------------------
// Build: { iconBaseName -> Set<target node directory> }
// ---------------------------------------------------------------------------

const iconTargets = new Map(); // iconFilename -> Set<targetDir>

const serviceJsonFiles = [];
for await (const f of walk(NODES_DIR)) {
	if (/[\\/]services[^\\/]*\.json$/i.test(f)) serviceJsonFiles.push(f);
}

// Collect every (icon, target directory) pair across all service JSONs.
//
// File shapes seen in the repo:
//   - single service:     `{ "title": "...", "icon": "x.svg", ... }`
//   - collection of services: `{ "svcKey": { "icon": "x.svg", ... }, ... }`
//     or                     `[ { "icon": "x.svg", ... }, ... ]`
// We walk all three and collect icon strings from any nested service-shaped
// object that has an `icon: string` field.
function collectIcons(node, into) {
	if (!node || typeof node !== 'object') return;
	if (typeof node.icon === 'string') into.push(node.icon);
	if (Array.isArray(node)) {
		for (const child of node) collectIcons(child, into);
	} else {
		for (const child of Object.values(node)) collectIcons(child, into);
	}
}

for (const jsonFile of serviceJsonFiles) {
	let parsed;
	try {
		parsed = parseJsonc(await readFile(jsonFile, 'utf8'));
	} catch (e) {
		console.warn(`! skipping invalid JSON ${rel(jsonFile)}: ${e.message}`);
		continue;
	}
	const dir = path.dirname(jsonFile);
	const icons = [];
	collectIcons(parsed, icons);
	for (const iconValue of icons) {
		if (/^(https?|ftp):\/\//i.test(iconValue)) continue;
		// `iconValue` is used as a destination filename in path.join(targetDir,
		// destName) below. Reject anything that isn't a plain basename so a
		// malformed service JSON (e.g. `"icon": "../../foo.svg"`) can't write
		// outside the owning node directory.
		if (iconValue !== path.basename(iconValue)) {
			console.warn(`! skipping non-basename icon "${iconValue}" in ${rel(jsonFile)}`);
			continue;
		}
		if (!iconTargets.has(iconValue)) iconTargets.set(iconValue, new Set());
		iconTargets.get(iconValue).add(dir);
	}
}

// ---------------------------------------------------------------------------
// Walk the legacy dir, copy each SVG into all target dirs
// ---------------------------------------------------------------------------

const legacySvgs = [];
if (existsSync(LEGACY_DIR)) {
	for await (const f of walk(LEGACY_DIR)) {
		if (/\.svg$/i.test(f)) legacySvgs.push(f);
	}
}

const movedSources = new Set();
const orphans = [];
let totalCopies = 0;

// Build a case-insensitive lookup from the iconTargets map so that legacy
// SVGs with case variations (e.g. `Prompt.svg`) match JSON references with
// the canonical casing (`prompt.svg`).
//
// When two iconTargets keys collide on case (e.g. `Foo.svg` and `foo.svg`),
// merge their target directories instead of letting the second entry
// overwrite the first — otherwise some node dirs silently miss the copy.
// The first-seen canonical name wins (arbitrary but deterministic over the
// Map iteration order, which is insertion order).
const iconTargetsLower = new Map();
for (const [key, set] of iconTargets) {
	const lower = key.toLowerCase();
	const existing = iconTargetsLower.get(lower);
	if (existing) {
		for (const dir of set) existing.targets.add(dir);
	} else {
		iconTargetsLower.set(lower, { canonicalName: key, targets: new Set(set) });
	}
}

for (const sourceSvg of legacySvgs) {
	const name = path.basename(sourceSvg);

	// `unknown.svg` is the universal fallback. It must always end up at
	// nodes/src/nodes/core/unknown.svg, regardless of whether some service
	// JSON happens to reference it explicitly. Handle it first so the
	// fallback target is guaranteed to receive the file.
	if (name.toLowerCase() === FALLBACK_NAME.toLowerCase()) {
		if (!existsSync(FALLBACK_TARGET)) await mkdir(FALLBACK_TARGET, { recursive: true });
		const dest = path.join(FALLBACK_TARGET, FALLBACK_NAME);
		await writeFile(dest, await readFile(sourceSvg));
		console.log(`  fallback → ${rel(dest)}`);
		totalCopies += 1;
		movedSources.add(sourceSvg);
		continue;
	}

	const lookup = iconTargetsLower.get(name.toLowerCase());

	if (!lookup) {
		orphans.push(sourceSvg);
		continue;
	}

	// Use the JSON-referenced casing for the destination filename. This makes
	// the migration safe on case-sensitive filesystems (e.g. Linux CI).
	const destName = lookup.canonicalName;
	const content = await readFile(sourceSvg);
	for (const targetDir of lookup.targets) {
		const dest = path.join(targetDir, destName);
		await writeFile(dest, content);
		console.log(`  ${name} → ${rel(dest)}`);
		totalCopies += 1;
	}
	movedSources.add(sourceSvg);
}

// ---------------------------------------------------------------------------
// Delete originals that were successfully relocated
// ---------------------------------------------------------------------------

for (const source of movedSources) {
	await unlink(source);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log('');
console.log(`Migrated ${movedSources.size} legacy SVG(s) into ${totalCopies} target location(s).`);

if (orphans.length) {
	console.log(`\nOrphaned SVGs (NOT moved, NOT deleted — please review):`);
	for (const o of orphans) console.log(`  ? ${rel(o)}`);
	console.log(`These are not referenced by any service JSON's "icon" field.`);
}

// Flag any service-referenced icons that had no source SVG in the legacy dir.
// Match case-insensitively to align with the relocation logic above
// (`iconTargetsLower`), otherwise we emit false-positive missing entries for
// icons that exist in the legacy dir under a different casing.
const legacyByNameLower = new Set(legacySvgs.map((p) => path.basename(p).toLowerCase()));
const missing = [];
for (const name of iconTargets.keys()) {
	if (!legacyByNameLower.has(name.toLowerCase())) missing.push(name);
}
if (missing.length) {
	console.log(`\nReferenced-but-missing icons (no source SVG in legacy dir):`);
	for (const name of missing) console.log(`  ? ${name}`);
	console.log(`These are referenced by service JSONs but had no source file in ${rel(LEGACY_DIR)}.`);
	console.log(`If they already exist in their node dirs, that's fine.`);
}
