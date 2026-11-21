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
// contract-floors tests — per-major floor scoping and line-ending-proof reads
// =============================================================================
//
// Pins the two rules freeze-client-api.js takes from contract-floors.js:
//   1. a surface is held against the floors of its own MAJOR only; floors of
//      another major are listed (history) but never selected;
//   2. a frozen floor checked out with CRLF (core.autocrlf=true) reads back
//      byte-identical to the LF bundle the generator emits.
//
// Zero-dependency built-in runner:
//     node --test packages/client-typescript/scripts/contract-floors.test.js
// =============================================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const {
	BEGIN,
	END,
	DECISION_NOTE,
	keyFromVersion,
	majorOf,
	compareKeys,
	listFrozenKeys,
	floorsOfMajor,
	normalizeEol,
	extractBundleBody,
	readFloorsIn,
	readFloorsAt,
	releasedFloorEdits,
} = require('./contract-floors');

// The git fixtures below build their own repository; a variable inherited
// from a hook (GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE) would point every git
// call at the outer one.
for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) delete process.env[name];

/**
 * Create a versions directory holding empty floor files for the given keys,
 * plus files the lister must ignore.
 *
 * @param {string[]} keys - Floor keys to create (e.g. ['1.3', '2.0']).
 * @returns {string} The directory path.
 */
function versionsDirWith(keys) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-contract-floors-'));
	for (const key of keys) fs.writeFileSync(path.join(dir, `v${key}.d.ts`), '');
	// Not floors: a scratch file and a malformed name.
	fs.writeFileSync(path.join(dir, 'README.md'), '');
	fs.writeFileSync(path.join(dir, 'v2.d.ts'), '');
	return dir;
}

// =============================================================================
// FLOOR KEYS
// =============================================================================

test('keyFromVersion: MAJOR.MINOR of a package version', () => {
	assert.equal(keyFromVersion('1.6.0'), '1.6');
	assert.equal(keyFromVersion('2.0.0'), '2.0');
	assert.equal(keyFromVersion('2.10.3-beta.1'), '2.10');
	assert.equal(keyFromVersion('not-a-version'), null);
});

test('majorOf and compareKeys order numerically, not as text', () => {
	assert.equal(majorOf('1.10'), 1);
	assert.equal(majorOf('2.0'), 2);
	assert.deepEqual(['2.0', '1.10', '1.3', '10.0', '1.5'].sort(compareKeys), ['1.3', '1.5', '1.10', '2.0', '10.0']);
});

test('listFrozenKeys lists every major, ascending, and nothing else', () => {
	const dir = versionsDirWith(['1.5', '2.0', '1.3', '1.6', '2.1']);
	assert.deepEqual(listFrozenKeys(dir), ['1.3', '1.5', '1.6', '2.0', '2.1']);
	assert.deepEqual(listFrozenKeys(path.join(dir, 'missing')), []);
});

// =============================================================================
// PER-MAJOR SCOPING
// =============================================================================

test('floorsOfMajor: a 2.x surface is held against the 2.x floors only', () => {
	const keys = ['1.3', '1.5', '1.6', '2.0', '2.1'];
	assert.deepEqual(floorsOfMajor(keys, '2.1'), ['2.0', '2.1']);
	assert.deepEqual(floorsOfMajor(keys, '2.2'), ['2.0', '2.1']);
});

test('floorsOfMajor: a 1.x surface still holds against every 1.x floor', () => {
	assert.deepEqual(floorsOfMajor(['1.3', '1.5', '1.6', '2.0'], '1.6'), ['1.3', '1.5', '1.6']);
});

test('floorsOfMajor: the first release of a major has no floor to hold it', () => {
	// 1.x floors stay in the tree as history; none of them binds 2.0, so the
	// first 2.0 freeze mints from the live surface as-is.
	assert.deepEqual(floorsOfMajor(['1.3', '1.5', '1.6'], '2.0'), []);
});

test('floorsOfMajor: majors 1 and 10 are not confused', () => {
	assert.deepEqual(floorsOfMajor(['1.0', '10.0', '10.1'], '10.2'), ['10.0', '10.1']);
	assert.deepEqual(floorsOfMajor(['1.0', '10.0', '10.1'], '1.1'), ['1.0']);
});

test('the decision note points at the per-major decision', () => {
	assert.match(DECISION_NOTE, /MAJOR\/MINOR decision/);
	assert.match(DECISION_NOTE, /section 13, Step 7/);
	assert.match(DECISION_NOTE, /Contract floors across a major/);
});

// =============================================================================
// LINE ENDINGS
// =============================================================================

test('normalizeEol turns CRLF and lone CR into LF', () => {
	assert.equal(normalizeEol('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('extractBundleBody reads a CRLF checkout exactly like the LF original', () => {
	const body = 'export declare const A: number;\nexport type B = string;';
	const lf = ['// header', '', BEGIN, body, END, ''].join('\n');
	const crlf = lf.replace(/\n/g, '\r\n');
	assert.equal(extractBundleBody(lf), body);
	assert.equal(extractBundleBody(crlf), body);
	assert.equal(extractBundleBody(crlf), extractBundleBody(lf));
});

test('extractBundleBody returns null when a marker is missing', () => {
	assert.equal(extractBundleBody(`${BEGIN}\nexport {};\n`), null);
	assert.equal(extractBundleBody('export {};\n'), null);
});

test('the frozen floors in the tree read back with LF only', () => {
	// The committed floors must parse under the shared reader whatever the
	// checkout's line endings are. Floors are never deleted, so every one
	// released so far must be found: a missing directory or a deleted floor
	// fails here instead of leaving the loop below with nothing to check.
	const dir = path.join(__dirname, '..', 'contract', 'versions');
	const keys = listFrozenKeys(dir);
	for (const required of ['1.3', '1.5', '1.6', '2.0']) {
		assert.ok(keys.includes(required), `v${required}.d.ts is in ${dir}`);
	}
	for (const key of keys) {
		const body = extractBundleBody(fs.readFileSync(path.join(dir, `v${key}.d.ts`), 'utf8'));
		assert.notEqual(body, null, `v${key}.d.ts has its BEGIN/END markers`);
		assert.equal(body.includes('\r'), false, `v${key}.d.ts body has no CR`);
	}
});

// =============================================================================
// RELEASED-FLOOR IMMUTABILITY
// =============================================================================

/**
 * A throwaway git repository with the given floors (and one file that is not
 * a floor) under contract/versions, staged and written as a TREE object: a
 * tree is a revision git can read, and needs no commit identity or signing.
 *
 * @param {Record<string, string>} floors - key -> floor text.
 * @returns {{root: string, versions: string, tree: string}} The work tree, its versions directory and the tree id.
 */
function gitFixture(floors) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-contract-floors-git-'));
	const git = (...args) =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
	git('init', '-q');
	const versions = path.join(root, 'contract', 'versions');
	fs.mkdirSync(versions, { recursive: true });
	for (const [key, text] of Object.entries(floors)) fs.writeFileSync(path.join(versions, `v${key}.d.ts`), text);
	fs.writeFileSync(path.join(versions, 'README.md'), 'not a floor\n');
	git('add', '-A');
	return { root, versions, tree: git('write-tree') };
}

test('releasedFloorEdits: a released floor may not change or go; the in-progress one may', () => {
	// The package is at 2.1: v2.1 is in progress, v1.6 and v2.0 are released.
	const base = new Map([
		['1.6', 'a\n'],
		['2.0', 'b\n'],
		['2.1', 'c\n'],
	]);
	const edits = (entries) => releasedFloorEdits(base, new Map(entries), '2.1');
	// Re-cutting the in-progress 2.1 floor is allowed.
	assert.deepEqual(
		edits([
			['1.6', 'a\n'],
			['2.0', 'b\n'],
			['2.1', 'C\n'],
		]),
		[]
	);
	// Editing the released 2.0 floor is not.
	assert.deepEqual(
		edits([
			['1.6', 'a\n'],
			['2.0', 'B\n'],
			['2.1', 'c\n'],
		]),
		[{ key: '2.0', change: 'changed' }]
	);
	// Nor is deleting the released 1.6 floor.
	assert.deepEqual(
		edits([
			['2.0', 'b\n'],
			['2.1', 'c\n'],
		]),
		[{ key: '1.6', change: 'removed' }]
	);
});

test('releasedFloorEdits: moving the package past a minor seals that floor', () => {
	// The base is at 2.0 (in progress there); the tree bumps to 2.1.
	const base = new Map([['2.0', 'b\n']]);
	const bumped = new Map([
		['2.0', 'B\n'],
		['2.1', 'c\n'],
	]);
	assert.deepEqual(releasedFloorEdits(base, bumped, '2.1'), [{ key: '2.0', change: 'changed' }]);
	// A floor the base does not hold yet is new, not an edit.
	assert.deepEqual(releasedFloorEdits(base, new Map([['2.0', 'b\n'], ['2.1', 'c\n']]), '2.1'), []);
});

test('releasedFloorEdits: a CRLF checkout of an unchanged floor is not an edit', () => {
	const base = new Map([['1.6', 'a\nb\n']]);
	assert.deepEqual(releasedFloorEdits(base, new Map([['1.6', 'a\r\nb\r\n']]), '2.0'), []);
});

test('readFloorsAt reads the floors a revision holds, and a hand-edited released floor is named', () => {
	const { root, versions, tree } = gitFixture({ '1.6': 'one\n', '2.0': 'two\n' });
	const base = readFloorsAt(root, 'contract/versions', tree);
	assert.deepEqual([...base.entries()], [
		['1.6', 'one\n'],
		['2.0', 'two\n'],
	]);
	assert.deepEqual(releasedFloorEdits(base, readFloorsIn(versions), '2.0'), []);

	// Narrow the released 1.6 floor in the tree, and re-cut the in-progress 2.0.
	fs.writeFileSync(path.join(versions, 'v1.6.d.ts'), 'one, narrowed\n');
	fs.writeFileSync(path.join(versions, 'v2.0.d.ts'), 'two, re-cut\n');
	assert.deepEqual(releasedFloorEdits(base, readFloorsIn(versions), '2.0'), [{ key: '1.6', change: 'changed' }]);
});

test('readFloorsAt fails on a revision git cannot resolve', () => {
	const { root } = gitFixture({ '2.0': 'two\n' });
	assert.throws(() => readFloorsAt(root, 'contract/versions', 'no-such-rev'), /cannot resolve 'no-such-rev'/);
});
