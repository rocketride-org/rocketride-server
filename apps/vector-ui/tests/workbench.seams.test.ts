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
// the Query history in both mounts, the console actions and fetchNeighbors
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import type { IExplorerEndpoint, IHistoryEntry } from 'shared/explorer';
import { manualClock } from 'shared/explorer/connect/testing';
import { fetchNeighbors } from '../src/adapters/actions';
import { makeConsoleActions } from '../src/adapters/consoleActions';
import { createConnectionRegistry } from '../src/adapters/connections';
import type { IConnectionLink } from '../src/adapters/connections';
import { makeVectorHistory, vectorQueryHistory } from '../src/adapters/explorer';
import { persistedQueryHistory, queryEntryOf, sessionQueryHistory, storedEntryOf } from '../src/adapters/queryHistory';
import type { IDocumentItem } from '../src/contract/types';
import { APP_HISTORY_NOTE, DEVTOOL_HISTORY_NOTE } from '../src/env';
import type { IQueryHistoryEntry } from '../src/env';
import type { IRemoveTarget } from '../src/vector/confirm';
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

test('a connection opens on the Overview, in Search, with nothing handed to the Query tab, nothing staged and no fields read', () => {
	const entry = createConnectionRegistry().entry(endpoint('k-defaults'), null);
	assert.equal(entry.tab.get(), 'overview');
	assert.equal(entry.queryMode.get(), 'search');
	assert.equal(entry.queryPrefill.get(), null);
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

test('console actions: stage (nothing confirmed or sent), show a tab, and "Ask about these" lands on Query in Ask', () => {
	const entry = createConnectionRegistry().entry(endpoint('k-actions'), null);
	const fronted: string[] = [];
	const actions = makeConsoleActions(entry, { openDocument: () => undefined, showConsole: () => fronted.push(entry.tab.get()), announce: () => undefined });
	actions.stageRemove?.(['doc-1', 'doc-2']);
	assert.deepEqual([...entry.staged.get().values()], [
		{ objectId: 'doc-1', path: 'doc-1', chunks: null },
		{ objectId: 'doc-2', path: 'doc-2', chunks: null },
	]);
	assert.equal(entry.controller.getState().confirm, null, 'staging opens no confirmation');
	assert.deepEqual(fronted, [], 'and does not front the console');
	actions.openTab?.('collection');
	assert.equal(entry.tab.get(), 'collection');
	assert.deepEqual(fronted, ['collection'], 'showing a tab fronts the console, on that tab');
	actions.askAbout(['doc-1']);
	assert.equal(entry.tab.get(), 'query');
	assert.equal(entry.queryMode.get(), 'ask');
	entry.controller.dispose();
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

test('Query history entries map onto the shared store: mode as kind, top-k as limit, results as rows; another kind is not shown', () => {
	const stored = storedEntryOf('q1', { ...RUN, pinned: true, note: 'n' });
	assert.deepEqual(stored, { id: 'q1', question: RUN.question, at: 1_000, ms: 40, outcome: 'rows', kind: 'semantic', rows: 7, limit: 10, pinned: true, note: 'n' });
	assert.deepEqual(queryEntryOf(stored), { id: 'q1', ...RUN, pinned: true, note: 'n' });
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
	assert.deepEqual(saved.map((e) => [e.question, e.kind, e.limit, e.rows]), [[RUN.question, 'semantic', 10, 7], ['from another tool', 'other', undefined, undefined]], 'written with the store, the other entry kept');
	detach();
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
	await assert.rejects(fetchNeighbors({ invoke: async <T>() => ({ success: false, code: 'BUSY', error: 'busy' }) as T }, 'store_1', ['doc', 3], 12), (error: unknown) => error instanceof ExplorerToolError && error.code === 'BUSY');
});
