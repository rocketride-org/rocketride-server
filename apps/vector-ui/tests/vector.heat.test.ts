// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// vector.heat — the document tab's heat strip scores its chunks against the query
// =============================================================================
//
// The document tab shows how similar every chunk of the document is to the
// active query (the text query the map placed, or the chat question it showed
// there). The query text is embedded on the embedding node and that exact
// vector goes to the store's `neighbors` with the document's chunk keys as
// `scope_keys`. Without a query the tab says how to get one instead of drawing
// an empty strip. Static renders (no DOM harness): effects do not run, so the
// render tests pin the states, and the call itself is tested on fakes.
// =============================================================================

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ExplorerToolError } from 'shared/explorer';
import type { IExplorerEndpoint } from 'shared/explorer';
import type { ConsoleActions, ConsoleModel, IDialectResult, VectorChannels } from '../src/contract/types';
import { createSelectionStore } from '../src/contract/bridge';

// ── Shell stand-ins (installed before the view loads) ─────────────────────────

const h = React.createElement;
const shellStandIn = {
	commonStyles: new Proxy({}, { get: () => ({}) }),
	Banner: ({ variant, children }: { variant: string; children: React.ReactNode }) => h('div', { 'data-banner': variant }, children),
	Button: ({ children }: { children?: React.ReactNode }) => h('button', { type: 'button' }, children),
	ContentHeader: ({ title, actions }: { title: string; actions?: React.ReactNode }) => h('header', null, h('h2', null, title), actions),
	BxTrash: () => h('span', null, 'trash'),
};
const moduleWithLoad = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const originalLoad = moduleWithLoad._load;
moduleWithLoad._load = function (request: string, parent: unknown, isMain: boolean): unknown {
	if (request === 'shell') return shellStandIn;
	return originalLoad.call(this, request, parent, isMain);
};

const { DocumentView } = require('../src/views/DocumentView') as typeof import('../src/views/DocumentView');
const { heatKeys, heatScores, HEAT_NO_EMBED, HEAT_NO_QUERY, HEAT_SCORING } = require('../src/vector/heat') as typeof import('../src/vector/heat');
const { scoreChunks } = require('../src/adapters/actions') as typeof import('../src/adapters/actions');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const dialect = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'provisional', 'dialect_pgvector.json'), 'utf8')) as IDialectResult;
const KEY = 'heat-1';
const noop = (): void => undefined;
const actions: ConsoleActions = { openDocument: noop, showOnMap: noop, requestRemove: noop, askAbout: noop, documentsChanged: noop, announce: noop };

/** A console model for one connection. */
function model(overrides: Partial<ConsoleModel> = {}): ConsoleModel {
	const on = { enabled: true, reason: null };
	return {
		connectionKey: KEY,
		connection: { endpoint: { key: KEY, anchorRole: 'tools', readOnly: false, nodeId: 'store_1', pipelineName: 'Vector demo' } as unknown as IExplorerEndpoint, dialect },
		nodes: { store: 'store_1', embed: 'embed_1', llm: null, llmName: null },
		collection: 'vx_demo_docs',
		stats: null,
		limits: dialect.limits,
		capabilities: dialect.capabilities,
		writes: on,
		ingest: on,
		chat: on,
		embed: on,
		readOnly: false,
		...overrides,
	};
}

/** A Tools channel that never answers (no effect runs in a static render). */
const silent = { invoke: () => new Promise<never>(() => undefined) } as unknown as NonNullable<VectorChannels['tools']>;
const channels: VectorChannels = { tools: silent, chat: null, ingest: null };

/** The document tab, statically rendered, with the shared selection's query set to `query`. */
function render(opts: { query?: string | null; model?: ConsoleModel; selectionKey?: string } = {}): string {
	const selection = createSelectionStore(opts.selectionKey ?? KEY);
	if (opts.query) selection.setQuery(opts.query);
	return renderToStaticMarkup(h(DocumentView, { model: opts.model ?? model(), channels, selection, actions, objectId: 'o-1', path: 'C:/demo/a.md' }));
}

// ── The pure parts ────────────────────────────────────────────────────────────

test('heatKeys: one key per chunk in reading order, at most scope_keys_max of them', () => {
	assert.deepEqual(heatKeys('o-1', 3, 2000), [
		['o-1', 0],
		['o-1', 1],
		['o-1', 2],
	]);
	assert.equal(heatKeys('o-1', 5000, 2000).length, 2000);
	assert.deepEqual(heatKeys('o-1', 0, 2000), []);
	assert.deepEqual(heatKeys('o-1', Number.NaN, 2000), []);
});

test('heatScores: a key the store does not hold (null) has no score, a score of 0 is kept', () => {
	assert.deepEqual(heatScores([0, 1, 2, 3], [0.41, null, 0, 0.8]), [
		{ chunkId: 0, sim: 0.41 },
		{ chunkId: 2, sim: 0 },
		{ chunkId: 3, sim: 0.8 },
	]);
	assert.deepEqual(heatScores([0, 1], [0.5]), [{ chunkId: 0, sim: 0.5 }], 'a short answer scores only what it answered');
});

// ── The call ──────────────────────────────────────────────────────────────────

interface ICall {
	tool: string;
	input: Record<string, unknown>;
	nodeId: string | undefined;
}

/** A caller that records its calls and answers each tool from `answers`. */
function recorder(answers: Record<string, unknown>): { calls: ICall[]; caller: { invoke: <T>(tool: string, input?: Record<string, unknown>, opts?: { nodeId?: string }) => Promise<T> } } {
	const calls: ICall[] = [];
	return {
		calls,
		caller: {
			invoke: async <T>(tool: string, input: Record<string, unknown> = {}, opts: { nodeId?: string } = {}): Promise<T> => {
				calls.push({ tool, input, nodeId: opts.nodeId });
				return answers[tool] as T;
			},
		},
	};
}

test('scoreChunks: embeds the query on the embedding node and sends that exact vector to neighbors with the chunk keys as scope_keys', async () => {
	const vector = [0.1, -0.2, 0.3];
	const embed = recorder({ embed: { success: true, model: 'm', dimension: 3, vectors: [vector], prefix_applied: null, ms: 1 } });
	const store = recorder({ neighbors: { success: true, scores: [0.62, null, 0.31] } });
	const keys = heatKeys('o-1', 3, 2000);
	const scores = await scoreChunks({ caller: store.caller, nodeId: 'store_1' }, { caller: embed.caller, nodeId: 'embed_1' }, keys, 'where does the water come from?');
	assert.deepEqual(scores, [
		{ chunkId: 0, sim: 0.62 },
		{ chunkId: 2, sim: 0.31 },
	]);
	assert.deepEqual(embed.calls, [{ tool: 'embed', input: { texts: ['where does the water come from?'], kind: 'query' }, nodeId: 'embed_1' }]);
	assert.equal(store.calls.length, 1);
	assert.equal(store.calls[0]?.tool, 'neighbors');
	assert.equal(store.calls[0]?.nodeId, 'store_1');
	assert.equal(store.calls[0]?.input.vector, vector, 'the vector embed returned, unchanged');
	assert.deepEqual(store.calls[0]?.input.scope_keys, keys);
	assert.deepEqual(Object.keys(store.calls[0]?.input ?? {}).sort(), ['scope_keys', 'vector']);
});

test('scoreChunks: no keys, no calls; a refusal keeps its code; an answer without a vector is not sent on', async () => {
	const none = recorder({});
	assert.deepEqual(await scoreChunks({ caller: none.caller, nodeId: 'store_1' }, { caller: none.caller, nodeId: 'embed_1' }, [], 'q'), []);
	assert.equal(none.calls.length, 0);

	const embed = recorder({ embed: { success: true, model: 'm', dimension: 3, vectors: [[0.1, 0.2, 0.3]], prefix_applied: null, ms: 1 } });
	const refusing = recorder({ neighbors: { success: false, code: 'DIMENSION_MISMATCH', error: 'The vector has 3 values; this collection stores 384.' } });
	await assert.rejects(scoreChunks({ caller: refusing.caller, nodeId: 'store_1' }, { caller: embed.caller, nodeId: 'embed_1' }, heatKeys('o-1', 2, 2000), 'q'), (error: unknown) => error instanceof ExplorerToolError && error.code === 'DIMENSION_MISMATCH');

	const empty = recorder({ embed: { success: true, model: 'm', dimension: 3, vectors: [], prefix_applied: null, ms: 1 } });
	const store = recorder({});
	await assert.rejects(scoreChunks({ caller: store.caller, nodeId: 'store_1' }, { caller: empty.caller, nodeId: 'embed_1' }, heatKeys('o-1', 2, 2000), 'q'), /without a vector/);
	assert.equal(store.calls.length, 0);
});

test('scoreChunks: a store busy with another neighbour search is asked again, a few times, without embedding again', async () => {
	const vector = [0.1, 0.2, 0.3];
	const busy = { success: false, code: 'BUSY', error: 'Another neighbour search is running on this store; try again when it ends.' };
	const answers: unknown[] = [busy, busy, { success: true, scores: [0.5] }];
	const embed = recorder({ embed: { success: true, model: 'm', dimension: 3, vectors: [vector], prefix_applied: null, ms: 1 } });
	const store = { calls: 0, caller: { invoke: async <T>(): Promise<T> => answers[store.calls++] as T } };
	const waits: number[] = [];
	const wait = async (ms: number): Promise<void> => {
		waits.push(ms);
	};
	assert.deepEqual(await scoreChunks({ caller: store.caller, nodeId: 'store_1' }, { caller: embed.caller, nodeId: 'embed_1' }, heatKeys('o-1', 1, 2000), 'q', { wait }), [{ chunkId: 0, sim: 0.5 }]);
	assert.equal(embed.calls.length, 1, 'embedded once');
	assert.equal(store.calls, 3);
	assert.equal(waits.length, 2);
	assert.ok(waits[1]! > waits[0]!, 'each wait is longer');

	const always = { calls: 0, caller: { invoke: async <T>(): Promise<T> => (always.calls++, busy) as T } };
	await assert.rejects(scoreChunks({ caller: always.caller, nodeId: 'store_1' }, { caller: embed.caller, nodeId: 'embed_1' }, heatKeys('o-1', 1, 2000), 'q', { wait }), (error: unknown) => error instanceof ExplorerToolError && error.code === 'BUSY');
	assert.ok(always.calls >= 3 && always.calls <= 5, `gave up after ${always.calls} tries`);
});

// ── The document tab ──────────────────────────────────────────────────────────

/** Whether the markup holds the heat strip itself. */
const hasStrip = (out: string): boolean => /role="toolbar" aria-label="Similarity of each chunk to the query"/.test(out);

test('without a query the document tab says how to get one, and draws no empty strip', () => {
	const out = render();
	assert.ok(out.includes(HEAT_NO_QUERY), out);
	assert.equal(hasStrip(out), false);
	// A query of another connection is not this tab's.
	const other = render({ query: 'water', selectionKey: 'heat-2' });
	assert.ok(other.includes(HEAT_NO_QUERY));
	assert.equal(hasStrip(other), false);
});

test('with a query the document tab scores its chunks (busy until the store answers), and says so when nothing can embed it', () => {
	const out = render({ query: 'where does the water come from?' });
	assert.ok(out.includes(HEAT_SCORING), out);
	assert.doesNotMatch(out, new RegExp(HEAT_NO_QUERY.slice(0, 20)));
	assert.equal(hasStrip(out), false, 'no strip of empty cells while it waits');
	const off = render({ query: 'water', model: model({ embed: { enabled: false, reason: 'no embedding node' } }) });
	assert.ok(off.includes(HEAT_NO_EMBED), off);
	const noEmbedNode = render({ query: 'water', model: model({ nodes: { store: 'store_1', embed: null, llm: null, llmName: null } }) });
	assert.ok(noEmbedNode.includes(HEAT_NO_EMBED));
});
