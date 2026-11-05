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
// VECTOR-UI — export: CSV and JSON of what the screen shows (pure)
// =============================================================================
//
// The rows of an export are the rows a host already shows: the map's sample,
// its lasso selection, its visible points, clusters, duplicates and outliers;
// the directory's loaded documents; a search's results. This module turns
// them into a file and never asks a store for anything: it imports no call
// module (tests/vector.objectId.grep.test.ts walks its imports).
//
//   CSV   RFC 4180: fields holding a comma, a quote or a line break are
//         quoted with inner quotes doubled; records end with CRLF; the
//         column names come first. A text cell starting with = + - @ (or a
//         tab or a carriage return) is prefixed with ' so a spreadsheet
//         shows it instead of running it as a formula. The file starts with
//         a UTF-8 byte-order mark so spreadsheets read non-ASCII paths.
//   JSON  { schema_version: 1, kind, collection, exported_at, columns,
//         count, rows } with each row's values as they are.
//   name  vector-explorer_<collection>_<kind>_<yyyymmdd-hhmm>.<ext> (local
//         time; the collection reduced to safe characters).
//
// Before either format, cleanRows drops what an export must never carry: a
// column named like a vector or a secret (embedding, vector, values, token,
// api_key, password, host, ...), any cell that is not a word, a number, a
// boolean or empty (a stored vector is an array: it is written as empty),
// numbers that are not finite, and chunk text longer than snippet_chars.
//
// Point rows: chunkId is the chunk's number in its document, chunk_index the
// point's number in the sample (the map's and the Table's index); x, y and z
// are where the point is drawn (the layout on screen when the host passes it,
// else the node's PCA; z is empty in 2D); cluster is the group after the
// map's minimum size (empty for noise), cluster_label its words.
//
// An export of more than LARGE_EXPORT_ROWS rows is written in steps that
// report progress and can be cancelled (nothing is downloaded then).
// =============================================================================

import { EXPORT_COLUMNS } from '../contract/types';
import type { ExportCell, ExportKind, IDocumentItem, IExportItem, IExportRows, ISampleModel, ISampleResult, VectorKey } from '../contract/types';

/** The JSON file's schema version. */
export const EXPORT_SCHEMA_VERSION = 1;

/** Above this many rows an export shows its progress and a Cancel button. */
export const LARGE_EXPORT_ROWS = 20_000;

/** Rows written between two progress reports of a large export. */
export const EXPORT_STEP_ROWS = 2_000;

/** The node's default snippet length, used when a caller gives none. */
export const DEFAULT_SNIPPET_CHARS = 120;

/** Text columns that are not chunk content are still capped (a path, a label). */
export const OTHER_TEXT_MAX = 1_024;

/** Characters the collection may keep in a file name. */
export const FILE_COLLECTION_MAX = 64;

/** A disabled item with nothing in it. */
export const NOTHING_SELECTED = 'Nothing selected';

/** The download did not start. */
export const BLOCKED_SENTENCE = 'Your browser blocked the download.';

/** The map picture could not be taken (no drawing context, or it was lost). */
export const MAP_NOT_DRAWN = 'The map is not drawn right now.';

/** A large export the user stopped. */
export const CANCELLED_SENTENCE = 'Export cancelled.';

/** The formats a menu offers. */
export type ExportFormat = 'csv' | 'json' | 'png';

/** Text a spreadsheet would run as a formula (OWASP's CSV-injection list). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** Columns that carry chunk text: clamped to snippet_chars. */
const CONTENT_COLUMNS = new Set(['snippet', 'preview', 'content', 'text']);

/** Columns an export never writes, whatever a host hands it: vectors and secrets. */
const FORBIDDEN_COLUMN = /^(embeddings?|vectors?|values|sparse_values|query_vector|queryvector|tokens?|access_token|refresh_token|id_token|api_?key|apikey|secret|client_secret|password|passwd|authorization|auth|bearer|cookie|dsn|connection(_string)?|host|hostname|port|url|uri|endpoint|config|settings)$/i;

// -----------------------------------------------------------------------------
// Cells and rows
// -----------------------------------------------------------------------------

/**
 * Guard one text cell against formula injection: a leading = + - @ (or a tab or
 * carriage return) is shown as text by prefixing a single quote.
 *
 * @param text - The cell's text.
 * @returns The text, guarded when needed.
 */
export function guardCell(text: string): string {
	return FORMULA_START.test(text) ? `'${text}` : text;
}

/**
 * Clamp text to `max` characters, the last one an ellipsis when cut.
 *
 * @param text - The text.
 * @param max - Most characters.
 * @returns The text, at most `max` characters.
 */
function clamp(text: string, max: number): string {
	if (max <= 0) return '';
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * One cell as an export may write it: words, finite numbers, booleans or empty.
 *
 * @param value - Whatever the row held.
 * @param column - Its column (content columns are clamped harder).
 * @param snippetChars - The snippet length.
 * @returns The cell.
 */
function cleanCell(value: unknown, column: string, snippetChars: number): ExportCell {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'boolean') return value;
	if (typeof value === 'string') return clamp(value, CONTENT_COLUMNS.has(column) ? snippetChars : OTHER_TEXT_MAX);
	// Arrays (a stored vector), typed arrays, objects, functions: never written.
	return null;
}

/**
 * Rows this module cleaned, with the snippet length they were cleaned at.
 * runExport keeps that length (the store's snippet_chars, which the row
 * builders were given); rows a host built by hand are clamped at the node's
 * default instead, since the menu's props carry no limits.
 */
const CLEANED_AT = new WeakMap<IExportRows, number>();

/** Options of {@link cleanRows}. */
export interface ICleanOptions {
	/** The store's snippet length (dialect.limits.snippet_chars). */
	snippetChars?: number;
}

/**
 * The rows an export may write: forbidden columns dropped, only the columns
 * kept, every cell a word, a finite number, a boolean or empty, content
 * clamped to snippet_chars.
 *
 * @param rows - The host's rows.
 * @param options - The snippet length.
 * @returns Clean rows (new objects; the input is not changed).
 */
export function cleanRows(rows: IExportRows, options: ICleanOptions = {}): IExportRows {
	const snippetChars = options.snippetChars ?? DEFAULT_SNIPPET_CHARS;
	const columns = rows.columns.filter((c) => typeof c === 'string' && c !== '' && !FORBIDDEN_COLUMN.test(c));
	const out = rows.rows.map((row) => {
		const clean: Record<string, ExportCell> = {};
		for (const column of columns) clean[column] = cleanCell((row as Record<string, unknown>)[column], column, snippetChars);
		return clean;
	});
	const cleaned = { columns, rows: out };
	CLEANED_AT.set(cleaned, snippetChars);
	return cleaned;
}

/**
 * One CSV field: guarded text, quoted when it holds a comma, a quote or a line break.
 *
 * @param cell - The cell.
 * @returns The field.
 */
export function csvField(cell: ExportCell): string {
	if (cell === null) return '';
	if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
	const text = guardCell(cell);
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * One CSV record.
 *
 * @param columns - The columns.
 * @param row - A clean row.
 * @returns The record with its CRLF.
 */
function csvRecord(columns: readonly string[], row: Readonly<Record<string, ExportCell>>): string {
	return `${columns.map((c) => csvField(row[c] ?? null)).join(',')}\r\n`;
}

/**
 * Rows as RFC 4180 CSV (the column names first, CRLF after every record).
 *
 * @param rows - The rows (cleaned here).
 * @param options - The snippet length.
 * @returns The CSV text (without the byte-order mark the file adds).
 */
export function toCsv(rows: IExportRows, options: ICleanOptions = {}): string {
	const clean = cleanRows(rows, options);
	let text = csvRecord(clean.columns, Object.fromEntries(clean.columns.map((c) => [c, c])));
	for (const row of clean.rows) text += csvRecord(clean.columns, row);
	return text;
}

/** What the JSON file says about itself. */
export interface IJsonMeta {
	kind: ExportKind;
	collection: string | null;
	exportedAt: Date;
}

/**
 * The JSON head (everything before the rows), and the rows' opening.
 *
 * @param columns - Clean columns.
 * @param count - Rows.
 * @param meta - Kind, collection, time.
 * @returns The text up to and including `"rows": [`.
 */
function jsonHead(columns: readonly string[], count: number, meta: IJsonMeta): string {
	const head = { schema_version: EXPORT_SCHEMA_VERSION, kind: meta.kind, collection: meta.collection, exported_at: meta.exportedAt.toISOString(), columns, count };
	const text = JSON.stringify(head, null, '\t');
	return `${text.slice(0, -2)},\n\t"rows": [`;
}

/**
 * One JSON row (the columns in order).
 *
 * @param columns - Clean columns.
 * @param row - A clean row.
 * @param first - Whether it is the first row.
 * @returns The row's text.
 */
function jsonRow(columns: readonly string[], row: Readonly<Record<string, ExportCell>>, first: boolean): string {
	const ordered: Record<string, ExportCell> = {};
	for (const c of columns) ordered[c] = row[c] ?? null;
	return `${first ? '' : ','}\n\t\t${JSON.stringify(ordered)}`;
}

/**
 * Rows as the export's JSON document (schema_version 1).
 *
 * @param rows - The rows (cleaned here).
 * @param meta - Kind, collection and time.
 * @param options - The snippet length.
 * @returns The JSON text.
 */
export function toJson(rows: IExportRows, meta: IJsonMeta, options: ICleanOptions = {}): string {
	const clean = cleanRows(rows, options);
	let text = jsonHead(clean.columns, clean.rows.length, meta);
	clean.rows.forEach((row, i) => {
		text += jsonRow(clean.columns, row, i === 0);
	});
	return `${text}${clean.rows.length > 0 ? '\n\t' : ''}]\n}\n`;
}

/**
 * Two digits.
 *
 * @param n - A number below 100.
 * @returns It, zero-padded.
 */
function two(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * The file-name stamp yyyymmdd-hhmm in local time.
 *
 * @param at - The time.
 * @returns The stamp.
 */
export function fileStamp(at: Date): string {
	return `${at.getFullYear()}${two(at.getMonth() + 1)}${two(at.getDate())}-${two(at.getHours())}${two(at.getMinutes())}`;
}

/**
 * The collection as a file-name part: letters, digits, dot, dash and underscore.
 *
 * @param collection - The collection, or null.
 * @returns At most FILE_COLLECTION_MAX safe characters ('collection' when nothing is left).
 */
function safeCollection(collection: string | null): string {
	const safe = (collection ?? '')
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '')
		.slice(0, FILE_COLLECTION_MAX);
	return safe === '' ? 'collection' : safe;
}

/**
 * The export's file name.
 *
 * @param collection - The collection, or null.
 * @param kind - What is exported.
 * @param ext - csv, json or png.
 * @param at - When.
 * @returns vector-explorer_<collection>_<kind>_<yyyymmdd-hhmm>.<ext>.
 */
export function fileName(collection: string | null, kind: ExportKind, ext: ExportFormat, at: Date): string {
	return `vector-explorer_${safeCollection(collection)}_${kind}_${fileStamp(at)}.${ext}`;
}

/**
 * en-US count.
 *
 * @param n - A count.
 * @returns E.g. '1,340'.
 */
function count(n: number): string {
	return n.toLocaleString('en-US');
}

/**
 * "N point(s)".
 *
 * @param n - A count.
 * @param word - Singular noun.
 * @returns E.g. '1 point', '40 points'.
 */
function plural(n: number, word: string): string {
	return `${count(n)} ${word}${n === 1 ? '' : 's'}`;
}

// -----------------------------------------------------------------------------
// The map's rows
// -----------------------------------------------------------------------------

/** Where the points are drawn (the layout on screen), interleaved per point. */
export interface IExportPositions {
	xy: ArrayLike<number>;
	dims: 2 | 3;
}

/** What {@link pointRows} reads. */
export interface IPointRowsInput {
	sample: ISampleResult;
	/** Points to export, in order (default: every point not hidden). */
	indices?: readonly number[] | null;
	/** 1 per point not drawn (removed documents, isolation); skipped when `indices` is not given. */
	hidden?: ArrayLike<number> | null;
	/** The layout on screen; default the node's PCA coordinates. */
	positions?: IExportPositions | null;
	/** Cluster per point after the map's minimum size (-1 = none); default `sample.clusters.labels`. */
	clusterLabels?: ArrayLike<number> | null;
	/** A cluster's words; default its keywords joined by " · ", or "group <n>". */
	clusterName?: ((cluster: number) => string | null) | null;
	/** Similarity of every point to the active query, or null. */
	querySimilarity?: ArrayLike<number> | null;
	snippetChars: number;
}

/**
 * A cluster's words as the map's Clusters tab shows them.
 *
 * @param sample - The answer.
 * @param cluster - Its number.
 * @returns "falcon · orchid", or "group 14" for an unlabelled group.
 */
export function clusterWords(sample: ISampleResult, cluster: number): string {
	const words = sample.clusters?.keywords?.[cluster] ?? [];
	return words.length > 0 ? words.slice(0, 5).join(' · ') : `group ${cluster}`;
}

/**
 * Point rows (the frozen points column set) of a sample.
 *
 * @param input - Sample, points and what the map computed for them.
 * @returns The rows, one per point.
 */
export function pointRows(input: IPointRowsInput): IExportRows {
	const { sample } = input;
	const n = sample.n;
	const indices = input.indices ?? Array.from({ length: n }, (_, i) => i).filter((i) => !(input.hidden && input.hidden[i]));
	const dup = new Set<number>();
	for (const pair of sample.duplicates ?? []) {
		dup.add(pair.a);
		dup.add(pair.b);
	}
	const outliers = new Set(sample.outliers ?? []);
	const labels = input.clusterLabels ?? sample.clusters?.labels ?? null;
	const name = input.clusterName ?? ((c: number) => clusterWords(sample, c));
	const sims = input.querySimilarity ?? null;
	const positions = input.positions ?? null;
	const rows = indices
		.filter((i) => Number.isInteger(i) && i >= 0 && i < n)
		.map((i) => {
			const doc = sample.docs[sample.points.doc[i] as number];
			const cluster = labels && typeof labels[i] === 'number' && (labels[i] as number) >= 0 ? (labels[i] as number) : null;
			const at = positions ? (j: number) => positions.xy[i * positions.dims + j] as number : null;
			const sim = sims && typeof sims[i] === 'number' ? (sims[i] as number) : null;
			return {
				objectId: doc?.objectId ?? null,
				chunkId: sample.points.chunk[i] ?? null,
				path: doc?.path ?? null,
				chunk_index: i,
				length: sample.points.len?.[i] ?? null,
				density: sample.density?.[i] ?? null,
				cluster,
				cluster_label: cluster === null ? null : (name(cluster) ?? `group ${cluster}`),
				query_similarity: sim,
				is_duplicate: dup.has(i),
				is_outlier: outliers.has(i),
				x: at ? at(0) : (sample.points.x[i] ?? null),
				y: at ? at(1) : (sample.points.y[i] ?? null),
				z: at ? (positions?.dims === 3 ? at(2) : null) : (sample.points.z?.[i] ?? null),
				snippet: sample.points.snip?.[i] ?? null,
			} satisfies Record<(typeof EXPORT_COLUMNS.points)[number], ExportCell>;
		});
	return cleanRows({ columns: EXPORT_COLUMNS.points, rows }, { snippetChars: input.snippetChars });
}

/** What {@link keyRows} reads: point rows of keys, in the keys' order. */
export interface IKeyRowsInput extends Omit<IPointRowsInput, 'indices' | 'hidden'> {
	keys: readonly VectorKey[];
}

/**
 * Point rows of keys (the lasso selection): one row per key, in order; a key
 * no longer in the sample keeps its objectId and chunkId (and its path when
 * its document is in the sample) with the other columns empty.
 *
 * @param input - Sample, keys and the map's values.
 * @returns The rows.
 */
export function keyRows(input: IKeyRowsInput): IExportRows {
	const { sample } = input;
	const index = new Map<string, number>();
	for (let i = 0; i < sample.n; i += 1) {
		const k = `${sample.docs[sample.points.doc[i] as number]?.objectId ?? ''}#${sample.points.chunk[i]}`;
		if (!index.has(k)) index.set(k, i);
	}
	const found = pointRows({ ...input, indices: input.keys.map((k) => index.get(`${k[0]}#${k[1]}`) ?? -1).filter((i) => i >= 0) });
	const byIndex = new Map(found.rows.map((r) => [r.chunk_index as number, r]));
	const paths = new Map(sample.docs.map((d) => [d.objectId, d.path]));
	const rows = input.keys.map((k) => {
		const i = index.get(`${k[0]}#${k[1]}`);
		const hit = i === undefined ? undefined : byIndex.get(i);
		if (hit) return hit;
		const empty: Record<string, ExportCell> = Object.fromEntries(EXPORT_COLUMNS.points.map((c) => [c, null]));
		return { ...empty, objectId: k[0], chunkId: k[1], path: paths.get(k[0]) ?? null, is_duplicate: null, is_outlier: null };
	});
	return cleanRows({ columns: EXPORT_COLUMNS.points, rows }, { snippetChars: input.snippetChars });
}

/** What {@link mapExportItems} reads (the map toolbar's menu). */
export interface IMapExportInput extends Omit<IPointRowsInput, 'sample' | 'indices'> {
	sample: ISampleModel | null;
	/** The lasso selection. */
	selection: readonly VectorKey[];
	/** The points the duplicates queue lists (default: every point of a near-duplicate pair). */
	duplicates?: readonly number[] | null;
	/** The points the outliers queue lists (default: `sample.outliers`). */
	outliers?: readonly number[] | null;
	/** The picture (map/exportPng.ts composeMapPng), or null. */
	png: (() => Promise<Blob | null>) | null;
	/** Why the picture cannot be taken now (e.g. MAP_NOT_DRAWN), or null. */
	pngDisabled: string | null;
}

/** No sample yet. */
const NO_SAMPLE = 'Draw a sample first';

/**
 * The map toolbar's export items: the sample, the lasso selection, the
 * visible points, the clusters, the duplicates, the outliers and the picture.
 * Rows are built only when an item is chosen.
 *
 * @param input - The map's state.
 * @returns The items, in menu order.
 */
export function mapExportItems(input: IMapExportInput): IExportItem[] {
	const model = input.sample;
	const sample = model?.result ?? null;
	const base = { ...input };
	const rowsOf = (indices: readonly number[] | null) => (): IExportRows => (sample ? pointRows({ ...base, sample, indices }) : { columns: EXPORT_COLUMNS.points, rows: [] });
	const labels = input.clusterLabels ?? sample?.clusters?.labels ?? null;
	const clustered: number[] = [];
	if (sample && labels) {
		for (let i = 0; i < sample.n; i += 1) if ((labels[i] as number) >= 0 && !(input.hidden && input.hidden[i])) clustered.push(i);
		clustered.sort((a, b) => (labels[a] as number) - (labels[b] as number) || a - b);
	}
	const dupSet = new Set<number>();
	for (const pair of sample?.duplicates ?? []) {
		dupSet.add(pair.a);
		dupSet.add(pair.b);
	}
	const shown = (i: number): boolean => !(input.hidden && input.hidden[i]);
	const duplicates = input.duplicates ?? [...dupSet].filter(shown).sort((a, b) => a - b);
	const outliers = input.outliers ?? (sample?.outliers ?? []).filter(shown);
	let visible = 0;
	if (sample) for (let i = 0; i < sample.n; i += 1) if (shown(i)) visible += 1;
	const reason = (empty: boolean, why: string): string | null => (sample === null ? NO_SAMPLE : empty ? why : null);
	return [
		{ id: 'map-sample', label: sample ? `The sample (${plural(sample.n, 'point')})` : 'The sample', kind: 'points', disabled: reason(sample?.n === 0, 'The sample is empty'), rows: rowsOf(sample ? Array.from({ length: sample.n }, (_, i) => i) : []) },
		{ id: 'map-selection', label: input.selection.length > 0 ? `Lasso selection (${plural(input.selection.length, 'point')})` : 'Lasso selection', kind: 'selection', disabled: reason(input.selection.length === 0, NOTHING_SELECTED), rows: () => (sample ? keyRows({ ...base, sample, keys: input.selection }) : { columns: EXPORT_COLUMNS.points, rows: [] }) },
		{ id: 'map-visible', label: `Visible points (${count(visible)})`, kind: 'points', disabled: reason(visible === 0, 'No point is drawn'), rows: rowsOf(null) },
		{ id: 'map-clusters', label: `Points in clusters (${count(clustered.length)})`, kind: 'clusters', disabled: reason(!sample?.clusters, 'This sample has no clusters') ?? (clustered.length === 0 ? 'No point is in a cluster' : null), rows: rowsOf(clustered) },
		{ id: 'map-duplicates', label: `Near-duplicates (${count(duplicates.length)})`, kind: 'duplicates', disabled: reason(duplicates.length === 0, 'No near-duplicates in this sample'), rows: rowsOf(duplicates) },
		{ id: 'map-outliers', label: `Outliers (${count(outliers.length)})`, kind: 'outliers', disabled: reason(outliers.length === 0, 'No outliers in this sample'), rows: rowsOf(outliers) },
		{ id: 'map-png', label: 'Map as PNG', kind: 'map', disabled: sample === null ? NO_SAMPLE : input.png === null ? MAP_NOT_DRAWN : input.pngDisabled, ...(input.png ? { png: input.png } : {}) },
	];
}

/**
 * One cluster's points as an item (the Clusters tab's Export button).
 *
 * @param input - The map's state.
 * @param cluster - The cluster.
 * @returns The item.
 */
export function clusterExportItem(input: Omit<IMapExportInput, 'selection' | 'png' | 'pngDisabled'>, cluster: number): IExportItem {
	const sample = input.sample?.result ?? null;
	const labels = input.clusterLabels ?? sample?.clusters?.labels ?? null;
	const indices: number[] = [];
	if (sample && labels) for (let i = 0; i < sample.n; i += 1) if (labels[i] === cluster && !(input.hidden && input.hidden[i])) indices.push(i);
	const words = sample ? (input.clusterName?.(cluster) ?? clusterWords(sample, cluster)) : `group ${cluster}`;
	return {
		id: `cluster-${cluster}`,
		label: `${words} (${plural(indices.length, 'point')})`,
		kind: 'clusters',
		disabled: sample === null ? NO_SAMPLE : indices.length === 0 ? 'No point is in this cluster' : null,
		rows: () => (sample ? pointRows({ ...input, sample, indices }) : { columns: EXPORT_COLUMNS.points, rows: [] }),
	};
}

// -----------------------------------------------------------------------------
// The directory's rows
// -----------------------------------------------------------------------------

/**
 * Document rows (the frozen documents column set).
 *
 * @param items - The directory's loaded rows.
 * @returns The rows.
 */
export function documentRows(items: readonly IDocumentItem[]): IExportRows {
	const rows = items.map(
		(d) =>
			({
				objectId: d.objectId,
				path: d.path,
				chunks: d.chunks,
				has_first_chunk: d.has_first_chunk,
				tables: d.tables,
				size: d.size,
				ingestedAt: d.ingestedAt,
				deleted_chunks: d.deleted_chunks ?? null,
				max_chunk_id: d.max_chunk_id ?? null,
			}) satisfies Record<(typeof EXPORT_COLUMNS.documents)[number], ExportCell>
	);
	return cleanRows({ columns: EXPORT_COLUMNS.documents, rows });
}

/** What {@link documentExportItems} reads (the directory's menu). */
export interface IDocumentExportInput {
	/** The loaded rows, in the directory's order. */
	rows: readonly IDocumentItem[];
	/** The rows inside the active scope, with its words, or null without one. */
	scoped: { label: string; rows: readonly IDocumentItem[] } | null;
}

/**
 * The directory's export items: the loaded documents, and the scope's when one applies.
 *
 * @param input - The rows.
 * @returns The items.
 */
export function documentExportItems(input: IDocumentExportInput): IExportItem[] {
	const items: IExportItem[] = [{ id: 'documents-loaded', label: `Loaded documents (${count(input.rows.length)})`, kind: 'documents', disabled: input.rows.length === 0 ? 'No documents loaded' : null, rows: () => documentRows(input.rows) }];
	if (input.scoped) {
		const scoped = input.scoped;
		items.push({ id: 'documents-scoped', label: `Documents in scope ${scoped.label} (${count(scoped.rows.length)})`, kind: 'documents', disabled: scoped.rows.length === 0 ? 'No loaded document is in the scope' : null, rows: () => documentRows(scoped.rows) });
	}
	return items;
}

// -----------------------------------------------------------------------------
// Search rows (the search panel and the retrieval debugger)
// -----------------------------------------------------------------------------

/** One search result as a panel shows it (vector/retrieval.ts RetrievalRow has this shape). */
export interface ISearchExportRow {
	rank: number;
	objectId: string;
	chunkId: number;
	path: string;
	score: number | null;
	rawScore: number | null;
	/** used / near_miss / below_floor (or a panel's own word). */
	status: string;
	/** The answer cited this chunk. */
	inAnswer: boolean;
	preview: string;
}

/** Status words of a search row. */
const STATUS_WORDS: Record<string, string> = { used: 'used', near_miss: 'below threshold', below_threshold: 'below threshold', below_floor: 'below floor' };

/**
 * Search rows (the frozen search column set).
 *
 * @param results - The rows a panel shows.
 * @param options - The snippet length.
 * @returns The rows.
 */
export function searchRows(results: readonly ISearchExportRow[], options: { snippetChars: number }): IExportRows {
	const rows = results.map(
		(r) =>
			({
				rank: r.rank,
				objectId: r.objectId,
				chunkId: r.chunkId,
				path: r.path,
				score: r.score,
				raw_score: r.rawScore,
				status: STATUS_WORDS[r.status] ?? r.status,
				cited: r.inAnswer,
				preview: r.preview,
			}) satisfies Record<(typeof EXPORT_COLUMNS.search)[number], ExportCell>
	);
	return cleanRows({ columns: EXPORT_COLUMNS.search, rows }, options);
}

/** One query's results. */
export interface ISearchSide {
	question: string;
	rows: readonly ISearchExportRow[];
}

/** What {@link searchExportItems} reads (the search panel: A, B, both). */
export interface ISearchExportInput {
	a: ISearchSide | null;
	b: ISearchSide | null;
	snippetChars: number;
}

/**
 * The search panel's export items: query A, query B, and both (with a `query` column).
 *
 * @param input - The two sides.
 * @returns The items (B and both only when there is a B).
 */
export function searchExportItems(input: ISearchExportInput): IExportItem[] {
	const options = { snippetChars: input.snippetChars };
	const side = (id: 'a' | 'b', s: ISearchSide | null): IExportItem => ({
		id: `search-${id}`,
		label: s ? `Results for ${id.toUpperCase()} (${count(s.rows.length)})` : `Results for ${id.toUpperCase()}`,
		kind: 'search',
		disabled: !s ? 'No search yet' : s.rows.length === 0 ? 'No results to export' : null,
		rows: () => searchRows(s?.rows ?? [], options),
	});
	const items = [side('a', input.a)];
	if (input.b) {
		const a = input.a;
		const b = input.b;
		items.push(side('b', b));
		const total = (a?.rows.length ?? 0) + b.rows.length;
		items.push({
			id: 'search-both',
			label: `Both result lists (${count(total)})`,
			kind: 'search',
			disabled: total === 0 ? 'No results to export' : null,
			rows: () => {
				const rowsA = searchRows(a?.rows ?? [], options).rows.map((r) => ({ query: 'A', ...r }));
				const rowsB = searchRows(b.rows, options).rows.map((r) => ({ query: 'B', ...r }));
				return cleanRows({ columns: ['query', ...EXPORT_COLUMNS.search], rows: [...rowsA, ...rowsB] }, options);
			},
		});
	}
	return items;
}

/**
 * The retrieval debugger's export item ("Why these?").
 *
 * @param rows - The debugger's rows.
 * @param snippetChars - The snippet length.
 * @returns One item.
 */
export function retrievalExportItems(rows: readonly ISearchExportRow[] | null, snippetChars: number): IExportItem[] {
	return [{ id: 'retrieval', label: rows ? `Retrieved chunks (${count(rows.length)})` : 'Retrieved chunks', kind: 'retrieval', disabled: !rows ? 'Nothing retrieved yet' : rows.length === 0 ? 'No results to export' : null, rows: () => searchRows(rows ?? [], { snippetChars }) }];
}

// -----------------------------------------------------------------------------
// The run
// -----------------------------------------------------------------------------

/** Options of {@link runExport}. */
export interface IExportRunOptions {
	/** For the file name. */
	collection: string | null;
	/** The clock (tests). */
	now?: () => Date;
	/** Hand the file to the browser; false (or a throw) when the browser refused. */
	download(blob: Blob, fileName: string): boolean;
	/** Progress of a large export: rows written of all. */
	onProgress?(done: number, total: number): void;
	/** Set `aborted` to stop a large export. */
	signal?: { readonly aborted: boolean };
	/** Let the page breathe between steps (default: a zero timeout). */
	yieldToUi?: () => Promise<void>;
	/** The store's snippet length (default: what the rows were built with, else the node's default). */
	snippetChars?: number;
}

/** What an export did. */
export type ExportOutcome =
	| { status: 'done'; fileName: string; rows: number | null; bytes: number }
	// A refused download of rows keeps the written text, so it can be copied instead (a dev-tool mount's webview may block downloads).
	| { status: 'blocked'; fileName: string; message: string; copy?: { format: 'csv' | 'json'; text: string } }
	| { status: 'cancelled'; message: string }
	| { status: 'unavailable'; message: string }
	| { status: 'failed'; message: string };

/**
 * What the menu offers instead of a refused download of rows.
 *
 * @param format - csv or json.
 * @returns The button's words.
 */
export function copyLabel(format: 'csv' | 'json'): string {
	return `Copy as ${format.toUpperCase()}`;
}

/** Said when the clipboard is blocked too: the export is shown to select. */
export const COPY_BLOCKED_SENTENCE = 'Copying is not allowed in this window either. The export is below: select it and copy it with Ctrl+C (Cmd+C on a Mac).';

/** A zero timeout. */
function breathe(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Write rows as CSV or JSON, in steps when large.
 *
 * @param rows - Clean rows.
 * @param format - csv or json.
 * @param meta - For JSON.
 * @param options - Progress, cancel and pacing.
 * @returns The text, or null when cancelled.
 */
async function writeRows(rows: IExportRows, format: 'csv' | 'json', meta: IJsonMeta, options: IExportRunOptions): Promise<string | null> {
	const total = rows.rows.length;
	const large = total > LARGE_EXPORT_ROWS;
	const parts: string[] = [format === 'csv' ? csvRecord(rows.columns, Object.fromEntries(rows.columns.map((c) => [c, c]))) : jsonHead(rows.columns, total, meta)];
	const pace = options.yieldToUi ?? breathe;
	for (let start = 0; start < total; start += EXPORT_STEP_ROWS) {
		const end = Math.min(total, start + EXPORT_STEP_ROWS);
		let chunk = '';
		for (let i = start; i < end; i += 1) chunk += format === 'csv' ? csvRecord(rows.columns, rows.rows[i] as Record<string, ExportCell>) : jsonRow(rows.columns, rows.rows[i] as Record<string, ExportCell>, i === 0);
		parts.push(chunk);
		if (large) {
			options.onProgress?.(end, total);
			if (options.signal?.aborted) return null;
			if (end < total) await pace();
			if (options.signal?.aborted) return null;
		}
	}
	if (format === 'json') parts.push(`${total > 0 ? '\n\t' : ''}]\n}\n`);
	return parts.join('');
}

/**
 * Export one item: build its rows (or picture), write the file and hand it to the browser.
 *
 * @param item - The chosen item.
 * @param format - csv, json or png.
 * @param options - Collection, download, progress, cancel.
 * @returns What happened.
 */
export async function runExport(item: IExportItem, format: ExportFormat, options: IExportRunOptions): Promise<ExportOutcome> {
	if (item.disabled !== null) return { status: 'unavailable', message: item.disabled };
	const at = (options.now ?? (() => new Date()))();
	const name = fileName(options.collection, item.kind, format, at);
	let blob: Blob;
	let rowCount: number | null = null;
	let written: { format: 'csv' | 'json'; text: string } | null = null;
	try {
		if (format === 'png') {
			const picture = item.png ? await item.png() : null;
			if (!picture) return { status: 'unavailable', message: MAP_NOT_DRAWN };
			blob = picture.type === 'image/png' ? picture : new Blob([picture], { type: 'image/png' });
		} else {
			if (!item.rows) return { status: 'unavailable', message: 'This item has no rows to export' };
			const given = item.rows();
			const rows = cleanRows(given, { snippetChars: options.snippetChars ?? CLEANED_AT.get(given) ?? DEFAULT_SNIPPET_CHARS });
			rowCount = rows.rows.length;
			const text = await writeRows(rows, format, { kind: item.kind, collection: options.collection, exportedAt: at }, options);
			if (text === null) return { status: 'cancelled', message: CANCELLED_SENTENCE };
			written = { format, text };
			blob = format === 'csv' ? new Blob(['﻿', text], { type: 'text/csv;charset=utf-8' }) : new Blob([text], { type: 'application/json;charset=utf-8' });
		}
	} catch (error) {
		return { status: 'failed', message: `The export could not be written: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (options.signal?.aborted) return { status: 'cancelled', message: CANCELLED_SENTENCE };
	let handed = false;
	try {
		handed = options.download(blob, name);
	} catch {
		handed = false;
	}
	if (!handed) return { status: 'blocked', fileName: name, message: BLOCKED_SENTENCE, ...(written === null ? {} : { copy: written }) };
	return { status: 'done', fileName: name, rows: rowCount, bytes: blob.size };
}

/**
 * The sentence after an export.
 *
 * @param outcome - What happened.
 * @returns E.g. 'Saved vector-explorer_…csv (40 rows).'.
 */
export function outcomeSentence(outcome: ExportOutcome): string {
	if (outcome.status === 'done') return outcome.rows === null ? `Saved ${outcome.fileName}.` : `Saved ${outcome.fileName} (${plural(outcome.rows, 'row')}).`;
	return outcome.message;
}

/**
 * The words of a large export's progress.
 *
 * @param done - Rows written.
 * @param total - All rows.
 * @returns "Preparing 12,000 of 40,000 rows…".
 */
export function progressSentence(done: number, total: number): string {
	return `Preparing ${count(done)} of ${count(total)} rows…`;
}
