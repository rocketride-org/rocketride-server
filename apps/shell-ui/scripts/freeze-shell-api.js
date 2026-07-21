// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

'use strict';

// =============================================================================
// shell:freeze — generate the next frozen shell-api contract version
// =============================================================================
//
// Backs the `./builder shell:freeze` builder target. Bundles shell-ui's curated
// api.ts surface into a single self-contained .d.ts and APPENDS it under
// packages/shell-api/versions/ as the next frozen version. Existing versions are
// never rewritten or dropped.
//
// The contract is the INTERSECTION of every frozen version (`ShellApiLatest` in
// index.ts). shell-ui's api.ts holds the live surface against it (`_contractHold`),
// so a removed or breaking member fails shell-ui's OWN `tsc --noEmit` — there is
// no gate here to override and no freeze path that drops a member (freezing only
// ever appends). This file also pins each exported TYPE against the earliest
// version that froze it (contract-check.generated.ts).
//
// Usage:  node freeze-shell-api.js [--check | --regen]
//   (no flag)  full freeze — appends the next version + re-accumulates the contract.
//   --check    CI mode — nonzero exit if the live surface differs from the newest
//              frozen version (no freeze committed).
//   --regen    reapply the accumulated barrels + conformance over the EXISTING
//              versions without appending one (used when the mechanism, not the
//              surface, changes).
// =============================================================================

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// =============================================================================
// PATHS
// =============================================================================

const SCRIPTS_DIR = __dirname; // apps/shell-ui/scripts
const APP_ROOT = path.resolve(SCRIPTS_DIR, '..'); // apps/shell-ui
const SRC_DIR = path.join(APP_ROOT, 'src');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..'); // rocketride-server
const CONTRACT_TSCONFIG = path.join(APP_ROOT, 'tsconfig.contract.json');
const SHARED_UI_TSCONFIG = path.join(REPO_ROOT, 'packages', 'shared-ui', 'tsconfig.json');
const SHELL_API_DIR = path.join(REPO_ROOT, 'packages', 'shell-api');
const VERSIONS_DIR = path.join(SHELL_API_DIR, 'versions');
const INDEX_TS = path.join(SHELL_API_DIR, 'index.ts');
const LATEST_TS = path.join(SHELL_API_DIR, 'latest.ts');
const CONTRACT_CHECK = path.join(SRC_DIR, 'contract-check.generated.ts');
const APIVER_TS = path.join(SRC_DIR, 'apiver.ts');
const TMP_DIR = path.join(SHELL_API_DIR, '.freeze-tmp');

// Markers wrapping the generated declaration body inside each version file, so
// the no-op comparison can isolate the bundle from the provenance header and
// the version-specific type alias.
const BEGIN = '// ===== BEGIN FROZEN BUNDLE — do not edit =====';
const END = '// ===== END FROZEN BUNDLE =====';

// NOTE — the client must never appear in an INPUT position on the surface.
// The RocketRideClient (an MF shared singleton the shell serves to every app)
// is frozen INLINE in the bundle with a covariant type floor: additions pass,
// removals fail — append-only, matching how the singleton actually evolves.
// But if any surface member takes the client as a function parameter or
// component prop, the contravariant VALUE floors flip direction there and
// every additive SDK member reads as a breaking change (this bit
// WorkspaceProvider once; it now reads the client from useShellConnection()
// instead of props). Components should always source the client from
// useShellConnection()/getClient(), never accept it as input.

// Reusable MIT license header for the hand-shaped generated files.
const MIT_HEADER = [
	'// MIT License',
	'//',
	'// Copyright (c) 2026 Aparavi Software AG',
	'//',
	'// Permission is hereby granted, free of charge, to any person obtaining a copy',
	'// of this software and associated documentation files (the "Software"), to deal',
	'// in the Software without restriction, including without limitation the rights',
	'// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
	'// copies of the Software, and to permit persons to whom the Software is',
	'// furnished to do so, subject to the following conditions:',
	'//',
	'// The above copyright notice and this permission notice shall be included in all',
	'// copies or substantial portions of the Software.',
	'//',
	'// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
	'// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
	'// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
	'// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
	'// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
	'// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
	'// SOFTWARE.',
].join('\n');

// =============================================================================
// BINARY RESOLUTION
// =============================================================================

/**
 * Resolve a workspace binary and its version by walking node_modules from the
 * shell-ui app root, so the freeze works regardless of where the monorepo
 * hoisted the dependency.
 *
 * @param {string} pkg - npm package name (e.g. 'typescript').
 * @param {string} binName - the bin entry to select when `bin` is a map.
 * @returns {{ binPath: string, version: string }}
 */
function resolveBin(pkg, binName) {
	// Locate the package's manifest starting from the app root.
	const pkgJsonPath = require.resolve(`${pkg}/package.json`, { paths: [APP_ROOT] });
	const pkgDir = path.dirname(pkgJsonPath);
	const manifest = require(pkgJsonPath);
	// The `bin` field is either a string or a name→path map.
	const binRel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[binName];
	return { binPath: path.join(pkgDir, binRel), version: manifest.version };
}

const TSC = resolveBin('typescript', 'tsc');
const DBG = resolveBin('dts-bundle-generator', 'dts-bundle-generator');

// The TypeScript compiler API, used to strip non-public members from the
// bundle (see stripNonPublicMembers).
const ts = require(require.resolve('typescript', { paths: [APP_ROOT] }));

// =============================================================================
// BUNDLE POST-PROCESSING
// =============================================================================

// Strip non-public class members from the generated bundle so inlined classes
// compare STRUCTURALLY rather than nominally. This still matters even with the
// SDK's dist/types now trimmed at build time: dts-bundle-generator also inlines
// shell-ui's OWN classes (ConnectionManager, the auth providers) from source,
// which keep their privates. Shared with the SDK trim so both agree on "not
// public" — see scripts/lib/stripDts.js.
const { stripNonPublicMembers } = require('../../../scripts/lib/stripDts');

// =============================================================================
// PROCESS HELPERS
// =============================================================================

/**
 * Run a Node CLI (resolved binary JS) and capture combined output.
 *
 * @param {string} binPath - Absolute path to the CLI's entry .js.
 * @param {string[]} args - CLI arguments.
 * @param {string} cwd - Working directory for the child process.
 * @returns {{ code: number, output: string }}
 */
function runNodeBin(binPath, args, cwd) {
	try {
		// execFileSync throws on a nonzero exit; capture stdout on success.
		const out = execFileSync(process.execPath, [binPath, ...args], {
			cwd,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		return { code: 0, output: out };
	} catch (err) {
		return { code: err.status || 1, output: `${err.stdout || ''}${err.stderr || ''}` };
	}
}

/** Prefixed console logger for freeze progress. */
function log(msg) {
	console.log(`[shell:freeze] ${msg}`);
}

/** Read the current rocketride-server git commit (or 'unknown'). */
function gitCommit() {
	try {
		return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
	} catch {
		return 'unknown';
	}
}

/** Remove the scratch directory used during generation. */
function cleanup() {
	try {
		fs.rmSync(TMP_DIR, { recursive: true, force: true });
	} catch {
		// Best-effort — a leftover temp dir is harmless.
	}
}

// =============================================================================
// FREEZE STEPS
// =============================================================================

/**
 * Step 1 — type-check shared-ui and the shell-ui contract program. A frozen
 * contract must never be generated from a broken tree.
 */
function preCheck() {
	log('Pre-check: tsc --noEmit (shared-ui + shell-ui contract)...');
	for (const [label, tsconfig] of [
		['shared-ui', SHARED_UI_TSCONFIG],
		['shell-ui (contract)', CONTRACT_TSCONFIG],
	]) {
		const r = runNodeBin(TSC.binPath, ['--noEmit', '-p', tsconfig], REPO_ROOT);
		if (r.code !== 0) {
			console.error(`[shell:freeze] Pre-check FAILED for ${label}:`);
			console.error(r.output);
			cleanup();
			process.exit(1);
		}
	}
	log('Pre-check passed.');
}

/**
 * Step 2 — bundle api.ts into a single self-contained .d.ts and return its body
 * (banner stripped). dts-bundle-generator resolves triple-slash references from
 * its CWD, so it is run from src/ where the `../../../` reference in api.ts also
 * resolves the way tsc (file-relative) resolves it.
 *
 * @returns {string} The generated declaration body.
 */
function generateCandidate() {
	fs.mkdirSync(TMP_DIR, { recursive: true });
	const candidatePath = path.join(TMP_DIR, 'candidate.d.ts');
	const r = runNodeBin(
		DBG.binPath,
		[
			'--project', path.relative(SRC_DIR, CONTRACT_TSCONFIG),
			'--no-check',
			'--no-banner',
			'--export-referenced-types=false',
			'-o', candidatePath,
			'api.ts',
		],
		SRC_DIR,
	);
	if (r.code !== 0 || !fs.existsSync(candidatePath)) {
		console.error('[shell:freeze] dts-bundle-generator FAILED:');
		console.error(r.output);
		cleanup();
		process.exit(1);
	}
	// Strip non-public class members so inlined classes compare structurally,
	// then normalize trailing whitespace so the no-op comparison is stable.
	const stripped = stripNonPublicMembers(fs.readFileSync(candidatePath, 'utf8'), ts);
	return `${stripped.replace(/\s+$/, '')}\n`;
}

/**
 * Step 3 — determine the next version number from existing snapshots.
 *
 * @returns {{ next: number, prev: number }} `prev` is -1 when none exist.
 */
function determineVersions() {
	if (!fs.existsSync(VERSIONS_DIR)) return { next: 0, prev: -1 };
	const nums = fs
		.readdirSync(VERSIONS_DIR)
		.map((f) => /^v(\d+)\.d\.ts$/.exec(f))
		.filter(Boolean)
		.map((m) => parseInt(m[1], 10));
	if (nums.length === 0) return { next: 0, prev: -1 };
	const max = Math.max(...nums);
	return { next: max + 1, prev: max };
}

/** Extract the declaration body between the BEGIN/END markers of a version file. */
function extractBundleBody(fileContent) {
	const start = fileContent.indexOf(BEGIN);
	const end = fileContent.indexOf(END);
	if (start === -1 || end === -1) return null;
	return fileContent.slice(start + BEGIN.length, end).trim();
}

// NOTE: there is deliberately no compatibility gate here anymore. Backward
// compatibility is enforced structurally by the accumulated contract itself: the
// per-version floors in contract-check.generated.ts (and the anchor in
// contract-hold.ts) assert the live surface still satisfies EACH frozen version.
// A removed/broken member fails shell-ui's own tsc, and freezing only ever
// appends a version — there is no tool path that drops one. That makes the old
// gate (and its resettable escape hatch) unnecessary.

/**
 * Collect the TOP-LEVEL member names of the `shellApi` value object from a bundle
 * body, tracking brace depth so nested object-type keys are ignored.
 *
 * @param {string} bundleText - A generated/frozen bundle body.
 * @returns {Set<string>} The value-member names (e.g. useShellConnection, getClient).
 */
function shellApiMemberNames(bundleText) {
	const names = new Set();
	let started = false;
	let depth = 0;
	for (const line of bundleText.split('\n')) {
		if (!started) {
			if (/declare const shellApi:\s*\{/.test(line)) started = true;
			else continue;
		} else if (depth === 1) {
			// Only depth-1 lines are top-level members of the object.
			const m = /^\s*readonly (\w+):/.exec(line);
			if (m) names.add(m[1]);
		}
		for (const ch of line) {
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
		}
		if (started && depth === 0) break;
	}
	return names;
}

/**
 * The set of exported surface names in a bundle: value members (prefixed `v:`)
 * plus standalone type exports (prefixed `t:`). Order-independent, so cosmetic
 * reordering of api.ts does not change it.
 *
 * @param {string} bundleText - A generated/frozen bundle body.
 * @returns {Set<string>} Namespaced surface names.
 */
function surfaceNames(bundleText) {
	const names = new Set();
	for (const n of shellApiMemberNames(bundleText)) names.add(`v:${n}`);
	for (const n of parseExportedTypes(bundleText)) {
		if (!/^ShellApiV\d+$/.test(n)) names.add(`t:${n}`);
	}
	return names;
}

/**
 * Is there an ACTIONABLE change vs the newest frozen version — i.e. a genuinely
 * NEW exported name (value member or type)? Removals can't reach here (the floors
 * fail shell-ui's build first), and the floors guarantee the candidate is a
 * superset of the newest, so the only possibility is additions. A cosmetic edit
 * (reordering, whitespace) or a floor-compatible type tweak leaves the name set
 * unchanged and is therefore NOT actionable — no redundant version is minted.
 *
 * @param {number} prev - Newest existing version, or -1.
 * @param {string} candidateBody - The freshly generated bundle body.
 * @returns {boolean} True when a new name appeared since the newest version.
 */
function hasActionableChange(prev, candidateBody) {
	if (prev < 0) return true; // no prior version — the first freeze is always actionable
	const prevBody = extractBundleBody(fs.readFileSync(path.join(VERSIONS_DIR, `v${prev}.d.ts`), 'utf8'));
	if (prevBody === null) return true;
	const prevNames = surfaceNames(prevBody);
	for (const n of surfaceNames(candidateBody)) {
		if (!prevNames.has(n)) return true;
	}
	return false;
}

/**
 * Auto-write the shell-api version into src/apiver.ts. Keeps `SHELL_API_VERSION`
 * in lock-step with the newest frozen version with zero manual steps; the app
 * registration step reads the same file to stamp each app's apps.json entry.
 * Rewrites only the numeric literal.
 *
 * @param {number} n - The version number to write.
 */
function writeApiVersion(n) {
	const src = fs.readFileSync(APIVER_TS, 'utf8');
	const re = /export const SHELL_API_VERSION = \d+ as const;/;
	if (!re.test(src)) {
		console.error(`[shell:freeze] Could not find SHELL_API_VERSION literal in ${APIVER_TS}`);
		cleanup();
		process.exit(1);
	}
	fs.writeFileSync(APIVER_TS, src.replace(re, `export const SHELL_API_VERSION = ${n} as const;`));
}

/** Build the provenance header stamped onto each frozen version file. */
function versionHeader(next) {
	return [
		MIT_HEADER,
		'',
		'// =============================================================================',
		`// FROZEN shell-api contract — ShellApiV${next} — never edit by hand`,
		'// =============================================================================',
		`// Generated:     ${new Date().toISOString()}`,
		`// Source commit: ${gitCommit()}`,
		`// Generator:     dts-bundle-generator@${DBG.version}`,
		'// Produced by:   ./builder shell:freeze',
		'// =============================================================================',
	].join('\n');
}

/**
 * Step 6a — write the frozen version snapshot.
 *
 * @param {number} next - Version number.
 * @param {string} candidateBody - The generated bundle body.
 */
function writeVersion(next, candidateBody) {
	fs.mkdirSync(VERSIONS_DIR, { recursive: true });
	const content = [
		versionHeader(next),
		'',
		BEGIN,
		candidateBody.trim(),
		END,
		`export type ShellApiV${next} = ShellApiShape;`,
		'',
	].join('\n');
	fs.writeFileSync(path.join(VERSIONS_DIR, `v${next}.d.ts`), content);
}

/**
 * Step 6b — regenerate latest.ts and index.ts from the full set of versions.
 *
 * @param {number} maxN - The newest (just-frozen) version number.
 */
function regenerateBarrels(maxN) {
	const generatedNote = [
		'',
		'// =============================================================================',
		'// GENERATED by `./builder shell:freeze` — do not edit by hand.',
		'// =============================================================================',
		'',
	].join('\n');

	// latest.ts re-exports the newest version's full surface. `export type *`
	// (not `export *`) keeps this a pure type re-export: shell-api is a types-only
	// package and its versions exist only as `.d.ts`, so a value re-export would
	// emit a runtime `import './versions/vN'` (module-not-found) if ever bundled.
	fs.writeFileSync(LATEST_TS, `${MIT_HEADER}\n${generatedNote}export type * from './versions/v${maxN}';\n`);

	// index.ts maps every version number to its snapshot type and tracks latest.
	const versions = [];
	for (let i = 0; i <= maxN; i++) versions.push(i);
	const imports = versions.map((i) => `import type { ShellApiV${i} } from './versions/v${i}';`).join('\n');
	const mapEntries = versions.map((i) => `\t${i}: ShellApiV${i};`).join('\n');
	const index = [
		MIT_HEADER,
		generatedNote.trimEnd(),
		'',
		imports,
		'',
		'/** Registry mapping each frozen shell API version number to its type snapshot. */',
		`export interface ShellApiVersions {\n${mapEntries}\n}`,
		'',
		'/**',
		' * The newest frozen shell API version — a convenience alias for consumers.',
		' *',
		' * Accumulation is NOT an intersection of versions: that reduces nominal members',
		' * (enums like ConnectionState) to `never`. The "nothing ever frozen can be',
		" * removed\" guarantee is the per-version floors in shell-ui's",
		' * contract-check.generated.ts, which assert the live surface still satisfies',
		' * EACH frozen version separately.',
		' */',
		`export type ShellApiLatest = ShellApiVersions[${maxN}];`,
		'',
		// Type-only re-export: everything in shell-api is types, so this must never
		// emit a runtime import (see latest.ts above).
		"export type * from './latest';",
		'',
	].join('\n');
	fs.writeFileSync(INDEX_TS, index);
}

/** Collect the individually-exported named types from the bundle body. */
function parseExportedTypes(candidateBody) {
	const names = new Set();
	// Inline `export interface X` / `export type X` declarations, plus
	// explicitly-exported classes (`export declare class X`) — classes only
	// become exported here when api.ts re-exports them by name (with
	// --export-referenced-types=false merely-referenced classes stay
	// unexported), so each collected name is importable from './api' and its
	// covariant type floor gives the class an append-only guarantee. This is
	// how the inlined RocketRideClient is frozen (additions pass, removals
	// fail) without entangling the contravariant value floors.
	let m;
	const inlineRe = /^export (?:interface|type|declare (?:abstract )?class) (\w+)/gm;
	while ((m = inlineRe.exec(candidateBody))) names.add(m[1]);
	// Re-export blocks: `export { A as B, C }`.
	const blockRe = /export \{([^}]*)\}/g;
	while ((m = blockRe.exec(candidateBody))) {
		for (const part of m[1].split(',')) {
			const token = part.trim();
			if (!token) continue;
			const asMatch = /\w+\s+as\s+(\w+)/.exec(token);
			names.add(asMatch ? asMatch[1] : token);
		}
	}
	// Exclude the contract machinery — it is checked via the ShellApiShape gate.
	names.delete('ShellApiShape');
	return [...names];
}

/**
 * Map each individually-exported named type to the EARLIEST frozen version that
 * declared it. Derived from the frozen version files (not the live surface), so a
 * type REMOVED from api.ts is still in the map — its `Current_` import in the
 * conformance file then fails, catching the removal. A regeneration cannot erase
 * it without deleting a frozen version file.
 *
 * @param {number} maxN - Newest frozen version number.
 * @returns {Map<string, number>} type name -> earliest version that froze it.
 */
function collectFrozenTypes(maxN) {
	const earliest = new Map();
	for (let v = 0; v <= maxN; v++) {
		const p = path.join(VERSIONS_DIR, `v${v}.d.ts`);
		if (!fs.existsSync(p)) continue;
		for (const name of parseExportedTypes(fs.readFileSync(p, 'utf8'))) {
			// The per-version shape alias is covered by the api.ts contract hold.
			if (/^ShellApiV\d+$/.test(name)) continue;
			if (!earliest.has(name)) earliest.set(name, v);
		}
	}
	return earliest;
}

/**
 * Step 7 — regenerate the conformance file compiled by shell-ui's own tsc.
 *
 * The live VALUE surface is held against the accumulated contract in api.ts
 * (`_contractHold` = `ShellApiLatest`, the intersection of all versions). This
 * file additionally pins every individually-exported TYPE against the earliest
 * version that froze it, so a removed or narrowed type export becomes a
 * `tsc --noEmit` error here. Types are drawn from the frozen files (accumulated),
 * never from the live surface, so a removal cannot be erased by re-running.
 *
 * @param {number} maxN - Newest frozen version number.
 */
function generateConformance(maxN) {
	const names = [...collectFrozenTypes(maxN).entries()];
	const versions = [];
	for (let v = 0; v <= maxN; v++) {
		if (fs.existsSync(path.join(VERSIONS_DIR, `v${v}.d.ts`))) versions.push(v);
	}
	const lines = [];
	lines.push('// =============================================================================');
	lines.push('// contract-check.generated.ts');
	lines.push('// =============================================================================');
	lines.push('// GENERATED by `./builder shell:freeze` — do not edit by hand.');
	lines.push('//');
	lines.push('// Enforces the accumulated shell-api contract under shell-ui\'s own tsc:');
	lines.push('//  - a per-version VALUE floor: the live surface must satisfy EACH frozen');
	lines.push('//    version separately (per-version, not intersected — intersecting the');
	lines.push('//    snapshots reduces nominal members like enums to `never`).');
	lines.push('//  - a per-TYPE floor: each exported type, pinned to the earliest version');
	lines.push('//    that froze it.');
	lines.push('// Removing or narrowing anything ever frozen breaks this file. Floors are');
	lines.push('// appended per freeze from the immutable versions/*.d.ts and never dropped.');
	lines.push('// =============================================================================');
	lines.push('');
	lines.push("import type { ShellApiShape } from './api';");
	for (const v of versions) {
		lines.push(`import type { ShellApiV${v} } from 'shell-api/versions/v${v}';`);
	}
	for (const [name, v] of names) {
		lines.push(`import type { ${name} as Frozen_${name} } from 'shell-api/versions/v${v}';`);
		lines.push(`import type { ${name} as Current_${name} } from './api';`);
	}
	lines.push('');
	lines.push('// VALUE floors — the live surface must still satisfy every frozen version.');
	for (const v of versions) {
		lines.push(`const _floor_v${v}: ShellApiV${v} = {} as ShellApiShape;`);
		lines.push(`void _floor_v${v};`);
	}
	lines.push('');
	lines.push('// TYPE floors — each frozen exported type must still be satisfied.');
	for (const [name] of names) {
		lines.push(`const _t_${name}: Frozen_${name} = {} as Current_${name};`);
		lines.push(`void _t_${name};`);
	}
	lines.push('');
	fs.writeFileSync(CONTRACT_CHECK, lines.join('\n'));
}

// =============================================================================
// MAIN
// =============================================================================

/** Orchestrates the freeze (or --check) run. */
function main() {
	const checkMode = process.argv.includes('--check');
	const regenMode = process.argv.includes('--regen');

	// --regen: reapply the accumulated barrels + conformance over the EXISTING
	// versions without freezing a new one. Used when the contract MECHANISM
	// changes (not the surface) — no candidate is generated, no version written.
	if (regenMode) {
		preCheck();
		const { prev } = determineVersions();
		if (prev < 0) {
			log('No frozen versions to regenerate.');
			return;
		}
		regenerateBarrels(prev);
		generateConformance(prev);
		// Also re-stamp apiver.ts so a freeze interrupted between conformance and
		// the version stamp is fully repairable with a single --regen run.
		writeApiVersion(prev);
		log(`Regenerated index.ts + contract-check.generated.ts + apiver.ts from v0..v${prev} (no new version).`);
		return;
	}

	// Steps 1-4 are shared by check + freeze.
	preCheck();
	const candidateBody = generateCandidate();
	const { next, prev } = determineVersions();

	if (checkMode) {
		// CI mode: never write; fail only on an ACTIONABLE drift (a new export the
		// live surface has that the newest frozen version does not). A cosmetic or
		// floor-compatible change is not flagged — it needs no freeze.
		if (prev < 0) {
			// A missing baseline in CI is a FAILURE, not a pass: an emptied
			// versions/ directory would otherwise sail through --check (and the
			// regen tamper-diff, which also no-ops with nothing to regenerate).
			console.error('[shell:freeze --check] No frozen version exists. The shell contract baseline is missing — restore packages/shell-api/versions/ or run `./builder shell:freeze`.');
			cleanup();
			process.exit(1);
		} else if (!hasActionableChange(prev, candidateBody)) {
			log(`Up to date with v${prev} (no actionable change).`);
		} else {
			console.error(
				`[shell:freeze --check] Shell API has new exports not in v${prev}. Run \`./builder shell:freeze\`.`,
			);
			cleanup();
			process.exit(1);
		}
		cleanup();
		return;
	}

	// Full freeze — append the next version only when the surface ACTUALLY grew.
	// A cosmetic edit (reordering exports, whitespace) or a floor-compatible type
	// tweak leaves the exported name set unchanged and mints no redundant version.
	// (No compatibility gate: removals fail shell-ui's own tsc via the floors.)
	if (!hasActionableChange(prev, candidateBody)) {
		log('No actionable change to the shell API surface — nothing to freeze.');
		cleanup();
		return;
	}

	writeVersion(next, candidateBody);
	try {
		regenerateBarrels(next);
		generateConformance(next);
		writeApiVersion(next);
	} catch (err) {
		// Roll the snapshot back so a rerun regenerates EVERYTHING. Leaving the
		// version file behind would make the rerun see "no actionable change"
		// and skip the (stale) barrels / conformance / apiver forever.
		fs.rmSync(path.join(VERSIONS_DIR, `v${next}.d.ts`), { force: true });
		throw err;
	}
	cleanup();

	// Summary.
	log(`Froze ShellApiV${next} -> packages/shell-api/versions/v${next}.d.ts`);
	log(`Contract now accumulates v0..v${next} via per-version floors (nothing dropped).`);
	log(`Bumped SHELL_API_VERSION -> ${next} in apps/shell-ui/src/apiver.ts.`);
	log('Updated packages/shell-api/{latest.ts,index.ts} and apps/shell-ui/src/contract-check.generated.ts.');
	log('Only apps/shell-ui/src/api.ts is hand-curated; everything else here is generated.');
	log('Changes left uncommitted.');
}

main();
