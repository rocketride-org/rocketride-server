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
// VECTOR — SEARCH WORKBENCH (pure): search without the LLM
// =============================================================================
//
// The model behind the chat panel's Search toggle (components/SearchPanel.tsx)
// and the "Why these?" debugger's export:
//
//   - modes: Semantic (embed the question on the pipeline's embedding node,
//     then `search` the store with exactly that vector), Keyword (`search`
//     with the question and mode 'keyword'), Hybrid (both, fused here by
//     reciprocal rank fusion, k = 60) and Auto (the semantic search with the
//     question beside it, so the store may fall back to keyword search);
//     each mode is offered only when the store and the embedding node can
//     serve it, otherwise disabled with the sentence that says why;
//   - the threshold slider re-classifies the rows a run already has, so the
//     count it names is the table's count of passing rows at every position,
//     next to what today's node setting passes, with the node setting to copy;
//   - the scope (folder, file type, ...) goes out as `filter.objectIds`, never
//     more than `limits.scope_keys_max` ids;
//   - "Open in Search" brings the chat's question with the chunks its answer
//     cited: the first run searches as "Why these?" did (its k, the
//     documents the question was asked about), and the "cited" marks go only
//     on a run of that question, never on another one on the same panel.
//
// `runWorkbench` makes a run's calls through the function it is given (the
// panel passes chat/toolCalls' callTool): the query vector is a local of that
// function, sent once to `search` and never returned or kept.
// =============================================================================

import type { ConsoleActions, ConsoleModel, IChatSource, IExportItem, IExportRows, IScopeState, IScoreInfo, ISearchInput, ISearchResult, IVectorLimits, KeywordMatch, SelectionStore, VectorKey } from '../contract/types';
import { EXPORT_COLUMNS } from '../contract/types';
import type { CallOutcome } from '../chat/toolCalls';
import { QUERY_NEEDS_EMBED } from '../map/wording';
import { DEBUGGER_EXTRA, MODEL_MISMATCH_SENTENCE, debuggerTopK, embedInput } from './retrieval';
import type { RetrievalStatus, RetrievalView } from './retrieval';
import { keyId } from './compare';

// ── Modes ───────────────────────────────────────────────────────────────────

/** A way to search. */
export type SearchMode = 'semantic' | 'keyword' | 'hybrid' | 'auto';

/** The modes, in the order the panel offers them. */
export const SEARCH_MODES: readonly SearchMode[] = ['semantic', 'keyword', 'hybrid', 'auto'];

/** The words of each mode. */
export const MODE_LABELS: Readonly<Record<SearchMode, string>> = { semantic: 'Semantic', keyword: 'Keyword', hybrid: 'Hybrid', auto: 'Auto' };

/** What each mode does, for its hover text. */
export const MODE_HINTS: Readonly<Record<SearchMode, string>> = {
	semantic: 'Ranks the chunks by meaning: the question is embedded and the store searches with that vector',
	keyword: 'Finds the chunks that contain the words of the question',
	hybrid: 'Runs both searches and fuses the two lists here by their ranks',
	auto: 'Searches by meaning; the store falls back to keyword search when it cannot',
};

/** Keyword search is not offered by this store. */
export const KEYWORD_UNSUPPORTED = 'This store cannot search by keyword';

/** Vector search is not offered by this store node. */
export const VECTOR_UNSUPPORTED = 'This store node cannot search by meaning; update the node.';

/** Hybrid needs both halves. */
export const HYBRID_NEEDS_KEYWORD = 'Hybrid needs keyword search, which this store cannot do';

/** How a hybrid list is labelled: the fusion happens in the browser, not on the store. */
export const HYBRID_LABEL = 'hybrid (fused here)';

/** The reciprocal rank fusion constant (the usual 60). */
export const RRF_K = 60;

/** Shown when the store answered a semantic search with a keyword search. */
export const KEYWORD_FALLBACK_SENTENCE = 'The store fell back to a keyword search, so these scores are not similarities.';

/** One mode, offered or not. */
export interface ModeOption {
	mode: SearchMode;
	label: string;
	enabled: boolean;
	/** Why it is not offered; null when it is. */
	reason: string | null;
}

/**
 * The modes this connection can run.
 *
 * @param model - The console model's capabilities, embedding availability and nodes.
 * @returns One option per mode, in {@link SEARCH_MODES} order.
 */
export function modeOptions(model: Pick<ConsoleModel, 'capabilities' | 'embed' | 'nodes'>): ModeOption[] {
	const keyword = model.capabilities.search_keyword === true;
	const vector = model.capabilities.search_vector === true;
	const embedReady = model.embed.enabled && model.nodes.embed !== null && model.nodes.embed !== '';
	const embedReason = model.embed.reason ?? QUERY_NEEDS_EMBED;
	const semanticReason = !vector ? VECTOR_UNSUPPORTED : !embedReady ? embedReason : null;
	const reasons: Record<SearchMode, string | null> = {
		semantic: semanticReason,
		keyword: keyword ? null : KEYWORD_UNSUPPORTED,
		hybrid: semanticReason ?? (keyword ? null : HYBRID_NEEDS_KEYWORD),
		auto: semanticReason,
	};
	return SEARCH_MODES.map((mode) => ({ mode, label: MODE_LABELS[mode], enabled: reasons[mode] === null, reason: reasons[mode] }));
}

/**
 * The mode the panel starts in: Semantic, else Keyword, else none.
 *
 * @param options - {@link modeOptions}.
 * @returns The mode, or null when nothing can run.
 */
export function defaultMode(options: readonly ModeOption[]): SearchMode | null {
	for (const mode of ['semantic', 'keyword'] as const) if (options.find((o) => o.mode === mode)?.enabled) return mode;
	return options.find((o) => o.enabled)?.mode ?? null;
}

/**
 * What a keyword search matches on this store (`dialect.keyword_match`).
 *
 * @param match - The dialect's answer.
 * @returns The caption.
 */
export function keywordCaption(match: KeywordMatch | null | undefined): string {
	if (match === 'substring') return 'Keyword search matches text fragments on this store';
	if (match === 'token') return 'Keyword search matches whole words on this store';
	return 'This store does not say whether keyword search matches whole words or text fragments';
}

/** The calls of one run. */
export interface SearchPlan {
	/** Embed the question first. */
	embed: boolean;
	/** The searches, in order: by the vector, by keyword, or by the vector with the store's keyword fallback. */
	searches: Array<'vector' | 'keyword' | 'auto'>;
	/** Fuse the two lists here. */
	fused: boolean;
	/** Tool calls in all. */
	calls: number;
}

/**
 * The calls a mode makes.
 *
 * @param mode - The mode.
 * @returns The plan.
 */
export function plan(mode: SearchMode): SearchPlan {
	const searches: SearchPlan['searches'] = mode === 'semantic' ? ['vector'] : mode === 'keyword' ? ['keyword'] : mode === 'hybrid' ? ['vector', 'keyword'] : ['auto'];
	const embed = mode !== 'keyword';
	return { embed, searches, fused: mode === 'hybrid', calls: searches.length + (embed ? 1 : 0) };
}

// ── k, inputs and scope ─────────────────────────────────────────────────────

/** The panel's choices of k. */
export const TOP_K_OPTIONS: readonly number[] = [5, 10, 25, 50];

/** k before the user picks one. */
export const DEFAULT_TOP_K = 10;

/** The node's documented maximum for `top_k`, when the dialect does not say. */
const TOP_K_MAX = 100;

/**
 * The choices of k this node accepts.
 *
 * @param limits - The node's limits.
 * @returns The options (the node's maximum alone when it is below 5).
 */
export function topKOptions(limits: Pick<IVectorLimits, 'top_k_max'> | null): number[] {
	const max = limits?.top_k_max ?? TOP_K_MAX;
	const options = TOP_K_OPTIONS.filter((k) => k <= max);
	return options.length > 0 ? options : [Math.max(1, Math.floor(max))];
}

/**
 * k clamped to [1, top_k_max].
 *
 * @param topK - The requested k.
 * @param limits - The node's limits.
 * @returns k.
 */
function clampTopK(topK: number, limits: Pick<IVectorLimits, 'top_k_max'> | null): number {
	const max = limits?.top_k_max ?? TOP_K_MAX;
	return Math.max(1, Math.min(max, Number.isFinite(topK) ? Math.floor(topK) : DEFAULT_TOP_K));
}

/**
 * The `search` input of a semantic (or Auto) run.
 *
 * @param vector - Exactly the vector `embed` returned for the question.
 * @param embeddingModel - The model `embed` reported (the store warns on a mismatch), or null.
 * @param query - The question (sent only in Auto, for the store's keyword fallback).
 * @param topK - k.
 * @param limits - The node's limits.
 * @param mode - 'semantic' (no fallback) or 'auto'.
 * @param objectIds - The scope, or null.
 * @returns The input.
 */
export function semanticSearchInput(vector: number[], embeddingModel: string | null, query: string, topK: number, limits: Pick<IVectorLimits, 'top_k_max'> | null, mode: 'semantic' | 'auto', objectIds: readonly string[] | null): ISearchInput {
	const input: ISearchInput = { vector };
	if (mode === 'auto') input.query = query.trim();
	input.top_k = clampTopK(topK, limits);
	input.mode = mode;
	input.include_below_floor = true;
	input.include_below_threshold = true;
	if (embeddingModel !== null && embeddingModel !== '') input.embedding_model = embeddingModel;
	if (objectIds !== null) input.filter = { objectIds: [...objectIds] };
	return input;
}

/**
 * The `search` input of a keyword run. Rows under the node's threshold are kept: a keyword score is not a similarity.
 *
 * @param query - The question.
 * @param topK - k.
 * @param limits - The node's limits.
 * @param objectIds - The scope, or null.
 * @returns The input.
 */
export function keywordSearchInput(query: string, topK: number, limits: Pick<IVectorLimits, 'top_k_max'> | null, objectIds: readonly string[] | null): ISearchInput {
	const input: ISearchInput = { query: query.trim(), mode: 'keyword', top_k: clampTopK(topK, limits), include_below_threshold: true };
	if (objectIds !== null) input.filter = { objectIds: [...objectIds] };
	return input;
}

/** What the scope does to a run. */
export interface ScopeGate {
	/** The ids to send as `filter.objectIds`, or null for the whole collection. */
	objectIds: string[] | null;
	/** Why Run is off, or null. */
	blocked: string | null;
	/** "Searching 12 documents in scope: …", or null without a scope. */
	line: string | null;
}

/**
 * The scope's effect on Search: its objectIds, or why it blocks a run.
 *
 * @param scope - The console's scope, or null.
 * @param limits - The node's limits (scope_keys_max).
 * @returns The gate.
 */
export function searchScope(scope: IScopeState | null | undefined, limits: Pick<IVectorLimits, 'scope_keys_max'>): ScopeGate {
	if (!scope || !scope.applyTo.search) return { objectIds: null, blocked: null, line: null };
	const cap = limits.scope_keys_max;
	const over = scope.overflow ?? (scope.objectIds !== null && scope.objectIds.length > cap ? scope.objectIds.length : null);
	if (over !== null) return { objectIds: null, blocked: `Scope too large for the map, search and chat (${over.toLocaleString('en-US')} documents; at most ${cap.toLocaleString('en-US')}). Narrow the folder.`, line: null };
	if (scope.objectIds === null) return { objectIds: null, blocked: 'Finding the documents in scope…', line: null };
	// An empty filter would search the whole collection.
	if (scope.objectIds.length === 0) return { objectIds: null, blocked: 'No documents match the scope.', line: null };
	const n = scope.objectIds.length;
	return { objectIds: [...scope.objectIds], blocked: null, line: `Searching ${n === 1 ? '1 document' : `${n.toLocaleString('en-US')} documents`} in scope: ${scope.label}` };
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** Characters of a row's content shown and exported, the ellipsis included (the node's snippet_chars by default). */
export const PREVIEW_CHARS = 120;

/**
 * At most `max` characters of a text, the ellipsis included.
 *
 * @param text - The text.
 * @param max - The most characters.
 * @returns The text, or its start and '…'.
 */
export function previewOf(text: string, max: number = PREVIEW_CHARS): string {
	const most = Math.max(1, Math.floor(max));
	return text.length > most ? `${text.slice(0, most - 1)}…` : text;
}

/** One result of a run. */
export interface WorkbenchRow {
	/** Position in the run's list (after fusion in Hybrid). */
	rank: number;
	key: VectorKey;
	objectId: string;
	chunkId: number;
	path: string;
	/** The driver's similarity score (see dialect.score); null for a row found by keyword only. */
	score: number | null;
	rawScore: number | null;
	sim: number | null;
	/** The store flagged it under its floor (it drops such rows); null when it did not say. */
	belowFloor: boolean | null;
	/** Rank on the semantic list, or null. */
	semanticRank: number | null;
	/** Rank on the keyword list, or null. */
	keywordRank: number | null;
	/** The keyword search's own score (not a similarity), or null. */
	keywordScore: number | null;
	/** Reciprocal rank fusion score (Hybrid), or null. */
	fused: number | null;
	/** The chat's answer cited this chunk ("Open in Search"). */
	cited: boolean;
	/** At most {@link PREVIEW_CHARS} (or the node's snippet_chars, if fewer) characters of the chunk, the ellipsis included. */
	preview: string;
}

/**
 * A finite number, or null.
 *
 * @param value - Anything.
 * @returns The number or null.
 */
function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The rows of one `search` answer.
 *
 * @param result - The answer.
 * @param rated - True for a semantic answer (scores are similarities), false for a keyword one.
 * @param cited - Chunks to mark as cited.
 * @param previewChars - The longest preview (the node's snippet_chars when it is below {@link PREVIEW_CHARS}).
 * @returns The rows, in the store's order.
 */
export function rowsFromSearch(result: ISearchResult, rated: boolean, cited: readonly VectorKey[], previewChars: number = PREVIEW_CHARS): WorkbenchRow[] {
	const marked = new Set(cited.map(keyId));
	const items = Array.isArray(result?.results) ? result.results : [];
	return items.map((item, index) => {
		const metadata = item.metadata ?? {};
		const objectId = typeof metadata.objectId === 'string' ? metadata.objectId : '';
		const chunkId = typeof metadata.chunkId === 'number' ? metadata.chunkId : -1;
		const rank = typeof item.rank === 'number' ? item.rank : index + 1;
		const content = typeof item.content === 'string' ? item.content : '';
		const key: VectorKey = [objectId, chunkId];
		return {
			rank,
			key,
			objectId,
			chunkId,
			path: typeof metadata.parent === 'string' ? metadata.parent : '',
			score: rated ? num(item.score) : null,
			rawScore: rated ? num(item.raw_score) : null,
			sim: rated ? num(item.sim) : null,
			belowFloor: rated && typeof item.below_floor === 'boolean' ? item.below_floor : null,
			semanticRank: rated ? rank : null,
			keywordRank: rated ? null : rank,
			keywordScore: rated ? null : num(item.score),
			fused: null,
			cited: marked.has(keyId(key)),
			preview: previewOf(content, Math.min(PREVIEW_CHARS, previewChars)),
		};
	});
}

/**
 * Reciprocal rank fusion of a semantic and a keyword list: each chunk scores
 * Σ 1 / (k + rank) over the lists it is on. Ties keep the semantic list's
 * order, then the keyword list's, then the key; a chunk listed twice in one
 * list counts at its best rank.
 *
 * @param semantic - The semantic rows, in rank order.
 * @param keyword - The keyword rows, in rank order.
 * @param k - The fusion constant ({@link RRF_K}).
 * @param limit - Rows to keep.
 * @returns The fused rows, ranked from 1.
 */
export function fuse(semantic: readonly WorkbenchRow[], keyword: readonly WorkbenchRow[], k: number, limit: number): WorkbenchRow[] {
	const byId = new Map<string, WorkbenchRow>();
	for (const row of semantic) {
		const id = keyId(row.key);
		if (byId.has(id) || row.semanticRank === null) continue;
		byId.set(id, { ...row, keywordRank: null, keywordScore: null, fused: 1 / (k + row.semanticRank) });
	}
	const seenKeyword = new Set<string>();
	for (const row of keyword) {
		const id = keyId(row.key);
		if (seenKeyword.has(id) || row.keywordRank === null) continue;
		seenKeyword.add(id);
		const share = 1 / (k + row.keywordRank);
		const known = byId.get(id);
		if (known) byId.set(id, { ...known, keywordRank: row.keywordRank, keywordScore: row.keywordScore, fused: (known.fused ?? 0) + share, cited: known.cited || row.cited });
		else byId.set(id, { ...row, semanticRank: null, score: null, rawScore: null, sim: null, belowFloor: null, fused: share });
	}
	const rankOr = (value: number | null): number => (value === null ? Number.POSITIVE_INFINITY : value);
	const fused = [...byId.values()].sort((a, b) => (b.fused ?? 0) - (a.fused ?? 0) || rankOr(a.semanticRank) - rankOr(b.semanticRank) || rankOr(a.keywordRank) - rankOr(b.keywordRank) || (keyId(a.key) < keyId(b.key) ? -1 : keyId(a.key) > keyId(b.key) ? 1 : 0));
	return fused.slice(0, Math.max(0, limit)).map((row, index) => ({ ...row, rank: index + 1 }));
}

// ── The threshold slider ────────────────────────────────────────────────────

/** Where a row falls at the slider: the debugger's three statuses, plus rows found by keyword only. */
export type WorkbenchStatus = RetrievalStatus | 'keyword';

/** Words for each status (the colour only repeats them). */
export const STATUS_WORDS: Readonly<Record<WorkbenchStatus, string>> = {
	used: 'passes the threshold',
	near_miss: 'near miss: below the threshold',
	below_floor: 'below the floor (the store drops it)',
	keyword: 'keyword match (no similarity)',
};

/** A row and where it falls. */
export interface ClassifiedRow extends WorkbenchRow {
	status: WorkbenchStatus;
}

/** A run's rows at one slider position. */
export interface Classification {
	/** The slider position. */
	at: number;
	rows: ClassifiedRow[];
	counts: {
		/** Rows that pass at `at` (the table's 'passes' rows). */
		passing: number;
		nearMisses: number;
		belowFloor: number;
		/** Rows found by keyword only (no similarity). */
		keywordOnly: number;
		/** Rows with a similarity (the "of N"). */
		rated: number;
	};
}

/**
 * Whether `score` is worse than `line` under the store's ordering.
 *
 * @param score - The score.
 * @param line - The threshold or floor.
 * @param higherIsBetter - The ordering.
 * @returns True when the score falls under the line.
 */
function under(score: number, line: number, higherIsBetter: boolean): boolean {
	return higherIsBetter ? score < line : score > line;
}

/**
 * Lay a run's rows out against the slider and the store's floor. The floor
 * flag the store sent wins; without one the floor is compared here.
 *
 * @param rows - The run's rows.
 * @param at - The slider position.
 * @param score - `dialect.score`, or null.
 * @returns The classification.
 */
export function classifyAt(rows: readonly WorkbenchRow[], at: number, score: IScoreInfo | null): Classification {
	const floor = score !== null ? num(score.floor) : null;
	const higherIsBetter = score?.higher_is_better !== false;
	const classified = rows.map((row): ClassifiedRow => {
		if (row.score === null) return { ...row, status: 'keyword' };
		const belowFloor = row.belowFloor ?? (floor !== null && under(row.score, floor, higherIsBetter));
		return { ...row, status: belowFloor ? 'below_floor' : under(row.score, at, higherIsBetter) ? 'near_miss' : 'used' };
	});
	const count = (status: WorkbenchStatus): number => classified.filter((row) => row.status === status).length;
	return {
		at,
		rows: classified,
		counts: { passing: count('used'), nearMisses: count('near_miss'), belowFloor: count('below_floor'), keywordOnly: count('keyword'), rated: classified.length - count('keyword') },
	};
}

/** The slider's bounds. */
export interface SliderRange {
	min: number;
	max: number;
	step: number;
}

/**
 * The slider's bounds: `dialect.score.range`, else 0 to 1.
 *
 * @param score - `dialect.score`, or null.
 * @returns The range.
 */
export function sliderRange(score: IScoreInfo | null): SliderRange {
	const range = score?.range;
	if (Array.isArray(range) && range.length === 2 && Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[1] > range[0]) return { min: range[0], max: range[1], step: 0.01 };
	return { min: 0, max: 1, step: 0.01 };
}

/**
 * A slider value on the 0.01 grid (the slider's step).
 *
 * @param value - Any value.
 * @returns The value rounded to 2 decimals.
 */
export function onGrid(value: number): number {
	return Math.round(value * 100) / 100;
}

/**
 * Where the slider starts: the node's threshold, else the store's floor, else the bottom of the range.
 *
 * @param score - `dialect.score`, or null.
 * @returns The value, inside the range.
 */
export function initialThreshold(score: IScoreInfo | null): number {
	const range = sliderRange(score);
	const start = num(score?.threshold) ?? num(score?.floor) ?? range.min;
	return onGrid(Math.max(range.min, Math.min(range.max, start)));
}

/**
 * The slider's line: "At 0.42: 7 of 20 would pass (today's node setting 0.30 passes 11)".
 *
 * @param rows - The run's rows.
 * @param at - The slider position.
 * @param score - `dialect.score`, or null.
 * @returns The sentence.
 */
export function thresholdSentence(rows: readonly WorkbenchRow[], at: number, score: IScoreInfo | null): string {
	const view = classifyAt(rows, at, score);
	if (rows.length === 0) return 'Nothing to weigh against the threshold.';
	if (view.counts.rated === 0) return 'Keyword results carry no similarity, so the threshold does not apply.';
	const node = score !== null ? num(score.threshold) : null;
	const atNode = node !== null && onGrid(node) === onGrid(at);
	const head = `At ${at.toFixed(2)}: ${view.counts.passing} of ${view.counts.rated} ${atNode ? 'pass' : 'would pass'}`;
	if (node === null) return `${head} (the store node has no threshold set)`;
	if (atNode) return `${head} (today's node setting)`;
	return `${head} (today's node setting ${node.toFixed(2)} passes ${classifyAt(rows, node, score).counts.passing})`;
}

/**
 * The slider's `aria-valuetext`: "0.42: 7 of 20 pass".
 *
 * @param view - The rows at the slider.
 * @returns The words.
 */
export function sliderValueText(view: Classification): string {
	return `${view.at.toFixed(2)}: ${view.counts.passing} of ${view.counts.rated} pass`;
}

/** Under the "Copy as node setting" button. */
export const NODE_SETTING_NOTE = 'Set this on the store node in the pipeline editor; this console cannot change node settings.';

/** The button's hover text: where the setting lives. */
export const NODE_SETTING_FIELD = "The store node's Retrieval Score field holds this value";

/** Why the setting cannot be copied. */
export const NODE_SETTING_RANGE = 'The store node takes a threshold from 0 to 1.';

/**
 * What "Copy as node setting" copies.
 *
 * @param at - The slider position.
 * @returns `threshold_search: 0.42`, or null outside the 0..1 the node accepts.
 */
export function nodeSettingText(at: number): string | null {
	if (!Number.isFinite(at) || at < 0 || at > 1) return null;
	return `threshold_search: ${at.toFixed(2)}`;
}

/**
 * A row's score as hover text: the formula, or what the number is when it is no similarity.
 *
 * @param row - The row.
 * @param score - `dialect.score`, or null.
 * @returns The text.
 */
export function scoreTitle(row: WorkbenchRow, score: IScoreInfo | null): string {
	const fused = row.fused !== null && row.semanticRank !== null && row.keywordRank !== null ? `; fused here: 1/(${RRF_K} + ${row.semanticRank}) + 1/(${RRF_K} + ${row.keywordRank}) = ${row.fused.toFixed(4)}` : row.fused !== null ? `; fused here: ${row.fused.toFixed(4)}` : '';
	if (row.score === null) return `Found by keyword; a keyword result carries no similarity${fused}`;
	const formula = score?.formula && score.formula !== 'unknown' ? ` (${score.formula}${score.higher_is_better === false ? ', lower is better' : ''})` : '';
	return `Score ${row.score}${formula}${fused}`;
}

// ── A run ───────────────────────────────────────────────────────────────────

/** How long each call may take. */
export const CALL_TIMEOUT_MS = 60_000;

/** What a run needs from the panel: the call, and where it is. */
export interface WorkbenchDeps {
	/** Call one tool on one node (the panel passes chat/toolCalls' callTool). */
	call(tool: 'embed' | 'search', input: Record<string, unknown>, nodeId: string): Promise<CallOutcome>;
	/** The run moved on. */
	onPhase?(phase: 'embedding' | 'searching'): void;
}

/** One run's request. */
export interface WorkbenchRequest {
	question: string;
	mode: SearchMode;
	topK: number;
	limits: IVectorLimits;
	storeNode: string;
	embedNode: string | null;
	/** The scope's ids, or null for the whole collection. */
	objectIds: readonly string[] | null;
	/** What "Open in Search" brought: its cited chunks are marked on a run of its question only. */
	chat?: ChatPrefill | null;
}

/** A finished run. Holds no vector. */
export interface WorkbenchRun {
	question: string;
	mode: SearchMode;
	/** What the store did: 'keyword' when an Auto (or Semantic) search came back by keyword. */
	modeUsed: 'semantic' | 'keyword' | 'hybrid';
	rows: WorkbenchRow[];
	/** True when the rows carry similarities (the slider applies). */
	rated: boolean;
	warnings: string[];
	keywordFallback: boolean;
	modelMismatch: boolean;
	embeddingModel: string | null;
	/** Documents in scope, or null without one. */
	scoped: number | null;
	/** The chat answer behind this run: set only when its question is the one "Open in Search" brought. */
	fromChat: RunFromChat | null;
}

/** A run's outcome. */
export type WorkbenchOutcome = { ok: true; run: WorkbenchRun } | { ok: false; stage: 'input' | 'embed' | 'search'; code: string | null; message: string; retryAfterS: number | null };

/**
 * Seconds to wait before embedding again, from a RATE_LIMITED failure.
 *
 * @param outcome - The failed call.
 * @returns retry_after_s, or null.
 */
export function retryAfterSeconds(outcome: Extract<CallOutcome, { ok: false }>): number | null {
	const error = outcome.error;
	if (error !== null && typeof error === 'object') return num((error as Record<string, unknown>).retry_after_s);
	return null;
}

/**
 * Whole seconds left until `until`.
 *
 * @param until - Epoch ms.
 * @param now - Epoch ms.
 * @returns Seconds, at least 0.
 */
export function secondsLeft(until: number, now: number): number {
	return Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * The countdown line while the embedding node refuses new questions.
 *
 * @param seconds - Seconds left.
 * @returns The sentence.
 */
export function rateLimitSentence(seconds: number): string {
	return `Too many searches were embedded in the last minute. Run again in ${Math.max(0, Math.ceil(seconds))} s.`;
}

/**
 * A failure outcome.
 *
 * @param stage - Where it failed.
 * @param code - The code, or null.
 * @param message - The sentence.
 * @param retryAfterS - Seconds to wait, or null.
 * @returns The outcome.
 */
function failed(stage: 'input' | 'embed' | 'search', code: string | null, message: string, retryAfterS: number | null = null): WorkbenchOutcome {
	return { ok: false, stage, code, message, retryAfterS };
}

/**
 * Why the question could not be embedded.
 *
 * @param outcome - The failed `embed` call.
 * @returns The outcome.
 */
function embedFailure(outcome: Extract<CallOutcome, { ok: false }>): WorkbenchOutcome {
	if (outcome.code === 'RATE_LIMITED') {
		const wait = retryAfterSeconds(outcome) ?? 60;
		return failed('embed', 'RATE_LIMITED', rateLimitSentence(wait), wait);
	}
	if (outcome.kind === 'timeout') return failed('embed', outcome.code, 'The embedding node did not answer in time. Try again.');
	return failed('embed', outcome.code, `The embedding node could not embed the question: ${outcome.message}`);
}

/**
 * Why a search failed.
 *
 * @param outcome - The failed `search` call.
 * @returns The outcome.
 */
function searchFailure(outcome: Extract<CallOutcome, { ok: false }>): WorkbenchOutcome {
	if (outcome.kind === 'timeout' || outcome.code === 'TIMEOUT') return failed('search', outcome.code, 'The store did not answer in time. Try again.');
	return failed('search', outcome.code, `The store refused the search: ${outcome.message}`);
}

/**
 * Run one search: embed (when the mode needs it), search, and in Hybrid search
 * by keyword too and fuse. The vector `embed` returned is a local here, sent
 * once to `search` and dropped.
 *
 * @param deps - The call and the phase callback.
 * @param request - The run.
 * @returns The run, or why it failed.
 */
export async function runWorkbench(deps: WorkbenchDeps, request: WorkbenchRequest): Promise<WorkbenchOutcome> {
	const question = request.question.trim();
	if (question === '') return failed('input', null, 'Type a question to search for.');
	const steps = plan(request.mode);
	const topK = clampTopK(request.topK, request.limits);
	const previewChars = Number.isFinite(request.limits.snippet_chars) && request.limits.snippet_chars > 0 ? request.limits.snippet_chars : PREVIEW_CHARS;
	const { cited, fromChat } = chatTie(request.chat ?? null, question, request.objectIds);
	let semantic: ISearchResult | null = null;
	let keyword: ISearchResult | null = null;
	let embeddingModel: string | null = null;

	if (steps.embed) {
		if (request.embedNode === null || request.embedNode === '') return failed('input', null, QUERY_NEEDS_EMBED);
		deps.onPhase?.('embedding');
		const embedded = await deps.call('embed', { ...embedInput(question) }, request.embedNode);
		if (!embedded.ok) return embedFailure(embedded);
		const vectors = embedded.value.vectors;
		const vector = Array.isArray(vectors) && Array.isArray(vectors[0]) ? (vectors[0] as number[]) : null;
		if (vector === null) return failed('embed', null, 'The embedding node answered without a vector.');
		embeddingModel = typeof embedded.value.model === 'string' ? embedded.value.model : null;
		deps.onPhase?.('searching');
		const searched = await deps.call('search', { ...semanticSearchInput(vector, embeddingModel, question, topK, request.limits, steps.searches[0] === 'auto' ? 'auto' : 'semantic', request.objectIds) }, request.storeNode);
		if (!searched.ok) return searchFailure(searched);
		semantic = searched.value as unknown as ISearchResult;
	}
	if (steps.searches.includes('keyword')) {
		deps.onPhase?.('searching');
		const searched = await deps.call('search', { ...keywordSearchInput(question, topK, request.limits, request.objectIds) }, request.storeNode);
		if (!searched.ok) return searchFailure(searched);
		keyword = searched.value as unknown as ISearchResult;
	}

	// Fallback and model warnings belong to the semantic answer; a keyword answer's own warnings are not a fallback.
	const warnings = semantic !== null && Array.isArray(semantic.warnings) ? semantic.warnings.filter((w): w is string => typeof w === 'string') : [];
	const keywordFallback = semantic !== null && (semantic.mode_used === 'keyword' || warnings.includes('keyword_fallback'));
	const rated = semantic !== null && !keywordFallback;
	let rows: WorkbenchRow[];
	let modeUsed: WorkbenchRun['modeUsed'];
	if (semantic !== null && keyword !== null) {
		rows = fuse(rowsFromSearch(semantic, rated, cited, previewChars), rowsFromSearch(keyword, false, cited, previewChars), RRF_K, topK);
		modeUsed = 'hybrid';
	} else if (semantic !== null) {
		rows = rowsFromSearch(semantic, rated, cited, previewChars);
		modeUsed = rated ? 'semantic' : 'keyword';
	} else {
		rows = rowsFromSearch(keyword as ISearchResult, false, cited, previewChars);
		modeUsed = 'keyword';
	}
	return {
		ok: true,
		run: {
			question,
			mode: request.mode,
			modeUsed,
			rows,
			rated,
			warnings,
			keywordFallback,
			modelMismatch: warnings.includes('model_mismatch'),
			embeddingModel,
			scoped: request.objectIds !== null ? request.objectIds.length : null,
			fromChat,
		},
	};
}

/**
 * The caption over a run's table: "Semantic search: 20 results".
 *
 * @param run - The run.
 * @returns The words.
 */
export function runCaption(run: WorkbenchRun): string {
	const n = run.rows.length === 1 ? '1 result' : `${run.rows.length} results`;
	if (run.modeUsed === 'hybrid') return `Hybrid search: ${n}, ${HYBRID_LABEL} by reciprocal rank fusion (k = ${RRF_K})`;
	return `${run.modeUsed === 'semantic' ? 'Semantic' : 'Keyword'} search: ${n}`;
}

/**
 * The line when a run found nothing.
 *
 * @param run - The run.
 * @returns The sentence.
 */
export function noResultsSentence(run: Pick<WorkbenchRun, 'question'>): string {
	return `No chunks matched “${run.question}”.`;
}

/** Re-exported for the panel: the model-mismatch banner's words. */
export { MODEL_MISMATCH_SENTENCE };

// ── From the chat ("Open in Search") ────────────────────────────────────────

/** What "Open in Search" brings from the chat: the question, the chunks its answer cited, and how "Why these?" searched. */
export interface ChatPrefill {
	question: string;
	/** The chunks the answer cited. */
	cited: readonly VectorKey[];
	/** The k "Why these?" searched with; absent: the panel picks one that shows the cited chunks plus ten. */
	topK?: number | null;
	/** The documents the question was asked about ("Why these?" searched only them); null or absent: the whole collection. */
	objectIds?: readonly string[] | null;
}

/** A run's tie to the chat answer "Open in Search" brought. */
export interface RunFromChat {
	/** Chunks the answer cited. */
	cited: number;
	/** Documents the question was asked about, or null for the whole collection. */
	askedAbout: number | null;
	/** The run searched what the answer did: the whole collection both, or the same documents. */
	sameScope: boolean;
}

/**
 * Some documents, or null for none (an empty list is the whole collection, as the chat sends it).
 *
 * @param objectIds - The ids, or null.
 * @returns A copy, or null.
 */
function scopeIds(objectIds: readonly string[] | null | undefined): string[] | null {
	return objectIds && objectIds.length > 0 ? [...objectIds] : null;
}

/**
 * Whether two scopes cover the same documents (null is the whole collection).
 *
 * @param a - A scope.
 * @param b - Another.
 * @returns True when they are the same set.
 */
function sameScope(a: readonly string[] | null, b: readonly string[] | null): boolean {
	if (a === null || b === null) return a === b;
	const set = new Set(a);
	return set.size === new Set(b).size && b.every((id) => set.has(id));
}

/**
 * The chat's citations for one run: a run of the question "Open in Search" brought carries them; any other carries none.
 *
 * @param chat - What "Open in Search" brought, or null.
 * @param question - The run's question (trimmed).
 * @param objectIds - The run's scope, or null.
 * @returns The keys to mark and the run's tie to the answer.
 */
function chatTie(chat: ChatPrefill | null, question: string, objectIds: readonly string[] | null): { cited: readonly VectorKey[]; fromChat: RunFromChat | null } {
	if (chat === null || chat.question.trim() !== question.trim()) return { cited: [], fromChat: null };
	const askedAbout = scopeIds(chat.objectIds);
	return { cited: chat.cited, fromChat: { cited: chat.cited.length, askedAbout: askedAbout !== null ? askedAbout.length : null, sameScope: sameScope(askedAbout, scopeIds(objectIds)) } };
}

/**
 * Some documents in words.
 *
 * @param n - How many.
 * @returns "1 document", "4 documents".
 */
function documents(n: number): string {
	return n === 1 ? '1 document' : `${n.toLocaleString('en-US')} documents`;
}

/**
 * The line over a run of the question "Open in Search" brought: how many of
 * the answer's cited chunks it lists, and whether it searched what the answer did.
 *
 * @param run - The run's rows, its tie to the answer and its scope.
 * @param scopeOn - Run searches within the console's scope.
 * @returns The line, or null on any other run.
 */
export function fromChatLine(run: { rows: readonly Pick<WorkbenchRow, 'cited'>[]; fromChat: RunFromChat | null; scoped: number | null }, scopeOn: boolean): string | null {
	const tie = run.fromChat;
	if (tie === null) return null;
	const n = tie.cited;
	const listed = run.rows.filter((row) => row.cited).length;
	let line: string;
	if (n === 0) line = 'From the chat: its answer cited no chunks.';
	else if (listed >= n) line = n === 1 ? 'From the chat: the chunk its answer cited is marked “cited”.' : `From the chat: the ${n} chunks its answer cited are marked “cited”.`;
	else if (listed === 0) line = n === 1 ? 'From the chat: the chunk its answer cited is not in these results.' : `From the chat: none of the ${n} chunks its answer cited is in these results.`;
	else line = `From the chat: ${listed} of the ${n} chunks its answer cited ${listed === 1 ? 'is' : 'are'} in these results, marked “cited”.`;
	if (tie.sameScope) {
		if (tie.askedAbout !== null) return `${line} Searched only the ${tie.askedAbout === 1 ? 'document' : `${tie.askedAbout.toLocaleString('en-US')} documents`} the question was asked about, as the answer did.`;
		return scopeOn ? `${line} Searched the whole collection, as the answer did; Run searches within the scope.` : line;
	}
	if (tie.askedAbout === null) return `${line} Searched within the scope; the answer was not.`;
	return `${line} The question was asked about ${documents(tie.askedAbout)} only; this search ${run.scoped === null ? 'covered the whole collection' : 'used the scope instead'}.`;
}

/**
 * What "Why these?" hands Search: the question, the answer's cited chunks, the k it searched with and the documents it searched.
 *
 * @param question - The question.
 * @param answerSources - The answer's citations.
 * @param answerTopK - The answer's k (the debugger asks for it plus ten).
 * @param limits - The node's limits, or null.
 * @param objectIds - The documents the question was asked about, or null.
 * @returns The prefill.
 */
export function openInSearchPrefill(question: string, answerSources: readonly IChatSource[], answerTopK: number, limits: Pick<IVectorLimits, 'top_k_max'> | null, objectIds: readonly string[] | null): ChatPrefill {
	return { question, cited: answerSources.map((source) => source.key), topK: debuggerTopK(answerTopK, limits), objectIds: scopeIds(objectIds) };
}

/**
 * The smallest offered k that shows the cited chunks plus ten (as the debugger does), else the largest.
 *
 * @param options - The offered k.
 * @param cited - How many chunks the answer cited.
 * @returns k.
 */
function topKFor(options: readonly number[], cited: number): number {
	const want = cited + DEBUGGER_EXTRA;
	return options.find((k) => k >= want) ?? options[options.length - 1] ?? DEFAULT_TOP_K;
}

/** The run "Open in Search" starts. */
export interface PrefillRun {
	question: string;
	/** Semantic (as "Why these?" searched) when offered, else the panel's default; null when nothing can run. */
	mode: SearchMode | null;
	topK: number;
	/** The documents the question was asked about, or null for the whole collection. */
	objectIds: string[] | null;
}

/**
 * The run "Open in Search" starts: the search "Why these?" made (Semantic, its k, its documents), so both list the same rows.
 *
 * @param prefill - What "Open in Search" brought.
 * @param options - {@link modeOptions}.
 * @param ks - {@link topKOptions}.
 * @returns The run.
 */
export function prefillRun(prefill: ChatPrefill, options: readonly ModeOption[], ks: readonly number[]): PrefillRun {
	const mode = options.find((o) => o.mode === 'semantic')?.enabled ? 'semantic' : defaultMode(options);
	const given = prefill.topK;
	const topK = typeof given === 'number' && Number.isFinite(given) && given >= 1 ? Math.floor(given) : topKFor(ks, prefill.cited.length);
	return { question: prefill.question, mode, topK, objectIds: scopeIds(prefill.objectIds) };
}

/**
 * The k the panel offers: {@link topKOptions}, plus the current k when "Open in Search" brought another.
 *
 * @param ks - {@link topKOptions}.
 * @param current - The panel's k.
 * @returns The choices, ascending.
 */
export function topKChoices(ks: readonly number[], current: number): number[] {
	return ks.includes(current) ? [...ks] : [...ks, current].sort((a, b) => a - b);
}

// ── Export ──────────────────────────────────────────────────────────────────

/**
 * A run's rows as an export (the search columns; words, never vectors).
 *
 * @param view - The rows at the slider (statuses as on screen).
 * @param run - 'A' or 'B' to add a leading `run` column (the "both" export), else none.
 * @returns The rows.
 */
export function workbenchExportRows(view: Classification, run?: 'A' | 'B'): IExportRows {
	const columns = run ? ['run', ...EXPORT_COLUMNS.search] : [...EXPORT_COLUMNS.search];
	return {
		columns,
		rows: view.rows.map((row) => ({
			...(run ? { run } : {}),
			rank: row.rank,
			objectId: row.objectId,
			chunkId: row.chunkId,
			path: row.path,
			score: row.score,
			raw_score: row.rawScore,
			status: STATUS_WORDS[row.status],
			cited: row.cited,
			preview: row.preview,
		})),
	};
}

/**
 * The Search panel's export entries: its results, and with Compare B's and both.
 *
 * @param a - Run A at the slider, or null before a run.
 * @param b - Run B at the slider, or null.
 * @returns The entries.
 */
export function searchExportItems(a: Classification | null, b: Classification | null): IExportItem[] {
	const count = (view: Classification): string => (view.rows.length === 1 ? '1 row' : `${view.rows.length} rows`);
	if (a === null) return [{ id: 'search-a', label: 'Search results', kind: 'search', disabled: 'Run a search first' }];
	if (b === null) return [{ id: 'search-a', label: `Search results (${count(a)})`, kind: 'search', disabled: null, rows: () => workbenchExportRows(a) }];
	return [
		{ id: 'search-a', label: `Search A results (${count(a)})`, kind: 'search', disabled: null, rows: () => workbenchExportRows(a) },
		{ id: 'search-b', label: `Search B results (${count(b)})`, kind: 'search', disabled: null, rows: () => workbenchExportRows(b) },
		{
			id: 'search-both',
			label: `A and B (${a.rows.length + b.rows.length} rows)`,
			kind: 'search',
			disabled: null,
			rows: () => {
				const rowsA = workbenchExportRows(a, 'A');
				return { columns: rowsA.columns, rows: [...rowsA.rows, ...workbenchExportRows(b, 'B').rows] };
			},
		},
	];
}

/**
 * The "Why these?" debugger's rows as an export (the search columns, its own status words).
 *
 * @param view - The debugger's view.
 * @param words - The debugger's status words.
 * @returns The rows.
 */
export function retrievalExportRows(view: RetrievalView, words: Readonly<Record<RetrievalStatus, string>>): IExportRows {
	return {
		columns: [...EXPORT_COLUMNS.search],
		rows: view.rows.map((row) => ({
			rank: row.rank,
			objectId: row.objectId,
			chunkId: row.chunkId,
			path: row.path,
			score: row.score,
			raw_score: row.rawScore,
			status: words[row.status],
			cited: row.inAnswer,
			preview: previewOf(row.preview),
		})),
	};
}

// ── The map ─────────────────────────────────────────────────────────────────

/**
 * Show search results on the map: the map is told the question (and that
 * there is no second one) before the highlight brings it to the front, so it
 * can place the question's star; the rows are highlighted as search results.
 *
 * @param selection - The connection's selection.
 * @param actions - The console's actions.
 * @param question - The question searched for.
 * @param keys - The rows to highlight.
 */
export function showSearchOnMap(selection: Pick<SelectionStore, 'setQuery' | 'clearQueryB'>, actions: Pick<ConsoleActions, 'showOnMap'>, question: string, keys: readonly VectorKey[]): void {
	selection.setQuery(question);
	selection.clearQueryB();
	actions.showOnMap(keys, 'search');
}
