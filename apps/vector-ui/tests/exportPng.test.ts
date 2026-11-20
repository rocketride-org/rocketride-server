// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EXPORT PNG: the map as a picture
// =============================================================================
//
// The WebGL canvas keeps no drawing buffer (preserveDrawingBuffer: false), so
// reading it later gives a cleared picture. map/exportPng.ts therefore asks the
// renderer for a snapshot (it draws the frame again and copies it in the same
// task) BEFORE it composites anything else, then lays the edge layer and the
// overlay over it at the device pixel ratio (at most 2x) and adds a footer
// with the legend and "<collection> · <N> of <M> chunks · <layout> · <colour
// by> · <date>". The canvases here are a small software raster, so the test
// reads real pixels.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ICanvasLike, IMapPngInput, IPointSnapshot } from '../src/map/exportPng';
import { EXPORT_DPR_MAX, MAP_NOT_DRAWN, composeMapPng, exportScale, footerLine, mapPngItem } from '../src/map/exportPng';

/** 2026-10-15 09:05 local time. */
const AT = new Date(2026, 9, 15, 9, 5, 30);

/** Parse '#rrggbb' or 'rgb(r, g, b)' into bytes (what the raster needs). */
function rgba(colour: string): [number, number, number, number] {
	const hex = /^#([0-9a-f]{6})$/i.exec(colour);
	if (hex) {
		const v = parseInt(hex[1] as string, 16);
		return [(v >> 16) & 255, (v >> 8) & 255, v & 255, 255];
	}
	const fn = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(colour);
	if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3]), 255];
	return [0, 0, 0, 255];
}

/**
 * A 2D context over a raster canvas (fillRect, drawImage, fillText; a scale-only transform).
 *
 * @param self - The canvas drawn on.
 * @returns The context.
 */
function rasterContext(self: RasterCanvas): CanvasRenderingContext2D {
	let sx = 1;
	let sy = 1;
	const ctx = {
		canvas: self,
		fillStyle: '#000000',
		strokeStyle: '#000000',
		font: '12px sans-serif',
		textBaseline: 'alphabetic',
		textAlign: 'left',
		lineWidth: 1,
		globalAlpha: 1,
		setTransform(a: number, _b: number, _c: number, d: number): void {
			sx = a;
			sy = d;
			self.log.push(`transform:${a}`);
		},
		save(): void {},
		restore(): void {},
		fillRect(x: number, y: number, w: number, h: number): void {
			self.paint(x * sx, y * sy, w * sx, h * sy, rgba(String(ctx.fillStyle)));
			self.log.push('fillRect');
		},
		strokeRect(): void {},
		beginPath(): void {},
		arc(): void {},
		fill(): void {},
		stroke(): void {},
		fillText(text: string, x: number, y: number): void {
			self.texts.push(text);
			self.paint(x * sx, (y - 8) * sy, Math.max(1, text.length * 5) * sx, 8 * sy, rgba(String(ctx.fillStyle)));
			self.log.push(`text:${text}`);
		},
		measureText(text: string): { width: number } {
			return { width: text.length * 6 };
		},
		drawImage(source: RasterCanvas, dx: number, dy: number, dw?: number, dh?: number): void {
			const w = (dw ?? source.width) * sx;
			const h = (dh ?? source.height) * sy;
			for (let y = 0; y < Math.floor(h); y += 1) {
				for (let x = 0; x < Math.floor(w); x += 1) {
					const px = source.pixel((x * source.width) / w, (y * source.height) / h);
					if (px[3] === 0) continue;
					const tx = Math.floor(dx * sx + x);
					const ty = Math.floor(dy * sy + y);
					if (tx < self.width && ty < self.height) self.data.set(px, (ty * self.width + tx) * 4);
				}
			}
			self.log.push(`drawImage:${source.name}`);
		},
	};
	return ctx as unknown as CanvasRenderingContext2D;
}

/** A software canvas: RGBA bytes, a scale-only transform, fillRect, drawImage and fillText (recorded). */
class RasterCanvas implements ICanvasLike {
	width: number;
	height: number;
	data: Uint8ClampedArray;
	readonly log: string[];
	readonly texts: string[] = [];
	constructor(
		width: number,
		height: number,
		log: string[],
		readonly name = 'export'
	) {
		this.width = width;
		this.height = height;
		this.data = new Uint8ClampedArray(width * height * 4);
		this.log = log;
	}

	/** The pixel at device coordinates. */
	pixel(x: number, y: number): [number, number, number, number] {
		const o = (Math.floor(y) * this.width + Math.floor(x)) * 4;
		return [this.data[o] as number, this.data[o + 1] as number, this.data[o + 2] as number, this.data[o + 3] as number];
	}

	/** Paint a device-pixel rectangle. */
	paint(x0: number, y0: number, w: number, h: number, colour: [number, number, number, number]): void {
		for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.height, Math.ceil(y0 + h)); y += 1) {
			for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.width, Math.ceil(x0 + w)); x += 1) {
				if (colour[3] === 0) continue;
				this.data.set(colour, (y * this.width + x) * 4);
			}
		}
	}

	getContext(kind: '2d'): CanvasRenderingContext2D | null {
		return kind === '2d' ? rasterContext(this) : null;
	}

	toBlob(callback: (blob: Blob | null) => void, type?: string): void {
		callback(new Blob([new Uint8Array(this.data)], { type: type ?? 'image/png' }));
	}
}

/** A WebGL-like canvas with points drawn as 4x4 squares, and its renderer's snapshot. */
function pointsRenderer(log: string[], opts: { lost?: boolean; widthCss: number; heightCss: number; dpr: number }): IPointSnapshot & { gl: RasterCanvas; calls: number; lost: boolean } {
	const gl = new RasterCanvas(Math.round(opts.widthCss * opts.dpr), Math.round(opts.heightCss * opts.dpr), log, 'points');
	for (const [x, y] of [
		[20, 20],
		[60, 40],
		[100, 70],
	])
		gl.paint(x * opts.dpr, y * opts.dpr, 4 * opts.dpr, 4 * opts.dpr, [200, 30, 30, 255]);
	const renderer = {
		gl,
		calls: 0,
		lost: opts.lost ?? false,
		snapshot(target: CanvasRenderingContext2D): boolean {
			renderer.calls += 1;
			log.push('snapshot');
			if (renderer.lost) return false;
			target.drawImage(gl as unknown as CanvasImageSource, 0, 0, opts.widthCss, opts.heightCss);
			return true;
		},
	};
	return renderer;
}

/** The input of a 200x120 map at the given DPR. */
function input(log: string[], dpr: number, extra: Partial<IMapPngInput> = {}): { input: IMapPngInput; made: RasterCanvas[]; renderer: ReturnType<typeof pointsRenderer> } {
	const made: RasterCanvas[] = [];
	const renderer = pointsRenderer(log, { widthCss: 200, heightCss: 120, dpr });
	const overlay = new RasterCanvas(200 * dpr, 120 * dpr, log, 'overlay');
	overlay.paint(150 * dpr, 10 * dpr, 6 * dpr, 6 * dpr, [0, 120, 212, 255]);
	const edges = new RasterCanvas(200 * dpr, 120 * dpr, log, 'edges');
	return {
		renderer,
		made,
		input: {
			renderer,
			under: [edges as unknown as CanvasImageSource],
			over: [overlay as unknown as CanvasImageSource],
			widthCss: 200,
			heightCss: 120,
			dpr,
			theme: { background: '#ffffff', text: '#1a1a1a', border: '#cccccc' },
			legend: {
				rows: [
					{ label: 'falcon · orchid', colour: '#c81e1e', count: 42, outlined: false },
					{ label: 'manual · valve', colour: '#1e64c8', count: 17, outlined: true },
				],
				ramp: null,
				note: null,
			},
			footer: { collection: 'vx_demo_docs', shown: 1000, of: 1318, layout: 'pca', colourBy: 'cluster', date: AT },
			createCanvas(width: number, height: number): ICanvasLike {
				const c = new RasterCanvas(width, height, log);
				made.push(c);
				return c;
			},
			...extra,
		},
	};
}

/** The exported picture: the tallest canvas made (the map plus its footer). */
function exported(made: RasterCanvas[]): RasterCanvas {
	return made.reduce((a, b) => (b.height > a.height ? b : a));
}

test('the footer line names the collection, the counts, the layout, the colouring and the date', () => {
	assert.equal(footerLine({ collection: 'vx_demo_docs', shown: 1000, of: 1318, layout: 'pca', colourBy: 'cluster', date: AT }), 'vx_demo_docs · 1,000 of 1,318 chunks · PCA · Colour by cluster · 2026-10-15 09:05');
	assert.equal(footerLine({ collection: null, shown: 5000, of: null, layout: 'tsne', colourBy: 'query-similarity', date: AT }), 'collection · 5,000 chunks · t-SNE · Colour by query similarity · 2026-10-15 09:05');
	assert.equal(footerLine({ collection: 'c', shown: 3, of: 3, layout: 'neighbour-graph', colourBy: 'chunk-position', date: AT }), 'c · 3 of 3 chunks · Neighbour graph · Colour by chunk position · 2026-10-15 09:05');
});

test('the picture is drawn at the device pixel ratio, never above 2x', () => {
	assert.equal(EXPORT_DPR_MAX, 2);
	assert.equal(exportScale(3), 2);
	assert.equal(exportScale(2), 2);
	assert.equal(exportScale(1.5), 1.5);
	assert.equal(exportScale(1), 1);
	assert.equal(exportScale(0), 1);
	assert.equal(exportScale(Number.NaN), 1);
});

test('the snapshot is taken before anything is composited; the points, the overlay and the footer are in the picture', async () => {
	const log: string[] = [];
	const { input: run, made, renderer } = input(log, 3);
	const blob = await composeMapPng(run);
	assert.ok(blob, 'a picture');
	assert.equal(blob.type, 'image/png');
	assert.equal(renderer.calls, 1);
	const canvas = exported(made);
	assert.equal(canvas.width, 400, 'css width x 2 (DPR 3 capped)');
	assert.ok(canvas.height > 240, 'the map plus a footer');
	const snap = log.indexOf('snapshot');
	assert.ok(snap >= 0);
	for (const later of ['drawImage:edges', 'drawImage:overlay']) assert.ok(log.indexOf(later) > snap, `${later} after the snapshot`);
	assert.ok(log.findIndex((l) => l.startsWith('text:')) > snap, 'the footer after the snapshot');
	assert.deepEqual(canvas.pixel(21 * 2, 21 * 2), [200, 30, 30, 255], 'a point pixel is the point colour');
	assert.deepEqual(canvas.pixel(152 * 2, 12 * 2), [0, 120, 212, 255], 'the overlay is on top');
	assert.equal(canvas.pixel(5, 5)[3], 255, 'the background is opaque');
	const words = canvas.texts.join(' · ');
	assert.match(words, /vx_demo_docs · 1,000 of 1,318 chunks · PCA · Colour by cluster · 2026-10-15 09:05/);
	assert.match(words, /falcon · orchid \(42\)/);
	assert.match(words, /manual · valve \(17\)/);
});

test('a lost context, a refused snapshot or no renderer gives no picture; the item says the map is not drawn', async () => {
	const log: string[] = [];
	const lost = input(log, 1);
	lost.renderer.lost = true;
	assert.equal(await composeMapPng(lost.input), null);
	assert.equal(await composeMapPng({ ...input(log, 1).input, renderer: null }), null);
	let asked = 0;
	const refusing: IPointSnapshot = {
		lost: false,
		snapshot: () => {
			asked += 1;
			return false;
		},
	};
	const refused = input(log, 1, { renderer: refusing });
	assert.equal(await composeMapPng(refused.input), null, 'a snapshot that could not draw gives no picture');
	assert.equal(asked, 1);
	assert.equal(refused.made.length, 1, 'nothing is composited after a refused snapshot');
	assert.equal(MAP_NOT_DRAWN, 'The map is not drawn right now.');
	const off = mapPngItem(() => lost.input, { lost: true, hasSample: true });
	assert.deepEqual([off.id, off.kind, off.disabled], ['map-png', 'map', MAP_NOT_DRAWN]);
	const empty = mapPngItem(() => lost.input, { lost: false, hasSample: false });
	assert.match(empty.disabled ?? '', /sample/);
	const on = mapPngItem(() => input(log, 1).input, { lost: false, hasSample: true });
	assert.equal(on.disabled, null);
	const blob = await on.png!();
	assert.ok(blob && blob.size > 0);
});

test('a ramp colouring writes its ends in the footer instead of rows', async () => {
	const log: string[] = [];
	const { input: run, made } = input(log, 1, { legend: { rows: [], ramp: { stops: ['#000000', '#ffffff'], low: 'sparse', high: 'dense' }, note: 'Density of the sample.' } });
	await composeMapPng(run);
	const words = exported(made).texts.join('\n');
	assert.match(words, /sparse/);
	assert.match(words, /dense/);
	assert.match(words, /Density of the sample\./);
});

test('a narrow map wraps the footer line at its parts, every line within the width', async () => {
	const log: string[] = [];
	const { input: run, made } = input(log, 1, { widthCss: 150, legend: { rows: [], ramp: null, note: 'A note long enough to need more than one line in a narrow picture.' } });
	await composeMapPng(run);
	const canvas = exported(made);
	const footer = canvas.texts.slice(-6);
	for (const line of canvas.texts) assert.ok(line.length * 6 <= 150 - 20 || !line.includes(' '), `"${line}" fits`);
	assert.ok(canvas.texts.length >= 4, 'the note and the footer line wrapped');
	assert.match(footer.join(' · '), /vx_demo_docs · 1,000 of 1,318 chunks · PCA · Colour by cluster · 2026-10-15 09:05/);
	assert.ok(canvas.height > 120 + 4 * 16, 'the footer grew with its lines');
});
