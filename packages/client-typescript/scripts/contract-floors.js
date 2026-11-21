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
// contract-floors — floor keys, per-major scoping and frozen-bundle reading
// =============================================================================
//
// The pure half of freeze-client-api.js: everything that decides WHICH floors
// hold the live surface and how a frozen floor's body is read back. It needs
// no TypeScript toolchain, so its tests run with `node --test` alone:
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
 * @returns {string|null} The body, or null when a marker is missing.
 */
function extractBundleBody(fileContent) {
	const text = normalizeEol(fileContent);
	const start = text.indexOf(BEGIN);
	const end = text.indexOf(END);
	if (start === -1 || end === -1) return null;
	return text.slice(start + BEGIN.length, end).trim();
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
	normalizeEol,
	extractBundleBody,
};
