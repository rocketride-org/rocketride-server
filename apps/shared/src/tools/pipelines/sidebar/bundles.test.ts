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

/** Pipeline bundles in the sidebar: a folder holding one pipe is one entry (plan §9). */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { bundlePathsFor, collapseBundles, entryPathOfFile, fileOfEntry, isShortId, pipeStemOf } from './bundles';
import type { ProjectEntry } from './types';

test('a short id is one dot-free segment', () => {
	assert.equal(isShortId('docBrain'), true);
	assert.equal(isShortId('doc-brain_2'), true);
	assert.equal(isShortId('00000000-0000-0000-0000-000000000000'), true);
	assert.equal(isShortId('acme.docBrain'), false);
	assert.equal(isShortId(''), false);
	assert.equal(isShortId('doc brain'), false);
});

test('the pipe stem drops either pipeline extension and nothing else', () => {
	assert.equal(pipeStemOf('ingest/docBrain.pipe'), 'docBrain');
	assert.equal(pipeStemOf('docBrain.pipe.json'), 'docBrain');
	assert.equal(pipeStemOf('docBrain/readme.md'), null);
	assert.equal(pipeStemOf('.pipe'), null);
});

test('bundle paths for a new pipeline put the pipe in a folder of the typed name', () => {
	assert.deepEqual(bundlePathsFor('', 'docBrain'), { folder: 'docBrain', file: 'docBrain/docBrain.pipe' });
	assert.deepEqual(bundlePathsFor('ingest', 'docBrain'), { folder: 'ingest/docBrain', file: 'ingest/docBrain/docBrain.pipe' });
});

test('a folder holding one pipe is a bundle whatever the file is called; its id comes from the file', () => {
	const entries: ProjectEntry[] = [
		{ path: 'docBrain', type: 'dir' },
		{ path: 'docBrain/assets', type: 'dir' },
		{ path: 'docBrain/anything.pipe', type: 'file', projectId: 'brain', sources: [{ id: 'webhook_1', name: 'Webhook' }] },
		{ path: 'flat.pipe', type: 'file', projectId: 'flat' },
		{ path: 'ingest', type: 'dir' },
		{ path: 'ingest/a.pipe', type: 'file', projectId: 'a' },
		{ path: 'ingest/b.pipe', type: 'file', projectId: 'b' },
	];
	const out = collapseBundles(entries);
	assert.deepEqual(out, [
		{ path: 'docBrain', type: 'file', projectId: 'brain', sources: [{ id: 'webhook_1', name: 'Webhook' }], file: 'docBrain/anything.pipe' },
		{ path: 'flat.pipe', type: 'file', projectId: 'flat' },
		{ path: 'ingest', type: 'dir' },
		{ path: 'ingest/a.pipe', type: 'file', projectId: 'a' },
		{ path: 'ingest/b.pipe', type: 'file', projectId: 'b' },
	]);
	// The input is not modified.
	assert.equal(entries.length, 7);
});

test('a folder with one direct pipe but pipes deeper is a directory, not a bundle', () => {
	const entries: ProjectEntry[] = [
		{ path: 'ingest/main.pipe', projectId: 'main' },
		{ path: 'ingest/sub/other.pipe', projectId: 'other' },
	];
	const out = collapseBundles(entries);
	assert.equal(out.length, 2);
	// The inner folder holds one pipe and nothing deeper: that one IS a bundle.
	assert.deepEqual(out[1], { path: 'ingest/sub', type: 'file', projectId: 'other', file: 'ingest/sub/other.pipe' });
	assert.deepEqual(out[0], entries[0]);
});

test('a bundle discovered without its folder entry (VS Code lists files only) still collapses', () => {
	const out = collapseBundles([{ path: 'pipelines/docBrain/docBrain.pipe', projectId: 'docBrain' }]);
	assert.deepEqual(out, [{ path: 'pipelines/docBrain', type: 'file', projectId: 'docBrain', file: 'pipelines/docBrain/docBrain.pipe' }]);
});

test('no bundles: the list is returned as is', () => {
	const entries: ProjectEntry[] = [{ path: 'a.pipe' }, { path: 'dir', type: 'dir' }, { path: 'dir/x.pipe' }, { path: 'dir/y.pipe' }];
	assert.equal(collapseBundles(entries), entries);
});

test('a sidebar path maps to the file it opens and back', () => {
	const entries = collapseBundles([{ path: 'docBrain/main.pipe', projectId: 'docBrain' }, { path: 'flat.pipe' }]);
	assert.equal(fileOfEntry(entries, 'docBrain'), 'docBrain/main.pipe');
	assert.equal(fileOfEntry(entries, 'flat.pipe'), 'flat.pipe');
	assert.equal(fileOfEntry(entries, 'unknown.pipe'), 'unknown.pipe');
	assert.equal(entryPathOfFile(entries, 'docBrain/main.pipe'), 'docBrain');
	assert.equal(entryPathOfFile(entries, 'flat.pipe'), 'flat.pipe');
});
