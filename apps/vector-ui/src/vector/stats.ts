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
// VECTOR - STATS STRIP (pure): figures, chips, refresh plan, "counts as of"
// =============================================================================
//
// The strip at the top of the console (R2). Every figure comes from the
// node's `stats` answer (and the probe's `dialect`); a figure the store did
// not count is "—" with a tooltip saying so, never an estimate. The legacy
// `count` (rows including the control record) appears only in the Chunks
// tooltip. Chips carry their whole message in their label.
//
// Refresh: `stats({mode:'full'})` when the console opens, after a removal or
// a completed upload and on Refresh; `stats({mode:'quick'})` at most every
// 15 s while the console is visible, which returns the raw count plus the
// node's cached figures, so the strip says "counts as of N s ago".
// =============================================================================

import type { IDialectResult } from '../contract/types';
import { QUICK_STATS_INTERVAL_MS } from './budgets';
import { formatSize } from './fileType';
import { HEALTH_KINDS, HEALTH_TITLES } from './health';
import type { IHealthSummary } from './health';
import type { IStatsView } from './results';
import { CAVEAT_SENTENCES, CODE_SENTENCES, EMPTY, caveatSentence } from './wording';

// =============================================================================
// FIGURES
// =============================================================================

/** One figure of the strip. */
export interface IStatFigure {
	key: 'documents' | 'chunks' | 'deleted' | 'avg' | 'model' | 'metric' | 'size';
	label: string;
	/** The text shown: a formatted number, or "—" when the store did not say. */
	value: string;
	tooltip: string | null;
	/** True when the value is "—". */
	missing: boolean;
}

/** The text of a figure the store did not give. */
export const MISSING = '—';

/**
 * A count, en-US grouping.
 *
 * @param n - The count.
 * @returns e.g. '1,318'.
 */
export function formatCount(n: number): string {
	return n.toLocaleString('en-US');
}

/**
 * A figure, or "—" with the reason.
 *
 * @param key - Which figure.
 * @param label - Its label.
 * @param value - The formatted value, or null when the store did not count it.
 * @param what - What could not be counted ("documents").
 * @param tooltip - The tooltip when there is a value.
 * @returns The figure.
 */
function figure(key: IStatFigure['key'], label: string, value: string | null, what: string, tooltip: string | null = null): IStatFigure {
	if (value === null) return { key, label, value: MISSING, tooltip: `This store cannot count ${what}.`, missing: true };
	return { key, label, value, tooltip, missing: false };
}

/**
 * The strip's figures.
 *
 * @param stats - The last `stats` answer, or null before the first.
 * @param dialect - The probe's answer, or null.
 * @returns Documents, Chunks, Deleted, Avg, Model and Metric, in that order, then Size when the dialect reports the bytes the collection takes.
 */
export function statsFigures(stats: IStatsView | null, dialect: IDialectResult | null): IStatFigure[] {
	const caveats = new Set([...(stats?.caveats ?? []), ...(dialect?.caveats ?? [])]);
	const fmt = (n: number | null | undefined): string | null => (n === null || n === undefined ? null : formatCount(n));
	const legacyRows = stats?.legacyCount !== null && stats?.legacyCount !== undefined ? `${formatCount(stats.legacyCount)} rows including the control record` : null;

	const documents = figure('documents', 'Documents', fmt(stats?.documents), 'documents', caveats.has('documents_by_first_chunk') ? CAVEAT_SENTENCES.documents_by_first_chunk : null);
	if (documents.missing && caveats.has('documents_by_first_chunk')) documents.tooltip = `${documents.tooltip} ${CAVEAT_SENTENCES.documents_by_first_chunk}`;
	const chunks = figure('chunks', 'Chunks', fmt(stats?.chunks), 'chunks', legacyRows);
	if (chunks.missing && legacyRows !== null) chunks.tooltip = `${chunks.tooltip} ${legacyRows}`;
	const avg = stats?.avgPerDocument;
	const model = stats?.model ?? dialect?.model ?? null;
	const dimension = stats?.dimension ?? dialect?.dimension ?? null;
	const metric = stats?.metric ?? dialect?.metric ?? null;
	const index = dialect?.index?.type ?? null;

	let modelFigure: IStatFigure;
	if (model === null && dimension === null) modelFigure = { key: 'model', label: 'Model', value: MISSING, tooltip: 'This store does not record its embedding model.', missing: true };
	else {
		const short = model === null ? 'unknown model' : (model.split('/').pop() ?? model);
		modelFigure = { key: 'model', label: 'Model', value: dimension === null ? short : `${short} · ${dimension}-d`, tooltip: model, missing: false };
	}
	const metricFigure: IStatFigure = metric === null && index === null ? { key: 'metric', label: 'Metric', value: MISSING, tooltip: 'This store does not report its metric or index.', missing: true } : { key: 'metric', label: 'Metric', value: [metric ?? 'unknown metric', index === null ? null : index.toUpperCase()].filter(Boolean).join(' · '), tooltip: null, missing: false };

	const figures = [documents, chunks, figure('deleted', 'Deleted', fmt(stats?.deleted), 'deleted chunks'), figure('avg', 'Avg', avg === null || avg === undefined ? null : `${(Math.round(avg * 10) / 10).toLocaleString('en-US')}/doc`, 'chunks per document'), modelFigure, metricFigure];
	// Size only joins the strip when the store reports it (pgvector: the table's total relation size); never a dash.
	const bytes = dialect?.size_bytes;
	if (typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0) figures.push({ key: 'size', label: 'Size', value: formatSize(bytes), tooltip: `${formatSize(bytes)} on the store (${formatCount(bytes)} bytes)`, missing: false });
	return figures;
}

// =============================================================================
// CHIPS
// =============================================================================

/** One chip under the figures. */
export interface IStatChip {
	key: string;
	label: string;
	tone: 'success' | 'info' | 'warning' | 'error' | 'muted';
	tooltip: string | null;
}

/** Chip labels for the caveats the strip shows (the directory shows its own: unsorted, paging). */
const CAVEAT_CHIPS: Readonly<Record<string, { label: string; tone: IStatChip['tone'] }>> = {
	brute_force_search: { label: 'Brute-force search', tone: 'info' },
	score_scale_raw: { label: 'Raw scores', tone: 'info' },
	score_scale_inverted_fixed: { label: 'Scores fixed', tone: 'info' },
	shared_org_table: { label: 'Shared table', tone: 'warning' },
	cloud_only_unverified: { label: 'Not run live', tone: 'warning' },
	extras_not_stored: { label: 'No file size or ingest time', tone: 'muted' },
	no_filtered_count: { label: 'Some counts unavailable', tone: 'muted' },
	document_count_capped: { label: 'Orphan count capped', tone: 'muted' },
	model_mismatch: { label: 'Model mismatch', tone: 'error' },
	meta_column_pending: { label: 'Metadata column pending', tone: 'warning' },
	filtered_search_may_underfill: { label: 'Filtered search may return fewer', tone: 'info' },
};

/** Caveats shown elsewhere (or as their own chip below), never as a caveat chip here. */
const NOT_A_CHIP: ReadonlySet<string> = new Set(['experimental', 'documents_by_first_chunk', 'documents_unsorted', 'documents_paging_unsupported', 'biased_sample']);

/**
 * The strip's chips, in a fixed order: support, writes, caveats, health.
 *
 * @param input - The dialect, the last stats and whether the connection is read-only.
 * @returns The chips.
 */
export function statsChips(input: { dialect: IDialectResult | null; stats: IStatsView | null; readOnly: boolean; health?: IHealthSummary | null }): IStatChip[] {
	const { dialect, stats, readOnly, health = null } = input;
	const chips: IStatChip[] = [];
	if (dialect) {
		chips.push(dialect.support === 'supported' ? { key: 'support', label: 'Supported', tone: 'success', tooltip: 'Run against a live server on new and legacy collections in this build.' } : { key: 'support', label: 'Experimental', tone: 'warning', tooltip: CAVEAT_SENTENCES.experimental });
	}
	if (readOnly) chips.push({ key: 'writes', label: 'Read-only', tone: 'muted', tooltip: `${EMPTY.readOnly}.` });
	else if (dialect) chips.push(dialect.allow_writes ? { key: 'writes', label: 'Writes on', tone: 'info', tooltip: 'Documents can be moved to the trash, restored and deleted from this console (allow_writes is on for this store node).' } : { key: 'writes', label: 'Writes off', tone: 'muted', tooltip: CODE_SENTENCES.WRITES_DISABLED });

	const caveats = [...new Set([...(dialect?.caveats ?? []), ...(stats?.caveats ?? [])])];
	if (dialect?.health.model_mismatch === true && !caveats.includes('model_mismatch')) caveats.push('model_mismatch');
	if (dialect?.health.meta_column === false && !caveats.includes('meta_column_pending')) caveats.push('meta_column_pending');
	for (const caveat of caveats) {
		if (NOT_A_CHIP.has(caveat)) continue;
		const known = CAVEAT_CHIPS[caveat];
		chips.push(known ? { key: caveat, label: known.label, tone: known.tone, tooltip: caveatSentence(caveat) } : { key: caveat, label: caveat.replace(/_/g, ' '), tone: 'muted', tooltip: null });
	}

	if (dialect?.health.control_record === false) chips.push({ key: 'repair', label: 'Repair needed', tone: 'error', tooltip: 'This collection has no control record, so its embedding model and dimension are not recorded.' });
	// Fresh stats win: the dialect is read at discovery (and again after a write), so a store found empty would
	// otherwise stay "Empty collection" beside the documents an upload just added.
	const missing = stats ? stats.collectionExists === false : dialect?.health.collection_exists === false;
	if (missing) chips.push({ key: 'empty', label: 'Empty collection', tone: 'muted', tooltip: CODE_SENTENCES.COLLECTION_MISSING });
	const orphans = stats?.withoutFirstChunk ?? 0;
	if (health !== null && health.flagged > 0) chips.push(attentionChip(health, stats?.withoutFirstChunk ?? null));
	else if (orphans > 0) chips.push({ key: 'orphans', label: `${formatCount(orphans)} without first chunk`, tone: 'warning', tooltip: `${formatCount(orphans)} ${orphans === 1 ? 'document has' : 'documents have'} lost its first chunk; the directory lists ${orphans === 1 ? 'it' : 'them'} under "Needs attention".` });
	return chips;
}

/**
 * The "N need attention" chip: documents of the loaded ones with a defect
 * (vector/health.ts needsAttention; oversize alone is not one), the breakdown
 * per flag in its tooltip, and the store's own count of
 * documents without a first chunk when it differs from the loaded one.
 *
 * @param health - The loaded documents' health.
 * @param storeOrphans - The store's count of documents without a first chunk, or null.
 * @returns The chip.
 */
function attentionChip(health: IHealthSummary, storeOrphans: number | null): IStatChip {
	const n = formatCount(health.flagged);
	const label = health.complete ? `${n} ${health.flagged === 1 ? 'needs' : 'need'} attention` : `${n} of ${formatCount(health.loaded)} loaded need attention`;
	const parts = HEALTH_KINDS.map((kind) => `${HEALTH_TITLES[kind]}: ${health.unreported.includes(kind) ? 'not reported' : formatCount(health.counts[kind])}`);
	let tooltip = `${parts.join(' · ')}. Counted over the ${formatCount(health.loaded)} ${health.loaded === 1 ? 'document' : 'documents'} loaded; the directory lists them under "Needs attention" and marks oversize documents in their folders.`;
	if (storeOrphans !== null && storeOrphans !== health.counts.no_first_chunk) tooltip += ` The store counts ${formatCount(storeOrphans)} ${storeOrphans === 1 ? 'document' : 'documents'} without a first chunk.`;
	return { key: 'attention', label, tone: 'warning', tooltip };
}

// =============================================================================
// REFRESH
// =============================================================================

/** What asked for a refresh. */
export type StatsTrigger = 'open' | 'write' | 'upload' | 'manual' | 'tick';

/**
 * Which `stats` mode to call now, if any. Before the first answer a tick asks
 * nothing, except after a failed call: then it asks again in full at the
 * quick-stats pace (a task that was restarting answers once it runs).
 *
 * @param trigger - What asked.
 * @param ctx - Whether the console is visible, when the last answer arrived (null: none yet), when the last call failed (null: none since), the time and whether a call is in flight.
 * @returns 'full', 'quick', or null for no call.
 */
export function statsRefreshPlan(trigger: StatsTrigger, ctx: { visible: boolean; lastAt: number | null; failedAt?: number | null; now: number; inFlight: boolean }): 'full' | 'quick' | null {
	if (trigger !== 'tick') return 'full';
	if (!ctx.visible || ctx.inFlight) return null;
	if (ctx.lastAt === null) {
		const failedAt = ctx.failedAt ?? null;
		return failedAt !== null && ctx.now - failedAt >= QUICK_STATS_INTERVAL_MS ? 'full' : null;
	}
	return ctx.now - ctx.lastAt >= QUICK_STATS_INTERVAL_MS ? 'quick' : null;
}

/**
 * "counts as of 12 s ago" from the node's `counts_as_of`.
 *
 * @param stats - The last answer, or null.
 * @param now - Epoch ms.
 * @returns The text, or null when the node gave no time.
 */
export function countsAsOfText(stats: IStatsView | null, now: number): string | null {
	if (stats === null || stats.countsAsOf === null) return null;
	const at = Date.parse(stats.countsAsOf);
	if (!Number.isFinite(at)) return null;
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return `counts as of ${seconds} s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `counts as of ${minutes} min ago`;
	return `counts as of ${new Date(at).toISOString().slice(11, 16)} UTC`;
}
