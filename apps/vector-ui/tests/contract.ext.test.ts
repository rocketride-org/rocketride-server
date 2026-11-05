// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CONTRACT EXTENSIONS: the frozen shapes of contract section 4.4 and their pass-throughs
// =============================================================================
//
// What the app relies on before any additive feature is built:
//
//   - the provisional fixtures of the new answers match the contract types:
//     at compile time (each JSON file is assigned to its type with literals
//     widened, so a missing key or a wrong kind fails tsc) and at run time
//     (exactly the type's keys, and every literal from its vocabulary);
//   - the vocabularies mirror the store nodes' vx_types.py;
//   - the pass-throughs: the readers keep the new keys, fetchDocumentsPage
//     sends a filter only when given, the selection store's second question,
//     showCompareOnMap, the tool table, the map's call helpers, the frozen
//     signatures of map/dedupe.ts, and the four in-memory caches cleared on a
//     change of identity.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { IRoleChannel } from 'shared/explorer';
import { createSelectionStore } from '../src/contract/bridge';
import { CAPABILITY_KEYS, CAVEATS, DOCUMENTS_FILTER_KEYS, EXPORT_COLUMNS, VECTOR_STORE_TOOLS } from '../src/contract/types';
import type { IDialectResult, IDocumentItem, IDocumentsResult, IDuplicatePair, IRecommendResult, ISampleClusters, ISampleListing, ISampleResult, ISimilarityMatrixResult, IToolFailure, IVectorLimits } from '../src/contract/types';
import { fetchDocumentsPage } from '../src/adapters/actions';
import { showCompareOnMap } from '../src/adapters/consoleActions';
import { connectionEntry, recommendExamples, reviewedDocuments, savedFilters, savedViews } from '../src/adapters/connections';
import { TOOL, VECTOR_TOOLS, connectionCaches } from '../src/adapters/explorer';
import { callRecommend, callSimilarityMatrix } from '../src/map/calls';
import { groupOf, groups, pairsAt } from '../src/map/dedupe';
import type { IDuplicateGroup } from '../src/map/dedupe';
import { DEFAULT_LIMITS, readDialect, readDocumentsPage } from '../src/vector/results';
import dialectEnriched from './fixtures/provisional/dialect_enriched.json';
import filterClient from './fixtures/provisional/list_documents_filter_client.json';
import filterPartial from './fixtures/provisional/list_documents_filter_partial.json';
import filterServer from './fixtures/provisional/list_documents_filter_server.json';
import recommendOk from './fixtures/provisional/recommend_ok.json';
import recommendUnsupported from './fixtures/provisional/recommend_unsupported.json';
import matrixOk from './fixtures/provisional/similarity_matrix_ok.json';
import { fixture } from './support/fixtures';

const REPO = path.resolve(__dirname, '..', '..', '..');

// =============================================================================
// FIXTURES AGAINST THE TYPES
// =============================================================================

/** A type with its literal unions widened to their primitives and tuples to arrays (what a JSON import infers). */
type Widen<T> = T extends string ? string : T extends number ? number : T extends boolean ? boolean : T extends readonly (infer U)[] ? Widen<U>[] : T extends object ? { [K in keyof T]: Widen<T[K]> } : T;

// Compile-time: every required key is there with the right kind (tsc fails otherwise).
const typed: Array<[string, unknown]> = [
	['list_documents_filter_server', filterServer satisfies Widen<IDocumentsResult>],
	['list_documents_filter_partial', filterPartial satisfies Widen<IDocumentsResult>],
	['list_documents_filter_client', filterClient satisfies Widen<IDocumentsResult>],
	['recommend_ok', recommendOk satisfies Widen<IRecommendResult>],
	['recommend_unsupported', recommendUnsupported satisfies Widen<IToolFailure>],
	['similarity_matrix_ok', matrixOk satisfies Widen<ISimilarityMatrixResult>],
	['dialect_enriched', dialectEnriched satisfies Widen<IDialectResult>],
];

/** Every key of a type, so tsc keeps each list complete and exact. */
type KeyMap<T> = { readonly [K in keyof Required<T>]: true };

const DOCUMENTS_KEYS: KeyMap<IDocumentsResult> = { success: true, items: true, next_cursor: true, total: true, counts_exact: true, distinct: true, sorted: true, caveats: true, warnings: true, filter_applied: true, filter_ignored: true };
const ITEM_KEYS: KeyMap<IDocumentItem> = { objectId: true, path: true, chunks: true, has_first_chunk: true, tables: true, deleted: true, nodeId: true, size: true, modifyTime: true, ingestedAt: true, pointId: true, max_chunk_id: true, deleted_chunks: true };
const RECOMMEND_KEYS: KeyMap<IRecommendResult> = { success: true, items: true, strategy_used: true, native: true, metric: true, k_requested: true, examples_resolved: true, not_found: true };
const MATRIX_KEYS: KeyMap<ISimilarityMatrixResult> = { success: true, n: true, keys: true, metric: true, dp: true, matrix: true, source: true, not_found: true };
const CLUSTER_KEYS: KeyMap<ISampleClusters> = { method: true, edge_threshold: true, percentile: true, count: true, noise: true, labels: true, sizes: true, keywords: true, labelled: true, label_source: true, labelled_from: true, took_ms: true };
const LISTING_KEYS: KeyMap<ISampleListing> = { documents: true, truncated: true, reason: true };
const NEW_LIMITS: Array<keyof IVectorLimits> = ['recommend_examples_max', 'matrix_keys_max', 'max_components'];

/**
 * Assert an object carries only keys of its type (and, unless optional, every one).
 *
 * @param value - The object.
 * @param keys - The type's keys.
 * @param optional - Keys that may be absent.
 * @param where - For the message.
 */
function exactKeys(value: object, keys: object, optional: readonly string[], where: string): void {
	const mine = Object.keys(value);
	const theirs = Object.keys(keys);
	assert.deepEqual(
		mine.filter((k) => !theirs.includes(k)),
		[],
		`${where}: keys the type does not have`
	);
	assert.deepEqual(
		theirs.filter((k) => !optional.includes(k) && !mine.includes(k)),
		[],
		`${where}: keys the type requires`
	);
}

/** A key: [objectId, chunkId]. */
function isKey(value: unknown): boolean {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && value[0] !== '' && Number.isInteger(value[1]) && (value[1] as number) >= 0;
}

test('every new fixture is checked against its type at compile time', () => {
	assert.equal(typed.length, 7);
	for (const [name, value] of typed) assert.ok(value && typeof value === 'object', name);
});

test('documents with a filter: exactly the documents keys, filter_applied from the vocabulary, the health fields on the items', () => {
	const cases: Array<[string, IDocumentsResult, string]> = [
		['list_documents_filter_server', fixture('list_documents_filter_server'), 'server'],
		['list_documents_filter_partial', fixture('list_documents_filter_partial'), 'partial'],
		['list_documents_filter_client', fixture('list_documents_filter_client'), 'none'],
	];
	for (const [name, page, applied] of cases) {
		exactKeys(page, DOCUMENTS_KEYS, ['warnings'], name);
		assert.equal(page.filter_applied, applied, name);
		assert.ok(Array.isArray(page.filter_ignored), name);
		for (const item of page.items) exactKeys(item, ITEM_KEYS, [], `${name} item`);
		for (const key of page.filter_ignored ?? []) assert.ok((DOCUMENTS_FILTER_KEYS as readonly string[]).includes(key), `${name}: ${key} is a filter key`);
		for (const caveat of page.caveats) assert.ok((CAVEATS as readonly string[]).includes(caveat), `${name}: ${caveat}`);
	}
	assert.deepEqual(fixture<IDocumentsResult>('list_documents_filter_server').filter_ignored, []);
	assert.ok(fixture<IDocumentsResult>('list_documents_filter_partial').caveats.includes('documents_filter_partial'));
	assert.ok(fixture<IDocumentsResult>('list_documents_filter_client').caveats.includes('documents_filter_client'));
	// Stores that do not compute the health fields answer null for both.
	for (const item of fixture<IDocumentsResult>('list_documents_filter_client').items) assert.deepEqual([item.max_chunk_id, item.deleted_chunks], [null, null]);
	assert.equal(fixture<IDocumentsResult>('list_documents_filter_partial').items[0]?.deleted_chunks, 1);
});

test('recommend: exactly its keys, neighbour rows, a strategy from the vocabulary; the refusal is a failure envelope', () => {
	const answer = fixture<IRecommendResult>('recommend_ok');
	exactKeys(answer, RECOMMEND_KEYS, [], 'recommend_ok');
	assert.ok(['average_vector', 'best_score'].includes(answer.strategy_used));
	assert.ok(['cosine', 'l2', 'ip'].includes(answer.metric));
	assert.ok(answer.items.length <= answer.k_requested);
	for (const item of answer.items) {
		assert.ok(isKey(item.key));
		assert.deepEqual(Object.keys(item).sort(), ['below_floor', 'chunkId', 'key', 'path', 'preview', 'score', 'sim']);
		assert.equal(item.chunkId, item.key[1]);
	}
	const sims = answer.items.map((item) => item.sim);
	assert.deepEqual(
		sims,
		[...sims].sort((a, b) => b - a),
		'most similar first'
	);
	assert.deepEqual(Object.keys(answer.examples_resolved).sort(), ['negative', 'positive']);
	const refused = fixture<IToolFailure>('recommend_unsupported');
	assert.equal(refused.success, false);
	assert.equal(refused.code, 'UNSUPPORTED');
});

test('similarity_matrix: exactly its keys, n keys, a symmetric n x n matrix with a unit diagonal at dp places, a source from the vocabulary', () => {
	const answer = fixture<ISimilarityMatrixResult>('similarity_matrix_ok');
	exactKeys(answer, MATRIX_KEYS, [], 'similarity_matrix_ok');
	assert.equal(answer.keys.length, answer.n);
	assert.ok(answer.keys.every(isKey));
	assert.ok(['cache', 'store', 'mixed'].includes(answer.source));
	assert.equal(answer.matrix.length, answer.n);
	for (let i = 0; i < answer.n; i += 1) {
		assert.equal(answer.matrix[i]?.length, answer.n);
		assert.equal(answer.matrix[i]?.[i], 1);
		for (let j = 0; j < answer.n; j += 1) {
			const v = answer.matrix[i]?.[j] as number;
			assert.equal(v, answer.matrix[j]?.[i]);
			assert.equal(Math.round(v * 10 ** answer.dp) / 10 ** answer.dp, v);
		}
	}
});

test('the enriched dialect: the pgvector probe plus the new capability keys, limits, size_bytes and keyword_match', () => {
	const enriched = fixture<IDialectResult>('dialect_enriched');
	const plain = fixture<IDialectResult>('dialect_pgvector');
	assert.deepEqual(
		Object.keys(enriched).filter((k) => !(k in plain)),
		['size_bytes', 'keyword_match']
	);
	assert.ok(['substring', 'token'].includes(enriched.keyword_match as string));
	for (const key of CAPABILITY_KEYS.filter((k) => k !== 'embed_node')) assert.equal(typeof enriched.capabilities[key], 'boolean', key);
	for (const key of ['clusters', 'documents_filter', 'recommend_best_score'] as const) assert.equal(plain.capabilities[key], false, `today's node reports ${key} off`);
	for (const key of NEW_LIMITS) assert.equal(enriched.limits[key], DEFAULT_LIMITS[key], key);
});

test('sample with clusters: the additive keys on top of sample_demo_1000, and clusters as the contract defines them', () => {
	const plain = fixture<ISampleResult>('sample_demo_1000');
	const sample = fixture<ISampleResult>('sample_demo_1000_clusters');
	const { clusters, listing, took_ms: _tookMs, ...rest } = sample;
	const { took_ms: _plainTookMs, ...plainRest } = plain;
	const { table, ...points } = rest.points;
	assert.deepEqual({ ...rest, points }, plainRest, 'the same answer otherwise: every key is additive');
	assert.ok(clusters && listing && table);
	exactKeys(clusters, CLUSTER_KEYS, [], 'clusters');
	exactKeys(listing, LISTING_KEYS, [], 'listing');
	assert.deepEqual(listing, { documents: plain.docs.length, truncated: false, reason: 'complete' });
	assert.equal(table.length, sample.n);
	assert.ok(table.every((v) => v === 0 || v === 1) && table.includes(1));
	assert.equal(clusters.method, 'knn-components');
	assert.ok([60, 70, 80, 90, 100].includes(clusters.percentile));
	assert.ok(clusters.edge_threshold > -1 && clusters.edge_threshold <= 1);
	assert.equal(clusters.labels.length, sample.n);
	assert.ok(clusters.labels.every((l) => Number.isInteger(l) && l >= -1 && l < clusters.count));
	assert.equal(clusters.sizes.length, clusters.count);
	assert.ok(clusters.count >= 3 && clusters.count <= DEFAULT_LIMITS.max_components!);
	assert.deepEqual(
		clusters.sizes,
		[...clusters.sizes].sort((a, b) => b - a),
		'numbered by size'
	);
	assert.ok(
		clusters.sizes.every((s) => s >= 2),
		'singletons are noise'
	);
	assert.equal(clusters.sizes.reduce((a, b) => a + b, 0) + clusters.noise, sample.n);
	for (let id = 0; id < clusters.count; id += 1) assert.equal(clusters.labels.filter((l) => l === id).length, clusters.sizes[id]);
	assert.equal(clusters.keywords.length, clusters.count);
	assert.ok(clusters.labelled <= 50 && clusters.labelled_from <= 50);
	clusters.keywords.forEach((words, id) => {
		assert.ok(words.length <= 5);
		assert.ok(words.every((w) => w.length >= 3 && w === w.toLowerCase()));
		if (id < clusters.labelled) assert.ok(words.length > 0 && (clusters.sizes[id] as number) >= 5, `group ${id} is labelled`);
		else assert.deepEqual(words, []);
	});
	assert.equal(clusters.label_source, 'text');
	// The labels add a few KB to the answer (the contract's budget is 12 KB at 2,000 points).
	const growth = JSON.stringify(sample).length - JSON.stringify(plain).length;
	assert.ok(growth > 0 && growth <= 12 * 1024, `${growth} bytes`);
});

test('a truncated listing: listing.truncated with its reason and the caveat, and every sampled document within the listed ones', () => {
	const sample = fixture<ISampleResult>('sample_listing_truncated');
	assert.ok(sample.listing);
	exactKeys(sample.listing, LISTING_KEYS, [], 'listing');
	assert.deepEqual(sample.listing, { documents: 500, truncated: true, reason: 'cap' });
	assert.ok(sample.caveats?.includes('listing_truncated'));
	assert.ok(sample.docs.length <= sample.listing.documents);
	assert.ok((sample.of.documents ?? 0) > sample.listing.documents, 'the collection has more than the sampler listed');
	assert.equal(sample.clusters, undefined, 'no clusters unless asked');
});

// =============================================================================
// VOCABULARIES MIRROR THE STORE NODES
// =============================================================================

/**
 * A tuple of strings defined in vx_types.py.
 *
 * @param name - The constant.
 * @returns Its strings, in order.
 */
function pythonTuple(name: string): string[] {
	const text = fs.readFileSync(path.join(REPO, 'packages', 'ai', 'src', 'ai', 'common', 'store', 'vx_types.py'), 'utf8');
	const m = new RegExp(`^${name}: Tuple\\[str, \\.\\.\\.\\] = \\(([\\s\\S]*?)^\\)`, 'm').exec(text);
	assert.ok(m, `${name} is defined in vx_types.py`);
	return [...(m[1] as string).matchAll(/^\s*'([^']+)',/gm)].map((x) => x[1] as string);
}

test("capability keys, caveats and the documents filter keys are the store nodes' own, in their order", () => {
	assert.deepEqual([...CAPABILITY_KEYS], pythonTuple('CAPABILITY_KEYS'));
	assert.deepEqual([...CAVEATS], pythonTuple('CAVEATS'));
	assert.deepEqual([...DOCUMENTS_FILTER_KEYS], pythonTuple('DOC_LIST_FILTER_KEYS'));
	for (const tool of ['recommend', 'similarity_matrix']) assert.ok((VECTOR_STORE_TOOLS as readonly string[]).includes(tool), tool);
});

test('the export column sets are words, never a vector', () => {
	for (const columns of Object.values(EXPORT_COLUMNS)) {
		assert.equal(new Set(columns).size, columns.length);
		assert.ok(!columns.some((c) => /vector|embedding|token/i.test(c)));
	}
});

// =============================================================================
// PASS-THROUGHS
// =============================================================================

test('the readers keep the additive keys only when a node sends them', () => {
	const server = readDocumentsPage(fixture('list_documents_filter_server'));
	assert.equal(server.filterApplied, 'server');
	assert.deepEqual(server.filterIgnored, []);
	assert.equal(server.items[0]?.max_chunk_id, 5);
	assert.equal(server.items[0]?.deleted_chunks, 0);
	const partial = readDocumentsPage(fixture('list_documents_filter_partial'));
	assert.equal(partial.filterApplied, 'partial');
	assert.deepEqual(partial.filterIgnored, ['ingested_after']);
	const old = readDocumentsPage(fixture('list_documents_page1'));
	assert.equal('filterApplied' in old, false, 'an answer without a filter says nothing about one');
	assert.equal('max_chunk_id' in (old.items[0] as object), false);
	const enriched = readDialect(fixture('dialect_enriched'));
	assert.equal(enriched?.size_bytes, 48234496);
	assert.equal(enriched?.keyword_match, 'substring');
	assert.equal(enriched?.capabilities.clusters, true);
	for (const key of NEW_LIMITS) assert.equal(enriched?.limits[key], DEFAULT_LIMITS[key]);
	const plain = readDialect(fixture('dialect_pgvector'));
	assert.equal(plain && 'size_bytes' in plain, false);
	assert.equal(plain && 'keyword_match' in plain, false);
	assert.equal(readDialect({ success: true, dialect: 'vector', keyword_match: 'regex' })?.keyword_match, null, 'an unknown semantics is no semantics');
});

test('fetchDocumentsPage sends a filter only when one is given', async () => {
	const sent: Array<Record<string, unknown>> = [];
	const caller = { invoke: async (_tool: string, input: Record<string, unknown> = {}) => (sent.push(input), fixture('list_documents_filter_server')) };
	await fetchDocumentsPage(caller, 'store_1', { cursor: null, limit: 200 });
	await fetchDocumentsPage(caller, 'store_1', { cursor: null, limit: 200 }, {}, null);
	const page = await fetchDocumentsPage(caller, 'store_1', { cursor: 'c', limit: 50 }, {}, { path_prefix: 'C:/demo/greenhouse/', file_types: ['pdf', 'txt'] });
	assert.deepEqual(sent[0], { cursor: null, limit: 200, deleted: 'active', sort: 'path' });
	assert.deepEqual(sent[1], { cursor: null, limit: 200, deleted: 'active', sort: 'path' });
	assert.deepEqual(sent[2], { cursor: 'c', limit: 50, deleted: 'active', sort: 'path', filter: { path_prefix: 'C:/demo/greenhouse/', file_types: ['pdf', 'txt'] } });
	assert.equal(page.filterApplied, 'server');
});

test('the selection store keeps a second question beside the first, and a reset forgets it', () => {
	const store = createSelectionStore('conn-1');
	assert.equal(store.getState().queryB, null);
	let changes = 0;
	store.subscribe(() => (changes += 1));
	store.setQuery('falcon water');
	store.setQueryB('greenhouse orchids');
	assert.deepEqual([store.getState().query, store.getState().queryB], ['falcon water', 'greenhouse orchids']);
	store.clearQueryB();
	assert.equal(store.getState().queryB, null);
	store.clearQueryB();
	assert.equal(changes, 3, 'clearing an empty slot changes nothing');
	store.setQueryB('again');
	store.reset('conn-2');
	assert.equal(store.getState().queryB, null);
});

test('showCompareOnMap tells the map both questions before it highlights both result lists, each key once, A first', () => {
	const store = createSelectionStore('conn-1');
	const seen: Array<{ query: string | null; queryB: string | null }> = [];
	const highlighted: Array<{ keys: readonly (readonly [string, number])[]; source: string }> = [];
	const actions = {
		showOnMap: (keys: readonly (readonly [string, number])[], source: string) => {
			seen.push({ query: store.getState().query, queryB: store.getState().queryB });
			highlighted.push({ keys, source });
		},
	};
	showCompareOnMap(
		store,
		actions,
		'A?',
		'B?',
		[
			['a', 0],
			['b', 1],
		],
		[
			['b', 1],
			['c', 2],
		]
	);
	assert.deepEqual(seen, [{ query: 'A?', queryB: 'B?' }]);
	assert.deepEqual(highlighted, [
		{
			keys: [
				['a', 0],
				['b', 1],
				['c', 2],
			],
			source: 'search',
		},
	]);
});

test('the tool table: recommend and similarity_matrix are capability-gated reads', () => {
	assert.equal(TOOL.recommend, 'recommend');
	assert.equal(TOOL.similarityMatrix, 'similarity_matrix');
	assert.equal(VECTOR_TOOLS.recommend?.idempotent, true);
	assert.equal(VECTOR_TOOLS.recommend?.capability, 'neighbors');
	assert.equal(VECTOR_TOOLS.similarity_matrix?.idempotent, true);
	assert.equal(VECTOR_TOOLS.similarity_matrix?.capability, 'sample');
});

test("the map's call helpers name their tool and node and forward the input untouched", async () => {
	const calls: Array<{ tool: string; input: Record<string, unknown>; nodeId: string | undefined }> = [];
	const channel = {
		invoke: async (tool: string, input: Record<string, unknown> = {}, opts: { nodeId?: string } = {}) => {
			calls.push({ tool, input, nodeId: opts.nodeId });
			return tool === 'recommend' ? fixture('recommend_ok') : fixture('recommend_unsupported');
		},
	} as unknown as Pick<IRoleChannel, 'invoke'>;
	const ok = await callRecommend(channel, { positive: [['a', 0]], negative: [['b', 3]], k: 6, strategy: 'average_vector' }, { nodeId: 'store_1' });
	assert.ok(ok.ok && ok.value.items.length === 6);
	const refused = await callSimilarityMatrix(
		channel,
		{
			keys: [
				['a', 0],
				['b', 3],
			],
		},
		{ nodeId: 'store_1' }
	);
	assert.ok(!refused.ok && refused.code === 'UNSUPPORTED');
	assert.deepEqual(calls, [
		{ tool: 'recommend', input: { positive: [['a', 0]], negative: [['b', 3]], k: 6, strategy: 'average_vector' }, nodeId: 'store_1' },
		{
			tool: 'similarity_matrix',
			input: {
				keys: [
					['a', 0],
					['b', 3],
				],
			},
			nodeId: 'store_1',
		},
	]);
});

test('map/dedupe.ts keeps its frozen signatures; groupOf numbers every point by its group', () => {
	const signatures: [(sample: ISampleResult, threshold: number) => IDuplicatePair[], (pairs: readonly IDuplicatePair[]) => IDuplicateGroup[]] = [pairsAt, groups];
	assert.equal(signatures.length, 2);
	assert.deepEqual(
		[
			...groupOf(
				[
					{ id: 0, points: [1, 3], simMin: 0.98, simMax: 0.99 },
					{ id: 1, points: [4], simMin: 1, simMax: 1 },
				],
				5
			),
		],
		[-1, 0, -1, 0, 1]
	);
	assert.deepEqual([...groupOf([], 3)], [-1, -1, -1]);
});

test('the four in-memory caches are registered and emptied on a change of identity; a connection starts with no scope', () => {
	for (const name of ['saved filters', 'saved views', 'reviewed documents', 'recommend examples']) assert.ok(connectionCaches.names().includes(name), name);
	savedFilters.set('k', [{ id: 'f1', name: 'handbooks', filter: { path_prefix: 'C:/demo/handbooks/' }, savedAt: 1 }]);
	savedViews.set('k', []);
	reviewedDocuments.set('k', new Set(['o1']));
	recommendExamples.set('k', { positive: [['o1', 0]], negative: [], withQuery: false });
	const entry = connectionEntry({ key: 'k-scope', nodeId: 'store_1' } as never, null, DEFAULT_LIMITS);
	assert.equal(entry.scope.get(), null);
	assert.equal(entry.documents.getRows(), entry.controller.getState().directory.rows);
	connectionCaches.clearAll();
	assert.deepEqual([savedFilters.size, savedViews.size, reviewedDocuments.size, recommendExamples.size], [0, 0, 0, 0]);
});
