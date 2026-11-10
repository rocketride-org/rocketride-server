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

// =============================================================================
// STORE TESTS: putting the user's files back to a snapshot
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { restoreFiles, snapshotFiles, type FileApi } from './store';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array | undefined) => (data ? new TextDecoder().decode(data) : undefined);

/** The engine's file API over a map of store path to content, which lists folders from the paths and logs every write. */
function fakeStore(files: Record<string, string>) {
	const store = new Map<string, Uint8Array>(Object.entries(files).map(([p, t]) => [p, bytes(t)]));
	const open = new Map<string, Uint8Array>();
	const written: string[] = [];
	const api = {
		async fsListDir(dir = '') {
			const names = new Map<string, 'file' | 'dir'>();
			for (const p of store.keys()) {
				if (dir && !p.startsWith(`${dir}/`)) continue;
				const [name, ...rest] = (dir ? p.slice(dir.length + 1) : p).split('/');
				names.set(name as string, rest.length ? 'dir' : 'file');
			}
			const entries = [...names].map(([name, type]) => ({ name, type }));
			return { entries, count: entries.length };
		},
		async fsReadMany(paths: string[]) {
			return paths.map((p) => (store.has(p) ? { path: p, ok: true, data: store.get(p) } : { path: p, ok: false, error: 'not found' }));
		},
		async fsOpen(p: string) {
			open.set(p, new Uint8Array(0));
			return { handle: p };
		},
		async fsWrite(handle: string, data: Uint8Array) {
			open.set(handle, data);
			return data.length;
		},
		async fsClose(handle: string) {
			store.set(handle, open.get(handle) as Uint8Array);
			open.delete(handle);
			written.push(handle);
		},
		async fsDelete(p: string) {
			store.delete(p);
		},
	};
	return { api: api as unknown as FileApi, store, written };
}

const PUBLISHED = {
	'.projects/.appdev/spending-ui/package.json': '{"name":"spending-ui"}',
	'.workspace/global.json': '{"activeApp":null}',
	'.logs/run.jsonl': 'engine log',
	'.deployments/local.spending/v1.json': '{"version":1}',
};

test("restore deletes the files a session added and rewrites the ones it changed or deleted, leaving the rest and the engine's system trees alone", async () => {
	const { api, store, written } = fakeStore(PUBLISHED);
	const snapshot = await snapshotFiles(api, ['']);
	assert.deepEqual([...snapshot.files.keys()].sort(), ['.projects/.appdev/spending-ui/package.json', '.workspace/global.json']);

	// a session: the shell saves the app's state, the app writes its own file, a file is changed and one deleted
	store.set('.workspace/local.spending.workspace.json', bytes('{"appState":{"rows":15}}'));
	store.set('spending/ledger.json', bytes('{"rows":15}'));
	store.set('.workspace/global.json', bytes('{"activeApp":"local.spending"}'));
	store.delete('.projects/.appdev/spending-ui/package.json');
	store.set('.logs/run-2.jsonl', bytes('another engine log'));

	const done = await restoreFiles(api, snapshot);
	assert.deepEqual(done.deleted.sort(), ['.workspace/local.spending.workspace.json', 'spending/ledger.json']);
	assert.deepEqual(done.rewritten.sort(), ['.projects/.appdev/spending-ui/package.json', '.workspace/global.json']);
	assert.deepEqual(written.sort(), done.rewritten);
	assert.deepEqual(Object.fromEntries([...store].map(([p, data]) => [p, text(data)])), { ...PUBLISHED, '.logs/run-2.jsonl': 'another engine log' });

	// the store already matches: nothing to do
	assert.deepEqual(await restoreFiles(api, snapshot), { deleted: [], rewritten: [] });
});
