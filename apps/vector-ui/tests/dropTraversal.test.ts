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
// dropTraversal — a dropped folder becomes files with their relative paths
// =============================================================================
//
// A browser drop hands over FileSystem entries (webkitGetAsEntry). Folders
// are walked so every file keeps the path it had under the dropped folder,
// which becomes its path in the store. The entries must be taken while the
// drop event runs; the walk itself is asynchronous.
// =============================================================================

import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { DROP_NOTHING_READ, MAX_TRAVERSAL_DEPTH, TRAVERSAL_SCAN_CAP, entriesFromDataTransfer, filesFromInput, isHiddenName, traverseDrop, traverseEntries, unreadableSentence } from '../src/ingest/dropTraversal';
import type { DataTransferLike, FsEntryLike } from '../src/ingest/dropTraversal';

/** Most a test here may take: they await fakes, so a regression must fail, not hang the run. */
const TEST_TIMEOUT_MS = 10_000;

/**
 * Declare a test bounded by {@link TEST_TIMEOUT_MS}.
 *
 * @param name - What it checks.
 * @param fn - The test.
 */
function test(name: string, fn: () => void | Promise<void>): void {
	void nodeTest(name, { timeout: TEST_TIMEOUT_MS }, fn);
}

/**
 * A fake file.
 *
 * @param name - Base name.
 * @param size - Bytes.
 * @param relative - webkitRelativePath (folder picker), if any.
 * @returns Something File-shaped.
 */
function fakeFile(name: string, size = 10, relative = ''): File {
	return { name, size, type: '', webkitRelativePath: relative } as unknown as File;
}

/**
 * A fake file entry.
 *
 * @param fullPath - '/folder/name.ext'.
 * @param fail - Make reading it fail.
 * @returns The entry.
 */
function fileEntry(fullPath: string, fail = false): FsEntryLike {
	const name = fullPath.slice(fullPath.lastIndexOf('/') + 1);
	return {
		isFile: true,
		isDirectory: false,
		name,
		fullPath,
		file(success, error) {
			if (fail) error?.(new Error('NotReadableError'));
			else success(fakeFile(name));
		},
	};
}

/**
 * A fake directory entry whose reader hands out its children in batches.
 *
 * @param fullPath - '/folder'.
 * @param children - Its entries.
 * @param batch - Entries per readEntries call (Chrome uses 100).
 * @returns The entry.
 */
function dirEntry(fullPath: string, children: FsEntryLike[], batch = 100): FsEntryLike {
	const name = fullPath.slice(fullPath.lastIndexOf('/') + 1);
	return {
		isFile: false,
		isDirectory: true,
		name,
		fullPath,
		createReader() {
			let at = 0;
			return {
				readEntries(success) {
					const next = children.slice(at, at + batch);
					at += next.length;
					// Asynchronous, like the browser.
					setTimeout(() => success(next), 0);
				},
			};
		},
	};
}

test('traverseEntries: a dropped folder yields every file with its path under the folder', async () => {
	const docs = dirEntry('/docs', [fileEntry('/docs/b.md'), dirEntry('/docs/sub', [fileEntry('/docs/sub/c.pdf')]), fileEntry('/docs/a.md')]);
	const result = await traverseEntries([docs, fileEntry('/loose.txt')], []);
	assert.deepEqual(
		result.files.map((f) => f.relPath),
		['docs/a.md', 'docs/b.md', 'docs/sub/c.pdf', 'loose.txt']
	);
	assert.equal(result.files[0].file.name, 'a.md');
	assert.equal(result.truncated, false);
	assert.deepEqual(result.errors, []);
});

test('traverseEntries: readEntries is called until it returns nothing (the browser hands out batches)', async () => {
	const children = Array.from({ length: 205 }, (_, i) => fileEntry(`/big/f${String(i).padStart(3, '0')}.txt`));
	const result = await traverseEntries([dirEntry('/big', children, 100)], []);
	assert.equal(result.files.length, 205);
	assert.equal(result.files[204].relPath, 'big/f204.txt');
});

test('traverseEntries: stops at the scan cap and says so', async () => {
	const children = Array.from({ length: TRAVERSAL_SCAN_CAP + 50 }, (_, i) => fileEntry(`/huge/f${i}.txt`));
	const result = await traverseEntries([dirEntry('/huge', children, 100)], []);
	assert.equal(result.files.length, TRAVERSAL_SCAN_CAP);
	assert.equal(result.truncated, true);
});

test('traverseEntries: hidden and system files and folders are skipped and counted', async () => {
	const drop = dirEntry('/proj', [fileEntry('/proj/.DS_Store'), fileEntry('/proj/Thumbs.db'), fileEntry('/proj/desktop.ini'), dirEntry('/proj/.git', [fileEntry('/proj/.git/config')]), fileEntry('/proj/readme.md')]);
	const result = await traverseEntries([drop], []);
	assert.deepEqual(
		result.files.map((f) => f.relPath),
		['proj/readme.md']
	);
	assert.deepEqual(result.skipped.sort(), ['proj/.DS_Store', 'proj/.git', 'proj/Thumbs.db', 'proj/desktop.ini']);
});

test('traverseEntries: a file that cannot be read is reported and the rest still arrive', async () => {
	const result = await traverseEntries([dirEntry('/d', [fileEntry('/d/bad.pdf', true), fileEntry('/d/good.pdf')])], []);
	assert.deepEqual(
		result.files.map((f) => f.relPath),
		['d/good.pdf']
	);
	assert.deepEqual(result.errors, ['Could not read d/bad.pdf.']);
});

test('traverseEntries: nesting deeper than the limit is not walked', async () => {
	// /x/d0/d1/…/d(N+4)/leaf.md, built from the inside out.
	const folders = Array.from({ length: MAX_TRAVERSAL_DEPTH + 5 }, (_, depth) => `d${depth}`);
	const fullPaths = folders.map((_, i) => `/x/${folders.slice(0, i + 1).join('/')}`);
	let entry: FsEntryLike = fileEntry(`${fullPaths[fullPaths.length - 1]}/leaf.md`);
	for (let i = fullPaths.length - 1; i >= 0; i--) entry = dirEntry(fullPaths[i], [entry]);
	const result = await traverseEntries([dirEntry('/x', [entry])], []);
	assert.equal(result.files.length, 0);
	assert.equal(result.errors.length, 1);
	assert.match(result.errors[0], /nested more than/);
});

test('entriesFromDataTransfer: takes the entries synchronously, so the walk survives the end of the drop event', async () => {
	const items = [
		{ kind: 'file', webkitGetAsEntry: () => dirEntry('/folder', [fileEntry('/folder/a.md')]) },
		{ kind: 'string', webkitGetAsEntry: () => null },
		{ kind: 'file', webkitGetAsEntry: () => fileEntry('/b.txt') },
	];
	const transfer: DataTransferLike = { items: items as unknown as DataTransferLike['items'], files: [] as unknown as DataTransferLike['files'] };
	const snapshot = entriesFromDataTransfer(transfer);
	assert.equal(typeof (snapshot as unknown as { then?: unknown }).then, 'undefined');
	// The browser empties the DataTransfer once the event handler returns.
	items.length = 0;
	const result = await traverseEntries(snapshot.entries, snapshot.loose);
	assert.deepEqual(
		result.files.map((f) => f.relPath),
		['b.txt', 'folder/a.md']
	);
});

test('entriesFromDataTransfer: without entry support, the plain file list is used', async () => {
	const files = [fakeFile('one.pdf'), fakeFile('two.md')];
	const transfer: DataTransferLike = { items: [{ kind: 'file' }] as unknown as DataTransferLike['items'], files: files as unknown as DataTransferLike['files'] };
	const snapshot = entriesFromDataTransfer(transfer);
	assert.equal(snapshot.entries.length, 0);
	const result = await traverseEntries(snapshot.entries, snapshot.loose);
	assert.deepEqual(
		result.files.map((f) => f.relPath),
		['one.pdf', 'two.md']
	);
});

test('entriesFromDataTransfer: an item the browser gives no entry for is read through getAsFile', async () => {
	// A drop built by a page script (or some browsers for some sources) answers webkitGetAsEntry() with null.
	const items = [
		{ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => fakeFile('one.pdf') },
		{ kind: 'file', webkitGetAsEntry: () => fileEntry('/folder/two.md') },
		{ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => fakeFile('three.txt') },
	];
	const transfer: DataTransferLike = { items: items as unknown as DataTransferLike['items'], files: [] as unknown as DataTransferLike['files'] };
	const snapshot = entriesFromDataTransfer(transfer);
	assert.equal(snapshot.unreadable, 0);
	const result = await traverseDrop(snapshot);
	assert.deepEqual(
		result.files.map((f) => f.relPath),
		['folder/two.md', 'one.pdf', 'three.txt']
	);
	assert.deepEqual(result.errors, []);
});

test('traverseDrop: items with neither an entry nor a file are counted and the drop says so', async () => {
	const items = [
		{ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => null },
		{ kind: 'file', webkitGetAsEntry: () => null },
		{ kind: 'file', webkitGetAsEntry: () => fileEntry('/ok.md') },
	];
	const snapshot = entriesFromDataTransfer({ items: items as unknown as DataTransferLike['items'], files: [] as unknown as DataTransferLike['files'] });
	assert.equal(snapshot.unreadable, 2);
	const result = await traverseDrop(snapshot);
	assert.deepEqual(
		result.files.map((f) => f.relPath),
		['ok.md']
	);
	assert.deepEqual(result.errors, [unreadableSentence(2)]);
	assert.match(unreadableSentence(1), /^1 dropped item could not be read as a file\./);
	assert.match(unreadableSentence(2), /^2 dropped items could not be read as files\./);
	assert.match(unreadableSentence(2), /Add files or Add folder/);
});

test('traverseDrop: a drop that yields nothing at all says so instead of doing nothing', async () => {
	const nothing = await traverseDrop(entriesFromDataTransfer({ items: [{ kind: 'file', webkitGetAsEntry: () => null }] as unknown as DataTransferLike['items'], files: [] as unknown as DataTransferLike['files'] }));
	assert.deepEqual(nothing.files, []);
	assert.deepEqual(nothing.errors, [unreadableSentence(1)]);
	const empty = await traverseDrop(entriesFromDataTransfer({ items: [] as unknown as DataTransferLike['items'], files: [] as unknown as DataTransferLike['files'] }));
	assert.deepEqual(empty.errors, [DROP_NOTHING_READ]);
	assert.match(DROP_NOTHING_READ, /Add files or Add folder/);
	// A drop of only hidden files reports what it skipped, not "nothing".
	const hidden = await traverseDrop(entriesFromDataTransfer({ items: [{ kind: 'file', webkitGetAsEntry: () => fileEntry('/.DS_Store') }] as unknown as DataTransferLike['items'], files: [] as unknown as DataTransferLike['files'] }));
	assert.deepEqual(hidden.errors, []);
	assert.deepEqual(hidden.skipped, ['.DS_Store']);
});

test('filesFromInput: the folder picker keeps webkitRelativePath; hidden files inside folders are skipped', () => {
	const picked = filesFromInput([fakeFile('a.md', 1, 'notes/a.md'), fakeFile('.DS_Store', 1, 'notes/.DS_Store'), fakeFile('b.pdf', 1, 'notes/deep/b.pdf'), fakeFile('c.txt')]);
	assert.deepEqual(
		picked.files.map((f) => f.relPath),
		['notes/a.md', 'notes/deep/b.pdf', 'c.txt']
	);
	assert.deepEqual(picked.skipped, ['notes/.DS_Store']);
});

test('isHiddenName: dot files and the usual system files', () => {
	for (const name of ['.DS_Store', '.git', '.env', 'Thumbs.db', 'desktop.ini', '__MACOSX']) assert.equal(isHiddenName(name), true, name);
	for (const name of ['report.pdf', 'a.b.c.md', 'thumbs.db.txt']) assert.equal(isHiddenName(name), false, name);
});
