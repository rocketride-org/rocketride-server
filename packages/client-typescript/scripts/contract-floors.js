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
// contract-floors — floor keys, per-major scoping, frozen-bundle reading and
// released-floor immutability
// =============================================================================
//
// The pure half of freeze-client-api.js: everything that decides WHICH floors
// hold the live surface, how a frozen floor's body is read back, how each type
// pin of the conformance file is named and asserted, and whether a released
// floor changed against a base revision (git only). It needs no TypeScript
// toolchain, so its tests run with `node --test` alone:
//
//     node --test packages/client-typescript/scripts/contract-floors.test.js
//
// Floors are scoped per MAJOR (decided 2026-11-11; named-pipes plan section 13,
// Step 7, "Contract floors across a major"). The SDK is semver, so a 2.x
// surface is held against the 2.x floors only. The 1.x floors stay in
// contract/versions/ as immutable history and are never checked against a 2.x
// surface; a major bump is the one place the surface may narrow.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// =============================================================================
// FROZEN BUNDLE MARKERS
// =============================================================================

// Markers wrapping the generated declaration body inside each version file, so
// the no-op comparison can isolate the bundle from the provenance header.
const BEGIN = '// ===== BEGIN FROZEN BUNDLE — do not edit =====';
const END = '// ===== END FROZEN BUNDLE =====';

// Where a breaking change is decided. Printed by every floor failure.
const DECISION_NOTE =
	'Breaking changes require a MAJOR/MINOR decision: floors hold within a major, and the surface may ' +
	'narrow only with a major bump (named-pipes plan section 13, Step 7, "Contract floors across a major").';

// =============================================================================
// FLOOR KEYS
// =============================================================================

/**
 * The floor key for a package version: its MAJOR.MINOR.
 *
 * @param {string} version - A package.json version such as '2.0.0'.
 * @returns {string|null} The key ('2.0'), or null when the version does not parse.
 */
function keyFromVersion(version) {
	const m = /^(\d+)\.(\d+)\.\d+/.exec(String(version));
	return m ? `${m[1]}.${m[2]}` : null;
}

/**
 * The MAJOR of a floor key.
 *
 * @param {string} key - A floor key such as '1.6'.
 * @returns {number} The major (1).
 */
function majorOf(key) {
	return Number(key.split('.')[0]);
}

/**
 * Numeric (major, minor) comparator for floor keys.
 *
 * @param {string} a - Key like '1.3'.
 * @param {string} b - Key like '1.10'.
 * @returns {number} Standard comparator result.
 */
function compareKeys(a, b) {
	const [am, an] = a.split('.').map(Number);
	const [bm, bn] = b.split('.').map(Number);
	return am - bm || an - bn;
}

/**
 * Enumerate the frozen floor keys present in a versions directory, sorted
 * ascending by (major, minor) so "earliest version that froze a type" is well
 * defined. Every major is listed: scoping is the caller's job.
 *
 * @param {string} versionsDir - The contract/versions directory.
 * @returns {string[]} Sorted keys, e.g. ['1.3', '1.5', '2.0'].
 */
function listFrozenKeys(versionsDir) {
	if (!fs.existsSync(versionsDir)) return [];
	return fs
		.readdirSync(versionsDir)
		.map((f) => /^v(\d+\.\d+)\.d\.ts$/.exec(f))
		.filter(Boolean)
		.map((m) => m[1])
		.sort(compareKeys);
}

/**
 * The floors that hold a surface of the given key: those of the SAME major,
 * ascending. A floor of another major is history and is never enforced.
 *
 * @param {string[]} keys - Every frozen floor key.
 * @param {string} key - The current package floor key.
 * @returns {string[]} The same-major keys, ascending.
 */
function floorsOfMajor(keys, key) {
	const major = majorOf(key);
	return keys.filter((k) => majorOf(k) === major).sort(compareKeys);
}

/**
 * The floors newer than the package's own key. A package version moved
 * behind an existing floor would make a released floor read as the
 * in-progress one (re-mintable, skipped by the released-floor check), so every
 * mode of the freeze script refuses to run while this is non-empty.
 *
 * @param {string} key - The current package floor key.
 * @param {Iterable<string>} keys - Floor keys from any source (duplicates allowed).
 * @returns {string[]} The distinct newer keys, ascending.
 */
function floorsNewerThan(key, keys) {
	return [...new Set(keys)].filter((k) => compareKeys(k, key) > 0).sort(compareKeys);
}

/**
 * Identifier-safe form of a floor key ('1.3' -> '1_3') for generated names.
 *
 * @param {string} key - The floor key.
 * @returns {string} The identifier fragment.
 */
function idFor(key) {
	return key.replace('.', '_');
}

// =============================================================================
// FROZEN BUNDLE READING
// =============================================================================

/**
 * Normalize line endings to LF. A Windows checkout with core.autocrlf=true
 * writes CRLF into the working tree, while the generator always emits LF;
 * comparing the two raw would report drift on an unchanged surface.
 *
 * @param {string} text - Text with any line endings.
 * @returns {string} The text with LF line endings only.
 */
function normalizeEol(text) {
	return text.replace(/\r\n?/g, '\n');
}

/**
 * Extract the declaration body between the BEGIN/END markers of a version
 * file, with LF line endings, trimmed.
 *
 * @param {string} fileContent - The version file's text.
 * @returns {string|null} The body, or null when a marker is missing or END precedes BEGIN.
 */
function extractBundleBody(fileContent) {
	const text = normalizeEol(fileContent);
	// Step 1: BEGIN, then the first END after it (an END before BEGIN is no bundle)
	const start = text.indexOf(BEGIN);
	if (start === -1) return null;
	const bodyStart = start + BEGIN.length;
	const end = text.indexOf(END, bodyStart);
	if (end === -1) return null;
	return text.slice(bodyStart, end).trim();
}

// =============================================================================
// CONFORMANCE PINS
// =============================================================================
//
// The per-TYPE half of the generated conformance file. Each frozen exported
// type is pinned once per floor of the major that declares it; a pin is an
// import of the frozen type, the live type, and two assertions.

/**
 * Give every type pin a unique identifier fragment (the part after `Frozen_`,
 * `_t_` and `_k_`). The earliest declaring floor keeps the bare type name, a
 * later one adds its key (`Foo__v2_1`). Type names are unique, but a later
 * pin's fragment can equal another type's bare name (a type literally named
 * `Foo__v2_1`): such a fragment is numbered (`Foo__v2_1_2`) until it is
 * unique, so no two pins share an import alias or an assertion name. Bare
 * names are reserved first, so a collision never renames an existing pin.
 *
 * @param {Map<string, {key: string, arity: number}[]>} pins - type -> its declaring floors, ascending.
 * @returns {Map<string, string[]>} type -> one fragment per pin, in pin order.
 */
function assignPinAliases(pins) {
	// Step 1: every earliest pin keeps its type's bare name
	const used = new Set(pins.keys());
	const aliases = new Map();
	// Step 2: a later pin adds its floor key, numbered while that is taken
	for (const [name, list] of pins) {
		aliases.set(
			name,
			list.map(({ key }, i) => {
				if (i === 0) return name;
				const base = `${name}__v${idFor(key)}`;
				let alias = base;
				for (let n = 2; used.has(alias); n += 1) alias = `${base}_${n}`;
				used.add(alias);
				return alias;
			})
		);
	}
	return aliases;
}

/**
 * The helper types the type pins use, declared once per checker file.
 *
 *  - `_AllKeys<T>`: the keys of every branch of a union (`keyof` of a union is
 *    only the keys all its branches share).
 *  - `_DroppedKeys<F, C>`: per frozen branch, the keys no live branch assignable
 *    to that branch still declares. `never` when every branch kept its keys.
 */
const PIN_HELPER_TYPES = [
	'type _AllKeys<T> = T extends unknown ? keyof T : never;',
	'type _DroppedKeys<F, C> = F extends unknown ? Exclude<keyof F, _AllKeys<Extract<C, F>>> : never;',
].join('\n');

/**
 * The three assertions of one type pin. Generic floors are applied at the
 * frozen arity (`<any, …>`): a bare generic is TS2314, and an arity change
 * surfaces as one here.
 *
 *  - `_t_`: the live type must be assignable to the frozen one. This catches
 *    a removed or narrowed required member, but not a removed OPTIONAL one:
 *    `{ id: string }` still assigns to `{ id: string; label?: string }`.
 *  - `_k_`: the live type must keep every key the frozen one declares, across
 *    every branch of a union. Both sides map their keys to themselves with
 *    optionality removed, so a key the live type dropped is a missing
 *    required property; keys the live type added are extra properties, which
 *    assignment allows.
 *  - `_b_`: each frozen branch must keep its own keys. `_k_` pools the keys of
 *    all branches, so an optional key removed from one branch while another
 *    branch still declares it passes there; here the live branches assignable
 *    to that frozen branch must still declare it, and the error names the key.
 *
 * @param {string} name - The exported type name (the `Current_` import).
 * @param {string} alias - The pin's fragment from assignPinAliases.
 * @param {number} arity - The type parameter count the declaring floor froze.
 * @returns {string[]} The generated lines.
 */
function typeFloorLines(name, alias, arity) {
	const args = arity > 0 ? `<${new Array(arity).fill('any').join(', ')}>` : '';
	const frozen = `Frozen_${alias}${args}`;
	const current = `Current_${name}${args}`;
	return [
		`const _t_${alias}: ${frozen} = {} as ${current};`,
		`void _t_${alias};`,
		`const _k_${alias}: { [K in _AllKeys<${frozen}>]-?: K } = {} as { [K in _AllKeys<${current}>]-?: K };`,
		`void _k_${alias};`,
		`const _b_${alias}: [_DroppedKeys<${frozen}, ${current}>] extends [never] ? true : ` +
			`_DroppedKeys<${frozen}, ${current}> = true;`,
		`void _b_${alias};`,
	];
}

// =============================================================================
// RELEASED-FLOOR IMMUTABILITY
// =============================================================================
//
// The regen check proves the DERIVED files (barrels, conformance file) match
// the floors in the tree. It cannot see an edit to a floor itself: a floor and
// the live surface edited together regenerate byte-identical derived files and
// still pass tsc. Immutability is therefore checked against a trusted base
// revision: every floor the base holds, except the one keyed to the tree's own
// package MAJOR.MINOR (the in-progress floor a re-freeze replaces), must be in
// the tree unchanged.

/**
 * Read every floor file of a versions directory in the working tree.
 *
 * @param {string} versionsDir - The contract/versions directory.
 * @returns {Map<string, string>} key -> file text.
 */
function readFloorsIn(versionsDir) {
	const floors = new Map();
	for (const key of listFrozenKeys(versionsDir)) {
		floors.set(key, fs.readFileSync(path.join(versionsDir, `v${key}.d.ts`), 'utf8'));
	}
	return floors;
}

/**
 * Read every floor file of a versions directory as a git revision holds it.
 *
 * @param {string} repoRoot - The git work tree root.
 * @param {string} versionsRel - The versions directory relative to repoRoot, '/'-separated.
 * @param {string} rev - A commit or tree (e.g. 'HEAD^1', 'origin/develop').
 * @returns {Map<string, string>} key -> file text at that revision (empty when it has no floors).
 * @throws {Error} When git cannot resolve the revision.
 */
function readFloorsAt(repoRoot, versionsRel, rev) {
	const git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
	// Step 1: the revision must exist (a shallow clone without it is an error,
	// not a pass). It is resolved ONCE to its tree id, and every read below
	// names that id: a ref that moves between the listing and the reads would
	// otherwise mix two commits
	let tree;
	try {
		tree = git(['rev-parse', '--verify', '--quiet', `${rev}^{tree}`]).trim();
	} catch {
		tree = '';
	}
	if (!tree) {
		throw new Error(`git cannot resolve '${rev}'; fetch it first (CI: fetch-depth 2 for HEAD^1)`);
	}
	// Step 2: the floor files that tree holds, read as committed
	const floors = new Map();
	const listing = git(['ls-tree', '--name-only', tree, '--', `${versionsRel}/`]);
	for (const file of listing.split('\n').filter(Boolean)) {
		const m = /\/v(\d+\.\d+)\.d\.ts$/.exec(file);
		if (m) floors.set(m[1], git(['show', `${tree}:${file}`]));
	}
	return floors;
}

/**
 * The released floors a tree changed or removed, against a trusted base.
 *
 * A floor is released once the package version has moved past its minor, so
 * every floor of the base is checked except the one keyed to the tree's own
 * package MAJOR.MINOR. A floor the base does not hold is new and not checked.
 * Text is compared with line endings normalized.
 *
 * @param {Map<string, string>} baseFloors - key -> floor text at the base.
 * @param {Map<string, string>} treeFloors - key -> floor text in the tree.
 * @param {string} inProgressKey - The tree's package floor key.
 * @returns {{key: string, change: 'changed'|'removed'}[]} The edited released floors, ascending.
 */
function releasedFloorEdits(baseFloors, treeFloors, inProgressKey) {
	const edits = [];
	for (const key of [...baseFloors.keys()].sort(compareKeys)) {
		if (key === inProgressKey) continue;
		if (!treeFloors.has(key)) {
			edits.push({ key, change: 'removed' });
		} else if (normalizeEol(treeFloors.get(key)) !== normalizeEol(baseFloors.get(key))) {
			edits.push({ key, change: 'changed' });
		}
	}
	return edits;
}

module.exports = {
	BEGIN,
	END,
	DECISION_NOTE,
	keyFromVersion,
	majorOf,
	compareKeys,
	listFrozenKeys,
	floorsOfMajor,
	floorsNewerThan,
	idFor,
	normalizeEol,
	extractBundleBody,
	assignPinAliases,
	typeFloorLines,
	PIN_HELPER_TYPES,
	readFloorsIn,
	readFloorsAt,
	releasedFloorEdits,
};
