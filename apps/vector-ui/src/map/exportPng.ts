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
// VECTOR-UI — the map as a PNG
// =============================================================================
//
// The WebGL canvas is created with preserveDrawingBuffer: false, so its
// picture is gone once the frame is shown: reading it later gives a cleared
// canvas. The points therefore come from the renderer's `snapshot(target)`,
// which draws the last frame again and copies it into `target` in the same
// task, and it is called FIRST, before anything else is composited.
//
// Snapshot convention: the target's transform is set to the export scale, so
// the renderer draws its canvas over (0, 0, widthCss, heightCss) in CSS
// pixels: `target.drawImage(glCanvas, 0, 0, widthCss, heightCss)`.
//
// The picture is then composited at the device pixel ratio, at most 2x:
//
//   background (the map surface)       opaque, so no pixel is transparent
//   `under` layers                     e.g. edges drawn below the points
//   the points (the snapshot)
//   `over` layers                      e.g. edges above, the overlay (rings, star, rays)
//   footer                             the legend (swatches with counts, or the
//                                      ramp's ends), its note, and
//                                      "<collection> · <N> of <M> chunks ·
//                                      <layout> · <colour by> · <date>",
//                                      wrapped at the map's width"
//
// No renderer, a lost context or a refused snapshot gives no picture (null);
// the menu then says "The map is not drawn right now.". Nothing is sent
// anywhere: the Blob goes to the export menu, which hands it to the browser.
// =============================================================================

import type { ColourBy, IExportItem, MapLayout } from '../contract/types';
import { MAP_NOT_DRAWN } from '../vector/export';
import type { IColouring } from './colours';
import type { IMapPalette } from './tokens';

export { MAP_NOT_DRAWN };

/** The picture's device pixel ratio never exceeds this. */
export const EXPORT_DPR_MAX = 2;

/** Footer metrics, CSS pixels. */
const PAD = 10;
const LINE = 16;
const SWATCH_R = 5;
const ITEM_GAP = 14;
const FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
const RAMP_WIDTH = 180;
const RAMP_HEIGHT = 8;

/** What the renderer gives the export (map/renderer.webgl.ts IPointRenderer.snapshot). */
export interface IPointSnapshot {
	/** True while the WebGL context is lost. */
	readonly lost?: boolean;
	/** Draw the last frame again into `target` (CSS-pixel units at its transform); false when nothing can be drawn. */
	snapshot(target: CanvasRenderingContext2D): boolean;
}

/** A canvas the export can draw on and encode (an HTMLCanvasElement or an OffscreenCanvas). */
export interface ICanvasLike {
	width: number;
	height: number;
	getContext(kind: '2d'): CanvasRenderingContext2D | null;
	toBlob?(callback: (blob: Blob | null) => void, type?: string): void;
	convertToBlob?(options?: { type?: string }): Promise<Blob>;
}

/** One legend row of the footer. */
export interface IPngLegendRow {
	label: string;
	colour: string;
	count: number;
	/** The colour is drawn with an outline ring on the map. */
	outlined: boolean;
}

/** The legend the footer carries. */
export interface IPngLegend {
	rows: readonly IPngLegendRow[];
	/** A sequential colouring's ramp, or null. */
	ramp: { stops: readonly string[]; low: string; high: string } | null;
	note: string | null;
}

/** The footer line's facts. */
export interface IPngFooter {
	collection: string | null;
	/** Points drawn. */
	shown: number;
	/** Chunks in the collection as the node reported them, or null when it did not. */
	of: number | null;
	layout: MapLayout;
	colourBy: ColourBy;
	date: Date;
}

/** Resolved colours (CSS colour strings, not tokens: a canvas cannot read var()). */
export interface IPngTheme {
	background: string;
	text: string;
	border?: string;
	outline?: string;
}

/** What {@link composeMapPng} reads. */
export interface IMapPngInput {
	renderer: IPointSnapshot | null;
	/** Layers below the points (each drawn over the whole map area). */
	under?: ReadonlyArray<CanvasImageSource | null | undefined>;
	/** Layers above the points (the overlay last). */
	over?: ReadonlyArray<CanvasImageSource | null | undefined>;
	widthCss: number;
	heightCss: number;
	/** window.devicePixelRatio (capped at EXPORT_DPR_MAX). */
	dpr: number;
	theme: IPngTheme;
	legend: IPngLegend;
	footer: IPngFooter;
	/** Make a canvas (tests; default: a document canvas, else an OffscreenCanvas). */
	createCanvas?(width: number, height: number): ICanvasLike | null;
}

/** The layout's words (as the toolbar names them). */
const LAYOUT_WORDS: Record<MapLayout, string> = { pca: 'PCA', 'neighbour-graph': 'Neighbour graph', tsne: 't-SNE' };

/** The colouring's words. */
const COLOUR_WORDS: Record<ColourBy, string> = {
	document: 'Colour by document',
	folder: 'Colour by folder',
	type: 'Colour by file type',
	'chunk-position': 'Colour by chunk position',
	'query-similarity': 'Colour by query similarity',
	density: 'Colour by density',
	cluster: 'Colour by cluster',
};

/**
 * The export's scale: the device pixel ratio, at least 1, at most EXPORT_DPR_MAX.
 *
 * @param dpr - window.devicePixelRatio.
 * @returns The scale.
 */
export function exportScale(dpr: number): number {
	if (!Number.isFinite(dpr) || dpr < 1) return 1;
	return Math.min(EXPORT_DPR_MAX, dpr);
}

/**
 * Two digits.
 *
 * @param n - Below 100.
 * @returns Zero-padded.
 */
function two(n: number): string {
	return String(n).padStart(2, '0');
}

/**
 * The footer line.
 *
 * @param footer - The facts.
 * @returns "<collection> · <N> of <M> chunks · <layout> · <colour by> · <yyyy-mm-dd hh:mm>".
 */
export function footerLine(footer: IPngFooter): string {
	const d = footer.date;
	const when = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
	const shown = footer.shown.toLocaleString('en-US');
	const counts = footer.of === null ? `${shown} chunks` : `${shown} of ${footer.of.toLocaleString('en-US')} chunks`;
	const collection = footer.collection && footer.collection.trim() !== '' ? footer.collection : 'collection';
	return [collection, counts, LAYOUT_WORDS[footer.layout] ?? footer.layout, COLOUR_WORDS[footer.colourBy] ?? footer.colourBy, when].join(' · ');
}

/**
 * The footer's legend from the map's colouring.
 *
 * @param colouring - The colouring (map/colours.ts), or null.
 * @returns Rows, ramp and note.
 */
export function pngLegend(colouring: IColouring | null): IPngLegend {
	if (!colouring) return { rows: [], ramp: null, note: null };
	return { rows: colouring.legend.map((e) => ({ label: e.label, colour: e.colour, count: e.count, outlined: e.outlined })), ramp: colouring.ramp, note: colouring.note };
}

/**
 * The picture's colours from the map palette.
 *
 * @param palette - The palette (map/tokens.ts), or null outside a themed host.
 * @returns Background, text, border and outline.
 */
export function pngTheme(palette: IMapPalette | null): IPngTheme {
	if (!palette) return { background: '#ffffff', text: '#1a1a1a', border: '#8a8a8a', outline: '#1a1a1a' };
	return { background: palette.surfaces.default, text: palette.text, border: palette.other, outline: palette.outline };
}

/**
 * A canvas from the document, else an OffscreenCanvas.
 *
 * @param width - Device pixels.
 * @param height - Device pixels.
 * @returns The canvas, or null outside a browser.
 */
function defaultCanvas(width: number, height: number): ICanvasLike | null {
	if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		return canvas as unknown as ICanvasLike;
	}
	const Offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => ICanvasLike }).OffscreenCanvas;
	return Offscreen ? new Offscreen(width, height) : null;
}

/**
 * Encode a canvas as PNG.
 *
 * @param canvas - The canvas.
 * @returns The Blob, or null.
 */
function encode(canvas: ICanvasLike): Promise<Blob | null> {
	if (typeof canvas.toBlob === 'function') return new Promise((resolve) => canvas.toBlob?.((blob) => resolve(blob), 'image/png'));
	if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
	return Promise.resolve(null);
}

/** One legend item placed in the footer (CSS pixels). */
interface IPlacedRow {
	row: IPngLegendRow;
	text: string;
	x: number;
	line: number;
}

/**
 * Place the legend rows left to right, wrapping at the width.
 *
 * @param ctx - A context with the footer font (measureText).
 * @param rows - The rows.
 * @param width - CSS width.
 * @returns The placed rows and the number of lines.
 */
function placeRows(ctx: CanvasRenderingContext2D, rows: readonly IPngLegendRow[], width: number): { placed: IPlacedRow[]; lines: number } {
	const placed: IPlacedRow[] = [];
	let x = PAD;
	let line = 0;
	for (const row of rows) {
		const text = `${row.label} (${row.count.toLocaleString('en-US')})`;
		const w = SWATCH_R * 2 + 4 + ctx.measureText(text).width;
		if (x > PAD && x + w > width - PAD) {
			line += 1;
			x = PAD;
		}
		placed.push({ row, text, x, line });
		x += w + ITEM_GAP;
	}
	return { placed, lines: rows.length > 0 ? line + 1 : 0 };
}

/**
 * Pack parts into lines no wider than `width` (a part wider than the width gets a line of its own).
 *
 * @param ctx - A context with the footer font (measureText).
 * @param parts - Words, or the footer line's parts.
 * @param joiner - What joins two parts on a line.
 * @param width - CSS width available.
 * @returns The lines.
 */
function wrapText(ctx: CanvasRenderingContext2D, parts: readonly string[], joiner: string, width: number): string[] {
	const lines: string[] = [];
	let line = '';
	for (const part of parts) {
		const next = line === '' ? part : `${line}${joiner}${part}`;
		if (line !== '' && ctx.measureText(next).width > width) {
			lines.push(line);
			line = part;
		} else line = next;
	}
	if (line !== '') lines.push(line);
	return lines;
}

/**
 * Draw the ramp strip (a gradient when the context has one, else its stops side by side).
 *
 * @param ctx - The context.
 * @param stops - Colours, low to high.
 * @param x - Left, CSS px.
 * @param y - Top, CSS px.
 */
function drawRamp(ctx: CanvasRenderingContext2D, stops: readonly string[], x: number, y: number): void {
	if (stops.length === 0) return;
	if (typeof ctx.createLinearGradient === 'function') {
		const gradient = ctx.createLinearGradient(x, 0, x + RAMP_WIDTH, 0);
		stops.forEach((colour, i) => gradient.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), colour));
		ctx.fillStyle = gradient;
		ctx.fillRect(x, y, RAMP_WIDTH, RAMP_HEIGHT);
		return;
	}
	const step = RAMP_WIDTH / stops.length;
	stops.forEach((colour, i) => {
		ctx.fillStyle = colour;
		ctx.fillRect(x + i * step, y, Math.ceil(step), RAMP_HEIGHT);
	});
}

/**
 * Composite the map into a PNG: the points' snapshot first, then the layers,
 * then the footer with the legend.
 *
 * @param input - Renderer, layers, size, theme, legend and footer.
 * @returns The PNG, or null when the map is not drawn (no renderer, a lost context, a refused snapshot) or no canvas can be made.
 */
export async function composeMapPng(input: IMapPngInput): Promise<Blob | null> {
	const renderer = input.renderer;
	if (!renderer || renderer.lost) return null;
	const make = input.createCanvas ?? defaultCanvas;
	const scale = exportScale(input.dpr);
	const widthCss = Math.max(1, input.widthCss);
	const heightCss = Math.max(1, input.heightCss);
	const width = Math.round(widthCss * scale);
	const mapHeight = Math.round(heightCss * scale);

	// 1. The points, before anything else: the snapshot draws the frame again and copies it in this task.
	const points = make(width, mapHeight);
	const pctx = points?.getContext('2d') ?? null;
	if (!points || !pctx) return null;
	pctx.setTransform(scale, 0, 0, scale, 0, 0);
	if (!renderer.snapshot(pctx)) return null;

	// 2. The footer's size (the legend, the note and the line wrap at the map's width).
	pctx.font = FONT;
	const { placed, lines } = placeRows(pctx, input.legend.rows, widthCss);
	const rampLines = input.legend.ramp ? 1 : 0;
	const noteLines = input.legend.note ? wrapText(pctx, input.legend.note.split(' '), ' ', widthCss - 2 * PAD) : [];
	const footerLines = wrapText(pctx, footerLine(input.footer).split(' · '), ' · ', widthCss - 2 * PAD);
	const footerHeightCss = PAD + (lines + rampLines + noteLines.length + footerLines.length) * LINE + PAD / 2;
	const canvas = make(width, mapHeight + Math.round(footerHeightCss * scale));
	const ctx = canvas?.getContext('2d') ?? null;
	if (!canvas || !ctx) return null;
	ctx.setTransform(scale, 0, 0, scale, 0, 0);

	// 3. Background, layers below, the points, layers above.
	const { theme } = input;
	ctx.fillStyle = theme.background;
	ctx.fillRect(0, 0, widthCss, heightCss + footerHeightCss);
	for (const layer of input.under ?? []) if (layer) ctx.drawImage(layer, 0, 0, widthCss, heightCss);
	ctx.drawImage(points as unknown as CanvasImageSource, 0, 0, widthCss, heightCss);
	for (const layer of input.over ?? []) if (layer) ctx.drawImage(layer, 0, 0, widthCss, heightCss);

	// 4. The footer: a rule, the legend, the ramp, the note, the line.
	ctx.fillStyle = theme.border ?? theme.text;
	ctx.fillRect(0, heightCss, widthCss, 1);
	ctx.font = FONT;
	ctx.textBaseline = 'alphabetic';
	let y = heightCss + PAD + 12;
	for (const item of placed) {
		const ty = y + item.line * LINE;
		ctx.fillStyle = item.row.colour;
		ctx.beginPath();
		ctx.arc(item.x + SWATCH_R, ty - 4, SWATCH_R, 0, Math.PI * 2);
		ctx.fill();
		if (item.row.outlined) {
			ctx.strokeStyle = theme.outline ?? theme.text;
			ctx.lineWidth = 1;
			ctx.stroke();
		}
		ctx.fillStyle = theme.text;
		ctx.fillText(item.text, item.x + SWATCH_R * 2 + 4, ty);
	}
	y += lines * LINE;
	if (input.legend.ramp) {
		const ramp = input.legend.ramp;
		ctx.fillStyle = theme.text;
		ctx.fillText(ramp.low, PAD, y);
		const lowWidth = ctx.measureText(ramp.low).width;
		drawRamp(ctx, ramp.stops, PAD + lowWidth + 6, y - RAMP_HEIGHT);
		ctx.fillStyle = theme.text;
		ctx.fillText(ramp.high, PAD + lowWidth + 12 + RAMP_WIDTH, y);
		y += LINE;
	}
	ctx.fillStyle = theme.text;
	for (const line of [...noteLines, ...footerLines]) {
		ctx.fillText(line, PAD, y);
		y += LINE;
	}

	const blob = await encode(canvas);
	return blob && blob.size > 0 ? blob : null;
}

/** No sample to draw. */
const NO_SAMPLE = 'Draw a sample first';

/**
 * The map menu's "Map as PNG" item.
 *
 * @param input - The picture's input, read when the item is chosen (the frame then is the one exported).
 * @param state - Whether the context is lost and whether a sample is drawn.
 * @returns The item.
 */
export function mapPngItem(input: () => IMapPngInput, state: { lost: boolean; hasSample: boolean }): IExportItem {
	return { id: 'map-png', label: 'Map as PNG', kind: 'map', disabled: !state.hasSample ? NO_SAMPLE : state.lost ? MAP_NOT_DRAWN : null, png: () => composeMapPng(input()) };
}
