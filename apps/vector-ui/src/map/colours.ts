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
// MAP - POINT COLOURS (pure: categories, ramps, "Other" and outlines)
// =============================================================================
//
// Colour is never the only carrier: the legend names every colour, the tooltip,
// inspector and Table say what a point is, and any colour that falls below 3:1
// on the map's surfaces is drawn with a 1 px outline (OUTLINE_TOKEN).
//
//   - Categories (document, folder, file type): the ten largest in the sample
//     take the six chart colours, then hashed hues whose lightness is moved until
//     they clear 3:1 on both surfaces of the current theme; the rest are "Other".
//   - Ramps (chunk position, query similarity, density): seven steps from a cool
//     to a warm hue, each moved to clear 3:1 as well.
//   - Clusters: one colour per group of the folded view (the chart colours,
//     then hues a golden angle apart, so no two groups share one), noise in
//     the "Other" colour.
//   - Document details (ingest date, file size, health, ingest node) come from
//     the console's loaded directory rows, joined by objectId; a point whose
//     document is not loaded yet keeps the neutral colour and is counted so.
//     Table chunks come from the sample's `points.table`. A mode without its
//     data is offered disabled with the reason (colourModeReason).
//
// While a text query colours the map by similarity, the colouring it replaced
// is kept (colourForQuery) and restored when the query clears
// (colourAfterQuery); Document stays the default.
// =============================================================================

import type { ColourBy, IDocumentItem, ISampleResult } from '../contract/types';
import { formatSize } from '../vector/fileType';
import type { IClusterView } from './clusters';
import { clusterLabel } from './clusters';
import { hslToRgb, minContrast, opaqueOver, parseColor, stableHash, toCss } from './contrast';
import type { Rgb } from './contrast';
import { MIN_GRAPHIC_CONTRAST } from './tokens';
import type { IMapPalette } from './tokens';
import { CLUSTERS_NOT_IN_SAMPLE, CLUSTERS_UNSUPPORTED, clustersNone } from './wording';

/**
 * Every colour mode of the map: the contract's (`ColourBy`) and the document
 * details read from the console's directory rows.
 */
export type MapColourBy = ColourBy | 'table' | 'ingest-date' | 'file-size' | 'health' | 'ingest-node';

/** A colour mode as the toolbar offers it. */
export interface IColourMode {
	id: MapColourBy;
	label: string;
	/** The toolbar's optgroup. */
	group: 'Content' | 'Document' | 'Analysis';
}

/** The modes, in the toolbar's order. */
export const COLOUR_MODES: readonly IColourMode[] = [
	{ id: 'document', label: 'Document', group: 'Content' },
	{ id: 'folder', label: 'Folder', group: 'Content' },
	{ id: 'type', label: 'File type', group: 'Content' },
	{ id: 'chunk-position', label: 'Chunk position', group: 'Content' },
	{ id: 'table', label: 'Table chunks', group: 'Content' },
	{ id: 'ingest-date', label: 'Ingest date', group: 'Document' },
	{ id: 'file-size', label: 'File size', group: 'Document' },
	{ id: 'health', label: 'Health', group: 'Document' },
	{ id: 'ingest-node', label: 'Ingest node', group: 'Document' },
	{ id: 'query-similarity', label: 'Query similarity', group: 'Analysis' },
	{ id: 'density', label: 'Density', group: 'Analysis' },
	{ id: 'cluster', label: 'Cluster', group: 'Analysis' },
];

/** The modes that read the console's directory rows. */
const DOCUMENT_MODES: ReadonlySet<MapColourBy> = new Set(['ingest-date', 'file-size', 'health', 'ingest-node']);

/** A sample without `points.table` (an older node). */
export const TABLE_UNSUPPORTED = 'This store node does not mark table chunks; update the node.';

/** No directory rows for the sample's documents yet. */
export const DOCUMENT_ROWS_NONE = 'Load the documents in the Console to colour by their details.';

/** Why a document-detail mode has nothing to show. */
const DOCUMENT_FIELD_MISSING: Record<'ingest-date' | 'file-size' | 'ingest-node', string> = {
	'ingest-date': 'This store does not keep ingest times.',
	'file-size': 'This store does not report file sizes.',
	'ingest-node': 'This store does not record which node added a document.',
};

/** What colourModeReason and colourPoints read besides the sample. */
export interface IColourContext {
	sample: ISampleResult;
	/** True when the store node computes clusters (capability `clusters`). */
	clustersOffered?: boolean;
	/** The console's loaded directory rows by objectId. */
	docRows?: ReadonlyMap<string, IDocumentItem> | null;
}

/**
 * Why a colour mode cannot be chosen now, or null when it can.
 *
 * @param by - The mode.
 * @param ctx - The sample, whether clusters are offered, the directory rows.
 * @returns The sentence the disabled option carries, or null.
 */
export function colourModeReason(by: MapColourBy, ctx: IColourContext): string | null {
	const { sample } = ctx;
	if (by === 'cluster') return sample.clusters ? null : ctx.clustersOffered ? CLUSTERS_NOT_IN_SAMPLE : CLUSTERS_UNSUPPORTED;
	if (by === 'table') return Array.isArray(sample.points.table) && sample.points.table.length === sample.n ? null : TABLE_UNSUPPORTED;
	if (!DOCUMENT_MODES.has(by)) return null;
	const rows = sample.docs.map((d) => ctx.docRows?.get(d.objectId)).filter((r): r is IDocumentItem => r !== undefined);
	if (rows.length === 0) return DOCUMENT_ROWS_NONE;
	if (by === 'ingest-date' && !rows.some((r) => r.ingestedAt !== null && Number.isFinite(Date.parse(r.ingestedAt)))) return DOCUMENT_FIELD_MISSING['ingest-date'];
	if (by === 'file-size' && !rows.some((r) => r.size !== null && Number.isFinite(r.size))) return DOCUMENT_FIELD_MISSING['file-size'];
	if (by === 'ingest-node' && !rows.some((r) => typeof r.nodeId === 'string' && r.nodeId !== '')) return DOCUMENT_FIELD_MISSING['ingest-node'];
	return null;
}

/**
 * Switch to the query's colouring, keeping the one it replaces.
 *
 * @param current - The colouring shown.
 * @param before - What a query already shown replaced, if any.
 * @returns 'query-similarity' and the colouring to return to.
 */
export function colourForQuery(current: MapColourBy, before: MapColourBy | null): { colourBy: 'query-similarity'; before: MapColourBy } {
	return { colourBy: 'query-similarity', before: current === 'query-similarity' ? (before ?? 'document') : current };
}

/**
 * The colouring once the query clears: the one it replaced (Document when none),
 * unless another was chosen meanwhile.
 *
 * @param current - The colouring shown.
 * @param before - What the query replaced.
 * @returns The colouring to show.
 */
export function colourAfterQuery(current: MapColourBy, before: MapColourBy | null): MapColourBy {
	return current === 'query-similarity' ? (before ?? 'document') : current;
}

/** A document's health, from its directory row (the same flags the console's health panel reads). */
export type DocumentHealth = 'empty' | 'no-first-chunk' | 'gaps' | 'deleted-chunks' | 'oversize' | 'healthy';

/** Words and colour slot of each health, in the legend's order. */
const HEALTH: Array<{ id: DocumentHealth; label: string; slot: number }> = [
	{ id: 'no-first-chunk', label: 'No first chunk', slot: 2 },
	{ id: 'gaps', label: 'Gaps in chunk numbers', slot: 3 },
	{ id: 'deleted-chunks', label: 'Has deleted chunks', slot: 4 },
	{ id: 'empty', label: 'Empty parse (no chunks)', slot: 5 },
	{ id: 'oversize', label: 'Over 10× the median chunk count', slot: 0 },
	{ id: 'healthy', label: 'Nothing to report', slot: 1 },
];

/**
 * A document's health: the first flag that applies, else 'healthy'.
 *
 * @param row - Its directory row.
 * @param medianChunks - Median chunks per loaded document (null when unknown: no 'oversize').
 * @returns The health.
 */
export function documentHealth(row: IDocumentItem, medianChunks: number | null): DocumentHealth {
	const chunks = row.chunks;
	if (chunks === 0) return 'empty';
	if (row.has_first_chunk === false) return 'no-first-chunk';
	if (chunks !== null && typeof row.max_chunk_id === 'number' && row.max_chunk_id + 1 !== chunks) return 'gaps';
	if (typeof row.deleted_chunks === 'number' && row.deleted_chunks > 0) return 'deleted-chunks';
	if (chunks !== null && medianChunks !== null && medianChunks > 0 && chunks > 10 * medianChunks) return 'oversize';
	return 'healthy';
}

/**
 * The median of numbers (null for none).
 *
 * @param counts - Numbers.
 * @returns The median.
 */
function median(counts: number[]): number | null {
	if (counts.length === 0) return null;
	const sorted = [...counts].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * The colours of the folded clusters: the chart colours first, then hues a
 * golden angle apart (no two groups share a colour), each clearing 3:1 or outlined.
 *
 * @param count - Groups.
 * @param palette - The theme.
 * @returns One colour per group.
 */
export function clusterColours(count: number, palette: IMapPalette): ICategoryColour[] {
	return Array.from({ length: count }, (_, g) => (g < palette.chart.length ? categoricalColour(g, `cluster-${g}`, palette) : categoricalColour(g, `cluster-${g}`, palette, (g * 137.508) % 360)));
}

/** Categories that get their own colour. */
export const TOP_CATEGORIES = 10;

/** One category's colour. */
export interface ICategoryColour {
	/** Opaque CSS colour. */
	colour: string;
	/** True when the colour is below 3:1 on a surface and is drawn with an outline. */
	outlined: boolean;
}

/** One legend row. */
export interface ILegendEntry {
	/** Category key (objectId for documents), or 'other'. */
	key: string;
	label: string;
	colour: string;
	/** Visible points in the category. */
	count: number;
	outlined: boolean;
}

/** The colours of a sample. */
export interface IColouring {
	/** One opaque CSS colour per point. */
	colours: string[];
	/** The same, as RGBA bytes (4 per point) for the renderer. */
	rgba: Uint8Array;
	/** 1 for a point drawn with the outline. */
	outlined: Uint8Array;
	/** Category rows (empty for ramps). */
	legend: ILegendEntry[];
	/** The ramp of a sequential mode, or null. */
	ramp: { stops: string[]; low: string; high: string } | null;
	/** A sentence when the mode has nothing to show (no query yet). */
	note: string | null;
}

/** The two surfaces, parsed. */
function surfacesOf(palette: IMapPalette): Rgb[] {
	const bg = parseColor(palette.surfaces.default) ?? { r: 255, g: 255, b: 255 };
	const paper = opaqueOver(palette.surfaces.paper, bg) ?? bg;
	return [bg, paper];
}

/**
 * The first lightness (moving away from the background) at which a hue clears 3:1 on both surfaces.
 *
 * @param hue - Degrees.
 * @param palette - The theme.
 * @param start - Starting lightness, percent.
 * @returns The colour (outlined only when no lightness works).
 */
function readableHue(hue: number, palette: IMapPalette, start?: number): ICategoryColour {
	const surfaces = surfacesOf(palette);
	const dark = palette.mode === 'dark';
	const first = start ?? (dark ? 60 : 42);
	for (let l = first; dark ? l <= 94 : l >= 8; l += dark ? 2 : -2) {
		const rgb = hslToRgb(hue, 0.65, l / 100);
		if (minContrast(rgb, surfaces) >= MIN_GRAPHIC_CONTRAST) return { colour: toCss(rgb), outlined: false };
	}
	return { colour: toCss(hslToRgb(hue, 0.65, first / 100)), outlined: true };
}

/**
 * The colour of a category slot.
 *
 * @param slot - 0-based rank among the top categories.
 * @param hashKey - What a hashed slot's hue is derived from.
 * @param palette - The theme.
 * @param hueOverride - Force a hue for a hashed slot (tests sweep every hue).
 * @returns The colour.
 */
export function categoricalColour(slot: number, hashKey: string, palette: IMapPalette, hueOverride?: number): ICategoryColour {
	if (slot < palette.chart.length) {
		const surfaces = surfacesOf(palette);
		const rgb = opaqueOver(palette.chart[slot] as string, surfaces[0] as Rgb) ?? { r: 128, g: 128, b: 128 };
		return { colour: toCss(rgb), outlined: minContrast(rgb, surfaces) < MIN_GRAPHIC_CONTRAST };
	}
	return readableHue(hueOverride ?? stableHash(hashKey) % 360, palette);
}

/** Hues of the sequential ramp, cool to warm. */
const RAMP_HUES = [230, 255, 280, 305, 330, 355, 22];

/**
 * The steps of the sequential ramp for a theme (low to high), each clearing 3:1.
 *
 * @param palette - The theme.
 * @returns Opaque CSS colours.
 */
export function rampStops(palette: IMapPalette): string[] {
	const dark = palette.mode === 'dark';
	return RAMP_HUES.map((hue, i) => readableHue(hue, palette, dark ? 54 + 3 * i : 46 - 2 * i).colour);
}

/** The last path segment. */
function baseName(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * The category of a document path.
 *
 * @param by - 'document' (base name), 'folder' (directory; bare names are "Uploaded") or 'type' (extension).
 * @param path - The document path as stored.
 * @returns The category label.
 */
export function categoryOf(by: 'document' | 'folder' | 'type', path: string): string {
	if (by === 'document') return baseName(path) || path;
	if (by === 'folder') {
		const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
		return cut > 0 ? path.slice(0, cut) : 'Uploaded';
	}
	const name = baseName(path);
	const dot = name.lastIndexOf('.');
	return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : 'no extension';
}

/** Nouns for the "Other" row. */
const OTHER_NOUN: Record<'document' | 'folder' | 'type', [string, string]> = { document: ['document', 'documents'], folder: ['folder', 'folders'], type: ['type', 'types'] };

/** Ramp ends per mode (the document-detail ramps name their ends with values). */
const RAMP_ENDS: Record<'chunk-position' | 'query-similarity' | 'density', [string, string]> = {
	'chunk-position': ['first chunk', 'last chunk'],
	'query-similarity': ['least similar', 'most similar'],
	density: ['sparse', 'dense'],
};

/** Legend row of the points whose document the directory has not loaded. */
const NOT_LOADED = 'Not loaded in the directory';

/** What colourPoints reads besides the sample and the mode. */
export interface IColourOptions {
	/** Query similarity per point (for 'query-similarity'). */
	querySims?: ArrayLike<number> | null;
	/** 1 per point not shown (left out of the counts). */
	hidden?: ArrayLike<number> | null;
	/** The folded clusters (for 'cluster'). */
	clusters?: IClusterView | null;
	/** The console's loaded directory rows by objectId (for the document-detail modes). */
	docRows?: ReadonlyMap<string, IDocumentItem> | null;
}

/**
 * Colour every point of a sample.
 *
 * @param sample - The `sample` answer.
 * @param by - The colour mode.
 * @param palette - The theme.
 * @param options - Query similarities, the hidden mask, the folded clusters, the directory rows.
 * @returns Colours, outlines, legend and ramp.
 */
export function colourPoints(sample: ISampleResult, by: MapColourBy, palette: IMapPalette, options: IColourOptions = {}): IColouring {
	const n = sample.n;
	const hidden = options.hidden ?? null;
	const visible = (i: number): boolean => !(hidden != null && (hidden[i] as number) !== 0);
	const surfaces = surfacesOf(palette);
	const other = toCss(opaqueOver(palette.other, surfaces[0] as Rgb) ?? { r: 128, g: 128, b: 128 });
	const colours = new Array<string>(n).fill(other);
	let legend: ILegendEntry[] = [];
	let ramp: IColouring['ramp'] = null;
	let note: string | null = null;
	const docRows = options.docRows ?? null;
	const rowOfPoint = (i: number): IDocumentItem | undefined => docRows?.get(sample.docs[sample.points.doc[i] as number]?.objectId ?? '');

	/** Categories by a key per point (null: not known), the ten largest coloured, the rest "Other". */
	const categorical = (keyOf: (i: number) => { key: string; label: string } | null, nouns: [string, string], fixed?: (key: string) => number | undefined): void => {
		const counts = new Map<string, { label: string; count: number }>();
		let unknown = 0;
		const keys = new Array<string | null>(n).fill(null);
		for (let i = 0; i < n; i += 1) {
			const k = keyOf(i);
			keys[i] = k ? k.key : null;
			if (!visible(i)) continue;
			if (!k) {
				unknown += 1;
				continue;
			}
			const row = counts.get(k.key);
			if (row) row.count += 1;
			else counts.set(k.key, { label: k.label, count: 1 });
		}
		const ranked = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || (a[1].label < b[1].label ? -1 : a[1].label > b[1].label ? 1 : 0) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
		const slotColour = new Map<string, ICategoryColour>();
		ranked.slice(0, TOP_CATEGORIES).forEach(([key], slot) => slotColour.set(key, categoricalColour(fixed?.(key) ?? slot, key, palette)));
		for (let i = 0; i < n; i += 1) {
			const c = keys[i] === null ? undefined : slotColour.get(keys[i] as string);
			if (c) colours[i] = c.colour;
		}
		legend = ranked.slice(0, TOP_CATEGORIES).map(([key, row]) => ({ key, label: row.label, colour: (slotColour.get(key) as ICategoryColour).colour, count: row.count, outlined: false }));
		const rest = ranked.slice(TOP_CATEGORIES);
		if (rest.length > 0) {
			const [one, many] = nouns;
			legend.push({ key: 'other', label: `Other (${rest.length.toLocaleString('en-US')} ${rest.length === 1 ? one : many})`, colour: other, count: rest.reduce((s, [, row]) => s + row.count, 0), outlined: false });
		}
		if (unknown > 0) legend.push({ key: 'not-loaded', label: NOT_LOADED, colour: other, count: unknown, outlined: false });
	};

	/** A ramp over one value per point (NaN: not known), low to high, with the ends' words. */
	const ramped = (values: Float64Array, ends: [string, string], unknownLabel: string | null): void => {
		const stops = rampStops(palette);
		let unknown = 0;
		for (let i = 0; i < n; i += 1) {
			const v = values[i] as number;
			if (Number.isFinite(v)) colours[i] = stops[Math.min(stops.length - 1, Math.max(0, Math.floor(v * stops.length)))] as string;
			else if (visible(i)) unknown += 1;
		}
		ramp = { stops, low: ends[0], high: ends[1] };
		if (unknownLabel !== null && unknown > 0) legend = [{ key: 'not-loaded', label: unknownLabel, colour: other, count: unknown, outlined: false }];
	};

	/** Values scaled to 0..1 between the visible minimum and maximum (NaN stays NaN). */
	const scaled = (raw: Float64Array): { values: Float64Array; lo: number; hi: number } => {
		let lo = Infinity;
		let hi = -Infinity;
		for (let i = 0; i < n; i += 1) {
			const v = raw[i] as number;
			if (!visible(i) || !Number.isFinite(v)) continue;
			lo = Math.min(lo, v);
			hi = Math.max(hi, v);
		}
		const values = new Float64Array(n).fill(Number.NaN);
		for (let i = 0; i < n; i += 1) {
			const v = raw[i] as number;
			if (Number.isFinite(v)) values[i] = hi > lo ? (v - lo) / (hi - lo) : 1;
		}
		return { values, lo, hi };
	};

	if (by === 'document' || by === 'folder' || by === 'type') {
		const keyOfDoc = sample.docs.map((d) => (by === 'document' ? d.objectId : categoryOf(by, d.path)));
		const labelOfDoc = sample.docs.map((d) => categoryOf(by, d.path));
		categorical((i) => {
			const d = sample.points.doc[i] as number;
			return { key: keyOfDoc[d] as string, label: labelOfDoc[d] as string };
		}, OTHER_NOUN[by]);
	} else if (by === 'cluster') {
		const view = options.clusters ?? null;
		if (view === null) note = sample.clusters ? CLUSTERS_NOT_IN_SAMPLE : CLUSTERS_UNSUPPORTED;
		else {
			const palettes = clusterColours(view.count, palette);
			const counts = new Array<number>(view.count).fill(0);
			let noise = 0;
			for (let i = 0; i < n; i += 1) {
				const g = view.labels[i] ?? -1;
				if (g >= 0 && g < view.count) {
					colours[i] = (palettes[g] as ICategoryColour).colour;
					if (visible(i)) counts[g] = (counts[g] as number) + 1;
				} else if (visible(i)) noise += 1;
			}
			// Every group is a legend row (the Legend shows the largest and says how many more).
			legend = counts
				.map((count, g) => ({ key: `cluster-${g}`, label: clusterLabel(view, g), colour: (palettes[g] as ICategoryColour).colour, count, outlined: false }))
				.filter((row) => row.count > 0)
				.sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
			legend.push({ key: 'noise', label: 'Unassigned (in no group)', colour: other, count: noise, outlined: false });
			if (view.count === 0) note = clustersNone(view.minSize);
		}
	} else if (by === 'table') {
		const table = sample.points.table;
		if (!Array.isArray(table) || table.length !== n) note = TABLE_UNSUPPORTED;
		else categorical((i) => (table[i] ? { key: 'table', label: 'Table chunk' } : { key: 'text', label: 'Text chunk' }), ['kind', 'kinds'], (key) => (key === 'table' ? 3 : 0));
	} else if (by === 'ingest-node') {
		categorical((i) => {
			const row = rowOfPoint(i);
			if (!row) return null;
			return row.nodeId ? { key: row.nodeId, label: row.nodeId } : { key: '(none)', label: 'Not recorded' };
		}, ['node', 'nodes']);
		if (legend.every((e) => e.key === 'not-loaded' || e.key === '(none)')) note = docRows && docRows.size > 0 ? DOCUMENT_FIELD_MISSING['ingest-node'] : DOCUMENT_ROWS_NONE;
	} else if (by === 'health') {
		const loaded = sample.docs.map((d) => docRows?.get(d.objectId)).filter((r): r is IDocumentItem => r !== undefined);
		const med = median(loaded.flatMap((r) => (r.chunks === null ? [] : [r.chunks])));
		const healthOf = new Map(loaded.map((r) => [r.objectId, documentHealth(r, med)]));
		const words = new Map(HEALTH.map((h) => [h.id as string, h]));
		categorical((i) => {
			const objectId = sample.docs[sample.points.doc[i] as number]?.objectId ?? '';
			const health = healthOf.get(objectId);
			return health ? { key: health, label: (words.get(health) as { label: string }).label } : null;
		}, ['state', 'states'], (key) => words.get(key)?.slot);
		if (loaded.length === 0) note = DOCUMENT_ROWS_NONE;
	} else if (by === 'ingest-date' || by === 'file-size') {
		const raw = new Float64Array(n).fill(Number.NaN);
		for (let i = 0; i < n; i += 1) {
			const row = rowOfPoint(i);
			if (!row) continue;
			if (by === 'ingest-date') {
				const t = row.ingestedAt === null ? Number.NaN : Date.parse(row.ingestedAt);
				raw[i] = Number.isFinite(t) ? t : Number.NaN;
			} else raw[i] = row.size !== null && Number.isFinite(row.size) && row.size > 0 ? Math.log10(row.size) : Number.NaN;
		}
		const { values, lo, hi } = scaled(raw);
		if (!Number.isFinite(lo)) note = docRows && docRows.size > 0 ? DOCUMENT_FIELD_MISSING[by] : DOCUMENT_ROWS_NONE;
		else {
			const ends: [string, string] = by === 'ingest-date' ? [`oldest (${new Date(lo).toISOString().slice(0, 10)})`, `newest (${new Date(hi).toISOString().slice(0, 10)})`] : [`smallest (${formatSize(Math.round(10 ** lo))})`, `largest (${formatSize(Math.round(10 ** hi))})`];
			ramped(values, ends, `${NOT_LOADED} or not reported`);
		}
	} else {
		const values = new Float64Array(n).fill(Number.NaN);
		if (by === 'chunk-position') {
			const maxChunk = new Map<number, number>();
			for (let i = 0; i < n; i += 1) maxChunk.set(sample.points.doc[i] as number, Math.max(maxChunk.get(sample.points.doc[i] as number) ?? 0, sample.points.chunk[i] as number));
			for (let i = 0; i < n; i += 1) {
				const d = sample.points.doc[i] as number;
				const total = sample.docs[d]?.chunks ?? (maxChunk.get(d) ?? 0) + 1;
				values[i] = Math.min(1, (sample.points.chunk[i] as number) / Math.max(1, total - 1));
			}
		} else {
			const source = by === 'density' ? sample.density : options.querySims ?? null;
			if (source === null || source.length < n) {
				note = 'Run a text query to colour the points by their similarity to it.';
			} else if (by === 'density') {
				// Rank-normalised, so a few extreme values do not flatten the rest.
				const order = Array.from({ length: n }, (_, i) => i).filter(visible).sort((a, b) => (source[a] as number) - (source[b] as number) || a - b);
				order.forEach((i, rank) => (values[i] = order.length > 1 ? rank / (order.length - 1) : 1));
			} else {
				const { values: s } = scaled(Float64Array.from({ length: n }, (_, i) => source[i] as number));
				values.set(s);
			}
		}
		if (note === null) ramped(values, RAMP_ENDS[by as 'chunk-position' | 'query-similarity' | 'density'], null);
	}

	const rgba = new Uint8Array(n * 4);
	const outlined = new Uint8Array(n);
	const weak = new Map<string, boolean>();
	for (let i = 0; i < n; i += 1) {
		const text = colours[i] as string;
		const rgb = parseColor(text) as Rgb;
		let w = weak.get(text);
		if (w === undefined) {
			w = minContrast(rgb, surfaces) < MIN_GRAPHIC_CONTRAST;
			weak.set(text, w);
		}
		rgba[4 * i] = rgb.r;
		rgba[4 * i + 1] = rgb.g;
		rgba[4 * i + 2] = rgb.b;
		rgba[4 * i + 3] = 255;
		outlined[i] = w ? 1 : 0;
	}
	for (const entry of legend) entry.outlined = weak.get(entry.colour) ?? false;
	return { colours, rgba, outlined, legend, ramp, note };
}
