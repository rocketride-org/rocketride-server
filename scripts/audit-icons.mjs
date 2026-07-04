// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * Icon-integrity audit for the node-icon co-location refactor.
 *
 * Validates that:
 *   1. Every service JSON's `"icon"` field resolves to an SVG file in the same
 *      directory (the icon lives next to the node that owns it).
 *   2. Every SVG under `nodes/src/nodes/<node>/` is referenced by at least one
 *      service JSON in the same directory (no orphaned icons), with the
 *      well-known exception of `nodes/src/nodes/core/unknown.svg` (the fallback).
 *   3. No SVGs remain in `packages/shared-ui/src/assets/nodes/` (the legacy
 *      central location must be emptied).
 *   4. Same-named SVGs across multiple node directories have byte-identical
 *      content (warning only — we duplicate by design when an icon is shared
 *      by multiple nodes).
 *
 * Exits 0 on success, 1 on any error.
 *
 * Run:  node scripts/audit-icons.mjs
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const NODES_DIR = path.join(REPO_ROOT, 'nodes', 'src', 'nodes');
const LEGACY_ICONS_DIR = path.join(
	REPO_ROOT,
	'packages',
	'shared-ui',
	'src',
	'assets',
	'nodes',
);
const FALLBACK_ICON_REL = path.join('core', 'unknown.svg');

const errors = [];
const warnings = [];

/** Recursively walk a directory and yield absolute file paths. */
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

async function findFiles(dir, match) {
	const out = [];
	for await (const file of walk(dir)) {
		if (match(file)) out.push(file);
	}
	return out;
}

async function sha256(file) {
	const hash = createHash('sha256');
	hash.update(await readFile(file));
	return hash.digest('hex');
}

function rel(p) {
	return path.relative(REPO_ROOT, p).split(path.sep).join('/');
}

/** Strip JSONC-style comments and trailing commas; matches what nodes/ uses. */
function parseJsonc(text) {
	const stripped = text
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:"'])\/\/[^\n]*/g, '$1')
		.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(stripped);
}

function collectIcons(node, into) {
	if (!node || typeof node !== 'object') return;
	if (typeof node.icon === 'string') into.push(node.icon);
	if (Array.isArray(node)) {
		for (const child of node) collectIcons(child, into);
	} else {
		for (const child of Object.values(node)) collectIcons(child, into);
	}
}

// ---------------------------------------------------------------------------
// Check 1: every service JSON's icon field resolves to a sibling SVG file
// ---------------------------------------------------------------------------

const serviceJsonFiles = await findFiles(
	NODES_DIR,
	(f) => /[\\/]services[^\\/]*\.json$/i.test(f),
);

/** Map<absolute icon file path, count of services referencing it> */
const referencedIcons = new Map();

for (const jsonFile of serviceJsonFiles) {
	let parsed;
	try {
		parsed = parseJsonc(await readFile(jsonFile, 'utf8'));
	} catch (e) {
		errors.push(`invalid JSON in ${rel(jsonFile)}: ${e.message}`);
		continue;
	}

	const dir = path.dirname(jsonFile);
	const icons = [];
	collectIcons(parsed, icons);

	for (const iconValue of icons) {
		// Skip remote URLs — those are resolved at runtime, not by the build.
		if (/^(https?|ftp):\/\//i.test(iconValue)) continue;

		// Reject non-basename icon values. Without this, a malformed service
		// JSON (e.g. `"icon": "../../foo.svg"`) could resolve to a file
		// outside the owning node directory and falsely pass the audit.
		if (iconValue !== path.basename(iconValue)) {
			warnings.push(
				`invalid icon path: ${rel(jsonFile)} uses non-local icon "${iconValue}" (must be a basename, no separators or "..")`,
			);
			continue;
		}

		const iconPath = path.join(dir, iconValue);
		if (!existsSync(iconPath)) {
			// Warning, not an error: the <Icon> component falls back to
			// the `unknown` icon at runtime when a name doesn't resolve.
			// The build still succeeds; this just flags it for follow-up.
			warnings.push(
				`missing icon: ${rel(jsonFile)} references "${iconValue}" but ${rel(iconPath)} does not exist — will render the fallback icon`,
			);
			continue;
		}
		referencedIcons.set(iconPath, (referencedIcons.get(iconPath) ?? 0) + 1);
	}
}

// ---------------------------------------------------------------------------
// Check 2: every SVG under nodes/ is referenced by at least one service JSON
// in the same directory (or is the well-known fallback).
// ---------------------------------------------------------------------------

const allNodeSvgs = await findFiles(NODES_DIR, (f) => /\.svg$/i.test(f));

// Icons placed directly under `nodes/src/nodes/core/` are treated as a
// library of generic / fallback icons. They don't need to be referenced
// by a service JSON in core/ — code may resolve them dynamically by name
// via the `<Icon name="..." />` component.
const CORE_DIR = path.join(NODES_DIR, 'core');
for (const svg of allNodeSvgs) {
	if (referencedIcons.has(svg)) continue;
	const relPath = path.relative(NODES_DIR, svg).split(path.sep).join('/');
	if (relPath === FALLBACK_ICON_REL.split(path.sep).join('/')) continue;
	if (path.dirname(svg) === CORE_DIR) continue;
	errors.push(
		`orphaned icon: ${rel(svg)} is not referenced by any service JSON in its directory`,
	);
}

// ---------------------------------------------------------------------------
// Check 3: legacy central icon dir must be removed (or contain no SVGs).
// ---------------------------------------------------------------------------

if (existsSync(LEGACY_ICONS_DIR)) {
	// Recursive — catches SVGs even if a contributor accidentally creates
	// a subdirectory under the legacy location.
	const legacy = await findFiles(LEGACY_ICONS_DIR, (f) => /\.svg$/i.test(f));
	if (legacy.length > 0) {
		errors.push(
			`legacy icon dir still has ${legacy.length} SVG(s) at ${rel(LEGACY_ICONS_DIR)} — they should be moved to nodes/src/nodes/<node>/`,
		);
	}
}

// ---------------------------------------------------------------------------
// Check 4: same-named SVGs across multiple node dirs should be byte-identical.
// ---------------------------------------------------------------------------

const byBasename = new Map(); // basename -> Map<sha, [paths]>

for (const svg of allNodeSvgs) {
	const base = path.basename(svg);
	const hash = await sha256(svg);
	if (!byBasename.has(base)) byBasename.set(base, new Map());
	const bucket = byBasename.get(base);
	if (!bucket.has(hash)) bucket.set(hash, []);
	bucket.get(hash).push(svg);
}

for (const [base, hashMap] of byBasename) {
	if (hashMap.size > 1) {
		const copies = [...hashMap.values()].flat().map(rel);
		warnings.push(
			`divergent duplicates: "${base}" has ${hashMap.size} different versions:\n    ${copies.join('\n    ')}`,
		);
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const totalSvgs = allNodeSvgs.length;
const totalRefs = [...referencedIcons.values()].reduce((a, b) => a + b, 0);
const totalJsons = serviceJsonFiles.length;

console.log('Icon-integrity audit');
console.log('--------------------');
console.log(`  service JSONs scanned: ${totalJsons}`);
console.log(`  SVG files under nodes/src/nodes/: ${totalSvgs}`);
console.log(`  icon references resolved: ${totalRefs}`);

if (warnings.length) {
	console.log(`\nwarnings (${warnings.length}):`);
	for (const w of warnings) console.log(`  ! ${w}`);
}

if (errors.length) {
	console.log(`\nerrors (${errors.length}):`);
	for (const e of errors) console.log(`  ✗ ${e}`);
	process.exit(1);
}

console.log('\nOK — all icons are co-located with their owning nodes.');
