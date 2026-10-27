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
// THE WORKBENCH'S SEAMS: the connection entry's new state, staging, the fields,
// the Query history in both mounts, the console actions, confirmations that
// belong to the surface that asked, focus after a close, and fetchNeighbors
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import type { IExplorerEndpoint, IHistoryEntry } from 'shared/explorer';
import { manualClock } from 'shared/explorer/connect/testing';
import { fetchNeighbors } from '../src/adapters/actions';
import { makeConsoleActions, stageTargets } from '../src/adapters/consoleActions';
import { createConnectionRegistry } from '../src/adapters/connections';
import type { IConnectionLink } from '../src/adapters/connections';
import { makeVectorHistory, vectorQueryHistory } from '../src/adapters/explorer';
import { QUERY_HISTORY_TEXT_MAX, persistedQueryHistory, queryEntryOf, sessionQueryHistory, storedEntryOf, storedText } from '../src/adapters/queryHistory';
import type { IDocumentItem } from '../src/contract/types';
import { APP_HISTORY_NOTE, DEVTOOL_HISTORY_NOTE } from '../src/env';
import type { IQueryHistoryEntry } from '../src/env';
import { CONSOLE_ORIGIN, confirmElsewhereText, documentOrigin, removalSummary, removeConfirmation, runRemoval } from '../src/vector/confirm';
import type { IRemoveTarget } from '../src/vector/confirm';
import { firstFocusable, focusLost } from '../src/vector/focus';
import { readDeleteResult, readTrashResult } from '../src/vector/results';
import { FIELD_EXAMPLE_MAX, chunkFields, documentFields } from '../src/vector/fields';
import { DEFAULT_LIMITS } from '../src/vector/results';
import { NO_STAGED, dropGone, stage, stagedSummary, unstage } from '../src/vector/staged';
import { fixture } from './support/fixtures';

/** An endpoint for the registry. */
function endpoint(key: string): IExplorerEndpoint {
	return { key, legacyKey: null, projectId: 'vp', pipelineName: 'Vector docs', runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 't1', roles: { tools: { source: 'tools_1' }, chat: null, ingest: null }, missingRoles: ['chat', 'ingest'], source: 'tools_1', nodeId: 'store_1', nodeName: 'Store', provider: 'postgres', state: 'ready', running: true, components: [], anchorRole: 'tools', readOnly: false };
}

const A: IRemoveTarget = { objectId: 'a', path: 'docs/a.md', chunks: 4 };
const B: IRemoveTarget = { objectId: 'b', path: 'docs/b.md', chunks: null };
const C: IRemoveTarget = { objectId: 'c', path: 'c.md', chunks: 2 };

/** A run as the Query tab records it. */
const RUN: Omit<IQueryHistoryEntry, 'id'> = { question: 'where is the water?', kind: 'semantic', at: 1_000, ms: 40, topK: 10, results: 7, outcome: 'rows' };

test('a connection opens on the Overview, in Search, with nothing handed to the Query or Documents tab, nothing staged and no fields read', () => {
	const entry = createConnectionRegistry().entry(endpoint('k-defaults'), null);
	assert.equal(entry.tab.get(), 'overview');
	assert.equal(entry.queryMode.get(), 'search');
	assert.equal(entry.queryPrefill.get(), null);
	assert.equal(entry.openDocument.get(), null);
	assert.equal(entry.staged.get().size, 0);
	assert.equal(entry.fields.get(), null);
	entry.controller.dispose();
});

test('staging: in the order staged, each document once, a count learned later kept; the same set back when nothing changed', () => {
	const one = stage(NO_STAGED, [A, B]);
	assert.deepEqual([...one.keys()], ['a', 'b']);
	assert.equal(stage(one, [A]), one, 'staged again: nothing changed');
	assert.equal(stage(one, [{ ...A, chunks: null }]), one, 'an unknown count does not replace a known one');
	const counted = stage(one, [{ ...B, chunks: 3 }, C]);
	assert.deepEqual([...counted.keys()], ['a', 'b', 'c'], 'b keeps its place');
	assert.equal(counted.get('b')?.chunks, 3);
	assert.equal(one.get('b')?.chunks, null, 'the old set is not changed');
	assert.equal(unstage(counted, ['zz']), counted, 'nothing to take out');
	assert.deepEqual([...unstage(counted, ['a', 'c']).keys()], ['b']);
	assert.equal(dropGone(counted, () => false), counted);
	assert.deepEqual([...dropGone(counted, (id) => id !== 'b').keys()], ['b']);
});

test('the staged summary: documents, the chunks the store counted, and how many it did not count', () => {
	assert.deepEqual(stagedSummary(NO_STAGED), { documents: 0, chunks: 0, unknown: 0 });
	assert.deepEqual(stagedSummary(stage(NO_STAGED, [A, B, C])), { documents: 3, chunks: 6, unknown: 1 });
	assert.deepEqual(stagedSummary(stage(NO_STAGED, [B])), { documents: 1, chunks: null, unknown: 1 }, 'no count reported for any: null, never 0');
});

test('a write that moved documents takes them out of the staged set', async () => {
	const clock = manualClock();
	const asked: string[] = [];
	const link: IConnectionLink = {
		session: () => ({
			invoke: async <T>(tool: string, input: Record<string, unknown> = {}): Promise<T> => {
				asked.push(tool);
				if (tool === 'soft_delete') return { ...fixture('soft_delete_ok'), object_ids: input.object_ids, matched_chunks: 4 } as T;
				if (tool === 'stats') return fixture('stats_pgvector') as T;
				return fixture('list_documents_page1') as T;
			},
		}),
		reprobe: () => undefined,
	};
	const entry = createConnectionRegistry().entry(endpoint('k-staged'), link, DEFAULT_LIMITS, clock);
	entry.staged.set(stage(NO_STAGED, [A, B]));
	entry.controller.setWritesEnabled(true);
	entry.controller.requestRemove([A]);
	await entry.controller.confirmRemove();
	await clock.settle();
	assert.ok(asked.includes('soft_delete'), 'the premise: the write ran');
	assert.deepEqual([...entry.staged.get().keys()], ['b'], 'a left the set; b is still staged');
	entry.controller.dispose();
});

test('console actions: stage what the caller knows (nothing confirmed or sent), show a tab, "Use as query" and "Ask about these" land on Query', () => {
	const entry = createConnectionRegistry().entry(endpoint('k-actions'), null);
	const fronted: string[] = [];
	const actions = makeConsoleActions(entry, { openDocument: () => undefined, showConsole: () => fronted.push(entry.tab.get()), announce: () => undefined });
	actions.stageRemove?.([{ objectId: 'doc-1', path: 'docs/one.md', chunks: 3 }, { objectId: 'doc-2' }]);
	assert.deepEqual([...entry.staged.get().values()], [
		{ objectId: 'doc-1', path: 'docs/one.md', chunks: 3 },
		{ objectId: 'doc-2', path: 'doc-2', chunks: null },
	], "the map's paths are kept; a document it knows nothing of reads as its id, its count unknown");
	entry.selection.selectDocument({ objectId: 'doc-3', path: 'docs/three.md' });
	assert.deepEqual(stageTargets(entry, [{ objectId: 'doc-3' }, { objectId: 'doc-1', path: 'other.md' }]), [
		{ objectId: 'doc-3', path: 'docs/three.md', chunks: null },
		{ objectId: 'doc-1', path: 'other.md', chunks: null },
	], 'what the app knows fills what the caller left out; what the caller gave wins');
	assert.equal(entry.controller.getState().confirm, null, 'staging opens no confirmation');
	assert.deepEqual(fronted, [], 'and does not front the console');
	actions.openTab?.('collection');
	assert.equal(entry.tab.get(), 'collection');
	assert.deepEqual(fronted, ['collection'], 'showing a tab fronts the console, on that tab');
	entry.queryMode.set('compare');
	actions.useAsQuery?.('falcon station water');
	assert.equal(entry.tab.get(), 'query');
	assert.equal(entry.queryMode.get(), 'search');
	const prefill = entry.queryPrefill.get();
	assert.deepEqual({ question: prefill?.question, mode: prefill?.mode }, { question: 'falcon station water', mode: 'search' });
	actions.useAsQuery?.('falcon station water');
	assert.notEqual(entry.queryPrefill.get()?.nonce, prefill?.nonce, 'the same text again is a new request');
	assert.deepEqual(fronted, ['collection', 'query', 'query']);
	actions.askAbout(['doc-1']);
	assert.equal(entry.tab.get(), 'query');
	assert.equal(entry.queryMode.get(), 'ask');
	entry.controller.dispose();
});

test('a confirmation belongs to the surface that asked: another surface asking meanwhile opens nothing and is told where it is', () => {
	const entry = createConnectionRegistry().entry(endpoint('k-origin'), null);
	const said: string[] = [];
	const console = makeConsoleActions(entry, { openDocument: () => undefined, showConsole: () => undefined, announce: () => undefined });
	entry.controller.setWritesEnabled(true);
	const tab = makeConsoleActions(entry, { openDocument: () => undefined, showConsole: () => undefined, announce: (t) => said.push(t), origin: documentOrigin('doc-9') });
	console.requestRemove(['doc-1']);
	assert.equal(entry.controller.getState().confirm?.origin, CONSOLE_ORIGIN);
	tab.requestRemove(['doc-9']);
	assert.deepEqual(entry.controller.getState().confirm?.targets.map((t) => t.objectId), ['doc-1'], 'the open one is never replaced');
	assert.equal(entry.controller.getState().elsewhere, documentOrigin('doc-9'), 'the document tab is told');
	assert.equal(confirmElsewhereText(CONSOLE_ORIGIN), "Another confirmation is open in this connection's console; finish or cancel it first.");
	console.requestRemove(['doc-2']);
	assert.deepEqual(entry.controller.getState().confirm?.targets.map((t) => t.objectId), ['doc-2'], 'the surface that holds it may ask again');
	entry.controller.cancelRemove();
	assert.equal(entry.controller.getState().elsewhere, null, 'closed: nothing to tell any more');
	tab.requestRemove(['doc-9']);
	assert.equal(entry.controller.getState().confirm?.origin, documentOrigin('doc-9'), 'then the document tab asks for its own');
	entry.controller.dispose();
});

test('Delete permanently is a Trash action: one document is typed by its file name, and a document kept whole is named', async () => {
	const PG = { storeName: 'Store', collection: 'vx_demo_docs', backend: 'pgvector', provider: 'postgres' };
	const one = removeConfirmation({ objectId: 'k', path: 'C:/demo/field/kestrel.md', chunks: 2 }, PG);
	assert.deepEqual(one.typed, { expected: 'kestrel.md', prompt: "Type the file name 'kestrel.md' to confirm." });
	assert.match(one.sentence, /If it still has chunks outside the trash, it is kept whole\./);
	assert.equal(removeConfirmation({ objectId: 'k', path: 'C:/demo/x.md', chunks: 2 }, { ...PG, provider: 'rocketride_vector' }).typed?.expected, 'vx_demo_docs', 'a shared table keeps its table name');
	const targets = [{ objectId: 'a', path: 'docs/a.md', chunks: 2 }, { objectId: 'b', path: 'docs/b.md', chunks: 1 }];
	const outcome = await runRemoval(['a', 'b'], async (batch) => readDeleteResult({ success: true, kept_live: ['b'], not_found: [], removed_chunks: 2, audit: { action: 'vector.delete', rows: 2, caller: { auth: 'account' } } }, batch), 100);
	assert.equal(removalSummary(outcome, targets, 'delete'), 'Deleted 1 document permanently (2 chunks). 1 was kept whole, because it still has chunks outside the trash: docs/b.md.');
	assert.equal(removalSummary({ ...outcome, removed: [], removedChunks: 0, keptLive: ['a'] }, targets.slice(0, 1), 'delete'), 'docs/a.md was kept whole, because it still has chunks outside the trash; nothing was deleted.');
	assert.deepEqual(outcome.audits, [{ action: 'vector.delete', rows: 2, caller: 'account' }], "each batch's audit block is kept");
	assert.deepEqual(readTrashResult({ success: true, object_ids: ['a'], matched_chunks: 2 }).audit, null, 'none: null');
});

test('the controller sends every permanent delete with deleted_only, and keeps the write\'s audit with its result', async () => {
	const clock = manualClock();
	const sent: Array<[string, Record<string, unknown>]> = [];
	const link: IConnectionLink = {
		session: () => ({
			invoke: async <T>(tool: string, input: Record<string, unknown> = {}): Promise<T> => {
				sent.push([tool, input]);
				if (tool === 'delete') return fixture('delete_ok') as T;
				if (tool === 'stats') return fixture('stats_pgvector') as T;
				return fixture('list_documents_page1') as T;
			},
		}),
		reprobe: () => undefined,
	};
	const entry = createConnectionRegistry().entry(endpoint('k-delete'), link, DEFAULT_LIMITS, clock);
	entry.controller.setWritesEnabled(true);
	entry.controller.requestDelete([{ objectId: '91ae15d4-3f6e-589f-bb81-72301f2ca1b6', path: 'a.md', chunks: 12 }]);
	await entry.controller.confirmRemove();
	await clock.settle();
	assert.deepEqual(sent.filter(([tool]) => tool === 'delete').map(([, input]) => input.deleted_only), [true]);
	assert.deepEqual(entry.controller.getState().removal.audit, [{ action: 'vector.delete', rows: 12, caller: 'account' }]);
	entry.controller.dispose();
});

test('focus after a close: only when it was lost (nothing, the body, or inside what closed), to the first candidate on the page and shown', () => {
	const body = {};
	const region = { contains: (node: unknown) => node === inside };
	const inside = {};
	assert.equal(focusLost(null, body, region), true);
	assert.equal(focusLost(body, body, region), true);
	assert.equal(focusLost(inside, body, region), true);
	assert.equal(focusLost({}, body, region), false, 'focus elsewhere stays where it is');
	const el = (shown: boolean, connected = true) => ({ isConnected: connected, offsetParent: shown ? {} : null, focus: () => undefined });
	const hidden = el(false);
	const gone = el(true, false);
	const tab = el(true);
	assert.equal(firstFocusable([null, hidden, gone, tab]), tab, 'a hidden panel\'s element and a removed one are passed over');
	assert.equal(firstFocusable([hidden]), null);
});

test('document fields: exact over the rows given, each with its coverage, one example, and what each filter takes', () => {
	const row = (over: Partial<IDocumentItem>): IDocumentItem => ({ objectId: 'o', path: 'docs/a.md', chunks: 3, has_first_chunk: true, tables: 0, deleted: false, nodeId: null, size: null, modifyTime: null, ingestedAt: '2026-10-01T00:00:00Z', pointId: null, ...over });
	const long = `docs/${'x'.repeat(200)}.md`;
	const fields = documentFields([row({ path: long, size: 10 }), row({ chunks: null, nodeId: 'n1' }), row({ ingestedAt: null })]);
	const by = new Map(fields.map((f) => [f.name, f]));
	assert.deepEqual([...by.keys()], ['path', 'size', 'modifyTime', 'ingestedAt', 'nodeId', 'chunks', 'tables']);
	for (const f of fields) {
		assert.equal(f.of, 3, f.name);
		assert.equal(f.source, 'listing', f.name);
	}
	assert.equal(by.get('path')?.coverage, 3);
	assert.equal(by.get('path')?.example?.length, FIELD_EXAMPLE_MAX, 'a long example is cut');
	assert.ok(by.get('path')?.example?.endsWith('…'));
	assert.equal(by.get('size')?.coverage, 1);
	assert.equal(by.get('size')?.example, '10');
	assert.deepEqual([by.get('modifyTime')?.coverage, by.get('modifyTime')?.example], [0, null], 'none reported: 0 of 3, no example');
	assert.equal(by.get('chunks')?.coverage, 2);
	assert.equal(by.get('ingestedAt')?.coverage, 2);
	assert.equal(by.get('tables')?.example, '0', 'a zero is a value');
	assert.deepEqual(fields.filter((f) => f.searchFilter).map((f) => f.name), ['nodeId'], 'search.filter takes nodeId of these');
	assert.deepEqual(fields.filter((f) => f.listFilter).map((f) => f.name), ['path', 'ingestedAt', 'chunks', 'tables']);
	assert.deepEqual(documentFields([]), [], 'no rows: nothing was read');
	assert.deepEqual(chunkFields([]), []);
});

test('a Compare entry keeps question B in memory only: never handed to the shared store, so a reload (or a reset) has none', () => {
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	history.record('k', { ...RUN, kind: 'compare', compareWith: 'question b' });
	const [entry] = history.entries('k').get();
	assert.equal(entry.compareWith, 'question b');
	assert.ok(!('compareWith' in storedEntryOf('x', { ...RUN, compareWith: 'question b' })), 'the stored entry has no question B');
	const store = makeVectorHistory(0);
	const persisted = persistedQueryHistory(store, APP_HISTORY_NOTE);
	const prefs: Record<string, unknown> = {};
	store.attachPrefs({ getPref: (key) => prefs[key], setPref: (key, value) => (prefs[key] = value) });
	persisted.record('k', { ...RUN, kind: 'compare', compareWith: 'question b' });
	assert.equal(persisted.entries('k').get()[0].compareWith, 'question b', 'shown for the page\'s life');
	store.flush();
	assert.doesNotMatch(JSON.stringify(prefs), /question b/, 'never written to the workspace file');
	history.forget();
	history.record('k', { ...RUN, kind: 'compare' });
	assert.equal(history.entries('k').get()[0].compareWith, undefined);
});

test('the history keeps the first 200 characters of a question and says so; it compares runs on the whole question, so only a true repeat is one entry', () => {
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	const entries = history.entries('k');
	const start = 'q'.repeat(199);
	history.record('k', { ...RUN, question: `${start}A and more`, at: 1 });
	history.record('k', { ...RUN, question: `${start}B and more`, at: 2 });
	assert.equal(entries.get().length, 2, 'two long questions that share their start stay two entries');
	for (const entry of entries.get()) {
		assert.equal(entry.question.length, QUERY_HISTORY_TEXT_MAX);
		assert.equal(entry.truncated, true);
	}
	history.record('k', { ...RUN, question: `${start}B and more`, at: 3 });
	assert.equal(entries.get().length, 3, 'an entry already cut is never merged');
	history.clear('k');
	history.record('k', { ...RUN, question: 'water', at: 1, results: 7 });
	const first = entries.get()[0];
	history.togglePin('k', first.id);
	history.record('k', { ...RUN, question: 'water', at: 2, results: 3, topK: 25 });
	assert.equal(entries.get().length, 1, 'the same kind and question run again is the same entry, run again');
	assert.deepEqual([entries.get()[0].id, entries.get()[0].pinned, entries.get()[0].kind, entries.get()[0].results, entries.get()[0].topK, entries.get()[0].at], [first.id, true, 'semantic', 3, 25, 2], 'it keeps its id and pin and takes the new run');
	assert.equal(entries.get()[0].truncated, undefined, 'a short question is whole');
	// DA-R1 I2: another kind of run of the same words is its own entry; the pinned one keeps its mode and k.
	history.record('k', { ...RUN, question: 'water', kind: 'ask', topK: null, at: 3, results: 2 });
	assert.deepEqual(entries.get().map((e) => [e.kind, e.topK, e.pinned === true]), [['ask', null, false], ['semantic', 25, true]]);
});

test("a Compare is its own entry beside a Search of the same A, keeps its question B when a Search of it follows, and a Compare of the same A run again takes the new B; nothing changes while recording is off", () => {
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	const entries = history.entries('k');
	history.record('k', { ...RUN, question: 'water', at: 1 });
	history.record('k', { ...RUN, question: 'water', kind: 'compare', at: 2, compareWith: 'wells' });
	assert.deepEqual(entries.get().map((e) => [e.kind, e.compareWith]), [['compare', 'wells'], ['semantic', undefined]], 'a Search and a Compare of the same A: two entries');
	history.record('k', { ...RUN, question: 'water', kind: 'compare', at: 3, compareWith: 'rivers' });
	assert.deepEqual(entries.get().map((e) => [e.kind, e.compareWith, e.at]), [['compare', 'rivers', 3], ['semantic', undefined, 1]], 'the Compare run again, with its new B');
	history.record('k', { ...RUN, question: 'water', at: 4 });
	assert.deepEqual(entries.get().map((e) => [e.kind, e.compareWith]), [['semantic', undefined], ['compare', 'rivers'], ['semantic', undefined]], 'a Search after it is its own entry, and the Compare keeps B');
	history.setRecording('k', false);
	history.record('k', { ...RUN, question: 'water', kind: 'compare', at: 5, compareWith: 'lakes' });
	assert.deepEqual(entries.get().map((e) => [e.kind, e.compareWith, e.at]), [['semantic', undefined, 4], ['compare', 'rivers', 3], ['semantic', undefined, 1]], 'a run not recorded changes nothing');
});

test('Query history entries map onto the shared store: mode as kind, top-k as limit, results as rows; another kind is not shown', () => {
	const stored = storedEntryOf('q1', { ...RUN, pinned: true, note: 'n' });
	assert.deepEqual(stored, { id: 'q1', question: storedText('semantic', RUN.question), at: 1_000, ms: 40, outcome: 'rows', kind: 'semantic', rows: 7, limit: 10, pinned: true, note: 'n' });
	assert.deepEqual(queryEntryOf(stored), { id: 'q1', ...RUN, pinned: true, note: 'n' }, 'read back without its kind\'s tag');
	const failed = storedEntryOf('q2', { ...RUN, kind: 'ask', topK: null, results: null, outcome: 'error', error: 'BUSY' });
	assert.deepEqual(queryEntryOf(failed), { id: 'q2', ...RUN, kind: 'ask', topK: null, results: null, outcome: 'error', error: 'BUSY' });
	assert.equal(queryEntryOf({ ...stored, kind: 'other' }), null);
	assert.equal(queryEntryOf({ ...stored, outcome: 'abandoned' }), null);
});

test("a dev-tool mount's Query history: kept in memory at once, pinned, noted, removed, cleared, switched off and forgotten", () => {
	const history = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	assert.equal(history.persisted, false);
	assert.equal(history.note, DEVTOOL_HISTORY_NOTE);
	const entries = history.entries('k');
	assert.equal(history.entries('k'), entries, 'one readable per key');
	let told = 0;
	const off = entries.subscribe(() => (told += 1));
	history.record('k', RUN);
	const first = entries.get();
	assert.equal(first.length, 1, 'recorded at once, with no preferences attached');
	assert.equal(entries.get(), first, 'a stable snapshot');
	assert.ok(told > 0);
	const id = first[0].id;
	history.togglePin('k', id);
	history.setNote('k', id, 'check');
	assert.deepEqual({ pinned: entries.get()[0].pinned, note: entries.get()[0].note }, { pinned: true, note: 'check' });
	history.record('k', { ...RUN, question: 'second', at: 2_000 });
	assert.deepEqual(entries.get().map((e) => e.question), ['second', RUN.question], 'newest first');
	history.remove('k', id);
	assert.deepEqual(entries.get().map((e) => e.question), ['second']);
	assert.equal(history.entries('other').get().length, 0, 'per connection');
	history.setRecording('k', false);
	assert.equal(history.recording('k').get(), false);
	history.record('k', { ...RUN, question: 'not kept', at: 3_000 });
	assert.deepEqual(entries.get().map((e) => e.question), ['second'], 'nothing recorded while switched off');
	history.clear('k');
	assert.equal(entries.get().length, 0);
	history.setRecording('k', true);
	history.record('k', RUN);
	const before = told;
	history.forget();
	assert.equal(entries.get().length, 0, 'a reset forgets everything');
	assert.ok(told > before, 'and says so');
	history.record('k', RUN);
	assert.equal(entries.get().length, 1, 'and records again after it');
	off();
});

test("the full app's Query history is the shared store in the workspace preferences: it waits for them, then keeps each run", () => {
	assert.equal(vectorQueryHistory.persisted, true);
	assert.equal(vectorQueryHistory.note, APP_HISTORY_NOTE);
	const store = makeVectorHistory(0);
	const history = persistedQueryHistory(store, APP_HISTORY_NOTE);
	history.record('k', RUN);
	assert.equal(history.entries('k').get().length, 0, 'before the preferences are read, a run waits (the recording switch may be off)');
	const prefs: Record<string, unknown> = { 'vector.history': { k: [{ id: 'old', question: 'from another tool', at: 1, ms: 1, outcome: 'rows', kind: 'other' }] } };
	const detach = store.attachPrefs({ getPref: (key) => prefs[key], setPref: (key, value) => (prefs[key] = value) });
	const shown = history.entries('k').get();
	assert.deepEqual(shown.map((e) => [e.question, e.kind, e.topK, e.results]), [[RUN.question, 'semantic', 10, 7]], 'the run, and not the entry of another kind');
	store.flush();
	const saved = (prefs['vector.history'] as Record<string, IHistoryEntry<'question'>[]>).k;
	assert.deepEqual(saved.map((e) => [e.question, e.kind, e.limit, e.rows]), [[storedText('semantic', RUN.question), 'semantic', 10, 7], ['from another tool', 'other', undefined, undefined]], 'written with the store (its kind\'s tag before the question), the other entry kept');
	detach();
});

test('fetchNeighbors: one read at a time per caller, only the newest waiting (an older one drops as stale), and BUSY asked again', async () => {
	const asked: unknown[] = [];
	const answers: Array<(value: unknown) => void> = [];
	const caller = { invoke: <T>(_tool: string, input?: Record<string, unknown>): Promise<T> => new Promise<T>((resolve) => { asked.push(input?.key); answers.push(resolve as (value: unknown) => void); }) };
	const first = fetchNeighbors(caller, 'store_1', ['d', 1], 12);
	const second = fetchNeighbors(caller, 'store_1', ['d', 2], 12);
	const third = fetchNeighbors(caller, 'store_1', ['d', 3], 12);
	await assert.rejects(second, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale', 'replaced while waiting');
	assert.deepEqual(asked, [['d', 1]], 'one at a time');
	answers[0]({ success: true, items: [] });
	await first;
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(asked, [['d', 1], ['d', 3]], 'then the newest');
	answers[1]({ success: true, items: [] });
	assert.deepEqual((await third).items, []);
	let calls = 0;
	const waits: number[] = [];
	const busy = { invoke: async <T>(): Promise<T> => (++calls < 3 ? { success: false, code: 'BUSY', error: 'busy' } : { success: true, items: [] }) as T };
	await fetchNeighbors(busy, 'store_1', ['d', 1], 12, { wait: async (ms) => void waits.push(ms) });
	assert.equal(calls, 3);
	assert.equal(waits.length, 2, 'asked again after a short wait');
});

test('fetchNeighbors asks for a chunk\'s neighbours (itself left out) and unwraps the answer; a failure envelope rejects with its code', async () => {
	const sent: Array<[string, Record<string, unknown> | undefined, string | undefined]> = [];
	const caller = {
		invoke: async <T>(tool: string, input?: Record<string, unknown>, opts?: { nodeId?: string }): Promise<T> => {
			sent.push([tool, input, opts?.nodeId]);
			return { success: true, items: [{ key: ['d', 2], sim: 0.9, score: 0.9, below_floor: false, path: 'd.md', chunkId: 2, preview: 'x' }], metric: 'cosine', scope: 'collection', k_requested: 12 } as T;
		},
	};
	const answer = await fetchNeighbors(caller, 'store_1', ['doc', 3], 12);
	assert.deepEqual(sent, [['neighbors', { key: ['doc', 3], k: 12, exclude_self: true }, 'store_1']]);
	assert.equal(answer.items.length, 1);
	const noItems = await fetchNeighbors({ invoke: async <T>() => ({ success: true, metric: 'cosine' }) as T }, 'store_1', ['doc', 3], 12);
	assert.deepEqual(noItems.items, [], 'items always an array');
	await assert.rejects(fetchNeighbors({ invoke: async <T>() => ({ success: false, code: 'NOT_FOUND', error: 'gone' }) as T }, 'store_1', ['doc', 3], 12), (error: unknown) => error instanceof ExplorerToolError && error.code === 'NOT_FOUND');
	await assert.rejects(fetchNeighbors({ invoke: async <T>() => ({ success: false, code: 'BUSY', error: 'busy' }) as T }, 'store_1', ['doc', 3], 12, { wait: async () => undefined }), (error: unknown) => error instanceof ExplorerToolError && error.code === 'BUSY', 'still busy after the retries: said');
});
