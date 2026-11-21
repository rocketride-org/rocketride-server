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
} = require('./contract-floors');

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
	// checkout's line endings are.
	const dir = path.join(__dirname, '..', 'contract', 'versions');
	for (const key of listFrozenKeys(dir)) {
		const body = extractBundleBody(fs.readFileSync(path.join(dir, `v${key}.d.ts`), 'utf8'));
		assert.notEqual(body, null, `v${key}.d.ts has its BEGIN/END markers`);
		assert.equal(body.includes('\r'), false, `v${key}.d.ts body has no CR`);
	}
});
