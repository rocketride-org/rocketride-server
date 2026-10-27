// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CONSOLE CONTROLLER: full and quick stats, background paging, chunks, and the confirmed removal
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { manualClock } from 'shared/explorer/connect/testing';
import type { IDocumentItem, IDocumentsFilter, IScopeState } from '../src/contract/types';
import { connectionCaches, vectorEndpoints } from '../src/adapters/explorer';
import { connectionEntry } from '../src/adapters/connections';
import { makeConsoleActions } from '../src/adapters/consoleActions';
import { QUICK_STATS_INTERVAL_MS } from '../src/vector/budgets';
import { CHAT_UNSCOPED_TEXT, chatScopeFor, consoleScope, mapScopeFor } from '../src/vector/consoleModel';
import { createConsoleStore } from '../src/vector/consoleStore';
import { pagerApplyPage, pagerBegin, pagerFail, pagerFooter, pagerInit } from '../src/vector/documents';
import { directoryView, scopeStripText } from '../src/vector/filters';
import { DEFAULT_LIMITS } from '../src/vector/results';
import type { IConsoleDeps } from '../src/vector/consoleStore';
import { readChunksPage, readDocumentsPage, readDeleteResult, readStats, readTrashResult } from '../src/vector/results';
import type { IDocumentsPageView } from '../src/vector/results';
import { BUSY, CANCELLED_TEXT, CODE_SENTENCES, NOT_PROBED_TEXT, failureText } from '../src/vector/wording';
import { probeAware, probeAwareChannel } from '../src/adapters/actions';
import { documentOrigin } from '../src/vector/confirm';
import { directoryHeading } from '../src/vector/documents';
import { fixture } from './support/fixtures';

interface ICall {
	tool: string;
	args: unknown[];
}

/** A doc row. */
function doc(objectId: string, path: string): IDocumentItem {
	return { objectId, path, chunks: 2, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt: null, pointId: null };
}

/** The trash listing's one page: two documents with chunks in the trash. */
function trashPage(): Record<string, unknown> {
	return { ...fixture('list_documents_page2_last'), items: [doc('gull', 'C:/demo/field/gull.md'), doc('heron', 'C:/demo/field/heron.md')].map((d) => ({ ...d, deleted: true })), next_cursor: null, total: 2 };
}

/** A controller over scripted tools and a manual clock. */
function harness(over: Partial<IConsoleDeps> = {}) {
	const clock = manualClock(Date.parse('2026-10-08T18:31:00Z'));
	const calls: ICall[] = [];
	const announced: string[] = [];
	const removedIds: string[][] = [];
	let written = 0;
	const deps: IConsoleDeps = {
		stats: async (mode) => {
			calls.push({ tool: 'stats', args: [mode] });
			return readStats(mode === 'quick' ? fixture('stats_quick') : fixture('stats_pgvector'));
		},
		documents: async (cursor, limit, _filter, deleted) => {
			if (deleted === 'deleted') {
				calls.push({ tool: 'trash listing', args: [cursor, limit] });
				return readDocumentsPage(trashPage());
			}
			calls.push({ tool: 'documents', args: [cursor, limit] });
			return readDocumentsPage(cursor ? fixture('list_documents_page2_last') : fixture('list_documents_page1'));
		},
		chunks: async (objectId, after, limit) => {
			calls.push({ tool: 'chunks', args: [objectId, after, limit] });
			return readChunksPage(fixture('chunks_page'));
		},
		trash: async (ids) => {
			calls.push({ tool: 'soft_delete', args: [ids] });
			return readTrashResult({ ...fixture('soft_delete_ok'), object_ids: ids, matched_chunks: 12 * ids.length });
		},
		restore: async (ids) => {
			calls.push({ tool: 'restore', args: [ids] });
			return readTrashResult({ ...fixture('restore_ok'), object_ids: ids, matched_chunks: 12 * ids.length });
		},
		remove: async (ids, opts) => {
			calls.push({ tool: 'delete', args: opts?.deletedOnly ? [ids, 'deleted_only'] : [ids] });
			return readDeleteResult({ ...fixture('delete_ok'), removed_chunks: 12 * ids.length }, ids);
		},
		announce: (text) => announced.push(text),
		onRemoved: (ids) => removedIds.push([...ids]),
		onWritten: () => void (written += 1),
		clock,
		...over,
	};
	const store = createConsoleStore(deps, { pageSize: 500, chunkPage: 100, writeBatch: 100 });
	return { store, clock, calls, announced, removedIds, written: () => written, tools: () => calls.map((c) => c.tool) };
}

test('opening the console: a full stats call and the directory loading every page in the background', async () => {
	const { store, clock, calls } = harness();
	store.open();
	await clock.settle();
	assert.deepEqual(
		calls.map((c) => [c.tool, ...c.args]),
		[
			['stats', 'full'],
			['documents', null, 500],
			['documents', readDocumentsPage(fixture('list_documents_page1')).nextCursor, 500],
		]
	);
	const state = store.getState();
	assert.equal(state.stats.view?.documents, 42);
	assert.equal(state.stats.mode, 'full');
	assert.equal(state.directory.status, 'done');
	assert.equal(state.directory.rows.length, 7);
	store.dispose();
});

test('quick stats every 15 s while visible, none while hidden, and Refresh is a full call', async () => {
	const { store, clock, tools } = harness();
	store.open();
	await clock.settle();
	await clock.advance(QUICK_STATS_INTERVAL_MS - 1);
	assert.equal(tools().filter((t) => t === 'stats').length, 1, 'not before 15 s');
	await clock.advance(1);
	assert.equal(tools().filter((t) => t === 'stats').length, 2);
	assert.equal(store.getState().stats.mode, 'quick');
	assert.equal(store.getState().stats.view?.countsAsOf, '2026-10-08T18:30:40Z');
	store.setVisible(false);
	await clock.advance(QUICK_STATS_INTERVAL_MS * 4);
	assert.equal(tools().filter((t) => t === 'stats').length, 2, 'no call while the console is hidden');
	store.setVisible(true);
	await clock.advance(QUICK_STATS_INTERVAL_MS);
	assert.equal(tools().filter((t) => t === 'stats').length, 3);
	store.refresh();
	await clock.settle();
	assert.equal(store.getState().stats.mode, 'full');
	store.dispose();
	const before = tools().length;
	await clock.advance(QUICK_STATS_INTERVAL_MS * 3);
	assert.equal(tools().length, before, 'nothing after dispose');
});

test('a stats failure keeps the last figures and says why', async () => {
	let fail = false;
	const { store, clock } = harness({
		stats: async () => {
			if (fail) throw new ExplorerToolError({ kind: 'store', tool: 'stats', message: 'OperationalError: the store did not answer', code: 'STORE_ERROR' });
			return readStats(fixture('stats_pgvector'));
		},
	});
	store.open();
	await clock.settle();
	fail = true;
	store.refresh();
	await clock.settle();
	const { stats } = store.getState();
	assert.equal(stats.status, 'error');
	assert.equal(stats.view?.documents, 42, 'the strip keeps its last values (shown greyed)');
	assert.deepEqual(stats.error, { headline: CODE_SENTENCES.STORE_ERROR, detail: 'OperationalError: the store did not answer' });
	store.dispose();
});

test('a failed first stats load is asked again in full every 15 s while visible, until it answers', async () => {
	let fail = true;
	const { store, clock, calls } = harness({
		stats: async (mode) => {
			calls.push({ tool: 'stats', args: [mode] });
			if (fail) throw new ExplorerToolError({ kind: 'raised', tool: 'stats', message: 'Task is not running', code: 'TASK_STOPPED' });
			return readStats(mode === 'quick' ? fixture('stats_quick') : fixture('stats_pgvector'));
		},
	});
	const modes = () => calls.filter((c) => c.tool === 'stats').map((c) => c.args[0]);
	store.open();
	await clock.settle();
	assert.equal(store.getState().stats.status, 'error');
	await clock.advance(QUICK_STATS_INTERVAL_MS - 1);
	assert.deepEqual(modes(), ['full'], 'not before 15 s');
	await clock.advance(1);
	assert.deepEqual(modes(), ['full', 'full'], 'a full call: there are no figures yet to refresh quickly');
	store.setVisible(false);
	await clock.advance(QUICK_STATS_INTERVAL_MS * 3);
	assert.equal(modes().length, 2, 'never while hidden');
	store.setVisible(true);
	fail = false;
	await clock.advance(QUICK_STATS_INTERVAL_MS);
	assert.deepEqual(modes(), ['full', 'full', 'full']);
	assert.equal(store.getState().stats.status, 'ready');
	assert.equal(store.getState().stats.view?.documents, 42);
	await clock.advance(QUICK_STATS_INTERVAL_MS);
	assert.deepEqual(modes(), ['full', 'full', 'full', 'quick'], 'once it answered, the quick refresh takes over');
	store.dispose();
});

test('hiding the console pauses the directory (rows sorted), showing it resumes at the cursor', async () => {
	const pages: IDocumentsPageView[] = [
		{ items: [doc('m', 'C:/b/m.md')], nextCursor: 'c1', total: 3, countsExact: true, distinct: true, sorted: true, caveats: [], warnings: [], pagingUnsupported: false },
		{ items: [doc('a', 'C:/a/a.md')], nextCursor: 'c2', total: 3, countsExact: true, distinct: true, sorted: true, caveats: [], warnings: [], pagingUnsupported: false },
		{ items: [doc('z', 'C:/c/z.md')], nextCursor: null, total: 3, countsExact: true, distinct: true, sorted: true, caveats: [], warnings: [], pagingUnsupported: false },
	];
	let release: (() => void) | null = null;
	const { store, clock, calls } = harness({
		documents: async (cursor, limit) => {
			calls.push({ tool: 'documents', args: [cursor, limit] });
			const index = cursor === null ? 0 : cursor === 'c1' ? 1 : 2;
			if (index === 1) await new Promise<void>((resolve) => (release = resolve));
			return pages[index];
		},
	});
	store.open();
	await clock.settle();
	store.setVisible(false);
	release!();
	await clock.settle();
	assert.equal(store.getState().directory.status, 'paused');
	assert.deepEqual(
		store.getState().directory.rows.map((r) => r.objectId),
		['a', 'm'],
		'paused: what is loaded is sorted'
	);
	assert.equal(calls.filter((c) => c.tool === 'documents').length, 2, 'no page is asked for while hidden');
	store.setVisible(true);
	await clock.settle();
	assert.equal(store.getState().directory.status, 'done');
	assert.deepEqual(
		calls.filter((c) => c.tool === 'documents').map((c) => c.args[0]),
		[null, 'c1', 'c2']
	);
	store.dispose();
});

test('a refresh while pages arrive starts over, and a late page of the old listing is dropped', async () => {
	let release: (() => void) | null = null;
	let first = true;
	const { store, clock } = harness({
		documents: async (cursor) => {
			if (cursor !== null && first) {
				first = false;
				await new Promise<void>((resolve) => (release = resolve));
				return { ...readDocumentsPage(fixture('list_documents_page2_last')), items: [doc('late', 'late.md')] };
			}
			return readDocumentsPage(cursor ? fixture('list_documents_page2_last') : fixture('list_documents_page1'));
		},
	});
	store.open();
	await clock.settle();
	store.refresh();
	await clock.settle();
	release!();
	await clock.settle();
	assert.ok(!store.getState().directory.rows.some((r) => r.objectId === 'late'), "the old listing's page never lands");
	assert.equal(store.getState().directory.status, 'done');
	store.dispose();
});

test('a failed page stops the listing with the reason; Retry asks for the same cursor', async () => {
	let fail = true;
	const { store, clock, calls } = harness({
		documents: async (cursor, limit) => {
			calls.push({ tool: 'documents', args: [cursor, limit] });
			if (cursor !== null && fail) throw new ExplorerToolError({ kind: 'timeout', tool: 'documents', message: 'Stopped waiting for documents after 40 s.' });
			return readDocumentsPage(cursor ? fixture('list_documents_page2_last') : fixture('list_documents_page1'));
		},
	});
	store.open();
	await clock.settle();
	assert.equal(store.getState().directory.status, 'error');
	assert.equal(store.getState().directory.rows.length, 5);
	fail = false;
	store.retryDocuments();
	await clock.settle();
	assert.equal(store.getState().directory.status, 'done');
	const cursors = calls.filter((c) => c.tool === 'documents').map((c) => c.args[0]);
	assert.equal(cursors[1], cursors[2], 'the same cursor again');
	store.dispose();
});

test('a store that answers the same page again is asked twice, not without end', async () => {
	// Two stores that ignore the page cursor: one hands the same cursor back, one a new
	// cursor each time; neither says documents_paging_unsupported. The scripted store
	// throws at the 50th call so a listing that never ends fails here instead of hanging.
	for (const cursorOf of [(_n: number) => 'c1', (n: number) => `o${n}`]) {
		let asked = 0;
		const { store, clock, calls } = harness({
			documents: async (cursor, limit) => {
				calls.push({ tool: 'documents', args: [cursor, limit] });
				asked += 1;
				if (asked >= 50) throw new Error('still asking after 50 pages');
				return { items: [doc('b', 'C:/x/b.md'), doc('a', 'C:/x/a.md')], nextCursor: cursorOf(asked), total: null, countsExact: true, distinct: true, sorted: false, caveats: [], warnings: [], pagingUnsupported: false };
			},
		});
		store.open();
		await clock.settle();
		const state = store.getState().directory;
		assert.equal(calls.filter((c) => c.tool === 'documents').length, 2, 'the first page and the one repeat');
		assert.equal(state.status, 'stalled');
		assert.equal(state.rows.length, 2);
		store.setVisible(false);
		store.setVisible(true);
		store.retryDocuments();
		store.loadMoreDocuments();
		await clock.settle();
		assert.equal(calls.filter((c) => c.tool === 'documents').length, 2, 'showing the console, Retry and Load more ask nothing more');
		store.refresh();
		await clock.settle();
		assert.equal(calls.filter((c) => c.tool === 'documents').length, 4, 'Refresh starts over, and stops again after the repeat');
		store.dispose();
	}
});

test('selecting a document lists its chunks, 100 per page, and "more" continues after the last one', async () => {
	const { store, clock, calls } = harness();
	store.open();
	await clock.settle();
	store.selectDocument('kestrel');
	await clock.settle();
	assert.deepEqual(
		store.getState().chunks.items.map((c) => c.chunkId),
		[0, 1, 2]
	);
	assert.equal(store.getState().chunks.hasMore, true);
	store.loadMoreChunks();
	await clock.settle();
	assert.deepEqual(
		calls.filter((c) => c.tool === 'chunks').map((c) => c.args),
		[
			['kestrel', -1, 100],
			['kestrel', 2, 100],
		]
	);
	store.selectDocument(null);
	assert.equal(store.getState().chunks.objectId, null);
	store.dispose();
});

const KESTREL = { objectId: 'kestrel', path: 'C:/demo/field/kestrel_field_guide.md', chunks: 12 };

test('move to trash: asking opens a confirmation to type nothing into and sends nothing; Cancel sends nothing and says so', async () => {
	const { store, clock, tools, announced } = harness();
	store.setWritesEnabled(true);
	store.open();
	await clock.settle();
	store.requestRemove([KESTREL]);
	assert.deepEqual([store.getState().confirm?.action, store.getState().confirm?.targets.length], ['trash', 1]);
	assert.ok(!tools().includes('soft_delete'), 'nothing is sent before Confirm');
	store.cancelRemove();
	await clock.settle();
	assert.equal(store.getState().confirm, null);
	assert.ok(!tools().includes('soft_delete'), 'Cancel sends nothing');
	assert.deepEqual(announced, [CANCELLED_TEXT]);
	assert.equal(store.getState().removal.message, CANCELLED_TEXT);
	store.dispose();
});

test('move to trash: Confirm sends soft_delete once, then refreshes the stats in full, the directory, the dialect and the map, and forgets the document', async () => {
	let probes = 0;
	const { store, clock, calls, announced, removedIds, written } = harness({ reprobe: () => void (probes += 1) });
	store.setWritesEnabled(true);
	store.open();
	await clock.settle();
	store.selectDocument('kestrel');
	await clock.settle();
	calls.length = 0;
	store.requestRemove([KESTREL]);
	await store.confirmRemove();
	await clock.settle();
	assert.deepEqual(calls.map((c) => [c.tool, ...c.args]).slice(0, 2), [
		['soft_delete', ['kestrel']],
		['stats', 'full'],
	]);
	assert.ok(
		calls.some((c) => c.tool === 'documents' && c.args[0] === null),
		'the directory starts over'
	);
	assert.ok(!calls.some((c) => c.tool === 'delete'), 'nothing is deleted permanently');
	assert.deepEqual(announced, ['Moved C:/demo/field/kestrel_field_guide.md to the trash (12 chunks)']);
	assert.deepEqual(removedIds, [['kestrel']], 'the selection and the map forget it');
	assert.equal(store.getState().chunks.objectId, null, "the trashed document's chunk list closes");
	assert.deepEqual([probes, written()], [1, 1], 'the dialect is probed again and the map draws its sample again');
	store.dispose();
});

test('move to trash: refused by the node, the sentence names the rule; with writes off nothing is ever sent', async () => {
	let sent = 0;
	const { store, clock, announced, written } = harness({
		trash: async () => {
			sent += 1;
			throw new ExplorerToolError({ kind: 'store', tool: 'soft_delete', message: 'Only a Tools source may remove documents.', code: 'WRITES_SOURCE' });
		},
	});
	store.setWritesEnabled(true);
	store.open();
	await clock.settle();
	store.requestRemove([{ objectId: 'k', path: 'k.md', chunks: 1 }]);
	await store.confirmRemove();
	assert.deepEqual(announced, [CODE_SENTENCES.WRITES_SOURCE]);
	assert.equal(store.getState().removal.status, 'error');
	assert.equal(written(), 0, 'a refused first batch changed nothing: the map keeps its sample');
	store.setWritesEnabled(false);
	store.requestRemove([{ objectId: 'k', path: 'k.md', chunks: 1 }]);
	store.requestDelete([{ objectId: 'k', path: 'k.md', chunks: 1 }]);
	await store.restore([{ objectId: 'k', path: 'k.md', chunks: 1 }]);
	await store.requestEmptyTrash();
	assert.equal(store.getState().confirm, null, 'no confirmation opens while writes are off');
	await store.confirmRemove();
	assert.equal(sent, 1, 'only the first, refused, call');
	store.dispose();
});

test('one write at a time: while one runs no confirmation opens, no restore is sent, and the screen reader hears why', async () => {
	let release: (() => void) | null = null;
	let inFlight = 0;
	let maxInFlight = 0;
	const { store, clock, announced, tools } = harness({
		trash: async (ids) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((resolve) => (release = resolve));
			inFlight -= 1;
			return readTrashResult({ ...fixture('soft_delete_ok'), object_ids: ids, matched_chunks: 2 * ids.length });
		},
	});
	store.setWritesEnabled(true);
	store.open();
	await clock.settle();
	store.requestRemove([{ objectId: 'a', path: 'a.md', chunks: 2 }]);
	const first = store.confirmRemove();
	await clock.settle();
	assert.equal(store.getState().removal.status, 'running');
	store.requestRemove([{ objectId: 'b', path: 'b.md', chunks: 2 }]);
	store.requestDelete([{ objectId: 'b', path: 'b.md', chunks: 2 }]);
	await store.restore([{ objectId: 'b', path: 'b.md', chunks: 2 }]);
	assert.equal(store.getState().confirm, null, 'no second confirmation opens while a write runs');
	assert.ok(!tools().includes('restore'), 'and no restore is sent');
	assert.deepEqual(announced, [BUSY.removing, BUSY.removing, BUSY.removing]);
	await store.confirmRemove();
	await clock.settle();
	assert.equal(maxInFlight, 1, 'one write at a time');
	release!();
	await first;
	await clock.settle();
	assert.equal(store.getState().removal.status, 'done');
	store.requestRemove([{ objectId: 'b', path: 'b.md', chunks: 2 }]);
	assert.equal(store.getState().confirm?.targets[0].objectId, 'b', 'once it ended, writing is offered again');
	store.dispose();
});

test('several documents go to the trash in batches of write_ids_max and stop at the first error', async () => {
	const sent: string[][] = [];
	const { store, clock, announced } = harness({
		trash: async (ids) => {
			sent.push([...ids]);
			if (sent.length === 2) throw new ExplorerToolError({ kind: 'store', tool: 'soft_delete', message: 'x', code: 'WRITES_DISABLED' });
			return readTrashResult({ success: true, object_ids: ids, not_found: [], matched_chunks: ids.length });
		},
	});
	store.setWritesEnabled(true);
	const targets = Array.from({ length: 250 }, (_, i) => ({ objectId: `id-${i}`, path: `f${i}.md`, chunks: 1 }));
	store.requestRemove(targets);
	assert.deepEqual([store.getState().confirm?.action, store.getState().confirm?.kind], ['trash', 'multi']);
	await store.confirmRemove();
	await clock.settle();
	assert.deepEqual(
		sent.map((b) => b.length),
		[100, 100]
	);
	assert.equal(announced[0], `Moved 100 documents to the trash (100 chunks). Stopped after 1 of 3 batches: ${CODE_SENTENCES.WRITES_DISABLED}`);
	store.dispose();
});

test('the Trash view lists list_documents with deleted "deleted" once it is shown; Refresh and a write list it again', async () => {
	const { store, clock, calls, tools } = harness();
	store.setWritesEnabled(true);
	store.open();
	await clock.settle();
	assert.ok(!tools().includes('trash listing'), 'the trash is not listed before it is shown');
	assert.equal(store.getState().view, 'active');
	store.setView('trash');
	await clock.settle();
	assert.equal(store.getState().view, 'trash');
	assert.deepEqual(
		store.getState().trash.rows.map((r) => r.objectId),
		['gull', 'heron']
	);
	assert.equal(store.getState().directory.rows.length, 7, 'the active listing is kept as it was');
	calls.length = 0;
	store.refresh();
	await clock.settle();
	assert.deepEqual(
		calls.filter((c) => c.tool === 'trash listing').map((c) => c.args[0]),
		[null],
		'Refresh lists the trash again from the start'
	);
	calls.length = 0;
	store.requestRemove([KESTREL]);
	await store.confirmRemove();
	await clock.settle();
	assert.ok(tools().includes('trash listing'), 'a document moved to the trash appears there');
	store.setView('active');
	assert.equal(store.getState().view, 'active');
	store.dispose();
});

test('restore runs at once (it can be undone), refreshes everything a write does, and forgets nothing', async () => {
	let probes = 0;
	const { store, clock, calls, announced, removedIds, written } = harness({ reprobe: () => void (probes += 1) });
	store.setWritesEnabled(true);
	store.open();
	store.setView('trash');
	await clock.settle();
	calls.length = 0;
	await store.restore([{ objectId: 'gull', path: 'C:/demo/field/gull.md', chunks: 2 }]);
	await clock.settle();
	assert.equal(store.getState().confirm, null, 'no confirmation');
	assert.deepEqual(calls.map((c) => [c.tool, ...c.args]).slice(0, 2), [
		['restore', ['gull']],
		['stats', 'full'],
	]);
	assert.ok(calls.some((c) => c.tool === 'documents' && c.args[0] === null) && calls.some((c) => c.tool === 'trash listing' && c.args[0] === null), 'both listings start over');
	assert.deepEqual(announced, ['Restored C:/demo/field/gull.md (12 chunks)']);
	assert.deepEqual(removedIds, [], 'a restored document is stored: nothing forgets it');
	assert.deepEqual([probes, written()], [1, 1]);
	store.dispose();
});

test('delete permanently (a Trash action): a confirmation first, then one delete with deleted_only, so a partly trashed document is kept; the document is forgotten', async () => {
	const { store, clock, calls, announced, removedIds } = harness();
	store.setWritesEnabled(true);
	store.open();
	store.setView('trash');
	await clock.settle();
	calls.length = 0;
	store.requestDelete([{ objectId: 'gull', path: 'C:/demo/field/gull.md', chunks: 2 }]);
	assert.deepEqual([store.getState().confirm?.action, store.getState().confirm?.kind], ['delete', 'single']);
	assert.ok(!calls.some((c) => c.tool === 'delete'), 'nothing is sent before Confirm');
	await store.confirmRemove();
	await clock.settle();
	assert.deepEqual(
		calls.filter((c) => c.tool === 'delete').map((c) => c.args),
		[[['gull'], 'deleted_only']]
	);
	assert.deepEqual(announced, ['Deleted C:/demo/field/gull.md permanently (12 chunks)']);
	assert.deepEqual(removedIds, [['gull']]);
	store.dispose();
});

test('empty trash: every page of the trash is listed first, then a confirmation; Confirm deletes with deleted_only and reports the documents kept live', async () => {
	const pages: Array<string | null> = [];
	const trash = (n: number) => Array.from({ length: n }, (_, i) => ({ ...doc(`t-${i}`, `C:/demo/trash/t${i}.md`), deleted: true }));
	const sent: Array<[string[], boolean]> = [];
	const { store, clock, announced, removedIds, written } = harness({
		documents: async (cursor, _limit, _filter, deleted) => {
			if (deleted !== 'deleted') return readDocumentsPage(fixture('list_documents_page2_last'));
			pages.push(cursor);
			const first = cursor === null;
			return readDocumentsPage({ ...fixture('list_documents_page2_last'), items: first ? trash(150).slice(0, 100) : trash(150).slice(100), next_cursor: first ? 'page-2' : null, total: 150 });
		},
		remove: async (ids, opts) => {
			sent.push([[...ids], opts?.deletedOnly === true]);
			// t-7 still has a live chunk: a later ingest added one after it was moved to the trash.
			const kept = ids.filter((id) => id === 't-7');
			return readDeleteResult({ success: true, deleted_count: ids.length, not_found: [], kept_live: kept, removed_chunks: 2 * (ids.length - kept.length) }, ids);
		},
	});
	store.setWritesEnabled(true);
	store.open();
	await clock.settle();
	await store.requestEmptyTrash();
	assert.deepEqual(pages, [null, 'page-2'], 'the whole trash, page after page');
	const pending = store.getState().confirm;
	assert.deepEqual([pending?.action, pending?.kind, pending?.targets.length], ['empty', 'multi', 150]);
	assert.equal(sent.length, 0, 'nothing is deleted before Confirm');
	await store.confirmRemove();
	await clock.settle();
	assert.deepEqual(
		sent.map(([ids, only]) => [ids.length, only]),
		[
			[100, true],
			[50, true],
		],
		'batches of write_ids_max, every one with deleted_only'
	);
	assert.equal(announced.at(-1), 'Emptied the trash: deleted 149 documents permanently (298 chunks). 1 was kept whole, because it still has chunks outside the trash: C:/demo/trash/t7.md.');
	assert.ok(!removedIds.flat().includes('t-7'), 'a kept document is not forgotten');
	assert.equal(store.getState().removal.partial, true, 'not all it was asked: the hub holds the line like a failure (R2-I2)');
	assert.equal(removedIds.flat().length, 149);
	assert.equal(written(), 1);
	store.dispose();
});

test('empty trash with nothing in it says so and opens nothing', async () => {
	const { store, clock, announced } = harness({
		documents: async () => readDocumentsPage({ ...fixture('list_documents_page2_last'), items: [], next_cursor: null, total: 0 }),
	});
	store.setWritesEnabled(true);
	store.open();
	await clock.settle();
	await store.requestEmptyTrash();
	assert.equal(store.getState().confirm, null);
	assert.deepEqual(announced, ['The trash is empty.']);
	store.dispose();
});

test("a document in the trash: its chunk list says IN_TRASH's sentence", async () => {
	const { store, clock } = harness({
		chunks: async () => {
			throw new ExplorerToolError({ kind: 'store', tool: 'chunks', message: "chunks: the document 'gull' is in the trash; restore it to read it", code: 'IN_TRASH' });
		},
	});
	store.open();
	store.selectDocument('gull');
	await clock.settle();
	assert.equal(store.getState().chunks.status, 'error');
	assert.equal(store.getState().chunks.error?.headline, 'This document is in the trash. Restore it to read it.');
	assert.equal(CODE_SENTENCES.IN_TRASH, 'This document is in the trash. Restore it to read it.');
	store.dispose();
});

// =============================================================================
// THE SCOPE: the listing's filter, the words for what the store applied, and the cap on every surface
// =============================================================================

/** A harness whose documents call records the filter and answers with a filtered fixture when given one. */
function scoped(answer: string = 'list_documents_filter_server') {
	const filters: Array<IDocumentsFilter | null | undefined> = [];
	const h = harness({
		documents: async (cursor, limit, filter) => {
			filters.push(filter);
			if (filter) return readDocumentsPage(fixture(answer));
			return readDocumentsPage(cursor ? fixture('list_documents_page2_last') : fixture('list_documents_page1'));
		},
	});
	return { ...h, filters };
}

test("the pager sends the scope's conditions; a new filter lists again from the first page, the same one asks nothing", async () => {
	const { store, clock, filters } = scoped();
	store.open();
	await clock.settle();
	assert.deepEqual(filters, [null, null], 'no scope: every page without a filter');
	const greenhouse = { path_prefix: 'C:/demo/greenhouse/' };
	store.setFilter(greenhouse);
	assert.equal(store.getState().directory.status, 'loading');
	assert.deepEqual(store.getState().directory.rows, [], 'the old listing is dropped');
	await clock.settle();
	assert.deepEqual(filters.slice(2), [greenhouse]);
	assert.equal(store.getState().directory.filterApplied, 'server');
	assert.equal(store.getState().directory.rows.length, 2);
	store.setFilter({ ...greenhouse });
	store.setFilter({ path_prefix: 'C:/demo/greenhouse/', min_chunks: null });
	await clock.settle();
	assert.equal(filters.length, 3, 'the same conditions ask nothing');
	store.refresh();
	await clock.settle();
	assert.deepEqual(filters[3], greenhouse, 'a refresh keeps the scope');
	store.setFilter(null);
	await clock.settle();
	assert.deepEqual(filters.slice(4), [null, null], 'no scope again: every document');
	assert.equal(store.getState().directory.filterApplied, null);
	store.dispose();
});

test('the path box with the scope: a store that filters by it lists again; one that skips it keeps the rows it listed', async () => {
	// pgvector answers 'server': the box is the store's to apply.
	{
		const { store, clock, filters } = scoped('list_documents_filter_server');
		const greenhouse = { path_prefix: 'C:/demo/greenhouse/' };
		store.setFilter(greenhouse);
		store.open();
		await clock.settle();
		store.setFilter({ ...greenhouse, path_contains: 'txt' });
		await clock.settle();
		assert.deepEqual(filters, [greenhouse, { ...greenhouse, path_contains: 'txt' }], 'asked again, with the box');
		store.dispose();
	}
	// A store that filters nothing ('none') would list the same rows for any text: they are kept, under the new filter.
	{
		const { store, clock, filters } = scoped('list_documents_filter_client');
		const handbooks = { path_prefix: 'C:/demo/handbooks/', file_types: ['md'] };
		store.setFilter(handbooks);
		store.open();
		await clock.settle();
		const asked = filters.length;
		const before = store.getState().directory;
		assert.equal(before.filterApplied, 'none');
		store.setFilter({ ...handbooks, path_contains: 'falcon' });
		await clock.settle();
		const after = store.getState().directory;
		assert.equal(filters.length, asked, 'nothing is asked');
		assert.equal(after.rows, before.rows, 'the rows are kept');
		assert.equal(after.status, before.status);
		assert.deepEqual(after.filter, { ...handbooks, path_contains: 'falcon' });
		assert.deepEqual(after.filterIgnored, ['path_prefix', 'file_types', 'path_contains']);
		const scope: IScopeState = { filter: { ...handbooks, path_contains: 'falcon' }, label: '', objectIds: null, overflow: null, applyTo: { documents: true, map: true, search: true, chat: true } };
		assert.equal(directoryView(after, scope, 'falcon', 2_000).summary, '1 of 3 loaded match (filtered here; the store cannot filter by these)');
		store.setFilter({ path_prefix: 'C:/demo/field/', path_contains: 'falcon' });
		await clock.settle();
		assert.deepEqual(filters[asked], { path_prefix: 'C:/demo/field/', path_contains: 'falcon' }, 'new conditions list again');
		store.dispose();
	}
	// A store that skipped the path text ('partial' naming it, as Chroma does): new text keeps the rows; clearing it lists again.
	{
		const filters: Array<IDocumentsFilter | null | undefined> = [];
		const { store, clock } = harness({
			documents: async (_cursor, _limit, filter) => {
				filters.push(filter);
				const skipped = filter?.path_contains != null;
				return readDocumentsPage({ ...fixture('list_documents_filter_server'), filter_applied: skipped ? 'partial' : 'server', filter_ignored: skipped ? ['path_contains'] : [], caveats: skipped ? ['documents_filter_partial'] : [] });
			},
		});
		const greenhouse = { path_prefix: 'C:/demo/greenhouse/' };
		store.setFilter({ ...greenhouse, path_contains: 'orchid' });
		store.open();
		await clock.settle();
		assert.equal(store.getState().directory.filterApplied, 'partial');
		store.setFilter({ ...greenhouse, path_contains: 'txt' });
		await clock.settle();
		assert.equal(filters.length, 1, 'the store skips the box: nothing is asked');
		assert.deepEqual(store.getState().directory.filter, { ...greenhouse, path_contains: 'txt' });
		assert.deepEqual(store.getState().directory.filterIgnored, ['path_contains']);
		store.setFilter(greenhouse);
		await clock.settle();
		assert.deepEqual(filters.slice(1), [greenhouse], 'without the box the store may apply everything: asked again');
		assert.equal(store.getState().directory.filterApplied, 'server');
		store.dispose();
	}
});

test("a filter set before the console opens is the first listing's; a removal lists again with it", async () => {
	const { store, clock, filters } = scoped();
	const handbooks = { path_prefix: 'C:/demo/handbooks/' };
	store.setFilter(handbooks);
	assert.equal(store.getState().directory.status, 'idle', 'nothing is asked before the console opens');
	store.open();
	await clock.settle();
	assert.deepEqual(filters, [handbooks]);
	store.setWritesEnabled(true);
	store.requestRemove([{ objectId: 'x', path: 'C:/demo/handbooks/x.md', chunks: 1 }]);
	await store.confirmRemove();
	await clock.settle();
	assert.deepEqual(filters, [handbooks, handbooks]);
	store.dispose();
});

test("the directory's status line says how much the store applied: server, partial, or here over what is loaded", async () => {
	const scope = (filter: IDocumentsFilter, documents = true): IScopeState => ({ filter, label: '', objectIds: null, overflow: null, applyTo: { documents, map: true, search: true, chat: true } });
	const cases: Array<[string, IDocumentsFilter, string]> = [
		['list_documents_filter_server', { path_prefix: 'C:/demo/greenhouse/' }, '2 documents match (store)'],
		['list_documents_filter_partial', { path_prefix: 'C:/demo/handbooks/', ingested_after: '2026-10-01T00:00:00Z' }, '0 documents match (store; ingest dates filtered here)'],
		['list_documents_filter_client', { path_prefix: 'C:/demo/handbooks/', file_types: ['md'] }, '1 of 3 loaded match (filtered here; the store cannot filter by these)'],
	];
	for (const [answer, filter, words] of cases) {
		const { store, clock } = scoped(answer);
		store.setFilter(filter);
		store.open();
		await clock.settle();
		const view = directoryView(store.getState().directory, scope(filter), '', 2_000);
		assert.equal(view.summary, words, answer);
		store.dispose();
	}
	const { store, clock } = scoped();
	store.open();
	await clock.settle();
	const off = directoryView(store.getState().directory, scope({ path_prefix: 'C:/demo/greenhouse/' }, false), '', 2_000);
	assert.equal(off.rows.length, 7, 'the Documents toggle off: the list shows every document');
	assert.equal(off.summary, 'Not applied to this list. Scope: 2 of 7 loaded match (filtered here)');
	const box = directoryView(store.getState().directory, null, 'orchid', 2_000);
	assert.equal(box.rows.length, 2, 'no scope: the path box filters what is loaded, as before');
	assert.equal(box.summary, '2 of 7 documents');
	store.dispose();
});

test('typing in the path box on a store that applies it: between the listings the line says the scope is loading, never that the store cannot filter', async () => {
	const { store, clock, filters } = scoped('list_documents_filter_server');
	const greenhouse = { path_prefix: 'C:/demo/greenhouse/' };
	let filter: IDocumentsFilter = greenhouse;
	let text = '';
	const scope = (): IScopeState => ({ filter, label: '', objectIds: null, overflow: null, applyTo: { documents: true, map: true, search: true, chat: true } });
	const lines: Array<{ status: string | null; strip: string }> = [];
	const unsubscribe = store.subscribe(() => {
		const view = directoryView(store.getState().directory, scope(), text, 2_000);
		lines.push({ status: view.summary, strip: view.scope ? scopeStripText(view.scope, { documents: 42 }) : '' });
	});
	store.setFilter(greenhouse);
	store.open();
	await clock.settle();
	const before = lines.length;
	// Two settled box texts: each lists again (the store applies path_contains).
	for (const typed of ['orc', 'orchid']) {
		text = typed;
		filter = { ...greenhouse, path_contains: typed };
		store.setFilter(filter);
		await clock.settle();
	}
	unsubscribe();
	assert.deepEqual(
		filters.slice(-2),
		[
			{ ...greenhouse, path_contains: 'orc' },
			{ ...greenhouse, path_contains: 'orchid' },
		],
		'each settled text asked the store'
	);
	const typing = lines.slice(before);
	assert.ok(
		typing.some((l) => l.status === 'Loading the documents in scope…' && l.strip === 'Scope: loading…'),
		'between the listings: loading'
	);
	assert.deepEqual(
		typing.filter((l) => /cannot filter|0 of 0|at least/.test(`${l.status} ${l.strip}`)),
		[],
		'nothing about what the store cannot filter, no count of nothing loaded'
	);
	assert.equal(typing[typing.length - 1]?.status, '2 documents match (store)');
	store.dispose();
});

test("a scope's first page fails: no status line about the store (the footer's error and Retry speak), and Retry lists it", async () => {
	let fail = true;
	const greenhouse = { path_prefix: 'C:/demo/greenhouse/' };
	const { store, clock } = harness({
		documents: async (_cursor, _limit, filter) => {
			if (filter && fail) throw new ExplorerToolError({ kind: 'timeout', tool: 'documents', message: 'Stopped waiting for documents after 40 s.' });
			return readDocumentsPage(filter ? fixture('list_documents_filter_server') : fixture('list_documents_page1'));
		},
	});
	const scope: IScopeState = { filter: greenhouse, label: '', objectIds: null, overflow: null, applyTo: { documents: true, map: true, search: true, chat: true } };
	store.setFilter(greenhouse);
	store.open();
	await clock.settle();
	const failed = store.getState().directory;
	assert.equal(failed.status, 'error');
	assert.equal(failed.pages, 0);
	const view = directoryView(failed, scope, '', 2_000);
	assert.equal(view.summary, null);
	assert.equal(view.scope?.applied, 'pending');
	assert.equal(scopeStripText(view.scope!, { documents: 42 }), 'Scope: not counted (the listing did not load)');
	assert.equal(pagerFooter(failed)?.retry, true, 'the footer offers Retry');
	fail = false;
	store.retryDocuments();
	await clock.settle();
	assert.equal(directoryView(store.getState().directory, scope, '', 2_000).summary, '2 documents match (store)');
	store.dispose();
});

test('askAbout never scopes the chat to more than scope_keys_max documents; it says why instead', () => {
	const limits = { ...DEFAULT_LIMITS, scope_keys_max: 3 };
	const entry = connectionEntry({ key: 'key-ask-cap', nodeId: 'store_1', roles: {}, provider: 'postgres', pipelineName: 'p' } as unknown as Parameters<typeof connectionEntry>[0], null, limits, manualClock());
	const announced: string[] = [];
	const actions = makeConsoleActions(entry, { openDocument: () => undefined, showConsole: () => undefined, announce: (t) => announced.push(t) });
	actions.askAbout(['a', 'b', 'c', 'd']);
	assert.equal(entry.chatScope.get(), null, 'nothing is scoped');
	assert.deepEqual(announced, ['Too many documents to ask about (4; at most 3). Narrow the selection.']);
	actions.askAbout(['a', 'b', 'c']);
	assert.deepEqual(entry.chatScope.get(), ['a', 'b', 'c']);
	connectionCaches.clearAll();
});

test('the chat is scoped by "Ask about these" first, else by the scope while its Chat toggle is on, never above the cap or to nothing', () => {
	const scope = (over: Partial<IScopeState> = {}): IScopeState => ({ filter: { path_prefix: 'C:/demo/' }, label: '', objectIds: ['a', 'b'], overflow: null, applyTo: { documents: true, map: true, search: true, chat: true }, ...over });
	assert.deepEqual(chatScopeFor(['x'], scope(), 2_000), ['x'], '"Ask about these" wins');
	assert.deepEqual(chatScopeFor(null, scope(), 2_000), ['a', 'b']);
	assert.equal(chatScopeFor(null, scope({ applyTo: { documents: true, map: true, search: true, chat: false } }), 2_000), null, 'Chat toggle off');
	assert.equal(chatScopeFor(null, scope({ objectIds: null }), 2_000), null, 'unresolved');
	assert.equal(chatScopeFor(null, scope({ objectIds: null, overflow: 2_340 }), 2_000), null, 'too large');
	assert.equal(chatScopeFor(null, scope({ objectIds: [] }), 2_000), null, 'a scope that keeps nothing does not scope the chat');
	assert.equal(chatScopeFor(null, scope({ objectIds: ['a', 'b', 'c'] }), 2), null, 'never more than the cap');
	assert.equal(chatScopeFor(['a', 'b', 'c'], null, 2), null, 'not even from "Ask about these"');
	assert.equal(chatScopeFor(null, null, 2_000), null);
});

// =============================================================================
// THE CONSOLE'S SCOPE: what the chat, search and the map are handed while its documents are (not yet) known
// =============================================================================

/** 600 documents in storage order, every third under C:/demo/handbooks/ (200 in scope). */
function handbookRow(i: number): IDocumentItem {
	return doc(`d${String(i).padStart(4, '0')}`, i % 3 === 0 ? `C:/demo/handbooks/doc_${i}.md` : `C:/demo/other/doc_${i}.md`);
}

/** A Qdrant-like page of that collection: the store filters nothing. */
function clientPage(from: number, n: number, next: string | null, total: number | null = 600): IDocumentsPageView {
	return readDocumentsPage({ success: true, items: Array.from({ length: n }, (_, k) => handbookRow(from + k)), next_cursor: next, total, counts_exact: true, distinct: true, sorted: false, caveats: ['documents_filter_client'], filter_applied: 'none', filter_ignored: ['path_prefix'] });
}

test('consoleScope: the chat is scoped only once the scope names its documents; until then it says the question goes to every document', () => {
	const folder = { path_prefix: 'C:/demo/handbooks/' };
	const fresh: IScopeState = { filter: folder, label: '', objectIds: null, overflow: null, applyTo: { documents: true, map: true, search: true, chat: true } };
	const begun = pagerBegin(pagerInit(), folder);
	const half = pagerApplyPage(begun, clientPage(0, 500, 'c1'));
	const whole = pagerApplyPage(half, clientPage(500, 100, null));
	const failed = pagerFail(begun, { headline: 'The store did not answer in time.' });
	const capped = { ...pagerApplyPage(begun, clientPage(0, 500, 'c1', 12_000)), status: 'capped' as const };
	const tail = ' A question asked now goes to every document.';
	assert.equal(CHAT_UNSCOPED_TEXT, tail.trim());

	// The listing pages: the scope is not applied yet; search waits for it (its ids are null), the map keeps what it drew.
	const waiting = consoleScope(null, fresh, half, 2_000);
	assert.equal(waiting.chat, null);
	assert.equal(waiting.chatNotice, `Waiting for the scope's documents (500 of 600 loaded); the map, search and chat are not scoped yet.${tail}`);
	assert.equal(waiting.waiting, true);
	assert.equal(waiting.applied, waiting.scope, 'search is handed the scope itself: it waits for the documents');
	assert.equal(waiting.applied?.objectIds, null);
	// Every page in: scoped, and nothing to say.
	const ready = consoleScope(null, fresh, whole, 2_000);
	assert.equal(ready.chat?.length, 200);
	assert.equal(ready.chatNotice, null);
	assert.equal(ready.waiting, false);
	assert.equal(ready.applied, ready.scope);
	assert.equal(ready.readiness?.phase, 'ready');
	// The first page failed, or the listing stopped short: nothing is scoped by it, and every surface is told so.
	for (const [dir, words] of [
		[failed, "The scope's documents did not load; Retry under the Documents list. The map, search and chat are not scoped."],
		[capped, "Only 500 of 12,000 documents are loaded, so the scope's documents are not all known: the map, search and chat are not scoped. Load more to include the other 11,500 (5,000 at a time)."],
	] as const) {
		const unknown = consoleScope(null, fresh, dir, 2_000);
		assert.equal(unknown.chat, null);
		assert.equal(unknown.chatNotice, `${words}${tail}`);
		assert.equal(unknown.waiting, false);
		assert.deepEqual(unknown.applied?.applyTo, { documents: true, map: false, search: false, chat: false }, 'the map and search are not scoped by it either');
		assert.deepEqual(unknown.scope?.applyTo, fresh.applyTo, "the user's toggles are kept for when the documents are known");
	}
	// "Ask about these" first; the Chat toggle off says nothing; no scope, nothing.
	assert.deepEqual(consoleScope(['x'], fresh, half, 2_000).chat, ['x']);
	assert.equal(consoleScope(['x'], fresh, half, 2_000).chatNotice, null);
	assert.equal(consoleScope(null, { ...fresh, applyTo: { ...fresh.applyTo, chat: false } }, half, 2_000).chatNotice, null);
	assert.deepEqual(consoleScope(null, null, half, 2_000), { scope: null, readiness: null, chat: null, chatNotice: null, applied: null, waiting: false });
	// Above the cap: the chat is not scoped, and says why.
	const big = consoleScope(null, { ...fresh, filter: { path_prefix: 'C:/demo/' } }, pagerApplyPage(pagerBegin(pagerInit(), { path_prefix: 'C:/demo/' }), readDocumentsPage({ success: true, items: Array.from({ length: 500 }, (_, i) => doc(`b${i}`, `C:/demo/${i}.md`)), next_cursor: 'c1', total: 2_340, counts_exact: true, distinct: true, sorted: true, caveats: [], filter_applied: 'server', filter_ignored: [] })), 2_000);
	assert.equal(big.chat, null);
	assert.equal(big.chatNotice, `Scope too large for the map, search and chat (2,340 documents; at most 2,000). Narrow the folder.${tail}`);
});

test('mapScopeFor: while a new scope finds its documents the map keeps the scope it drew with, so it samples once, when they are known', () => {
	const folder = { path_prefix: 'C:/demo/handbooks/' };
	const fresh: IScopeState = { filter: folder, label: '', objectIds: null, overflow: null, applyTo: { documents: true, map: true, search: true, chat: true } };
	const begun = pagerBegin(pagerInit(), folder);
	const whole = pagerApplyPage(pagerApplyPage(begun, clientPage(0, 500, 'c1')), clientPage(500, 100, null));
	const a = consoleScope(null, fresh, whole, 2_000);
	let held = mapScopeFor(null, a);
	assert.equal(held, a.applied, 'resolved: the map is scoped to it');
	// A chart's bar narrows the scope: a new listing for it is on its way.
	const narrowed = { ...fresh, filter: { ...folder, file_types: ['md'] } };
	const b = consoleScope(null, narrowed, pagerBegin(pagerInit(), narrowed.filter), 2_000);
	assert.equal(b.waiting, true);
	held = mapScopeFor(held, b);
	assert.equal(held, a.applied, 'the map keeps the documents it was drawn from: no sample of every document in between');
	const bDone = consoleScope(null, narrowed, pagerApplyPage(pagerApplyPage(pagerBegin(pagerInit(), narrowed.filter), clientPage(0, 500, 'c1')), clientPage(500, 100, null)), 2_000);
	held = mapScopeFor(held, bDone);
	assert.equal(held, bDone.applied);
	assert.equal(held?.objectIds?.length, 200);
	// Known not to be knowable (the listing failed): the map is not scoped, as its toggle says.
	const bFailed = consoleScope(null, narrowed, pagerFail(pagerBegin(pagerInit(), narrowed.filter), { headline: 'x' }), 2_000);
	assert.equal(mapScopeFor(held, bFailed)?.applyTo.map, false);
	// No scope: none.
	assert.equal(mapScopeFor(held, consoleScope(null, null, whole, 2_000)), null);
});

test('the store is probed again (its dialect) after an upload completes, after a write and on Refresh', async () => {
	let probes = 0;
	const { store, clock } = harness({ reprobe: () => void (probes += 1) });
	store.setWritesEnabled(true);
	store.open();
	await clock.settle();
	assert.equal(probes, 0, 'opening reads the dialect discovery already holds');
	store.documentsChanged();
	await clock.settle();
	assert.equal(probes, 1, 'after an upload');
	store.requestRemove([{ objectId: 'kestrel', path: 'C:/demo/field/kestrel_field_guide.md', chunks: 12 }]);
	await store.confirmRemove();
	await clock.settle();
	assert.equal(probes, 2, 'after a write');
	store.requestRemove([{ objectId: 'kestrel', path: 'C:/demo/field/kestrel_field_guide.md', chunks: 12 }]);
	store.cancelRemove();
	await clock.settle();
	assert.equal(probes, 2, 'Cancel sends no probe');
	store.refresh();
	await clock.settle();
	assert.equal(probes, 3, 'Refresh probes again: a store found empty and filled from elsewhere gets its index and size');
	store.dispose();
});

test("a connection's controller probes its endpoint again through the endpoint store", async () => {
	const asked: Array<[unknown, string]> = [];
	const real = vectorEndpoints.probe;
	vectorEndpoints.probe = async (client, key) => {
		asked.push([client, key]);
		return null;
	};
	try {
		const client = {} as never;
		const entry = connectionEntry({ key: 'probe-wiring', nodeId: 'store_1', provider: 'qdrant', roles: {}, components: [] } as never, client);
		entry.controller.documentsChanged();
		assert.deepEqual(asked, [[client, 'probe-wiring']]);
		entry.controller.dispose();
	} finally {
		vectorEndpoints.probe = real;
		connectionCaches.clearAll();
	}
});

test('Documents, then Trash, then Documents: Retry and Load more page the documents again (each tab names its listing when it shows)', async () => {
	let failOnce = true;
	const h = harness({
		documents: async (cursor, _limit, _filter, deleted) => {
			if (deleted === 'deleted') {
				h.calls.push({ tool: 'trash listing', args: [cursor] });
				return readDocumentsPage({ success: true, items: [], next_cursor: null, total: 0, counts_exact: true, distinct: true, sorted: true, caveats: [] });
			}
			h.calls.push({ tool: 'documents', args: [cursor] });
			if (failOnce) {
				failOnce = false;
				throw new ExplorerToolError({ kind: 'store', tool: 'list_documents', code: 'TIMEOUT', message: 'The store did not finish within its time budget.' });
			}
			return readDocumentsPage(fixture('list_documents_page1'));
		},
	});
	h.store.open();
	await h.clock.settle();
	assert.equal(h.store.getState().directory.status, 'error', 'the premise: the documents failed');
	h.store.setView('trash');
	await h.clock.settle();
	h.store.setView('active');
	const before = h.calls.length;
	h.store.retryDocuments();
	await h.clock.settle();
	const after = h.calls.slice(before).map((c) => c.tool).filter((t) => t !== 'stats');
	assert.ok(after.length > 0 && after.every((t) => t === 'documents'), `Retry pages the documents, not the trash: ${after.join(', ')}`);
	assert.notEqual(h.store.getState().directory.status, 'error');
	h.store.dispose();
});

test('staged documents applied: one confirmation for all of them with the paths and counts they were staged with, then one soft_delete batch; the moved ones are reported', async () => {
	const h = harness();
	h.store.setWritesEnabled(true);
	const staged = [
		{ objectId: 'a', path: 'docs/a.md', chunks: 4 },
		{ objectId: 'm', path: 'map/m.md', chunks: null },
	];
	h.store.requestRemove(staged);
	const pending = h.store.getState().confirm;
	assert.deepEqual(pending, { action: 'trash', kind: 'multi', targets: staged, origin: 'console' }, 'nothing is sent before Confirm');
	assert.ok(!h.tools().includes('soft_delete'));
	await h.store.confirmRemove();
	await h.clock.settle();
	assert.deepEqual(h.calls.filter((c) => c.tool === 'soft_delete').map((c) => c.args), [[['a', 'm']]]);
	assert.deepEqual(h.removedIds, [['a', 'm']], 'what moved leaves the selection, the map and the staged set (adapters/connections.ts onRemoved)');
	h.store.requestRemove(staged);
	h.store.cancelRemove();
	assert.equal(h.store.getState().confirm, null);
	assert.equal(h.calls.filter((c) => c.tool === 'soft_delete').length, 1, 'Cancel sends nothing');
	h.store.dispose();
});

test('B4: with no probe that answered, Refresh and Retry probe the store first, and a failed relist keeps the last known rows', async () => {
	let probed = true;
	let down = false;
	const order: string[] = [];
	let answer: () => void = () => undefined;
	const { store, clock } = harness({
		probed: () => probed,
		reprobe: () => {
			order.push('probe');
			return new Promise<void>((resolve) => {
				answer = () => {
					probed = !down;
					resolve();
				};
			});
		},
		documents: async (cursor) => {
			order.push('documents');
			if (down) throw new ExplorerToolError({ kind: 'unavailable', tool: 'list_documents', message: NOT_PROBED_TEXT });
			return readDocumentsPage(cursor ? fixture('list_documents_page2_last') : fixture('list_documents_page1'));
		},
	});
	store.open();
	await clock.settle();
	const known = store.getState().directory.rows.map((row) => row.objectId);
	assert.ok(known.length > 0, 'the premise: rows were read');
	// The store went down and its probe failed: Refresh probes first, and reads nothing until the probe answers.
	down = true;
	probed = false;
	order.length = 0;
	store.refresh();
	await clock.settle();
	assert.deepEqual(order, ['probe'], 'nothing is read before the probe answers');
	assert.equal(store.getState().checking, true, 'Refreshing… while it checks');
	store.refresh();
	assert.deepEqual(order, ['probe'], 'a Refresh while it checks is not asked again');
	answer();
	await clock.settle();
	assert.equal(store.getState().checking, false);
	assert.deepEqual(order, ['probe', 'documents'], 'then it reads');
	const failed = store.getState().directory;
	assert.equal(failed.status, 'error');
	assert.deepEqual(failed.rows.map((row) => row.objectId).sort(), [...known].sort(), 'the last known rows stay');
	assert.equal(failed.stale, true, 'marked as the last known');
	assert.match(pagerFooter(failed)?.text ?? '', /^Showing the last known \d+ documents; reading them again failed: The store did not answer when it was last checked\./);
	assert.match(directoryHeading(failed), /^\d+ last known$/);
	assert.equal(pagerFooter(failed)?.retry, true);
	// Retry probes first too; the store is back: the listing is read again and is no longer the last known.
	down = false;
	order.length = 0;
	store.retryDocuments();
	store.retryDocuments();
	assert.deepEqual(order, ['probe'], 'Retry probes first, once');
	answer();
	await clock.settle();
	assert.equal(order[0], 'probe');
	assert.ok(order.slice(1).every((step) => step === 'documents') && order.length > 1);
	const back = store.getState().directory;
	assert.equal(back.status, 'done');
	assert.equal(back.stale, undefined);
	assert.equal(back.held, undefined);
	// With a probe that answered, Refresh reads at once (and probes alongside, as before).
	order.length = 0;
	store.refresh();
	await clock.settle();
	assert.equal(order[0], 'documents');
	store.dispose();
});

test('B4: a listing that starts over keeps nothing for another filter, and its first page replaces what it held', () => {
	const read = pagerApplyPage(pagerBegin(pagerInit()), readDocumentsPage(fixture('list_documents_page2_last')));
	const again = pagerBegin(read);
	assert.equal(again.rows.length, 0, 'loading shows nothing new yet');
	assert.equal(again.held?.length, read.rows.length);
	assert.equal(pagerBegin(read, { path_prefix: 'C:/demo' }).held, undefined, 'another filter is another listing');
	const ok = pagerApplyPage(again, readDocumentsPage(fixture('list_documents_page2_last')));
	assert.equal(ok.held, undefined);
	assert.equal(ok.stale, undefined);
	const failedFirst = pagerFail(pagerBegin(pagerInit()), { headline: 'down' });
	assert.equal(failedFirst.stale, undefined, 'nothing to hold: an empty error as before');
	assert.match(pagerFooter(failedFirst)?.text ?? '', /^Loading stopped at 0 documents/);
});

test("B4: a call refused for want of a probe that answered says so, never 'update the node'", async () => {
	let probed = false;
	const refusing = { invoke: async () => Promise.reject(new ExplorerToolError({ kind: 'upgrade', tool: 'list_documents', message: 'This node cannot run list_documents: it does not advertise "list_documents". Update the pipeline\'s node to a version that supports it.' })) };
	const aware = probeAware(refusing, () => probed);
	assert.equal(probeAware(refusing, () => probed), aware, 'one stand-in per caller (its identity is a dependency)');
	const notProbed = await aware.invoke('list_documents').then(() => null, (error: unknown) => error);
	assert.ok(notProbed instanceof ExplorerToolError);
	assert.equal(notProbed.kind, 'unavailable');
	assert.equal(failureText(notProbed)?.headline, NOT_PROBED_TEXT);
	assert.doesNotMatch(NOT_PROBED_TEXT, /[Uu]pdate/);
	// A node whose probe answered without the capability is out of date: that refusal stays as it was.
	probed = true;
	const upgrade = await aware.invoke('list_documents').then(() => null, (error: unknown) => error);
	assert.ok(upgrade instanceof ExplorerToolError && upgrade.kind === 'upgrade');
	assert.match(failureText(upgrade)?.headline ?? '', /Update the pipeline's store node/);
	// Other failures pass through.
	const other = probeAware({ invoke: async () => Promise.reject(new ExplorerToolError({ kind: 'timeout', tool: 'stats', message: 'slow' })) }, () => false);
	const timeout = await other.invoke('stats').then(() => null, (error: unknown) => error);
	assert.ok(timeout instanceof ExplorerToolError && timeout.kind === 'timeout');
	// A role channel keeps what it is (its role, binding, uploads and questions); only its calls are probe-aware.
	const channel = { role: 'tools', bound: true, invoke: refusing.invoke, sendFiles: () => 'files', ask: () => 'ask' } as unknown as Parameters<typeof probeAwareChannel>[0];
	const awareChannel = probeAwareChannel(channel, () => false);
	assert.equal(awareChannel.role, 'tools');
	assert.equal(awareChannel.bound, true);
	assert.equal((awareChannel as unknown as { ask(): string }).ask(), 'ask');
	assert.equal(probeAwareChannel(channel, () => false), awareChannel);
	const viaChannel = await awareChannel.invoke('list_documents').then(() => null, (error: unknown) => error);
	assert.ok(viaChannel instanceof ExplorerToolError && viaChannel.kind === 'unavailable');
});

test("B10: a document tab's write or cancel carries its origin; the console's own carry none", async () => {
	const { store, clock } = harness();
	store.setWritesEnabled(true);
	store.open();
	await clock.settle();
	const kestrel = [{ objectId: 'kestrel', path: 'C:/demo/field/kestrel_field_guide.md', chunks: 12 }];
	store.requestRemove(kestrel, documentOrigin('kestrel'));
	store.cancelRemove();
	assert.deepEqual(store.getState().removal, { status: 'idle', message: CANCELLED_TEXT, origin: documentOrigin('kestrel') });
	store.requestRemove(kestrel, documentOrigin('kestrel'));
	const running = store.confirmRemove();
	assert.equal(store.getState().removal.origin, documentOrigin('kestrel'), 'while it runs');
	await running;
	assert.equal(store.getState().removal.status, 'done');
	assert.equal(store.getState().removal.origin, documentOrigin('kestrel'), 'and its result');
	store.requestRemove(kestrel);
	store.cancelRemove();
	assert.deepEqual(store.getState().removal, { status: 'idle', message: CANCELLED_TEXT }, "the console's own: no origin");
	await store.restore(kestrel, documentOrigin('kestrel'));
	assert.equal(store.getState().removal.origin, documentOrigin('kestrel'), 'a Restore from a document too');
	store.dispose();
});

