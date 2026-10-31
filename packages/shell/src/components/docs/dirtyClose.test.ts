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
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

// Tests for the dirty-close policy: the no-orphan close, the tri-state
// policy hooks, the last-view rule (a split view closes silently), the
// aggregated group prompt, and restore-time pruning of state written by
// the builds that orphaned documents.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Documents } from './Documents';
import type { DirtyCloseChoice, DirtyDocInfo, DocumentsUi } from './Documents';
import type { IVirtualFileSystem } from '../../modules/explorer/types';

/** A minimal in-memory VFS: enough for openDocument/saveDocument. */
function fakeVfs(seed: Record<string, unknown> = {}): IVirtualFileSystem & { files: Record<string, unknown> } {
	const files: Record<string, unknown> = { ...seed };
	return {
		files,
		list: async () => Object.keys(files).map((name) => ({ name, type: 'file' as const })),
		read: async (path: string) => files[path],
		write: async (path: string, content: unknown) => { files[path] = content; },
		rename: async () => {},
		delete: async () => {},
		mkdir: async () => {},
	};
}

/** A Documents instance with a recording policy hook. */
function withPolicy(choice: DirtyCloseChoice | null, seed: Record<string, unknown> = {}) {
	const asked: DirtyDocInfo[][] = [];
	const ui: DocumentsUi = {
		confirmDirtyClose: choice === null ? null : async (docs) => { asked.push([...docs]); return choice; },
	};
	const vfs = fakeVfs(seed);
	const docs = new Documents({ vfs, ui });
	return { docs, vfs, asked };
}

/** Opens an existing file and dirties it. */
async function openDirty(docs: Documents, uri: string): Promise<void> {
	await docs.openDocument(uri);
	docs.updateContent(uri, 'edited');
}

/** The editor ids currently in the active group. */
function editorIds(docs: Documents): string[] {
	const s = docs.getState();
	return [...(s.groups[s.activeGroupId]?.editorIds ?? [])];
}

test('closeEditor leaves no orphan when the last view of a dirty document closes', async () => {
	const { docs } = withPolicy('discard', { 'a.txt': 'original' });
	await openDirty(docs, 'a.txt');
	assert.equal(docs.getState().documents['a.txt']?.dirty, true);

	docs.closeEditor(editorIds(docs)[0]!);

	// The pre-fix behavior kept the document at editorCount 0 — no tab, but
	// unsaved content persisted into workspace state forever.
	assert.equal(docs.getState().documents['a.txt'], undefined);
	assert.deepEqual(editorIds(docs), []);
});

test('requestCloseEditor cancels the close when the policy says cancel', async () => {
	const { docs, asked } = withPolicy('cancel', { 'a.txt': 'original' });
	await openDirty(docs, 'a.txt');

	const closed = await docs.requestCloseEditor(editorIds(docs)[0]!);

	assert.equal(closed, false);
	assert.equal(asked.length, 1);
	assert.equal(docs.getState().documents['a.txt']?.dirty, true, 'content survives a cancel');
	assert.equal(editorIds(docs).length, 1, 'the tab stays open');
});

test('requestCloseEditor discards and closes when the policy says discard', async () => {
	const { docs, asked } = withPolicy('discard', { 'a.txt': 'original' });
	await openDirty(docs, 'a.txt');

	const closed = await docs.requestCloseEditor(editorIds(docs)[0]!);

	assert.equal(closed, true);
	assert.equal(asked.length, 1);
	assert.equal(docs.getState().documents['a.txt'], undefined);
});

test('requestCloseEditor saves through the VFS when the policy says save', async () => {
	const { docs, vfs, asked } = withPolicy('save', { 'a.txt': 'original' });
	await openDirty(docs, 'a.txt');

	const closed = await docs.requestCloseEditor(editorIds(docs)[0]!);

	assert.equal(closed, true);
	assert.equal(asked.length, 1);
	assert.equal(vfs.files['a.txt'], 'edited', 'the edit reached the VFS');
	assert.equal(docs.getState().documents['a.txt'], undefined);
});

test('a non-last view closes WITHOUT asking, and the document survives', async () => {
	const { docs, asked } = withPolicy('cancel', { 'a.txt': 'original' });
	await openDirty(docs, 'a.txt');

	// Split the document into a second group — two views, one document.
	docs.splitGroupWithDocument(docs.getState().activeGroupId, 'horizontal');
	assert.equal(docs.getState().documents['a.txt']?.editorCount, 2);

	// Close ONE of them. Nothing is destroyed, so nothing is asked — and a
	// 'cancel' policy must not be able to block it.
	const firstEditor = Object.keys(docs.getState().editors)[0]!;
	const closed = await docs.requestCloseEditor(firstEditor);

	assert.equal(closed, true);
	assert.equal(asked.length, 0, 'no prompt for a view that destroys nothing');
	assert.equal(docs.getState().documents['a.txt']?.editorCount, 1);
	assert.equal(docs.getState().documents['a.txt']?.dirty, true, 'edits still reachable');
});

test('a null policy discards without asking (the explicit opt-out)', async () => {
	const { docs, asked } = withPolicy(null, { 'a.txt': 'original' });
	await openDirty(docs, 'a.txt');

	const closed = await docs.requestCloseEditor(editorIds(docs)[0]!);

	assert.equal(closed, true);
	assert.equal(asked.length, 0);
	assert.equal(docs.getState().documents['a.txt'], undefined);
});

test('requestCloseGroup asks ONCE for every document it is the last home of', async () => {
	const { docs, asked } = withPolicy('cancel', { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' });
	await openDirty(docs, 'a.txt');
	await openDirty(docs, 'b.txt');
	await docs.openDocument('c.txt'); // clean — not at risk

	const groupId = docs.getState().activeGroupId;
	const closed = await docs.requestCloseGroup(groupId);

	assert.equal(closed, false, 'cancel abandons the group close');
	assert.equal(asked.length, 1, 'one aggregated prompt, not one per tab');
	assert.deepEqual(asked[0]!.map((d) => d.uri).sort(), ['a.txt', 'b.txt']);
	assert.equal(editorIds(docs).length, 3, 'nothing closed');
});

test('requestCloseGroup ignores a document still open in another group', async () => {
	const { docs, asked } = withPolicy('discard', { 'a.txt': 'original' });
	await openDirty(docs, 'a.txt');

	// Same document in a second group; closing one group is not its last home.
	const original = docs.getState().activeGroupId;
	docs.splitGroupWithDocument(original, 'vertical');

	const closed = await docs.requestCloseGroup(original);

	assert.equal(closed, true);
	assert.equal(asked.length, 0, 'a surviving view elsewhere means nothing is at risk');
	assert.equal(docs.getState().documents['a.txt']?.dirty, true);
});

test('changes debounce rather than writing per mutation, and flush on demand', () => {
	// Every write is a server round trip, so nothing persists per mutation —
	// not even a tab open or close. flushPersistence() is what covers the
	// teardown case, and it must write the CURRENT state, not a stale one.
	let appState: Record<string, unknown> = {};
	let writes = 0;
	let flushes = 0;
	const docs = new Documents({
		ui: { confirmDirtyClose: null },
		workspace: {
			appState,
			updateAppState: (updater) => { appState = updater(appState); writes++; },
			flushNow: () => { flushes++; },
		},
	});

	docs.openStaticDocument('tool:rocketride.monitor', 'Server Monitor');
	const editorId = Object.keys(docs.getState().editors)[0]!;
	for (let i = 0; i < 25; i++) docs.updateEditorViewport(editorId, { scrollTop: i });
	docs.closeEditor(editorId);

	assert.equal(writes, 0, 'no mutation wrote through on its own');

	docs.flushPersistence();

	assert.equal(writes, 1, 'one write for everything that accumulated');
	assert.equal(flushes, 1, 'and it pushes on through the workspace debounce too');
	const persisted = appState.documents as { documents: object; editors: object } | undefined;
	assert.deepEqual(persisted?.editors, {}, 'the flushed state reflects the close');
	assert.deepEqual(persisted?.documents, {}, 'no document survives in persisted state');
});

test('restore prunes documents and editors nothing can reach', () => {
	// State as the orphaning builds wrote it: a document with no editor, an
	// editor no group lists, and a live document whose count drifted.
	const persisted = {
		documents: {
			'live.txt': { uri: 'live.txt', content: 'x', dirty: false, version: 1, editorCount: 7, isNew: false },
			'orphan.txt': { uri: 'orphan.txt', content: 'lost edits', dirty: true, version: 3, editorCount: 0, isNew: false },
		},
		editors: {
			'editor-1': { id: 'editor-1', documentUri: 'live.txt', scrollTop: 0, scrollLeft: 0, cursorLine: 1, cursorColumn: 1, label: 'live.txt' },
			'editor-9': { id: 'editor-9', documentUri: 'orphan.txt', scrollTop: 0, scrollLeft: 0, cursorLine: 1, cursorColumn: 1, label: 'orphan.txt' },
		},
		groups: { 'group-1': { id: 'group-1', editorIds: ['editor-1'], activeEditorIndex: 0 } },
		rootNode: { type: 'leaf', id: 'group-1', groupId: 'group-1' },
		activeGroupId: 'group-1',
	};

	const docs = new Documents({
		workspace: { appState: { documents: persisted }, updateAppState: () => {} },
	});
	const s = docs.getState();

	assert.equal(s.documents['orphan.txt'], undefined, 'unreachable document dropped');
	assert.equal(s.editors['editor-9'], undefined, 'unlisted editor dropped');
	assert.ok(s.documents['live.txt'], 'reachable document kept');
	assert.equal(s.documents['live.txt']?.editorCount, 1, 'count rebuilt from real references');
});
