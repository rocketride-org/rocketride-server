// =============================================================================
// MIT License
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

// =============================================================================
// objectId — the id the engine gives an upload, derived in the browser
// =============================================================================
//
// An upload carries no objectId; the engine derives one from the name it is
// given: uuid5(NAMESPACE_URL, 'null://Stream/' + name). The app derives the
// same id from the path it is about to send, to ask the store whether that
// path is already stored. Every case below was computed with Python's
// uuid.uuid5 (tests/fixtures/provisional/upload_objectid_derivation.json).
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { NAMESPACE_URL, STREAM_URL_PREFIX, objectIdForPath, uuid5 } from '../src/vector/objectId';

const FIXTURES = path.join(__dirname, 'fixtures', 'provisional');
const SRC = path.join(__dirname, '..', 'src');

/**
 * Read a provisional fixture.
 *
 * @param name - File name.
 * @returns The parsed JSON.
 */
function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

interface DerivationFixture {
	namespace: string;
	prefix: string;
	cases: Array<{ name: string; objectId: string }>;
}

test('objectId: the namespace and prefix are the ones the engine uses', () => {
	const derivation = fixture<DerivationFixture>('upload_objectid_derivation.json');
	assert.equal(NAMESPACE_URL, derivation.namespace);
	assert.equal(STREAM_URL_PREFIX, derivation.prefix);
});

test('objectId: reproduces every engine-derived id in the derivation fixture', () => {
	const derivation = fixture<DerivationFixture>('upload_objectid_derivation.json');
	assert.ok(derivation.cases.length >= 9);
	for (const { name, objectId } of derivation.cases) {
		assert.equal(objectIdForPath(name), objectId, name);
	}
});

test('objectId: agrees with the ids the other fixtures carry for their paths', () => {
	const uploads = fixture<{ files: Array<{ relPath: string; objectId: string }> }>('upload_events.json');
	const duplicates = fixture<{ files: Array<{ relPath: string; objectId: string }> }>('upload_events_duplicate_basename.json');
	for (const { relPath, objectId } of [...uploads.files, ...duplicates.files]) {
		assert.equal(objectIdForPath(relPath), objectId, relPath);
	}
	const chat = fixture<{ documents: Array<{ metadata: { objectId: string; parent: string } }> }>('chat_result_with_documents.json');
	for (const { metadata } of chat.documents) {
		assert.equal(objectIdForPath(metadata.parent), metadata.objectId, metadata.parent);
	}
});

test('objectId: a decomposed (NFD) path derives the same id as its NFC form', () => {
	const nfc = 'Uploaded/naïve résumé.pdf';
	const nfd = nfc.normalize('NFD');
	assert.notEqual(nfd, nfc);
	assert.equal(objectIdForPath(nfd), objectIdForPath(nfc));
	assert.equal(objectIdForPath(nfd), 'dfc583a1-da22-5cfb-ab9b-de8c2a6d15d3');
});

test('uuid5: the RFC 4122 / Python reference value for the DNS namespace', () => {
	// Python: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
	assert.equal(uuid5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'python.org'), '886313e1-3b8a-5372-9b90-0c9aee199e5d');
});

test('uuid5: version 5 and the RFC 4122 variant on every id', () => {
	for (const name of ['', 'a', 'report.pdf', 'C:\\demo\\x.md', '📄 notes.md']) {
		const id = uuid5(NAMESPACE_URL, name);
		assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, name);
	}
});

test('uuid5: refuses a namespace that is not a uuid', () => {
	assert.throws(() => uuid5('not-a-uuid', 'x'), /namespace/i);
	assert.throws(() => uuid5('6ba7b811-9dad-11d1-80b4-00c04fd430c', 'x'), /namespace/i);
});

/**
 * Every source file under a directory (recursively).
 *
 * @param dir - The directory.
 * @returns Absolute paths of .ts/.tsx files.
 */
function sourcesUnder(dir: string): string[] {
	const out: string[] = [];
	if (!existsSync(dir)) return out;
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...sourcesUnder(full));
		else if (/\.tsx?$/.test(entry)) out.push(full);
	}
	return out;
}

test('objectId: the upload path never reaches for the browser digest API (it is absent on plain-HTTP origins)', () => {
	const files = [path.join(SRC, 'vector', 'sha1.ts'), path.join(SRC, 'vector', 'objectId.ts'), path.join(SRC, 'vector', 'uploads.ts'), ...sourcesUnder(path.join(SRC, 'ingest'))].filter((file) => existsSync(file));
	assert.ok(files.length >= 2);
	for (const file of files) {
		const text = readFileSync(file, 'utf8');
		assert.doesNotMatch(text, /crypto\s*\.\s*subtle|\bsubtle\s*\.\s*digest|require\(\s*['"](node:)?crypto['"]\s*\)|from\s+['"](node:)?crypto['"]/, path.relative(SRC, file));
	}
});
