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
// VECTOR - COLLECTION CHARTS (pure): the bins of the stats strip's four charts
// =============================================================================
//
// Four small charts over what the console already holds, with no call of
// their own: chunks per document (powers-of-two bins over the directory's
// loaded rows), chunk length (from the map's sample, its pinned points left
// out), documents by file type, and documents ingested over time (by day,
// week, month, quarter or year by the span, never more than MAX_PERIOD_BINS
// bars; times outside 2000 to a year from now are shown apart as "before" and
// "after" bars). Each says where its numbers come from and how much of the
// collection that is ("5 of 42 documents loaded"), never an estimate; a bar
// whose documents the store can be asked for carries the scope a click
// applies (a chunk range, a file type, a period).
// =============================================================================

import type { IDialectResult, IDocumentItem, IDocumentsFilter, ISampleModel } from '../contract/types';
import { extensionOf } from './fileType';
import { isFilterExtension } from './filters';

// =============================================================================
// BINS
// =============================================================================

/** One bar. */
export interface IBin {
	key: string;
	label: string;
	/** Inclusive bounds (integers for counts and lengths; epoch ms for periods). */
	lo: number;
	hi: number;
	count: number;
	/** The scope a click on it applies, or null when the store cannot be asked for it. */
	scope: IDocumentsFilter | null;
}

/**
 * The median.
 *
 * @param values - Numbers.
 * @returns The middle value (the mean of the two middles), or null for none.
 */
export function median(values: readonly number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Count values per bin: bin i holds [edges[i], edges[i + 1]); the last bin is
 * open above; values below the first edge are not counted.
 *
 * @param values - Numbers.
 * @param edges - Ascending lower edges.
 * @returns The counts, one per edge.
 */
export function binCounts(values: readonly number[], edges: readonly number[]): number[] {
	const counts = edges.map(() => 0);
	for (const v of values) {
		if (edges.length === 0 || v < (edges[0] as number)) continue;
		let lo = 0;
		let hi = edges.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if ((edges[mid] as number) <= v) lo = mid;
			else hi = mid - 1;
		}
		counts[lo] = (counts[lo] as number) + 1;
	}
	return counts;
}

/**
 * The smallest and largest of some numbers, in one pass. Spreading the
 * values into Math.min or Math.max passes each one as an argument, and past
 * about 125,000 of them (Load more, 25 times) V8 throws RangeError.
 *
 * @param values - Numbers (at least one; NaN is skipped).
 * @returns The smallest and the largest (Infinity and -Infinity for none).
 */
export function minMax(values: readonly number[]): { min: number; max: number } {
	let min = Infinity;
	let max = -Infinity;
	for (const v of values) {
		if (v < min) min = v;
		if (v > max) max = v;
	}
	return { min, max };
}

/** A range in words: '1', '2–3'. */
function rangeLabel(lo: number, hi: number): string {
	return lo === hi ? lo.toLocaleString('en-US') : `${lo.toLocaleString('en-US')}–${hi.toLocaleString('en-US')}`;
}

/**
 * Powers-of-two bins over counts (0; 1; 2–3; 4–7; …), contiguous from 1 (or 0
 * when a value is 0) to the bin of the largest value, empty bins kept.
 *
 * @param values - Non-negative integers.
 * @returns The bins (none for no values); each scopes to its range of chunks.
 */
export function logBins(values: readonly number[]): IBin[] {
	if (values.length === 0) return [];
	const { max } = minMax(values);
	const lows: number[] = values.some((v) => v < 1) ? [0] : [];
	for (let lo = 1; lo <= Math.max(1, max); lo *= 2) lows.push(lo);
	const counts = binCounts(values, lows);
	return lows.map((lo, i) => {
		const hi = lo === 0 ? 0 : lo * 2 - 1;
		return { key: `c${lo}`, label: rangeLabel(lo, hi), lo, hi, count: counts[i] as number, scope: { min_chunks: lo, max_chunks: hi } };
	});
}

/**
 * The step of at most `target` bins over [0, max]: 1, 2 or 5 times a power of ten.
 *
 * @param max - The largest value.
 * @param target - Bins wanted at most.
 * @returns The step (≥ 1).
 */
function niceStep(max: number, target: number): number {
	const raw = Math.max(1, max / target);
	const power = 10 ** Math.floor(Math.log10(raw));
	for (const m of [1, 2, 5, 10]) if (m * power >= raw) return m * power;
	return 10 * power;
}

/**
 * Equal-width bins of chunk lengths from 0 (at most 12, round widths).
 *
 * @param lengths - Characters per chunk.
 * @returns The bins (not scopes: the store cannot filter by length).
 */
export function lengthBins(lengths: readonly number[]): IBin[] {
	if (lengths.length === 0) return [];
	const { max } = minMax(lengths);
	const step = niceStep(max + 1, 10);
	const lows: number[] = [];
	for (let lo = 0; lo <= max; lo += step) lows.push(lo);
	const counts = binCounts(lengths, lows);
	return lows.map((lo, i) => ({ key: `l${lo}`, label: rangeLabel(lo, lo + step - 1), lo, hi: lo + step - 1, count: counts[i] as number, scope: null }));
}

/**
 * Documents by the extension of their file name (Windows, POSIX, share and
 * bare names alike): the most common first, ties by name; past `top` rows the
 * rest are one "other" bar.
 *
 * @param rows - The loaded documents.
 * @param top - Bars at most (default 8).
 * @returns The bins; a type's bar scopes to it when the node accepts it as an extension (not '15 meeting' from
 *   'Board 2026.10.15 meeting', 'db_old' or 'json-ld'; those bars are drawn, not clickable).
 */
export function byFileType(rows: readonly IDocumentItem[], top = 8): IBin[] {
	const NONE = '(no extension)';
	const counts = new Map<string, number>();
	for (const row of rows) {
		const ext = extensionOf(row.path) ?? NONE;
		counts.set(ext, (counts.get(ext) ?? 0) + 1);
	}
	const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	const bin = (ext: string, count: number, i: number): IBin => ({ key: `t${ext}`, label: ext, lo: i, hi: i, count, scope: ext !== NONE && isFilterExtension(ext) ? { file_types: [ext] } : null });
	if (sorted.length <= top) return sorted.map(([ext, count], i) => bin(ext, count, i));
	const kept = sorted.slice(0, top - 1).map(([ext, count], i) => bin(ext, count, i));
	const rest = sorted.slice(top - 1);
	kept.push({ key: 'tother', label: `other (${rest.length} types)`, lo: top - 1, hi: top - 1, count: rest.reduce((sum, [, n]) => sum + n, 0), scope: null });
	return kept;
}

// =============================================================================
// PERIODS
// =============================================================================

const DAY_MS = 86_400_000;

/** The ingest chart draws at most this many period bars (plus the "before" and "after" ones). */
export const MAX_PERIOD_BINS = 60;

/** Ingest times before this are shown apart (no vector store ingested anything earlier). */
const INGEST_EARLIEST_MS = Date.UTC(2000, 0, 1);

/** At most this many years of ingest times are binned, so even yearly bars stay under the cap. */
const INGEST_YEARS_MAX = 50;

/** How the ingest chart groups time, finest first. */
export type PeriodUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

const UNITS: readonly PeriodUnit[] = ['day', 'week', 'month', 'quarter', 'year'];

/** The start of the UTC period holding a time. */
function periodStart(ms: number, unit: PeriodUnit): number {
	const d = new Date(ms);
	if (unit === 'year') return Date.UTC(d.getUTCFullYear(), 0, 1);
	if (unit === 'quarter') return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
	if (unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
	const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
	if (unit === 'day') return day;
	return day - ((d.getUTCDay() + 6) % 7) * DAY_MS;
}

/** The start of the next period. */
function periodNext(start: number, unit: PeriodUnit): number {
	if (unit === 'day') return start + DAY_MS;
	if (unit === 'week') return start + 7 * DAY_MS;
	const d = new Date(start);
	if (unit === 'year') return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (unit === 'quarter' ? 3 : 1), 1);
}

/** How many periods of a unit run from `min` to `max` (counting stops past the cap). */
function periodCount(min: number, max: number, unit: PeriodUnit): number {
	let n = 0;
	for (let s = periodStart(min, unit); s <= max && n <= MAX_PERIOD_BINS; s = periodNext(s, unit)) n += 1;
	return n;
}

/** An ISO time without milliseconds. */
function iso(ms: number): string {
	return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/** A period's label: '2026-10-08', 'week of 2026-08-03', '2026-10', '2026 Q4', '2026'. */
function periodLabel(start: number, unit: PeriodUnit): string {
	const day = iso(start).slice(0, 10);
	switch (unit) {
		case 'day':
			return day;
		case 'week':
			return `week of ${day}`;
		case 'month':
			return day.slice(0, 7);
		case 'quarter':
			return `${day.slice(0, 4)} Q${Math.floor(new Date(start).getUTCMonth() / 3) + 1}`;
		case 'year':
			return day.slice(0, 4);
	}
}

/**
 * The ingest times the chart bins: from 2000 (or, decades on, the last 50
 * years) to a year after now, both as the first and last days kept.
 *
 * @param now - The console's clock (epoch ms).
 * @returns `from` (inclusive) and `to` (exclusive, the midnight after the last day), epoch ms.
 */
export function ingestWindow(now: number): { from: number; to: number } {
	const last = new Date(now + 365 * DAY_MS);
	const to = Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), last.getUTCDate() + 1);
	return { from: Math.max(INGEST_EARLIEST_MS, Date.UTC(last.getUTCFullYear() - INGEST_YEARS_MAX + 1, 0, 1)), to };
}

/**
 * Documents ingested per day (span within 31 days), week (Monday, UTC; within
 * 26 weeks), month, quarter or year: the finest of those that keeps at most
 * MAX_PERIOD_BINS bars, every period from the first to the last kept. Times
 * outside {@link ingestWindow} (a sentinel such as 9999-12-31 or 1970-01-01)
 * are counted in a "before" and an "after" bar, which scope nothing.
 *
 * @param rows - The loaded documents.
 * @param now - The console's clock (epoch ms).
 * @returns The unit, the bins (each period scopes to itself), how many rows had an ingest time and how many of those are outside the window.
 */
export function byIngestPeriod(rows: readonly IDocumentItem[], now: number = Date.now()): { unit: PeriodUnit; bins: IBin[]; dated: number; outside: number } {
	const range = ingestWindow(now);
	const times: number[] = [];
	const before: number[] = [];
	const after: number[] = [];
	for (const row of rows) {
		if (row.ingestedAt === null) continue;
		const at = Date.parse(row.ingestedAt);
		if (!Number.isFinite(at)) continue;
		if (at < range.from) before.push(at);
		else if (at >= range.to) after.push(at);
		else times.push(at);
	}
	const dated = times.length + before.length + after.length;
	const outside = before.length + after.length;
	if (dated === 0) return { unit: 'day', bins: [], dated: 0, outside: 0 };
	const bins: IBin[] = [];
	if (before.length > 0) bins.push({ key: 'pbefore', label: `before ${iso(range.from).slice(0, 10)}`, lo: minMax(before).min, hi: range.from - 1, count: before.length, scope: null });
	let unit: PeriodUnit = 'day';
	if (times.length > 0) {
		const { min, max } = minMax(times);
		const spanDays = (periodStart(max, 'day') - periodStart(min, 'day')) / DAY_MS;
		const finest = spanDays <= 31 ? 0 : spanDays <= 7 * 26 ? 1 : 2;
		unit = UNITS.slice(finest).find((u) => periodCount(min, max, u) <= MAX_PERIOD_BINS) ?? 'year';
		const starts: number[] = [];
		for (let s = periodStart(min, unit); s <= max && starts.length < MAX_PERIOD_BINS; s = periodNext(s, unit)) starts.push(s);
		const counts = binCounts(times, starts);
		starts.forEach((start, i) => {
			const next = periodNext(start, unit);
			bins.push({ key: `p${start}`, label: periodLabel(start, unit), lo: start, hi: next - 1, count: counts[i] as number, scope: { ingested_after: iso(start), ingested_before: iso(next) } });
		});
	}
	if (after.length > 0) bins.push({ key: 'pafter', label: `after ${iso(range.to - DAY_MS).slice(0, 10)}`, lo: range.to, hi: minMax(after).max, count: after.length, scope: null });
	return { unit, bins, dated, outside };
}

// =============================================================================
// THE FOUR CHARTS
// =============================================================================

/** One chart of the strip. */
export interface IChart {
	id: 'chunks' | 'length' | 'types' | 'ingest';
	title: string;
	/** What the bars count ('documents', 'chunks'). */
	unit: string;
	bins: IBin[];
	/** Source and coverage. */
	caption: string;
	/** The text alternative (the figure's aria-label). */
	summary: string;
	/** Why the chart cannot be drawn, or null. */
	disabled: string | null;
	/** The directory is still loading (skeleton bars until it has rows). */
	loading: boolean;
	median: number | null;
}

/** What the charts read. */
export interface IChartsInput {
	/** The directory's loaded rows. */
	rows: readonly IDocumentItem[];
	/** Documents the store holds, when it counted them. */
	total: number | null;
	/** The map's sample, or null. */
	sample: ISampleModel | null;
	dialect: IDialectResult | null;
	/** The directory is still loading pages. */
	loading: boolean;
	/** The console's clock (epoch ms) for the ingest chart's window; default now. */
	now?: number;
}

/** A number with its noun. */
function plural(n: number, one: string, many: string): string {
	return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** A median in words (one decimal at most). */
function medianText(m: number): string {
	return (Math.round(m * 10) / 10).toLocaleString('en-US');
}

/** "5 of 42 documents loaded", or "5 documents" when everything is loaded. */
function coverage(loaded: number, total: number | null): string {
	return total !== null && total > loaded ? `${loaded.toLocaleString('en-US')} of ${plural(total, 'document', 'documents')} loaded` : plural(loaded, 'document', 'documents');
}

/**
 * The text alternative of a chart.
 *
 * @param title - The chart.
 * @param bins - Its bars.
 * @param unit - What the bars count.
 * @param suffix - Words after a bin's label ('chunks', '').
 * @returns e.g. 'Chunks per document, 4 documents in 7 bins: most in 4–7 (2); the top bin is 64–127 (1).'
 */
function summaryOf(title: string, bins: readonly IBin[], unit: string, suffix = ''): string {
	const total = bins.reduce((sum, b) => sum + b.count, 0);
	if (bins.length === 0 || total === 0) return `${title}: nothing to show.`;
	const most = bins.reduce((best, b) => (b.count > best.count ? b : best), bins[0] as IBin);
	const last = [...bins].reverse().find((b) => b.count > 0) as IBin;
	const tail = last === most ? '' : `; the top bin is ${last.label}${suffix} (${last.count.toLocaleString('en-US')})`;
	return `${title}, ${plural(total, unit.replace(/s$/, ''), unit)} in ${plural(bins.length, 'bin', 'bins')}: most in ${most.label}${suffix} (${most.count.toLocaleString('en-US')})${tail}.`;
}

/**
 * Chunks per document over the loaded rows.
 *
 * @param rows - The loaded rows.
 * @param total - Documents the store holds, when it counted them.
 * @returns The chart.
 */
export function chunksPerDocument(rows: readonly IDocumentItem[], total: number | null): IChart {
	const counted = rows.map((r) => r.chunks).filter((c): c is number => c !== null);
	const bins = logBins(counted);
	const m = median(counted);
	const parts = [coverage(rows.length, total)];
	if (m !== null) parts.push(`median ${medianText(m)} chunks`);
	if (counted.length < rows.length) parts.push(`${(rows.length - counted.length).toLocaleString('en-US')} without a count`);
	return {
		id: 'chunks',
		title: 'Chunks per document',
		unit: 'documents',
		bins,
		caption: parts.join(' · '),
		summary: summaryOf('Chunks per document', bins, 'documents'),
		disabled: rows.length > 0 && counted.length === 0 ? 'This store does not count chunks per document' : null,
		loading: false,
		median: m,
	};
}

/**
 * The stats strip's four charts.
 *
 * @param input - The loaded rows, the store's total, the map's sample, the dialect and whether the directory is loading.
 * @returns Chunks per document, chunk length, documents by file type, ingested over time.
 */
export function collectionCharts(input: IChartsInput): IChart[] {
	const { rows, total, sample, dialect, loading, now = Date.now() } = input;
	const skeleton = loading && rows.length === 0;

	const chunks = { ...chunksPerDocument(rows, total), loading };

	let lengths: number[] = [];
	if (sample !== null) {
		const points = sample.result.points;
		lengths = points.len.filter((_, i) => points.pinned[i] !== 1);
	}
	const lengthChartBins = lengthBins(lengths);
	const lm = median(lengths);
	const length: IChart = {
		id: 'length',
		title: 'Chunk length',
		unit: 'chunks',
		bins: lengthChartBins,
		caption: sample === null ? '' : `from the map's sample of ${plural(lengths.length, 'chunk', 'chunks')}${lm === null ? '' : ` · median ${medianText(lm)} characters`}`,
		summary: summaryOf('Chunk length in characters', lengthChartBins, 'chunks'),
		disabled: sample === null || lengths.length === 0 ? "Draw the map's sample to see chunk lengths" : null,
		loading: false,
		median: lm,
	};

	const typeBins = byFileType(rows);
	const types: IChart = { id: 'types', title: 'Documents by file type', unit: 'documents', bins: typeBins, caption: coverage(rows.length, total), summary: summaryOf('Documents by file type', typeBins, 'documents'), disabled: null, loading, median: null };

	const caveats = new Set(dialect?.caveats ?? []);
	const periods = byIngestPeriod(rows, now);
	let ingestDisabled: string | null = null;
	if (caveats.has('extras_not_stored')) ingestDisabled = 'This store does not keep ingest times';
	else if (rows.length > 0 && periods.dated === 0) ingestDisabled = 'No ingest times on the loaded documents';
	const undated = rows.length - periods.dated;
	const range = ingestWindow(now);
	const apart = periods.outside > 0 ? ` · ${plural(periods.outside, 'ingest time', 'ingest times')} outside ${iso(range.from).slice(0, 10)} to ${iso(range.to - DAY_MS).slice(0, 10)}, shown apart` : '';
	const ingest: IChart = {
		id: 'ingest',
		title: 'Ingested over time',
		unit: 'documents',
		bins: periods.bins,
		caption: `${periods.dated > periods.outside ? `by ${periods.unit} · ` : ''}${coverage(rows.length, total)}${undated > 0 && periods.dated > 0 ? ` · ${undated.toLocaleString('en-US')} without an ingest time` : ''}${apart}`,
		summary: summaryOf(`Documents ingested by ${periods.unit}`, periods.bins, 'documents'),
		disabled: ingestDisabled,
		loading,
		median: null,
	};

	return [chunks, length, types, ingest].map((chart) => (skeleton && chart.id !== 'length' ? { ...chart, loading: true } : chart));
}
