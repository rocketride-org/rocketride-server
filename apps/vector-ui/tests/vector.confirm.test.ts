// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CONFIRM AND REMOVE: what the dialogs say, typed confirmations, batches that stop at the first error
// =============================================================================
//
// Three writes are confirmed here: Move to trash (nothing to type: it can be
// undone from the Trash), Delete permanently and Empty trash (both typed as
// before: the count of several documents, or a shared table's name). The
// map's duplicates queue moves to the trash through the same path: its queued
// documents reach the console's dialog whole (the paths listed), and the
// confirmed write sends them in batches of the node's write_ids_max, nothing
// before Confirm and nothing after Cancel.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { manualClock } from 'shared/explorer/connect/testing';
import { requestRemoval } from '../src/components/DuplicatesPanel';
import type { IDocumentItem } from '../src/contract/types';
import { dedupeView, docInfo, queueInit, queueReducer, queued } from '../src/map/dedupe';
import { MULTI_REMOVE_LIST_MAX } from '../src/vector/budgets';
import { createConsoleStore } from '../src/vector/consoleStore';
import type { IConsoleDeps } from '../src/vector/consoleStore';
import { readChunksPage, readDocumentsPage, readDeleteResult, readStats, readTrashResult } from '../src/vector/results';
import { loadSample } from './support/map.samples';
import { fixture } from './support/fixtures';
import { REMOVE_CANCEL_LABEL, batches, confirmReady, emptyTrashConfirmation, multiRemoveConfirmation, multiTrashConfirmation, removalSummary, removeConfirmation, runRemoval, trashConfirmation } from '../src/vector/confirm';
import type { IRemoveContext } from '../src/vector/confirm';
import type { IRemoveView } from '../src/vector/results';
import { CODE_SENTENCES } from '../src/vector/wording';

const PG: IRemoveContext = { storeName: 'PostgreSQL (pgvector)', collection: 'vx_demo_docs', backend: 'pgvector', provider: 'postgres' };
const RRV: IRemoveContext = { storeName: 'RocketRide Vector', collection: 'vector_explorer_docs', backend: 'pgvector', provider: 'rocketride_vector' };
const KESTREL = { objectId: 'kestrel-guide-object-id', path: 'C:/demo/field/kestrel_field_guide.md', chunks: 12 };

test('move to trash: the same lines, nothing to type, and where it can be restored from', () => {
	const c = trashConfirmation(KESTREL, PG);
	assert.equal(c.title, 'Move this document to the trash?');
	assert.deepEqual(
		c.lines.map((l) => l.label),
		['Path', 'objectId', 'Chunks', 'Store']
	);
	assert.equal(c.sentence, 'Moves this document and its 12 chunks to the trash of vx_demo_docs. Search, chat and the map leave it out until it is restored from the Trash.');
	assert.equal(c.confirmLabel, 'Move to trash');
	assert.equal(c.typed, null, 'nothing to type: it can be undone');
	assert.equal(c.destructive, false);
	const shared = trashConfirmation(KESTREL, RRV);
	assert.equal(shared.typed, null, 'not on a shared table either');
	assert.ok(shared.extra.includes("Shared table: every pipeline in this organization that names table 'vector_explorer_docs' reads and writes these rows."), 'the shared table is still said');
	const several = multiTrashConfirmation(
		Array.from({ length: 23 }, (_, i) => ({ objectId: `id-${i}`, path: `C:/demo/f${i}.md`, chunks: 2 })),
		PG
	);
	assert.deepEqual([several.title, several.confirmLabel, several.typed, several.more, several.destructive], ['Move 23 documents to the trash?', 'Move 23 documents to the trash', null, 3, false]);
	assert.equal(several.sentence, 'Moves these 23 documents and their 46 chunks to the trash of vx_demo_docs, in batches of at most 100; the first error stops the rest. Restore them from the Trash.');
});

test('delete permanently, one document: path, short objectId, chunk count, where, what cannot be undone, and its file name typed', () => {
	const c = removeConfirmation(KESTREL, PG);
	assert.equal(c.title, 'Delete this document permanently?');
	assert.deepEqual(c.lines, [
		{ label: 'Path', value: 'C:/demo/field/kestrel_field_guide.md' },
		{ label: 'objectId', value: 'kestrel-…' },
		{ label: 'Chunks', value: '12' },
		{ label: 'Store', value: 'PostgreSQL (pgvector) · vx_demo_docs · pgvector' },
	]);
	assert.equal(c.sentence, 'Deletes this document and its 12 chunks from vx_demo_docs. If it still has chunks outside the trash, it is kept whole. This cannot be undone; add the file again to restore it.');
	assert.equal(c.confirmLabel, 'Delete permanently');
	assert.equal(c.destructive, true);
	assert.equal(c.cancelLabel, REMOVE_CANCEL_LABEL);
	assert.equal(REMOVE_CANCEL_LABEL, 'Cancel');
	assert.deepEqual(c.typed, { expected: 'kestrel_field_guide.md', prompt: "Type the file name 'kestrel_field_guide.md' to confirm." }, 'a permanent delete of one document types its file name (DA-R0 C1)');
	assert.deepEqual(removeConfirmation({ ...KESTREL, path: '' }, PG).typed, { expected: '1', prompt: 'Type 1 to confirm.' }, 'no path: the count, 1');
	assert.equal(removeConfirmation({ ...KESTREL, chunks: null }, PG).sentence, 'Deletes this document and all its chunks from vx_demo_docs. If it still has chunks outside the trash, it is kept whole. This cannot be undone; add the file again to restore it.', 'no invented count');
	assert.equal(removeConfirmation({ ...KESTREL, chunks: 1 }, PG).sentence.includes('its 1 chunk from'), true);
});

test('rocketride_vector: deleting permanently types the table name, and says the table is shared by the organization', () => {
	const c = removeConfirmation(KESTREL, RRV);
	assert.deepEqual(c.typed, { expected: 'vector_explorer_docs', prompt: "Type the table name 'vector_explorer_docs' to confirm." });
	assert.ok(c.extra.includes("Shared table: every pipeline in this organization that names table 'vector_explorer_docs' reads and writes these rows."));
	assert.equal(confirmReady(c.typed, 'vector_explorer_docs'), true);
	assert.equal(confirmReady(c.typed, ' vector_explorer_docs '), true);
	assert.equal(confirmReady(c.typed, 'VECTOR_EXPLORER_DOCS'), false);
	assert.equal(confirmReady(null, ''), true);
});

test('delete permanently, several documents: type the count, at most 20 paths listed, the rest counted', () => {
	const targets = Array.from({ length: 23 }, (_, i) => ({ objectId: `id-${i}`, path: `C:/demo/f${i}.md`, chunks: 2 }));
	const c = multiRemoveConfirmation(targets, PG);
	assert.equal(c.title, 'Delete 23 documents permanently?');
	assert.equal(c.listed.length, MULTI_REMOVE_LIST_MAX);
	assert.equal(c.more, 3);
	assert.deepEqual(c.typed, { expected: '23', prompt: 'Type 23 to confirm.' });
	assert.equal(c.confirmLabel, 'Delete 23 documents permanently');
	assert.equal(c.sentence, 'Deletes these 23 documents and their 46 chunks from vx_demo_docs, in batches of at most 100; the first error stops the rest. A document that still has chunks outside the trash is kept whole. This cannot be undone.');
	const shared = multiRemoveConfirmation(targets.slice(0, 2), RRV);
	assert.equal(shared.typed?.expected, 'vector_explorer_docs', 'on a shared table the table name is typed, not the count');
	assert.equal(multiRemoveConfirmation([...targets.slice(0, 1), { objectId: 'x', path: 'x', chunks: null }], PG).sentence.includes('and all their chunks'), true);
});

test('empty trash: the documents in the trash listed, the count typed (a shared table its name), and what is kept', () => {
	const targets = Array.from({ length: 23 }, (_, i) => ({ objectId: `id-${i}`, path: `C:/demo/f${i}.md`, chunks: 2 }));
	const c = emptyTrashConfirmation(targets, PG);
	assert.deepEqual([c.title, c.confirmLabel, c.listed.length, c.more, c.destructive], ['Empty the trash?', 'Empty trash', MULTI_REMOVE_LIST_MAX, 3, true]);
	assert.deepEqual(c.typed, { expected: '23', prompt: 'Type 23 to confirm.' });
	assert.equal(c.sentence, 'Deletes the 23 documents in the trash of vx_demo_docs permanently, in batches of at most 100; a document that still has chunks outside the trash is kept. This cannot be undone.');
	assert.equal(emptyTrashConfirmation(targets.slice(0, 1), PG).typed?.expected, '1', 'even one document is typed');
	assert.equal(emptyTrashConfirmation(targets, RRV).typed?.expected, 'vector_explorer_docs');
});

test("batches of at most 100 (the node's write_ids_max)", () => {
	const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`);
	assert.deepEqual(
		batches(ids, 100).map((b) => b.length),
		[100, 100, 50]
	);
	assert.deepEqual(batches([], 100), []);
	assert.deepEqual(batches(['a'], 0), [['a']], 'a nonsense size still sends one id per batch');
});

test('runRemoval: every batch in order, rows as the node reported them', async () => {
	const sent: string[][] = [];
	const outcome = await runRemoval(
		['a', 'b', 'c'],
		async (batch) => {
			sent.push(batch);
			return { removed: batch.filter((id) => id !== 'c').map((objectId) => ({ objectId, chunks: 2 })), notFound: batch.filter((id) => id === 'c'), keptLive: [], removedChunks: 2 * batch.filter((id) => id !== 'c').length } satisfies IRemoveView;
		},
		2
	);
	assert.deepEqual(sent, [['a', 'b'], ['c']]);
	assert.deepEqual(
		outcome.removed.map((r) => r.objectId),
		['a', 'b']
	);
	assert.deepEqual(outcome.notFound, ['c']);
	assert.equal(outcome.removedChunks, 4);
	assert.equal(outcome.batchesRun, 2);
	assert.equal(outcome.batchesTotal, 2);
	assert.equal(outcome.error, null);
});

test('runRemoval stops at the first error and says what already ran; a count the node did not give stays unknown', async () => {
	const sent: string[][] = [];
	const outcome = await runRemoval(
		['a', 'b', 'c', 'd'],
		async (batch) => {
			sent.push(batch);
			if (batch[0] === 'c') throw new ExplorerToolError({ kind: 'store', tool: 'delete', message: 'Removing documents is turned off', code: 'WRITES_DISABLED' });
			return { removed: batch.map((objectId) => ({ objectId, chunks: null })), notFound: [], keptLive: [], removedChunks: null };
		},
		2
	);
	assert.deepEqual(
		sent,
		[
			['a', 'b'],
			['c', 'd'],
		],
		'nothing after the failed batch is sent'
	);
	assert.equal(outcome.batchesRun, 1);
	assert.equal(outcome.removedChunks, null);
	assert.deepEqual(outcome.error, { headline: CODE_SENTENCES.WRITES_DISABLED });
	assert.equal(removalSummary(outcome, [{ objectId: 'a', path: 'a.md' }], 'delete'), `Deleted 2 documents permanently. Stopped after 1 of 2 batches: ${CODE_SENTENCES.WRITES_DISABLED}`);
});

test('the announcement after a write names the document and the rows it moved or deleted', () => {
	const kestrel = [{ objectId: 'k', path: 'C:/demo/field/kestrel_field_guide.md' }];
	const one = { removed: [{ objectId: 'k', chunks: 12 }], notFound: [], keptLive: [], removedChunks: 12, batchesRun: 1, batchesTotal: 1, error: null };
	assert.equal(removalSummary(one, kestrel, 'delete'), 'Deleted C:/demo/field/kestrel_field_guide.md permanently (12 chunks)');
	assert.equal(removalSummary(one, kestrel, 'trash'), 'Moved C:/demo/field/kestrel_field_guide.md to the trash (12 chunks)');
	assert.equal(removalSummary(one, kestrel, 'restore'), 'Restored C:/demo/field/kestrel_field_guide.md (12 chunks)');
	const gone = { removed: [], notFound: ['k'], keptLive: [], removedChunks: 0, batchesRun: 1, batchesTotal: 1, error: null };
	assert.equal(removalSummary(gone, [{ objectId: 'k', path: 'x.md' }], 'delete'), 'x.md was already gone; nothing was deleted');
	assert.equal(removalSummary(gone, [{ objectId: 'k', path: 'x.md' }], 'trash'), 'x.md was already gone; nothing was moved to the trash');
	const many = {
		removed: [
			{ objectId: 'a', chunks: 1 },
			{ objectId: 'b', chunks: 2 },
		],
		notFound: ['c'],
		keptLive: [],
		removedChunks: 3,
		batchesRun: 1,
		batchesTotal: 1,
		error: null,
	};
	assert.equal(removalSummary(many, [], 'delete'), 'Deleted 2 documents permanently (3 chunks). 1 was already gone.');
	assert.equal(removalSummary(many, [], 'restore'), 'Restored 2 documents (3 chunks). 1 was already gone.');
	const emptied = { ...many, notFound: [], keptLive: ['p', 'q'] };
	assert.equal(removalSummary(emptied, [], 'empty'), 'Emptied the trash: deleted 2 documents permanently (3 chunks). 2 were kept whole, because they still have chunks outside the trash: p, q.', 'named by objectId where no path is known');
	assert.equal(removalSummary(emptied, [{ objectId: 'p', path: 'docs/p.md' }], 'empty'), 'Emptied the trash: deleted 2 documents permanently (3 chunks). 2 were kept whole, because they still have chunks outside the trash: docs/p.md, q.', 'by path where it is');
	assert.equal(removalSummary({ ...emptied, keptLive: [] }, [{ objectId: 'a', path: 'a.md' }], 'empty'), 'Emptied the trash: deleted 2 documents permanently (3 chunks).', 'Empty trash always counts, even for one document');
	const timeout = { removed: [], notFound: [], keptLive: [], removedChunks: null, batchesRun: 0, batchesTotal: 1, error: { headline: 'The request may still complete on the server. Refresh to check.' } };
	assert.equal(removalSummary(timeout, [{ objectId: 'k', path: 'x.md' }], 'trash'), 'The request may still complete on the server. Refresh to check.');
	assert.equal(removalSummary({ ...timeout, error: null }, [], 'empty'), 'Nothing was deleted.');
});

// =============================================================================
// THE DUPLICATES QUEUE THROUGH THE CONSOLE'S DIALOG
// =============================================================================

/** The demo sample's queue with a document kept by hand in each group, with directory rows for every document of the sample. */
function demoQueue(): { ids: string[]; rows: IDocumentItem[] } {
	const sample = loadSample('sample_demo_1000.json');
	const rows: IDocumentItem[] = sample.docs.map((d) => ({ objectId: d.objectId, path: d.path, chunks: d.chunks, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt: null, pointId: null }));
	const view = dedupeView(sample, 0.97);
	// The demo's groups are shared passages, which a policy leaves alone: keep the first document of each by hand.
	const state = view.groups.reduce((s, g) => queueReducer(s, { type: 'keep', group: g.key, objectId: g.objectIds[0] as string }), queueInit());
	return { ids: queued(view.groups, state, docInfo(sample, rows), new Set()).objectIds, rows };
}

/** A console controller whose moves to the trash are recorded batch by batch. */
function consoleWith(rows: IDocumentItem[], writeBatch: number) {
	const sent: string[][] = [];
	const clock = manualClock(Date.parse('2026-10-15T09:00:00Z'));
	const deps: IConsoleDeps = {
		stats: async () => readStats(fixture('stats_pgvector')),
		documents: async () => readDocumentsPage({ ...fixture('list_documents_page2_last'), items: rows }),
		chunks: async () => readChunksPage(fixture('chunks_page')),
		trash: async (ids) => {
			sent.push([...ids]);
			return readTrashResult({ ...fixture('soft_delete_ok'), object_ids: ids, matched_chunks: 3 * ids.length });
		},
		restore: async () => assert.fail('the queue never restores'),
		remove: async (ids) => {
			assert.fail(`the queue never deletes permanently (${ids.length})`);
			return readDeleteResult(fixture('delete_ok'), ids);
		},
		announce: () => undefined,
		clock,
	};
	const store = createConsoleStore(deps, { pageSize: 500, chunkPage: 100, writeBatch });
	store.setWritesEnabled(true);
	return { store, sent };
}

test('the queued duplicates reach the move-to-trash dialog whole: their paths, nothing to type, nothing sent before Confirm', () => {
	const { ids, rows } = demoQueue();
	assert.equal(ids.length, 5, 'the four-document group queues three, each pair one');
	const { store, sent } = consoleWith(rows, 100);
	const byId = new Map(rows.map((r) => [r.objectId, r]));
	const asked: string[][] = [];
	assert.equal(requestRemoval(ids, { onRemoveDocument: () => assert.fail('never the single dialog for a queue'), onRemoveDocuments: (objectIds) => asked.push([...objectIds]) }), true);
	assert.deepEqual(asked, [ids], 'the whole queue, never cut to write_ids_max');
	store.requestRemove(asked[0]!.map((objectId) => ({ objectId, path: byId.get(objectId)!.path, chunks: byId.get(objectId)!.chunks })));
	const pending = store.getState().confirm;
	assert.deepEqual([pending?.action, pending?.kind], ['trash', 'multi']);
	assert.deepEqual(
		pending?.targets.map((t) => t.objectId),
		ids
	);
	const dialog = multiTrashConfirmation(pending!.targets, PG);
	assert.equal(dialog.title, 'Move 5 documents to the trash?');
	assert.equal(dialog.typed, null);
	assert.deepEqual(
		dialog.listed,
		ids.map((id) => byId.get(id)!.path)
	);
	assert.deepEqual(sent, [], 'nothing is sent while the dialog is open');
	store.cancelRemove();
	assert.deepEqual(sent, [], 'Cancel sends nothing');
	store.dispose();
});

test("confirming the queue moves it to the trash in batches of the node's write_ids_max, every queued document once", async () => {
	const { ids, rows } = demoQueue();
	const { store, sent } = consoleWith(rows, 2);
	store.requestRemove(ids.map((objectId) => ({ objectId, path: objectId, chunks: null })));
	await store.confirmRemove();
	assert.deepEqual(
		sent.map((b) => b.length),
		[2, 2, 1]
	);
	assert.deepEqual(sent.flat(), ids);
	assert.equal(store.getState().removal.status, 'done');
	store.dispose();
});

test('a typed confirmation trims both sides: a file name that starts or ends with a space can be confirmed', () => {
	const { confirmReady } = require('../src/vector/confirm') as typeof import('../src/vector/confirm');
	assert.equal(confirmReady({ expected: ' notes.md ', prompt: '' }, 'notes.md'), true);
	assert.equal(confirmReady({ expected: 'notes.md', prompt: '' }, '  notes.md '), true);
	assert.equal(confirmReady({ expected: 'notes.md', prompt: '' }, 'notes'), false);
	assert.equal(confirmReady(null, ''), true);
});

test("the first focus (P2-11): Confirm for a move to the trash, Cancel for a bulk one (over 100 documents or one store batch), the typed field for a permanent write", () => {
	const { BULK_TRASH_FOCUS_CANCEL, confirmFirstFocus } = require('../src/vector/confirm') as typeof import('../src/vector/confirm');
	assert.equal(BULK_TRASH_FOCUS_CANCEL, 100);
	assert.equal(confirmFirstFocus('trash', 1, 100), 'confirm');
	assert.equal(confirmFirstFocus('trash', 100, 100), 'confirm', 'one full batch: still Confirm');
	assert.equal(confirmFirstFocus('trash', 101, 100), 'cancel', 'over 100: Cancel');
	assert.equal(confirmFirstFocus('trash', 5_000, 100), 'cancel', '"Stage all shown (5,000)" then Apply: Enter does not move them');
	assert.equal(confirmFirstFocus('trash', 30, 25), 'cancel', 'over the store\'s smaller batch');
	assert.equal(confirmFirstFocus('trash', 25, 25), 'confirm');
	assert.equal(confirmFirstFocus('trash', 150, 500), 'cancel', 'the smaller of 100 and the batch');
	assert.equal(confirmFirstFocus('delete', 1, 100), 'typed');
	assert.equal(confirmFirstFocus('empty', 3, 100), 'typed');
	const { multiTrashConfirmation } = require('../src/vector/confirm') as typeof import('../src/vector/confirm');
	const many = Array.from({ length: 150 }, (_, i) => ({ objectId: `d${i}`, path: `a/${i}.md`, chunks: 1 }));
	const content = multiTrashConfirmation(many, { storeName: 'Store', collection: 'docs', backend: 'pgvector', provider: 'postgres' });
	assert.match(content.title, /^Move 150 documents/, 'the count leads the title');
	assert.equal(content.typed, null, 'nothing to type: Restore undoes it');
});

test("Enter in the typed field: it confirms once the text matches, never on the Enter that ends a composition; before that a line kept under the field says what is missing, so the field never moves", () => {
	const { typedNudge } = require('../src/vector/confirm') as typeof import('../src/vector/confirm');
	const typed = { expected: '2', prompt: 'Type 2 to confirm.' };
	assert.equal(typedNudge(typed, '', false), '');
	assert.equal(typedNudge(typed, '', true), 'Nothing is typed yet.');
	assert.equal(typedNudge(typed, '1', true), 'What is typed does not match.');
	assert.equal(typedNudge(typed, ' 2 ', true), '', 'it matches: nothing to say');
	const fs = require('node:fs') as typeof import('node:fs');
	const path = require('node:path') as typeof import('node:path');
	const panel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'InlineRemoveConfirm.tsx'), 'utf8');
	assert.match(panel, /if \(event\.defaultPrevented \|\| event\.key !== 'Enter' \|\| event\.nativeEvent\.isComposing \|\| event\.keyCode === 229\) return;\s*event\.preventDefault\(\);\s*if \(ready\) onConfirm\(\);\s*else setNudged\(true\);/);
	assert.match(panel, /<span>\{content\.typed\.prompt\}<\/span>/, 'the prompt never changes, so it never rewraps');
	assert.match(panel, /<p id=\{nudgeId\} aria-live="polite" title=\{nudge \|\| undefined\} style=\{styles\.nudge\}>\s*\{nudge\}\s*<\/p>/, 'the nudge, announced, on its own line');
	assert.match(panel, /nudge: \{ height: 18, [^}]*lineHeight: '18px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' \}/, 'one line, said or not: nothing under it moves');
});
