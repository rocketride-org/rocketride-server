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
// Pins the rules freeze-client-api.js takes from contract-floors.js:
//   1. a surface is held against the floors of its own MAJOR only; floors of
//      another major are listed (history) but never selected, and a package
//      version behind an existing floor is refused;
//   2. a frozen floor checked out with CRLF (core.autocrlf=true) reads back
//      byte-identical to the LF bundle the generator emits, and a file whose
//      markers are missing or reversed has no bundle;
//   3. every type pin of the conformance file has its own name, and its
//      assertions fail on a dropped member, an optional one included;
//   4. a released floor may not change or go against a trusted base.
//
// Built-in runner; the type-pin test compiles its fixtures with the package's
// own typescript devDependency (the one the freeze script uses):
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
	floorsNewerThan,
	idFor,
	normalizeEol,
	extractBundleBody,
	assignPinAliases,
	typeFloorLines,
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

test('floorsNewerThan: a package version behind a floor names that floor', () => {
	// Moved back to 1.6 while v2.0 exists: v1.6 is released, not in progress.
	assert.deepEqual(floorsNewerThan('1.6', ['1.3', '1.6', '2.0']), ['2.0']);
	// Keys from the tree and from a base may repeat; each is named once.
	assert.deepEqual(floorsNewerThan('1.6', ['2.1', '2.0', '1.6', '2.0']), ['2.0', '2.1']);
	assert.deepEqual(floorsNewerThan('2.0', ['1.3', '1.6', '2.0']), []);
	assert.deepEqual(floorsNewerThan('1.10', ['1.9', '1.10']), []);
});

test('idFor makes a floor key identifier-safe', () => {
	assert.equal(idFor('1.3'), '1_3');
	assert.equal(idFor('2.10'), '2_10');
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

test('extractBundleBody returns null when END comes before BEGIN', () => {
	// Reversed markers are no bundle, not an empty one.
	assert.equal(extractBundleBody(['// header', END, 'export {};', BEGIN, ''].join('\n')), null);
	assert.equal(extractBundleBody(['// header', END, 'export {};', BEGIN, ''].join('\r\n')), null);
	// A stray END ahead of the bundle does not cut it: the first END after
	// BEGIN closes it.
	const body = 'export declare const A: number;';
	assert.equal(extractBundleBody(['// header', END, BEGIN, body, END, ''].join('\n')), body);
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
// CONFORMANCE PINS
// =============================================================================

test('assignPinAliases: every pin gets its own name, and bare names never move', () => {
	// Foo is declared by 2.0 and 2.1; another type is literally named
	// Foo__v2_1, the fragment Foo's 2.1 pin would take.
	const pins = new Map([
		[
			'Foo',
			[
				{ key: '2.0', arity: 0 },
				{ key: '2.1', arity: 0 },
			],
		],
		['Foo__v2_1', [{ key: '2.1', arity: 0 }]],
		['Foo__v2_1_2', [{ key: '2.1', arity: 0 }]],
		[
			'Bar',
			[
				{ key: '2.0', arity: 1 },
				{ key: '2.1', arity: 1 },
				{ key: '2.2', arity: 1 },
			],
		],
	]);
	const aliases = assignPinAliases(pins);
	assert.deepEqual(aliases.get('Foo'), ['Foo', 'Foo__v2_1_3']);
	assert.deepEqual(aliases.get('Foo__v2_1'), ['Foo__v2_1']);
	assert.deepEqual(aliases.get('Foo__v2_1_2'), ['Foo__v2_1_2']);
	assert.deepEqual(aliases.get('Bar'), ['Bar', 'Bar__v2_1', 'Bar__v2_2']);
	const all = [...aliases.values()].flat();
	assert.equal(new Set(all).size, all.length, 'no two pins share a name');
});

/**
 * Type-check a throwaway program with the package's own TypeScript and
 * return its diagnostics as text.
 *
 * @param {Record<string, string>} files - file name -> source; `check.ts` is the root.
 * @returns {string[]} One flattened message per diagnostic.
 */
function typeCheck(files) {
	const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '..')] }));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-contract-pins-'));
	for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
	const program = ts.createProgram([path.join(dir, 'check.ts')], {
		strict: true,
		noEmit: true,
		skipLibCheck: true,
		types: [],
		lib: ['lib.es2020.d.ts'],
		target: ts.ScriptTarget.ES2020,
		module: ts.ModuleKind.CommonJS,
	});
	return ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

// A frozen floor of five shapes: a record with an optional member, a generic,
// a class, a literal union and a function type.
const FROZEN_FIXTURE = [
	'export interface Rec { id: string; label?: string }',
	'export interface Box<T> { value: T; note?: string }',
	'export declare class Svc { name: string; port?: number; start(): void }',
	"export type Kind = 'a' | 'b';",
	'export type Fn = (x: number) => string;',
	'',
].join('\n');

// The pins the generator emits for each fixture type, as in the conformance file.
const PINNED = [
	['Rec', 0],
	['Box', 1],
	['Svc', 0],
	['Kind', 0],
	['Fn', 0],
];

/**
 * The conformance program over FROZEN_FIXTURE and a live module.
 *
 * @param {string} live - The live module's source.
 * @param {(lines: string[]) => string[]} [pick] - Which of each pin's lines to keep.
 * @returns {Record<string, string>} The program's files.
 */
function conformanceProgram(live, pick = (lines) => lines) {
	const check = [];
	for (const [name] of PINNED) {
		check.push(`import type { ${name} as Frozen_${name} } from './frozen';`);
		check.push(`import type { ${name} as Current_${name} } from './live';`);
	}
	for (const [name, arity] of PINNED) check.push(...pick(typeFloorLines(name, name, arity)));
	return { 'frozen.d.ts': FROZEN_FIXTURE, 'live.ts': live, 'check.ts': `${check.join('\n')}\nexport {};\n` };
}

// The live surface of the fixture: unchanged, plus members and a private.
const LIVE_GROWN = [
	'export interface Rec { id: string; label?: string; added?: boolean }',
	'export interface Box<T> { value: T; note?: string; size: number }',
	'export class Svc { name = ""; port?: number; extra = 1; private secret = 0; start(): void { void this.secret; } }',
	"export type Kind = 'a' | 'b';",
	'export type Fn = (x: number) => string;',
	'',
].join('\n');

test('typeFloorLines: the live surface may grow without breaking a pin', () => {
	assert.deepEqual(typeCheck(conformanceProgram(LIVE_GROWN)), []);
});

test('typeFloorLines: a dropped optional member fails its pin', () => {
	const dropped = LIVE_GROWN.replace('label?: string; ', '')
		.replace('note?: string; ', '')
		.replace('port?: number; ', '');
	// The assignment alone lets all three through: this is the gap the key
	// assertion closes.
	assert.deepEqual(typeCheck(conformanceProgram(dropped, (lines) => lines.slice(0, 2))), []);
	const messages = typeCheck(conformanceProgram(dropped)).join('\n');
	for (const member of ['label', 'note', 'port']) {
		assert.match(messages, new RegExp(`Property '${member}' is missing`), `dropping ${member} fails`);
	}
});

test('typeFloorLines: a dropped required member still fails the assignment', () => {
	const dropped = LIVE_GROWN.replace('export interface Rec { id: string; ', 'export interface Rec { ');
	const messages = typeCheck(conformanceProgram(dropped, (lines) => lines.slice(0, 2))).join('\n');
	assert.match(messages, /Property 'id' is missing/);
});

test('typeFloorLines: a generic pin is applied at its frozen arity', () => {
	assert.deepEqual(typeFloorLines('Box', 'Box__v2_1', 1), [
		'const _t_Box__v2_1: Frozen_Box__v2_1<any> = {} as Current_Box<any>;',
		'void _t_Box__v2_1;',
		'const _k_Box__v2_1: { [K in keyof Frozen_Box__v2_1<any>]-?: K } = ' +
			'{} as { [K in keyof Current_Box<any>]-?: K };',
		'void _k_Box__v2_1;',
	]);
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

test('readFloorsAt reads a ref name through the tree it names', () => {
	// A lightweight tag on a tree is a ref like a branch, with no commit
	// identity needed. Every read names the resolved tree, not the ref.
	const { root, tree } = gitFixture({ '1.6': 'one\n', '2.0': 'two\n' });
	execFileSync('git', ['tag', 'base', tree], { cwd: root, stdio: 'ignore' });
	assert.deepEqual(
		[...readFloorsAt(root, 'contract/versions', 'base').entries()],
		[
			['1.6', 'one\n'],
			['2.0', 'two\n'],
		]
	);
});

test('readFloorsAt fails on a revision git cannot resolve', () => {
	const { root } = gitFixture({ '2.0': 'two\n' });
	assert.throws(() => readFloorsAt(root, 'contract/versions', 'no-such-rev'), /cannot resolve 'no-such-rev'/);
});
