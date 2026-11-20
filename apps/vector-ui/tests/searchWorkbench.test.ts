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
// searchWorkbench — Search without the LLM: modes, the threshold slider,
// hybrid fusion, the calls a run makes and what it keeps
// =============================================================================
//
// The workbench behind the chat panel's Search toggle. A run embeds the
// question on the pipeline's embedding node and searches the store with that
// exact vector (Semantic, Auto), searches by keyword (Keyword), or both and
// fuses the two lists here (Hybrid, reciprocal rank fusion). The threshold
// slider re-classifies the rows the run already has, so the count it names is
// the count of the table's "passes" rows at every position, and the line
// compares it with the store node's own setting.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ConsoleModel, IChatSource, IDialectResult, IScopeState, IScoreInfo, ISearchResult, IVectorCapabilities, IVectorLimits, VectorKey } from '../src/contract/types';
import { EXPORT_COLUMNS } from '../src/contract/types';
import type { CallOutcome } from '../src/chat/toolCalls';
import { classifyRetrieval, debuggerSearchInput, withScope } from '../src/vector/retrieval';
import { QUERY_NEEDS_EMBED } from '../src/map/wording';
import { HYBRID_LABEL, HYBRID_NEEDS_KEYWORD, KEYWORD_UNSUPPORTED, NODE_SETTING_NOTE, RRF_K, SEARCH_MODES, STATUS_WORDS, TOP_K_OPTIONS, VECTOR_UNSUPPORTED, classifyAt, defaultMode, fromChatLine, fuse, initialThreshold, keywordCaption, keywordSearchInput, modeOptions, nodeSettingText, openInSearchPrefill, plan, prefillRun, previewOf, rateLimitSentence, retrievalExportRows, retryAfterSeconds, rowsFromSearch, runWorkbench, scoreTitle, searchExportItems, searchScope, secondsLeft, semanticSearchInput, showSearchOnMap, sliderRange, sliderValueText, thresholdSentence, topKChoices, topKOptions, workbenchExportRows } from '../src/vector/searchWorkbench';
import type { ChatPrefill, RunFromChat, SearchMode, WorkbenchDeps, WorkbenchRow, WorkbenchRun } from '../src/vector/searchWorkbench';

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * Read a provisional fixture.
 *
 * @param name - File name.
 * @returns The parsed JSON (a fresh copy each call).
 */
function fixture<T>(name: string): T {
	return JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'provisional', name), 'utf8')) as T;
}

const dialect = fixture<IDialectResult>('dialect_pgvector.json');
const enriched = fixture<IDialectResult>('dialect_enriched.json');
const embedOk = fixture<{ model: string; dimension: number; vectors: number[][] }>('embed_ok.json');
const searchVector = fixture<ISearchResult>('search_vector.json');
const searchBelowFloor = fixture<ISearchResult>('search_below_floor.json');
const keywordFallback = fixture<ISearchResult>('search_keyword_fallback_warning.json');
const mismatch = fixture<ISearchResult>('search_model_mismatch_warning.json');
const rateLimited = fixture<Record<string, unknown>>('embed_rate_limited.json');
const limits: IVectorLimits = dialect.limits;

/** Pinecone's shape: semantic search only (store_pinecone has no keyword search). */
const pineconeCapabilities: IVectorCapabilities = { ...dialect.capabilities, search_keyword: false };

/**
 * The fields of a console model the workbench reads.
 *
 * @param extra - Fields to replace.
 * @returns The model.
 */
function model(extra: Partial<ConsoleModel> = {}): Pick<ConsoleModel, 'capabilities' | 'embed' | 'nodes'> {
	return {
		capabilities: dialect.capabilities,
		embed: { enabled: true, reason: null },
		nodes: { store: 'store_1', embed: 'embed_1', llm: null, llmName: null },
		...extra,
	};
}

/**
 * A search answer of `scores` (descending), flagged against the dialect's floor 0.2.
 *
 * @param scores - The scores.
 * @returns The answer.
 */
function scored(scores: readonly number[]): ISearchResult {
	return {
		success: true,
		total: scores.length,
		mode_used: 'semantic',
		results: scores.map((score, i) => ({ content: `chunk ${i}`, score, metadata: { objectId: `doc${i % 7}`, chunkId: i, parent: `C:/demo/doc${i % 7}.md` }, rank: i + 1, raw_score: score, sim: score, below_threshold: score < 0.3, below_floor: score < 0.2 })),
	};
}

/** Twenty rows: 7 at or above 0.42, 11 at or above the node's 0.30, 3 under the floor 0.20. */
const TWENTY = [0.62, 0.58, 0.55, 0.51, 0.48, 0.45, 0.43, 0.4, 0.38, 0.36, 0.33, 0.295, 0.29, 0.27, 0.25, 0.22, 0.21, 0.19, 0.15, 0.12];

/** A recorded call. */
interface Call {
	tool: string;
	input: Record<string, unknown>;
	nodeId: string;
}

/**
 * Fake calls: each tool answers from a queue, every call is recorded.
 *
 * @param answers - Answers per tool, in call order.
 * @returns The deps and the record.
 */
function fakeCalls(answers: Record<string, Array<Record<string, unknown>>>): { deps: WorkbenchDeps; calls: Call[]; phases: string[] } {
	const calls: Call[] = [];
	const phases: string[] = [];
	const deps: WorkbenchDeps = {
		call: async (tool, input, nodeId): Promise<CallOutcome> => {
			calls.push({ tool, input, nodeId });
			const value = answers[tool]?.shift();
			if (value === undefined) return { ok: false, code: null, message: `no answer for ${tool}`, kind: null, error: null };
			if (value.success === false) return { ok: false, code: typeof value.code === 'string' ? value.code : null, message: String(value.error), kind: null, error: value };
			return { ok: true, value };
		},
		onPhase: (phase) => phases.push(phase),
	};
	return { deps, calls, phases };
}

/**
 * Every array of `dim` numbers with a non-integer inside a value (the lane's privacy check, in small).
 *
 * @param value - Anything.
 * @param dim - The dimension.
 * @returns How many there are.
 */
function vectorsIn(value: unknown, dim: number): number {
	if (Array.isArray(value)) {
		if (value.length === dim && value.every((v) => typeof v === 'number') && value.some((v) => !Number.isInteger(v))) return 1;
		return value.reduce((sum: number, v) => sum + vectorsIn(v, dim), 0);
	}
	if (value !== null && typeof value === 'object') return Object.values(value).reduce((sum: number, v) => sum + vectorsIn(v, dim), 0);
	return 0;
}

// ── Modes ───────────────────────────────────────────────────────────────────

test('modes: Semantic, Keyword, Hybrid and Auto, all offered on a store that searches by meaning and by keyword', () => {
	assert.deepEqual([...SEARCH_MODES], ['semantic', 'keyword', 'hybrid', 'auto']);
	const options = modeOptions(model());
	assert.deepEqual(
		options.map((o) => [o.mode, o.label, o.enabled, o.reason]),
		[
			['semantic', 'Semantic', true, null],
			['keyword', 'Keyword', true, null],
			['hybrid', 'Hybrid', true, null],
			['auto', 'Auto', true, null],
		]
	);
	assert.equal(defaultMode(options), 'semantic');
});

test('modes: a store without keyword search (Pinecone) disables Keyword and Hybrid with their sentences', () => {
	const options = modeOptions(model({ capabilities: pineconeCapabilities }));
	assert.equal(KEYWORD_UNSUPPORTED, 'This store cannot search by keyword');
	assert.deepEqual(
		options.find((o) => o.mode === 'keyword'),
		{ mode: 'keyword', label: 'Keyword', enabled: false, reason: KEYWORD_UNSUPPORTED }
	);
	assert.deepEqual(
		options.find((o) => o.mode === 'hybrid'),
		{ mode: 'hybrid', label: 'Hybrid', enabled: false, reason: HYBRID_NEEDS_KEYWORD }
	);
	assert.equal(options.find((o) => o.mode === 'semantic')?.enabled, true);
	assert.equal(options.find((o) => o.mode === 'auto')?.enabled, true);
});

test('modes: without the embedding node Semantic, Hybrid and Auto say why; Keyword stays and becomes the default', () => {
	for (const embed of [
		{ enabled: false, reason: null },
		{ enabled: true, reason: null },
	]) {
		const options = modeOptions(model({ embed, nodes: { store: 'store_1', embed: embed.enabled ? null : 'embed_1', llm: null, llmName: null } }));
		for (const mode of ['semantic', 'hybrid', 'auto'] as const)
			assert.deepEqual(
				options.find((o) => o.mode === mode),
				{ mode, label: mode[0].toUpperCase() + mode.slice(1), enabled: false, reason: QUERY_NEEDS_EMBED }
			);
		assert.equal(options.find((o) => o.mode === 'keyword')?.enabled, true);
		assert.equal(defaultMode(options), 'keyword');
	}
	// The console's own sentence wins when it has one.
	const own = modeOptions(model({ embed: { enabled: false, reason: 'No Tools source reaches embed_1' } }));
	assert.equal(own.find((o) => o.mode === 'semantic')?.reason, 'No Tools source reaches embed_1');
});

test('modes: a node that reports neither search (an old node) offers nothing, and says so', () => {
	const options = modeOptions(model({ capabilities: {} }));
	assert.equal(options.find((o) => o.mode === 'semantic')?.reason, VECTOR_UNSUPPORTED);
	assert.equal(options.find((o) => o.mode === 'keyword')?.reason, KEYWORD_UNSUPPORTED);
	assert.ok(options.every((o) => !o.enabled));
	assert.equal(defaultMode(options), null);
});

test('plan: the calls each mode makes', () => {
	assert.deepEqual(plan('semantic'), { embed: true, searches: ['vector'], fused: false, calls: 2 });
	assert.deepEqual(plan('keyword'), { embed: false, searches: ['keyword'], fused: false, calls: 1 });
	assert.deepEqual(plan('hybrid'), { embed: true, searches: ['vector', 'keyword'], fused: true, calls: 3 });
	assert.deepEqual(plan('auto'), { embed: true, searches: ['auto'], fused: false, calls: 2 });
});

test('keywordCaption: what a keyword search matches on this store (dialect.keyword_match)', () => {
	assert.equal(keywordCaption('substring'), 'Keyword search matches text fragments on this store');
	assert.equal(keywordCaption('token'), 'Keyword search matches whole words on this store');
	assert.equal(keywordCaption(null), 'This store does not say whether keyword search matches whole words or text fragments');
	assert.equal(keywordCaption(undefined), keywordCaption(null));
	assert.equal(keywordCaption(enriched.keyword_match), 'Keyword search matches text fragments on this store');
});

test('topKOptions: 5, 10, 25 and 50, never above the node limit', () => {
	assert.deepEqual([...TOP_K_OPTIONS], [5, 10, 25, 50]);
	assert.deepEqual(topKOptions(limits), [5, 10, 25, 50]);
	assert.deepEqual(topKOptions({ ...limits, top_k_max: 30 }), [5, 10, 25]);
	assert.deepEqual(topKOptions({ ...limits, top_k_max: 3 }), [3]);
});

// ── Inputs ──────────────────────────────────────────────────────────────────

test('semanticSearchInput: the exact vector embed returned, every row below the threshold and floor, the scope', () => {
	const vector = embedOk.vectors[0];
	const input = semanticSearchInput(vector, embedOk.model, 'where is the water?', 10, limits, 'semantic', ['o1', 'o2']);
	assert.equal(input.vector, vector, 'the vector embed returned, not a copy');
	assert.deepEqual({ ...input, vector: null }, { vector: null, top_k: 10, mode: 'semantic', include_below_floor: true, include_below_threshold: true, embedding_model: embedOk.model, filter: { objectIds: ['o1', 'o2'] } });
	assert.equal(Object.values(input).filter((value) => Array.isArray(value)).length, 1, 'one vector-shaped value');
	// Auto: the same search, with the question so the store can fall back to keyword search.
	const auto = semanticSearchInput(vector, null, 'where is the water?', 500, limits, 'auto', null);
	assert.deepEqual({ ...auto, vector: null }, { vector: null, query: 'where is the water?', top_k: 100, mode: 'auto', include_below_floor: true, include_below_threshold: true });
});

test('keywordSearchInput: the question, keyword mode, no vector; rows under the node threshold kept (keyword scores are no similarity)', () => {
	assert.deepEqual(keywordSearchInput('  KX4471 ', 25, limits, null), { query: 'KX4471', mode: 'keyword', top_k: 25, include_below_threshold: true });
	assert.deepEqual(keywordSearchInput('KX4471', 0, limits, ['o9']), { query: 'KX4471', mode: 'keyword', top_k: 1, include_below_threshold: true, filter: { objectIds: ['o9'] } });
});

// ── Scope ───────────────────────────────────────────────────────────────────

/**
 * A scope over `ids` (or one that overflowed).
 *
 * @param extra - Fields to replace.
 * @returns The scope.
 */
function scope(extra: Partial<IScopeState> = {}): IScopeState {
	return { filter: { path_prefix: 'C:/demo/handbooks/' }, label: 'folder is under C:/demo/handbooks/', objectIds: ['h1', 'h2', 'h3'], overflow: null, applyTo: { documents: true, map: true, search: true, chat: true }, ...extra };
}

test('searchScope: the scope is sent as objectIds; above the cap, unresolved or empty, Run is off with a sentence', () => {
	assert.deepEqual(searchScope(null, limits), { objectIds: null, blocked: null, line: null });
	assert.deepEqual(searchScope(scope({ applyTo: { documents: true, map: true, search: false, chat: true } }), limits), { objectIds: null, blocked: null, line: null });
	assert.deepEqual(searchScope(scope(), limits), { objectIds: ['h1', 'h2', 'h3'], blocked: null, line: 'Searching 3 documents in scope: folder is under C:/demo/handbooks/' });
	assert.deepEqual(searchScope(scope({ objectIds: null, overflow: 2340 }), limits), { objectIds: null, blocked: 'Scope too large for the map, search and chat (2,340 documents; at most 2,000). Narrow the folder.', line: null });
	assert.equal(searchScope(scope({ objectIds: Array.from({ length: 2001 }, (_, i) => `d${i}`) }), limits).blocked, 'Scope too large for the map, search and chat (2,001 documents; at most 2,000). Narrow the folder.', 'never more than scope_keys_max ids leave the browser');
	assert.equal(searchScope(scope({ objectIds: null }), limits).blocked, 'Finding the documents in scope…');
	assert.equal(searchScope(scope({ objectIds: [] }), limits).blocked, 'No documents match the scope.', 'an empty objectIds filter would search everything');
	assert.equal(searchScope(scope({ objectIds: ['h1'] }), limits).line, 'Searching 1 document in scope: folder is under C:/demo/handbooks/');
});

// ── Rows, classification and the slider ─────────────────────────────────────

test('rowsFromSearch: path #chunk, a 120-character preview, the cited mark; keyword rows carry no similarity', () => {
	const long: ISearchResult = { ...searchVector, results: [{ ...searchVector.results[0], content: 'x'.repeat(300) }, ...searchVector.results.slice(1)] };
	const cited: VectorKey[] = [['ef35cb9c-f98f-e472-d795-298a40a5cb2b', 67]];
	const rows = rowsFromSearch(long, true, cited);
	assert.equal(rows.length, 8);
	assert.equal(rows[0].preview, `${'x'.repeat(119)}…`);
	assert.equal(rows[0].preview.length, 120, 'never longer than snippet_chars, the ellipsis included');
	assert.equal(rowsFromSearch(long, true, [], 40)[0].preview.length, 40);
	assert.deepEqual(rows[1].key, ['ef35cb9c-f98f-e472-d795-298a40a5cb2b', 67]);
	assert.equal(rows[1].path, 'C:/demo/ops/ops_005.pdf');
	assert.equal(rows[1].cited, true);
	assert.equal(rows[0].cited, false);
	assert.equal(rows[0].score, 0.5433);
	assert.equal(rows[0].semanticRank, 1);
	assert.equal(rows[0].keywordRank, null);
	const keyword = rowsFromSearch(keywordFallback, false, []);
	assert.ok(keyword.every((row) => row.score === null && row.keywordRank !== null && row.semanticRank === null));
	assert.equal(keyword[0].keywordScore, 0);
});

test('classifyAt: passes, near misses, below the floor, keyword rows; the floor flags win', () => {
	const rows = rowsFromSearch(scored(TWENTY), true, []);
	const at42 = classifyAt(rows, 0.42, dialect.score);
	assert.deepEqual(at42.counts, { passing: 7, nearMisses: 10, belowFloor: 3, keywordOnly: 0, rated: 20 });
	assert.deepEqual(
		at42.rows.slice(5, 9).map((row) => row.status),
		['used', 'used', 'near_miss', 'near_miss']
	);
	assert.deepEqual(
		at42.rows.slice(-3).map((row) => row.status),
		['below_floor', 'below_floor', 'below_floor']
	);
	// A slider under the floor does not bring back rows the store drops.
	assert.equal(classifyAt(rows, 0.1, dialect.score).counts.passing, 17);
	// Keyword rows have no similarity: never counted against the slider.
	const keyword = classifyAt(rowsFromSearch(keywordFallback, false, []), 0.42, dialect.score);
	assert.deepEqual(keyword.counts, { passing: 0, nearMisses: 0, belowFloor: 0, keywordOnly: 3, rated: 0 });
	assert.ok(keyword.rows.every((row) => row.status === 'keyword'));
	assert.equal(STATUS_WORDS.keyword, 'keyword match (no similarity)');
});

test('classifyAt: a lower-is-better score inverts the comparison', () => {
	const score: IScoreInfo = { formula: 'l2 distance', higher_is_better: false, floor: 2, threshold: 1 };
	const result: ISearchResult = { results: [0.5, 1.5, 3].map((value, i) => ({ content: String(i), score: value, metadata: { objectId: `o${i}`, chunkId: 0 } })), total: 3 };
	assert.deepEqual(
		classifyAt(rowsFromSearch(result, true, []), 1, score).rows.map((row) => row.status),
		['used', 'near_miss', 'below_floor']
	);
});

test("the slider's passing count is the table's 'passes' count at every position, and it never rises as the slider rises", () => {
	const rows = rowsFromSearch(scored(TWENTY), true, []);
	const range = sliderRange(dialect.score);
	let previous = Infinity;
	for (let at = range.min; at <= range.max + 1e-9; at += range.step) {
		const view = classifyAt(rows, Math.round(at * 100) / 100, dialect.score);
		const shown = Number(/: (\d+) of/.exec(thresholdSentence(rows, view.at, dialect.score))?.[1]);
		assert.equal(shown, view.rows.filter((row) => row.status === 'used').length, `at ${view.at}`);
		assert.equal(shown, view.counts.passing);
		assert.ok(view.counts.passing <= previous);
		previous = view.counts.passing;
	}
	assert.ok(classifyAt(rows, 0.6, dialect.score).counts.passing < classifyAt(rows, 0.3, dialect.score).counts.passing, 'the slider at 0.6 passes fewer rows than at 0.3');
});

test("thresholdSentence: the count at the slider beside today's node setting", () => {
	const rows = rowsFromSearch(scored(TWENTY), true, []);
	assert.equal(thresholdSentence(rows, 0.42, dialect.score), "At 0.42: 7 of 20 would pass (today's node setting 0.30 passes 11)");
	assert.equal(thresholdSentence(rows, 0.3, dialect.score), "At 0.30: 11 of 20 pass (today's node setting)");
	assert.equal(thresholdSentence(rows, 0.42, { ...dialect.score, threshold: null }), 'At 0.42: 7 of 20 would pass (the store node has no threshold set)');
	assert.equal(thresholdSentence(rowsFromSearch(keywordFallback, false, []), 0.42, dialect.score), 'Keyword results carry no similarity, so the threshold does not apply.');
	assert.equal(thresholdSentence([], 0.42, dialect.score), 'Nothing to weigh against the threshold.');
	assert.equal(sliderValueText(classifyAt(rows, 0.42, dialect.score)), '0.42: 7 of 20 pass');
});

test('sliderRange and initialThreshold: over dialect.score.range, starting at the node setting', () => {
	assert.deepEqual(sliderRange(dialect.score), { min: -1, max: 1, step: 0.01 });
	assert.deepEqual(sliderRange({ ...dialect.score, range: [0, 1] }), { min: 0, max: 1, step: 0.01 });
	assert.deepEqual(sliderRange(null), { min: 0, max: 1, step: 0.01 });
	assert.equal(initialThreshold(dialect.score), 0.3);
	assert.equal(initialThreshold({ ...dialect.score, threshold: null }), 0.2, 'the floor when the node has no threshold');
	assert.equal(initialThreshold(null), 0);
	assert.equal(initialThreshold({ ...dialect.score, threshold: 5 }), 1, 'clamped into the range');
});

test('nodeSettingText: "Copy as node setting" copies threshold_search, and says the console cannot change it', () => {
	assert.equal(nodeSettingText(0.42), 'threshold_search: 0.42');
	assert.equal(nodeSettingText(0.3), 'threshold_search: 0.30');
	assert.equal(nodeSettingText(1), 'threshold_search: 1.00');
	assert.equal(nodeSettingText(-0.2), null, 'the store node takes 0 to 1');
	assert.equal(NODE_SETTING_NOTE, 'Set this on the store node in the pipeline editor; this console cannot change node settings.');
});

test('scoreTitle: the formula on hover; keyword rows and fused rows say what their number is', () => {
	const [semanticRow] = rowsFromSearch(searchVector, true, []);
	assert.equal(scoreTitle(semanticRow, dialect.score), 'Score 0.5433 (1 - cosine_distance)');
	assert.equal(scoreTitle(semanticRow, { ...dialect.score, formula: 'l2', higher_is_better: false }), 'Score 0.5433 (l2, lower is better)');
	const [keywordRow] = rowsFromSearch(keywordFallback, false, []);
	assert.equal(scoreTitle(keywordRow, dialect.score), 'Found by keyword; a keyword result carries no similarity');
	const [fused] = fuse(rowsFromSearch(searchVector, true, []), rowsFromSearch(keywordFallback, false, []), RRF_K, 10);
	assert.equal(scoreTitle(fused, dialect.score), 'Score 0.5433 (1 - cosine_distance); fused here: 1/(60 + 1) + 1/(60 + 1) = 0.0328');
});

// ── Hybrid: reciprocal rank fusion, here ────────────────────────────────────

/**
 * Rows of one list, in rank order.
 *
 * @param ids - objectIds (chunk 0 each).
 * @param rated - Semantic (true) or keyword (false).
 * @returns The rows.
 */
function list(ids: readonly string[], rated: boolean): WorkbenchRow[] {
	return rowsFromSearch({ results: ids.map((id, i) => ({ content: id, score: rated ? 0.9 - i * 0.1 : 1, metadata: { objectId: id, chunkId: 0, parent: `${id}.md` } })), total: ids.length, mode_used: rated ? 'semantic' : 'keyword' }, rated, []);
}

test('fuse: reciprocal rank fusion (k = 60) — a chunk in both lists rises; ties keep the semantic order', () => {
	assert.equal(RRF_K, 60);
	const fused = fuse(list(['a', 'b', 'c'], true), list(['c', 'd', 'a'], false), RRF_K, 10);
	assert.deepEqual(
		fused.map((row) => row.objectId),
		['a', 'c', 'b', 'd']
	);
	const a = fused[0];
	assert.equal(a.fused, 1 / 61 + 1 / 63);
	assert.equal(a.semanticRank, 1);
	assert.equal(a.keywordRank, 3);
	assert.equal(a.score, 0.9, 'the semantic score stays with the row');
	assert.deepEqual(
		fused.map((row) => row.rank),
		[1, 2, 3, 4]
	);
	// a and c tie (1/61 + 1/63): a ranks higher on the semantic list. b (semantic #2) and d (keyword #2) tie at 1/62: the semantic one first.
	assert.equal(fused[0].fused, fused[1].fused);
	assert.equal(fused[2].fused, fused[3].fused);
	const even = fuse(list(['y', 'x'], true), list(['x', 'y'], false), RRF_K, 10);
	assert.deepEqual(
		even.map((row) => row.objectId),
		['y', 'x']
	);
	// A key repeated in one list counts once, at its best position.
	const repeated = fuse(list(['a', 'a', 'b'], true), [], RRF_K, 10);
	assert.deepEqual(
		repeated.map((row) => [row.objectId, row.semanticRank]),
		[
			['a', 1],
			['b', 3],
		]
	);
	// Keyword-only rows have no similarity; the list is cut to k.
	assert.equal(fused[3].score, null);
	assert.equal(fuse(list(['a', 'b', 'c'], true), list(['d', 'e'], false), RRF_K, 2).length, 2);
	assert.equal(HYBRID_LABEL, 'hybrid (fused here)');
});

// ── A run ───────────────────────────────────────────────────────────────────

const base = { topK: 10, limits, storeNode: 'store_1', embedNode: 'embed_1', objectIds: null, chat: null };

test('runWorkbench semantic: embed on the embedding node, then search the store with exactly that vector; the run keeps no vector', async () => {
	const { deps, calls, phases } = fakeCalls({ embed: [embedOk as unknown as Record<string, unknown>], search: [searchVector as unknown as Record<string, unknown>] });
	const outcome = await runWorkbench(deps, { ...base, question: '  Where does Falcon Station get its water? ', mode: 'semantic', objectIds: ['o1'] });
	assert.ok(outcome.ok);
	assert.deepEqual(
		calls.map((call) => [call.tool, call.nodeId]),
		[
			['embed', 'embed_1'],
			['search', 'store_1'],
		]
	);
	assert.deepEqual(calls[0].input, { texts: ['Where does Falcon Station get its water?'], kind: 'query' });
	assert.deepEqual(calls[1].input.vector, embedOk.vectors[0], 'the vector embed returned');
	assert.equal(calls[1].input.embedding_model, embedOk.model);
	assert.deepEqual(calls[1].input.filter, { objectIds: ['o1'] });
	assert.deepEqual(phases, ['embedding', 'searching']);
	assert.equal(outcome.run.modeUsed, 'semantic');
	assert.equal(outcome.run.rated, true);
	assert.equal(outcome.run.rows.length, 8);
	assert.equal(outcome.run.scoped, 1);
	assert.equal(vectorsIn(outcome, embedOk.dimension), 0, 'nothing vector-shaped is kept');
	// Only the search request carries it, once.
	assert.equal(
		vectorsIn(
			calls.map((call) => call.input),
			embedOk.dimension
		),
		1
	);
});

test('runWorkbench keyword: one search by the question, no embed; KX4471 is sent as typed', async () => {
	const { deps, calls } = fakeCalls({ search: [{ success: true, results: [{ content: 'Valve KX4471 is checked weekly.', score: 1, metadata: { objectId: 'kx', chunkId: 4, parent: 'C:/demo/ops/valves.md' } }], total: 1, warnings: [], mode_used: 'keyword' }] });
	const outcome = await runWorkbench(deps, { ...base, question: 'KX4471', mode: 'keyword', embedNode: null });
	assert.ok(outcome.ok);
	assert.deepEqual(calls, [{ tool: 'search', nodeId: 'store_1', input: { query: 'KX4471', mode: 'keyword', top_k: 10, include_below_threshold: true } }]);
	assert.equal(outcome.run.modeUsed, 'keyword');
	assert.equal(outcome.run.rated, false);
	assert.deepEqual(outcome.run.rows[0].key, ['kx', 4]);
});

test('runWorkbench hybrid: embed, a vector search and a keyword search, fused here', async () => {
	const { deps, calls } = fakeCalls({ embed: [embedOk as unknown as Record<string, unknown>], search: [searchVector as unknown as Record<string, unknown>, keywordFallback as unknown as Record<string, unknown>] });
	const outcome = await runWorkbench(deps, { ...base, question: 'water', mode: 'hybrid' });
	assert.ok(outcome.ok);
	assert.deepEqual(
		calls.map((call) => [call.tool, call.input.mode]),
		[
			['embed', undefined],
			['search', 'semantic'],
			['search', 'keyword'],
		]
	);
	assert.equal(outcome.run.modeUsed, 'hybrid');
	assert.equal(outcome.run.rows.length, 8, 'cut to k after fusion');
	assert.ok(outcome.run.rows[0].fused !== null && outcome.run.rows[0].semanticRank !== null && outcome.run.rows[0].keywordRank !== null);
	assert.equal(outcome.run.keywordFallback, false, "the keyword half's own warnings are not a fallback");
});

test('runWorkbench auto: the store may fall back to keyword search; then nothing is rated', async () => {
	const { deps, calls } = fakeCalls({ embed: [embedOk as unknown as Record<string, unknown>], search: [keywordFallback as unknown as Record<string, unknown>] });
	const outcome = await runWorkbench(deps, { ...base, question: 'water', mode: 'auto' });
	assert.ok(outcome.ok);
	assert.equal(calls[1].input.mode, 'auto');
	assert.equal(calls[1].input.query, 'water');
	assert.equal(outcome.run.keywordFallback, true);
	assert.equal(outcome.run.rated, false);
	assert.equal(outcome.run.modeUsed, 'keyword');
});

test('runWorkbench: a model mismatch is reported; below-floor rows come back flagged', async () => {
	const { deps } = fakeCalls({ embed: [embedOk as unknown as Record<string, unknown>, embedOk as unknown as Record<string, unknown>], search: [mismatch as unknown as Record<string, unknown>, searchBelowFloor as unknown as Record<string, unknown>] });
	const first = await runWorkbench(deps, { ...base, question: 'q', mode: 'semantic' });
	assert.ok(first.ok && first.run.modelMismatch);
	const second = await runWorkbench(deps, { ...base, question: 'q', mode: 'semantic' });
	assert.ok(second.ok);
	assert.ok(classifyAt(second.run.rows, 0.3, dialect.score).counts.belowFloor > 0);
});

test('runWorkbench: RATE_LIMITED stops before the search and says when to try again', async () => {
	const { deps, calls } = fakeCalls({ embed: [rateLimited] });
	const outcome = await runWorkbench(deps, { ...base, question: 'q', mode: 'semantic' });
	assert.equal(outcome.ok, false);
	assert.ok(!outcome.ok);
	assert.equal(outcome.stage, 'embed');
	assert.equal(outcome.code, 'RATE_LIMITED');
	assert.equal(outcome.retryAfterS, 12);
	assert.equal(outcome.message, 'Too many searches were embedded in the last minute. Run again in 12 s.');
	assert.deepEqual(
		calls.map((call) => call.tool),
		['embed']
	);
});

test('runWorkbench: nothing is called without a question, or without the embedding node for a mode that needs it', async () => {
	const { deps, calls } = fakeCalls({});
	const empty = await runWorkbench(deps, { ...base, question: '   ', mode: 'keyword' });
	assert.ok(!empty.ok && empty.stage === 'input');
	const noEmbed = await runWorkbench(deps, { ...base, question: 'q', mode: 'hybrid', embedNode: null });
	assert.ok(!noEmbed.ok && noEmbed.message === QUERY_NEEDS_EMBED);
	assert.equal(calls.length, 0);
});

test('runWorkbench: a refused search reads as a sentence', async () => {
	const { deps } = fakeCalls({ search: [{ success: false, code: 'LIMIT_EXCEEDED', error: 'filter.objectIds may hold at most 2000 ids.' }] });
	const outcome = await runWorkbench(deps, { ...base, question: 'q', mode: 'keyword' });
	assert.ok(!outcome.ok);
	assert.equal(outcome.stage, 'search');
	assert.equal(outcome.message, 'The store refused the search: filter.objectIds may hold at most 2000 ids.');
});

test('rate limit: the countdown sentence and the seconds left', () => {
	assert.equal(retryAfterSeconds({ ok: false, code: 'RATE_LIMITED', message: 'x', kind: null, error: rateLimited }), 12);
	assert.equal(retryAfterSeconds({ ok: false, code: 'RATE_LIMITED', message: 'x', kind: null, error: null }), null);
	assert.equal(secondsLeft(10_000 + 12_000, 10_000), 12);
	assert.equal(secondsLeft(10_000 + 11_200, 10_000), 12);
	assert.equal(secondsLeft(10_000, 20_000), 0);
	assert.equal(rateLimitSentence(1), 'Too many searches were embedded in the last minute. Run again in 1 s.');
});

// ── From the chat ("Open in Search") ────────────────────────────────────────

const FALCON = 'Where does Falcon Station get its water?';
const CITED: VectorKey = ['ef35cb9c-f98f-e472-d795-298a40a5cb2b', 67];
const BROUGHT: ChatPrefill = { question: FALCON, cited: [CITED] };

/**
 * A finished run over search_vector.json (the cited chunk is on it).
 *
 * @param question - The question.
 * @param mode - The mode.
 * @param chat - What "Open in Search" brought, or null.
 * @param objectIds - The run's scope, or null.
 * @returns The run.
 */
async function runOf(question: string, mode: SearchMode, chat: ChatPrefill | null, objectIds: string[] | null = null): Promise<WorkbenchRun> {
	const { deps } = fakeCalls({ embed: [embedOk as unknown as Record<string, unknown>], search: [searchVector as unknown as Record<string, unknown>, keywordFallback as unknown as Record<string, unknown>] });
	const outcome = await runWorkbench(deps, { ...base, question, mode, chat, objectIds });
	assert.ok(outcome.ok);
	return outcome.run;
}

/**
 * The keys a run marks as cited.
 *
 * @param run - The run.
 * @returns "objectId#chunkId" per cited row.
 */
function citedKeys(run: WorkbenchRun): string[] {
	return run.rows.filter((row) => row.cited).map((row) => `${row.objectId}#${row.chunkId}`);
}

test('runWorkbench: the chat\'s cited chunks are marked only on a run of the question "Open in Search" brought', async () => {
	const same = await runOf(`  ${FALCON} `, 'semantic', BROUGHT);
	assert.deepEqual(citedKeys(same), [`${CITED[0]}#${CITED[1]}`]);
	assert.deepEqual(same.fromChat, { cited: 1, askedAbout: null, sameScope: true });
	// Another question on the same panel: the chunk is listed, but no answer to this question cited it.
	const other = await runOf('greenhouse orchid pressure', 'semantic', BROUGHT);
	assert.ok(
		other.rows.some((row) => row.objectId === CITED[0] && row.chunkId === CITED[1]),
		'the chunk is in the results'
	);
	assert.deepEqual(citedKeys(other), []);
	assert.equal(other.fromChat, null);
	assert.equal(fromChatLine(other, false), null);
	assert.ok(
		workbenchExportRows(classifyAt(other.rows, 0.3, dialect.score)).rows.every((row) => row.cited === false),
		'nor in the export'
	);
	const keyword = await runOf('falcon', 'keyword', BROUGHT);
	assert.deepEqual(citedKeys(keyword), []);
	assert.equal(keyword.fromChat, null);
	// The brought question in another mode: the answer did cite that chunk.
	assert.deepEqual(citedKeys(await runOf(FALCON, 'keyword', BROUGHT)), [`${CITED[0]}#${CITED[1]}`]);
	assert.deepEqual(citedKeys(await runOf(FALCON, 'hybrid', BROUGHT)), [`${CITED[0]}#${CITED[1]}`]);
	// Nothing brought: nothing marked.
	const none = await runOf(FALCON, 'semantic', null);
	assert.deepEqual(citedKeys(none), []);
	assert.equal(none.fromChat, null);
});

test('runWorkbench: whether a run searched the documents the answer did (the whole collection both, or the same ids in any order)', async () => {
	const askedAbout: ChatPrefill = { ...BROUGHT, objectIds: ['d2', 'd1'] };
	assert.deepEqual((await runOf(FALCON, 'semantic', askedAbout, ['d1', 'd2'])).fromChat, { cited: 1, askedAbout: 2, sameScope: true });
	assert.deepEqual((await runOf(FALCON, 'semantic', askedAbout, null)).fromChat, { cited: 1, askedAbout: 2, sameScope: false });
	assert.deepEqual((await runOf(FALCON, 'semantic', askedAbout, ['d1'])).fromChat, { cited: 1, askedAbout: 2, sameScope: false });
	assert.deepEqual((await runOf(FALCON, 'semantic', BROUGHT, ['d1'])).fromChat, { cited: 1, askedAbout: null, sameScope: false });
	assert.deepEqual((await runOf(FALCON, 'semantic', { ...BROUGHT, objectIds: [] }, null)).fromChat, { cited: 1, askedAbout: null, sameScope: true }, 'an empty scope is the whole collection, as the chat sends it');
});

test('fromChatLine: how many of the cited chunks the run lists, and whether it searched what the answer did', () => {
	/**
	 * The line for a run that lists `listed` of the answer's `cited` chunks.
	 *
	 * @param cited - Chunks the answer cited.
	 * @param listed - How many of them the run lists.
	 * @param scope - askedAbout, sameScope and the run's own scope.
	 * @param scopeOn - Run searches within the console's scope.
	 * @returns The line.
	 */
	const lineOf = (cited: number, listed: number, scope: Partial<RunFromChat> & { scoped?: number | null } = {}, scopeOn = false): string | null => fromChatLine({ rows: [...Array.from({ length: listed }, () => ({ cited: true })), { cited: false }], fromChat: { cited, askedAbout: scope.askedAbout ?? null, sameScope: scope.sameScope ?? true }, scoped: scope.scoped ?? null }, scopeOn);
	assert.equal(fromChatLine({ rows: [{ cited: false }], fromChat: null, scoped: null }, true), null);
	assert.equal(lineOf(3, 3), 'From the chat: the 3 chunks its answer cited are marked “cited”.');
	assert.equal(lineOf(1, 1), 'From the chat: the chunk its answer cited is marked “cited”.');
	assert.equal(lineOf(3, 2), 'From the chat: 2 of the 3 chunks its answer cited are in these results, marked “cited”.');
	assert.equal(lineOf(3, 1), 'From the chat: 1 of the 3 chunks its answer cited is in these results, marked “cited”.');
	assert.equal(lineOf(3, 0), 'From the chat: none of the 3 chunks its answer cited is in these results.');
	assert.equal(lineOf(1, 0), 'From the chat: the chunk its answer cited is not in these results.');
	assert.equal(lineOf(0, 0), 'From the chat: its answer cited no chunks.');
	assert.equal(lineOf(3, 3, { askedAbout: 1, scoped: 1 }), 'From the chat: the 3 chunks its answer cited are marked “cited”. Searched only the document the question was asked about, as the answer did.');
	assert.equal(lineOf(3, 3, { askedAbout: 2, scoped: 2 }), 'From the chat: the 3 chunks its answer cited are marked “cited”. Searched only the 2 documents the question was asked about, as the answer did.');
	assert.equal(lineOf(3, 3, {}, true), 'From the chat: the 3 chunks its answer cited are marked “cited”. Searched the whole collection, as the answer did; Run searches within the scope.');
	assert.equal(lineOf(3, 0, { sameScope: false, scoped: 2 }, true), 'From the chat: none of the 3 chunks its answer cited is in these results. Searched within the scope; the answer was not.');
	assert.equal(lineOf(3, 3, { askedAbout: 1, sameScope: false, scoped: null }), 'From the chat: the 3 chunks its answer cited are marked “cited”. The question was asked about 1 document only; this search covered the whole collection.');
	assert.equal(lineOf(3, 3, { askedAbout: 4, sameScope: false, scoped: 2 }, true), 'From the chat: the 3 chunks its answer cited are marked “cited”. The question was asked about 4 documents only; this search used the scope instead.');
});

test('"Open in Search": its first run sends the search "Why these?" sent — same vector, k, documents and flags', async () => {
	const sources: IChatSource[] = [
		{ rank: 1, key: ['2ed1cfeb-37ac-4394-30f7-699303f093bd', 39], objectId: '2ed1cfeb-37ac-4394-30f7-699303f093bd', chunkId: 39, path: 'C:/demo/ops/ops_021.pdf', score: 0.5433, text: '' },
		{ rank: 2, key: CITED, objectId: CITED[0], chunkId: CITED[1], path: 'C:/demo/ops/ops_005.pdf', score: 0.5247, text: '' },
		{ rank: 3, key: ['0ab4bcf8-0000-0000-0000-000000000000', 27], objectId: '0ab4bcf8-0000-0000-0000-000000000000', chunkId: 27, path: 'C:/demo/x.md', score: 0.5, text: '' },
	];
	for (const scope of [null, ['d1', 'd2']]) {
		const prefill = openInSearchPrefill(FALCON, sources, sources.length, limits, scope);
		assert.deepEqual(prefill, { question: FALCON, cited: sources.map((source) => source.key), topK: 13, objectIds: scope });
		const next = prefillRun(prefill, modeOptions(model()), topKOptions(limits));
		assert.deepEqual(next, { question: FALCON, mode: 'semantic', topK: 13, objectIds: scope });
		const { deps, calls } = fakeCalls({ embed: [embedOk as unknown as Record<string, unknown>], search: [searchVector as unknown as Record<string, unknown>] });
		const outcome = await runWorkbench(deps, { ...base, question: next.question, mode: next.mode as SearchMode, topK: next.topK, objectIds: next.objectIds, chat: prefill });
		assert.ok(outcome.ok);
		assert.deepEqual(calls[1].input, { ...withScope(debuggerSearchInput(embedOk.vectors[0], embedOk.model, sources.length, limits), scope) }, `scope ${JSON.stringify(scope)}`);
		assert.equal(outcome.run.fromChat?.sameScope, true);
	}
	assert.equal(openInSearchPrefill(FALCON, [], 0, limits, []).objectIds, null, 'no scope: the whole collection');
});

test('prefillRun and topKChoices: a prefill without k shows the cited chunks plus ten; Semantic when offered; the k joins the choices', () => {
	const contractOnly: ChatPrefill = { question: FALCON, cited: [CITED, CITED, CITED] };
	assert.deepEqual(prefillRun(contractOnly, modeOptions(model()), topKOptions(limits)), { question: FALCON, mode: 'semantic', topK: 25, objectIds: null });
	const noEmbed = modeOptions(model({ embed: { enabled: false, reason: null }, nodes: { store: 'store_1', embed: null, llm: null, llmName: null } }));
	assert.equal(prefillRun(BROUGHT, noEmbed, topKOptions(limits)).mode, 'keyword');
	assert.deepEqual(topKChoices([5, 10, 25, 50], 13), [5, 10, 13, 25, 50]);
	assert.deepEqual(topKChoices([5, 10, 25, 50], 10), [5, 10, 25, 50]);
});

// ── Export and the map ──────────────────────────────────────────────────────

test('workbenchExportRows: the search columns, the words on screen, no vector', () => {
	const rows = rowsFromSearch(searchVector, true, [['2ed1cfeb-37ac-4394-30f7-699303f093bd', 39]]);
	const exported = workbenchExportRows(classifyAt(rows, 0.52, dialect.score));
	assert.deepEqual(exported.columns, EXPORT_COLUMNS.search);
	assert.equal(exported.rows.length, 8);
	assert.deepEqual(exported.rows[0], { rank: 1, objectId: '2ed1cfeb-37ac-4394-30f7-699303f093bd', chunkId: 39, path: 'C:/demo/ops/ops_021.pdf', score: 0.5433, raw_score: 0.5433, status: STATUS_WORDS.used, cited: true, preview: rows[0].preview });
	assert.equal(exported.rows[3].status, STATUS_WORDS.near_miss);
	assert.ok(exported.rows.every((row) => Object.values(row).every((cell) => !Array.isArray(cell))));
	const both = workbenchExportRows(classifyAt(rows, 0.3, dialect.score), 'A');
	assert.deepEqual(both.columns, ['run', ...EXPORT_COLUMNS.search]);
	assert.equal(both.rows[0].run, 'A');
});

test("retrievalExportRows: the debugger's rows in the search columns, its own words, previews cut to 120 characters", () => {
	const view = classifyRetrieval({ ...searchVector, results: [{ ...searchVector.results[0], content: 'z'.repeat(400) }, ...searchVector.results.slice(1)] }, dialect.score, [{ rank: 1, key: ['2ed1cfeb-37ac-4394-30f7-699303f093bd', 39], objectId: '2ed1cfeb-37ac-4394-30f7-699303f093bd', chunkId: 39, path: 'C:/demo/ops/ops_021.pdf', score: 0.5433, text: '' }]);
	const words = { used: 'passed the threshold', near_miss: 'near miss: below the threshold', below_floor: 'below the floor' } as const;
	const exported = retrievalExportRows(view, words);
	assert.deepEqual(exported.columns, EXPORT_COLUMNS.search);
	assert.equal(exported.rows.length, 8);
	assert.equal(exported.rows[0].cited, true);
	assert.equal(exported.rows[0].status, 'passed the threshold');
	assert.equal(String(exported.rows[0].preview).length, 120);
	assert.equal(previewOf('short'), 'short');
	assert.ok(exported.rows.every((row) => Object.values(row).every((cell) => !Array.isArray(cell))));
});

test('searchExportItems: A, and with Compare B and both; disabled until a run', () => {
	const view = classifyAt(rowsFromSearch(searchVector, true, []), 0.3, dialect.score);
	assert.deepEqual(
		searchExportItems(null, null).map((item) => [item.id, item.kind, item.disabled]),
		[['search-a', 'search', 'Run a search first']]
	);
	const one = searchExportItems(view, null);
	assert.equal(one.length, 1);
	assert.equal(one[0].label, 'Search results (8 rows)');
	assert.equal(one[0].rows?.().rows.length, 8);
	const two = searchExportItems(view, view);
	assert.deepEqual(
		two.map((item) => [item.id, item.label]),
		[
			['search-a', 'Search A results (8 rows)'],
			['search-b', 'Search B results (8 rows)'],
			['search-both', 'A and B (16 rows)'],
		]
	);
	assert.deepEqual(
		two[2]
			.rows?.()
			.rows.map((row) => row.run)
			.slice(7, 9),
		['A', 'B']
	);
});

test('showSearchOnMap: the map is told the question (and no second one) before the highlight brings it to the front', () => {
	const log: string[] = [];
	const selection = { setQuery: (q: string | null) => log.push(`query ${q}`), clearQueryB: () => log.push('clear B') };
	const actions = { showOnMap: (keys: readonly VectorKey[], source: string) => log.push(`show ${keys.length} ${source}`) };
	showSearchOnMap(selection, actions, 'water', [
		['a', 1],
		['b', 2],
	]);
	assert.deepEqual(log, ['query water', 'clear B', 'show 2 search']);
});

// ── The panel keeps the vector to itself ───────────────────────────────────

/**
 * A file's code without comments.
 *
 * @param relative - Path under src/.
 * @returns The code.
 */
function code(relative: string): string {
	return readFileSync(path.join(__dirname, '..', 'src', relative), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

test('wiring: the workbench is pure, the panel calls embed and search through chat/toolCalls only, and never holds a vector in state', () => {
	const workbench = code(path.join('vector', 'searchWorkbench.ts'));
	for (const line of workbench.split('\n').filter((l) => /^import /.test(l))) {
		if (/^import type /.test(line)) continue;
		assert.doesNotMatch(line, /chat\/toolCalls|map\/calls|adapters\/|from 'shell'|from 'react'/, line);
	}
	assert.doesNotMatch(workbench, /localStorage|sessionStorage|indexedDB/);
	const panel = code(path.join('components', 'SearchPanel.tsx'));
	assert.match(panel, /import \{ callTool, toolChannelFor \} from '\.\.\/chat\/toolCalls';/);
	assert.doesNotMatch(panel, /\.invoke\(/, 'no call around chat/toolCalls');
	assert.doesNotMatch(panel, /useState<[^>]*number\[\]/);
	assert.doesNotMatch(panel, /useRef<[^>]*number\[\]/);
	assert.doesNotMatch(panel, /localStorage|sessionStorage|indexedDB|console\.(log|info|debug|warn|error)/);
	const phase = /type Phase = [^;]*;/.exec(panel)?.[0] ?? '';
	assert.ok(phase !== '', 'the panel declares its Phase');
	assert.doesNotMatch(phase, /vector|number\[\]/);
});

test('wiring: the panel hands each run the chat\'s prefill (never cited keys apart from their question); "Why these?" searches what the chat asked and hands Search its k and documents', () => {
	const panel = code(path.join('components', 'SearchPanel.tsx'));
	assert.doesNotMatch(panel, /setCited|useState<readonly VectorKey\[\]>/, 'no cited keys kept apart from their question');
	assert.match(panel, /chat: request\.chat/);
	assert.match(panel, /const next = prefillRun\(prefill, options, ks\);/);
	assert.match(panel, /objectIds: next\.objectIds/);
	assert.match(panel, /objectIds: gate\.objectIds/);
	const debuggerSource = code(path.join('components', 'RetrievalDebugger.tsx'));
	assert.match(debuggerSource, /withScope\(debuggerSearchInput\(vector, embeddingModel, topK, model\.limits\), scope\)/);
	assert.match(debuggerSource, /openInSearchPrefill\(question, answerSources \?\? \[\], topK, model\.limits, scope\)/);
	const chatPanel = code(path.join('components', 'ChatPanel.tsx'));
	assert.match(chatPanel, /<RetrievalDebugger [^>]*scope=\{turn\.scope\}/);
});

test('wiring: the search files insert no HTML, stop no propagation, listen for no keys, log nothing and hold no token', () => {
	const files = [path.join('components', 'SearchPanel.tsx'), path.join('components', 'QueryCompare.tsx'), path.join('vector', 'searchWorkbench.ts'), path.join('vector', 'compare.ts')];
	for (const file of files) {
		const text = code(file);
		assert.doesNotMatch(text, /dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\s*\(/, file);
		assert.doesNotMatch(text, /stopPropagation|stopImmediatePropagation|(window|document)\s*\.\s*addEventListener\s*\(\s*['"]key/, file);
		assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie|console\.(log|info|debug|warn|error)/, file);
		assert.doesNotMatch(text, /\.token\b|\btoken\s*:|getToken|roleTokens/, file);
	}
});
