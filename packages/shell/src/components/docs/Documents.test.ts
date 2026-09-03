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

// The shell tsconfig deliberately keeps the browser surface node-free
// ("types": []); this co-located node:test suite opts back in explicitly.
/// <reference types="node" />

/**
 * Regression tests for the Cloud Pipeline Builder stale-content bug
 * (rocketride-org/rocketride-server#2036): `check_connection` -- no, this is
 * `Documents.openDocument` trusting an already-present, clean cache entry
 * forever, even when it no longer matches the backing store. Proven on
 * cloud.rocketride.ai: store v1, open it, overwrite the stored file to v2 via
 * the fs API directly, then close+reopen or hard-reload the browser -- the
 * editor kept showing v1. Publishing the same bytes under a NEW filename
 * showed v2 immediately, which is what pointed at a name-keyed cache rather
 * than a propagation delay.
 *
 * The one case worth protecting is a document with genuine unsaved local
 * edits (`dirty: true`) -- that content must never be silently replaced by
 * whatever the store currently holds.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { Documents, type IVirtualFileSystem, type DocumentsState, type WorkspaceBinding } from './Documents';

/** In-memory VFS backed by a mutable Map, so tests can simulate an external
 * write to the store between two `openDocument` calls. `reads` records every
 * path `read()` was called with, so tests can assert a path was NEVER read
 * (e.g. a static or untitled document, which has nothing on the store to
 * read in the first place). `pauseNextRead`/`resumeRead` let a test suspend
 * a read mid-flight to deterministically interleave another call into the
 * gap, without relying on timer-based guessing. */
function makeFakeVfs(initial: Record<string, unknown> = {}): {
	vfs: IVirtualFileSystem;
	store: Map<string, unknown>;
	failNextRead: Set<string>;
	reads: string[];
	pauseNextRead: (path: string) => void;
	resumeRead: (path: string) => void;
} {
	const store = new Map<string, unknown>(Object.entries(initial));
	const failNextRead = new Set<string>();
	const reads: string[] = [];
	const pauseOnRead = new Set<string>();
	const pausedResolvers = new Map<string, () => void>();
	const vfs: IVirtualFileSystem = {
		list: async () => [],
		read: async (path: string) => {
			reads.push(path);
			if (pauseOnRead.has(path)) {
				pauseOnRead.delete(path);
				await new Promise<void>((resolve) => pausedResolvers.set(path, resolve));
			}
			if (failNextRead.has(path)) {
				failNextRead.delete(path);
				throw new Error('simulated read failure');
			}
			return store.has(path) ? store.get(path) : null;
		},
		write: async (path: string, content: unknown) => {
			store.set(path, content);
		},
		rename: async () => undefined,
		delete: async () => undefined,
		mkdir: async () => undefined,
	};
	return {
		vfs,
		store,
		failNextRead,
		reads,
		pauseNextRead: (path: string) => pauseOnRead.add(path),
		resumeRead: (path: string) => {
			pausedResolvers.get(path)?.();
			pausedResolvers.delete(path);
		},
	};
}

/** A DocumentsState as it would come back from persisted workspace appState:
 * a document entry with no active editor referencing it (`editorCount: 0`)
 * and marked clean -- exactly what a hard browser reload restores. */
function makePersistedState(uri: string, content: unknown): DocumentsState {
	return {
		documents: { [uri]: { uri, content, dirty: false, version: 1, editorCount: 0, isNew: false } },
		editors: {},
		groups: { 'group-1': { id: 'group-1', editorIds: [], activeEditorIndex: -1 } },
		rootNode: { type: 'leaf', id: 'group-1', groupId: 'group-1' },
		activeGroupId: 'group-1',
	};
}

function makeWorkspace(state: DocumentsState): WorkspaceBinding {
	return {
		appState: { documents: state },
		updateAppState: () => {},
	};
}

test('opening a document for the first time reads from the VFS', async () => {
	const { vfs } = makeFakeVfs({ 'a.pipe': 'v1' });
	const docs = new Documents(vfs);
	await docs.openDocument('a.pipe');
	assert.equal(docs.getDocument('a.pipe')?.content, 'v1');
});

test('closing the last editor of a clean document evicts it, so a later reopen sees an external change', async () => {
	const { vfs, store } = makeFakeVfs({ 'a.pipe': 'v1' });
	const docs = new Documents(vfs);
	await docs.openDocument('a.pipe');
	const [editorId] = Object.keys(docs.getState().editors);
	docs.closeEditor(editorId!);
	assert.equal(docs.getDocument('a.pipe'), undefined, 'a clean, unreferenced document should be evicted on close');

	store.set('a.pipe', 'v2');
	await docs.openDocument('a.pipe');
	assert.equal(docs.getDocument('a.pipe')?.content, 'v2');
});

test('#2036: a clean document restored from a persisted session is re-read, not trusted forever', async () => {
	// Simulates surviving a hard browser reload: the constructor restores
	// documents.['a.pipe'] from persisted appState with the OLD content and
	// editorCount: 0 (no live editor references it yet in this fresh session).
	const { vfs } = makeFakeVfs({ 'a.pipe': 'v2' }); // the store was updated externally since persistence
	const docs = new Documents(vfs, makeWorkspace(makePersistedState('a.pipe', 'v1')));

	// Sanity: the persisted (stale) content is there before any open happens.
	assert.equal(docs.getDocument('a.pipe')?.content, 'v1');

	await docs.openDocument('a.pipe');

	assert.equal(docs.getDocument('a.pipe')?.content, 'v2', 'open must re-read a clean document rather than trust the persisted cache');
});

test('a document with unsaved edits is never silently replaced by the store', async () => {
	const { vfs, store } = makeFakeVfs({ 'a.pipe': 'v1' });
	const docs = new Documents(vfs);
	await docs.openDocument('a.pipe');
	docs.updateContent('a.pipe', 'my unsaved edit');
	assert.equal(docs.getDocument('a.pipe')?.dirty, true);

	// An external write happens while the user has unsaved local changes.
	store.set('a.pipe', 'v2 from someone else');

	// Open the same document in a second pane (bypasses the "already open in
	// this group" short-circuit, exercising the same-uri-different-group path).
	const secondGroup = docs.splitGroup('group-1', 'horizontal');
	await docs.openDocument('a.pipe', secondGroup);

	assert.equal(docs.getDocument('a.pipe')?.content, 'my unsaved edit', 'dirty content must not be clobbered by a fresh read');
});

test('a failed re-read falls back to the previously cached content instead of clearing it', async () => {
	const { vfs, store, failNextRead } = makeFakeVfs({ 'a.pipe': 'v1' });
	const docs = new Documents(vfs);
	await docs.openDocument('a.pipe');
	const [editorId] = Object.keys(docs.getState().editors);

	// Re-open the same document from a persisted-like state with editorCount 0
	// (simulating a fresh session) so the read path is exercised again, but
	// this time the read throws (e.g. a transient network blip).
	docs.closeEditor(editorId!); // fresh close, doc would normally be evicted...
	// ...so seed it back as if freshly restored, to isolate the failure path
	// from the eviction behavior already covered above.
	const docs2 = new Documents(vfs, makeWorkspace(makePersistedState('a.pipe', 'v1')));
	failNextRead.add('a.pipe');
	store.set('a.pipe', 'v2'); // irrelevant: the read will throw before reaching this

	await docs2.openDocument('a.pipe');

	assert.equal(docs2.getDocument('a.pipe')?.content, 'v1', 'a failed read must not wipe out the last known-good content');
	assert.equal(docs2.getDocument('a.pipe')?.isNew, false, 'a document recovered from cache after a failed read is not "new"');
});

test('a cached null content is preserved when a re-read fails, not replaced with empty string', async () => {
	// A document's content can legitimately be `null` -- e.g. saved that way
	// via updateContent(uri, null) then saveDocument(), which preserves
	// content verbatim while only flipping `dirty`. `doc?.content ?? ''`
	// would treat that valid null the same as "no cached document at all"
	// and clobber it with '' before the read even runs -- permanently, once
	// the read then fails and there's nothing to overwrite it with.
	const { vfs, failNextRead } = makeFakeVfs({ 'a.pipe': null });
	failNextRead.add('a.pipe');
	const docs = new Documents(vfs, makeWorkspace(makePersistedState('a.pipe', null)));

	await docs.openDocument('a.pipe');

	assert.equal(docs.getDocument('a.pipe')?.content, null, 'a legitimately null cached content must survive a failed re-read, not become an empty string');
});

test('a static document reopened in another group stays static and is never read from the VFS', async () => {
	// static documents (e.g. a monitor/webview panel) are explicitly not
	// backed by the VFS -- there's nothing on the store for a freshness
	// check to mean anything, and openDocument must not try one.
	const { vfs, reads } = makeFakeVfs();
	const docs = new Documents(vfs);
	docs.openStaticDocument('monitor', 'Monitor', 'live status');

	const secondGroup = docs.splitGroup('group-1', 'horizontal');
	await docs.openDocument('monitor', secondGroup);

	assert.equal(docs.getDocument('monitor')?.static, true, 'reopening in another group must not drop the static flag');
	assert.equal(docs.getDocument('monitor')?.content, 'live status');
	assert.equal(reads.includes('monitor'), false, 'a static document must never be read from the VFS');
});

test('an untitled document reopened in another group keeps isNew true and is never read from the VFS', async () => {
	// isNew (untitled) documents have never been saved -- there's no store
	// counterpart to re-read, and doing so would falsely mark them saved.
	const { vfs, reads } = makeFakeVfs();
	const docs = new Documents(vfs);
	const uri = docs.createDocument(undefined, 'draft content');

	const secondGroup = docs.splitGroup('group-1', 'horizontal');
	await docs.openDocument(uri, secondGroup);

	assert.equal(docs.getDocument(uri)?.isNew, true, 'reopening in another group must not clear isNew');
	assert.equal(docs.getDocument(uri)?.content, 'draft content');
	assert.equal(reads.includes(uri), false, 'an untitled document must never be read from the VFS');
});

test('two concurrent opens of the same uri into the same group do not create duplicate tabs', async () => {
	// The "already open in this group" check at the top of openDocument runs
	// on a snapshot taken before the VFS read below it. If that read actually
	// suspends (a real await, which a Promise-returning read always causes at
	// least once), a second openDocument(uri, group) call for the identical
	// document can run entirely in between and commit its own editor first --
	// racing both calls here reproduces exactly that interleaving.
	const { vfs } = makeFakeVfs({ 'a.pipe': 'v1' });
	const docs = new Documents(vfs);

	await Promise.all([docs.openDocument('a.pipe', 'group-1'), docs.openDocument('a.pipe', 'group-1')]);

	const group = docs.getState().groups['group-1']!;
	const editorsForUri = group.editorIds.filter((eid) => docs.getState().editors[eid]?.documentUri === 'a.pipe');
	assert.equal(editorsForUri.length, 1, 'racing two opens of the same document into the same group must not open two tabs');
	assert.equal(docs.getDocument('a.pipe')?.editorCount, 1, 'editorCount must reflect the single tab actually created, not one per racing call');
});

test('discarding a document while its re-read is in flight does not resurrect it', async () => {
	// discardDocument() force-removes a document specifically because its
	// backing file was deleted from disk. If that races in while a clean
	// document is being re-read for a second pane, the read's result (which
	// may have started before the deletion, or is now reading a vanished
	// file) must not silently bring the document back.
	const { vfs, pauseNextRead, resumeRead } = makeFakeVfs({ 'a.pipe': 'v1' });
	const docs = new Documents(vfs);
	await docs.openDocument('a.pipe'); // cached, clean, one editor in group-1

	const secondGroup = docs.splitGroup('group-1', 'horizontal');
	pauseNextRead('a.pipe');
	const reopen = docs.openDocument('a.pipe', secondGroup); // suspends inside vfs.read()

	docs.discardDocument('a.pipe'); // simulates: the backing file was deleted from disk
	resumeRead('a.pipe');
	await reopen;

	assert.equal(docs.getDocument('a.pipe'), undefined, 'a document discarded mid-read must not be resurrected');
	const remainingEditors = Object.values(docs.getState().editors).filter((e) => e.documentUri === 'a.pipe');
	assert.equal(remainingEditors.length, 0, 'no editor should be created for a document discarded mid-open');
});
