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
// MAP - OVERLAY (everything drawn on top of the points, on a 2D canvas)
// =============================================================================
//
// The few things drawn per interaction rather than per point: the hover and
// selection rings, the keyboard focus ring, the neighbour links of the selected
// point, hollow out-of-sample points, the query star and its rays to the true
// top-k, a document's chunk path, duplicate pairs (dashed), outlier rings and
// the lasso outline. Positions come from callbacks so the overlay draws exactly
// where the renderer drew (the same view matrix); a point with no screen
// position (behind the 3D eye, or unknown) is skipped, never guessed.
//
// Colours: the accent (--rr-border-focus) for selection, star, rays, links and
// lasso; the outline (--rr-text-primary) for hover, outliers and duplicates;
// --rr-text-secondary for hollow points. Each is measured in
// tests/a11y.contrast.map.test.ts. Shapes and dashes, not colour alone, tell
// the marks apart.
//
// Beside it, two more layers:
//
//   - The similarity edges (Neighbours or Tree) on their own canvas under the
//     points: one path per alpha bucket (8 steps of similarity, weakest
//     faintest), so a frame is at most 8 strokes. In 2D the paths are built in
//     layout units once per edge set and stroked through the camera's affine
//     transform (edgeTransform2d), so panning and zooming build nothing; in 3D
//     they are built from the projected points. The edges are decorative: the
//     legend's counts and the Neighbours tab are their text alternative.
//   - Extras on the overlay (drawExtras): the compared question's star (B,
//     hollow) and its rays, the hovered point's edges drawn thicker, the
//     hovered cluster's points ringed, and the cluster labels (11 px text in
//     --rr-text-primary with a halo of the surface, at each group's medoid,
//     largest groups first, never two overlapping, at most 50, hidden when the
//     map is zoomed out).
// =============================================================================

import type { ICamera2D, IViewport } from './camera';
import type { IEdgeSet } from './graph';
import type { IStar } from './queryProjection';

/** A place in layout coordinates (a projected point outside the sample). */
export interface IPlace {
	x: number;
	y: number;
	z?: number;
}

/** A link end: a sample point, or a placed point. */
export interface IOverlayEnd {
	index?: number;
	at?: IPlace;
}

/** What to draw. */
export interface IOverlayModel {
	hovered: number | null;
	selected: number | null;
	/** Keyboard focus. */
	focused: number | null;
	/** Highlighted points (answer sources, query top-k, lasso selection). */
	highlight: number[];
	/** Links from the selected point to its neighbours. */
	neighbours: IOverlayEnd[];
	/** Out-of-sample points drawn hollow. */
	hollow: IPlace[];
	star: IStar | null;
	/** From the star to each true top-k result. */
	rays: IOverlayEnd[];
	/** A document's points in chunk order. */
	chunkPath: number[];
	/** Near-duplicate pairs. */
	duplicates: Array<[number, number]>;
	outliers: number[];
	/** The lasso path, screen x,y interleaved. */
	lasso: number[];
	/** 0..1: the one-off pulse of highlighted points (0 = none; always 0 under reduced motion). */
	pulse: number;
}

/** What a frame of the overlay actually drew (ends that resolved to a screen position, not what was asked). */
export interface IOverlayDrawn {
	/** The query star is on screen. */
	star: boolean;
	/** Rays drawn from the star. */
	rays: number;
	/** Neighbour links drawn from the selected point. */
	links: number;
	/** Chunk-path points that are an end of a drawn segment. */
	chunkPath: number;
}

/**
 * The canvas root's data attributes for what the overlay drew (`data-star`
 * '1'/'0', `data-rays`, `data-links`, `data-chunk-path`): the browser lanes
 * read the canvas through them.
 *
 * @param drawn - What the last frame drew.
 * @returns dataset entries (camelCase keys).
 */
export function overlayDataset(drawn: IOverlayDrawn): { star: string; rays: string; links: string; chunkPath: string } {
	return { star: drawn.star ? '1' : '0', rays: String(drawn.rays), links: String(drawn.links), chunkPath: String(drawn.chunkPath) };
}

/** Colours (resolved CSS). */
export interface IOverlayColours {
	accent: string;
	outline: string;
	other: string;
	text: string;
	/** The canvas surface (the star's edge). */
	surface: string;
}

/**
 * Draw the overlay. The caller clears the overlay canvas and sets the device-pixel transform.
 *
 * @param ctx - 2D context.
 * @param model - What to draw.
 * @param screen - Screen position of a sample point, or null.
 * @param place - Screen position of a layout place, or null.
 * @param colours - Resolved colours.
 * @param dpr - devicePixelRatio (line widths stay in CSS pixels).
 * @returns What was drawn (counts of the marks whose ends were on screen).
 */
export function drawOverlay(ctx: CanvasRenderingContext2D, model: IOverlayModel, screen: (index: number) => [number, number] | null, place: (p: IPlace) => [number, number] | null, colours: IOverlayColours, dpr: number): IOverlayDrawn {
	void dpr;
	const drawn: IOverlayDrawn = { star: false, rays: 0, links: 0, chunkPath: 0 };
	const at = (end: IOverlayEnd): [number, number] | null => (end.index !== undefined ? screen(end.index) : end.at ? place(end.at) : null);
	const ring = (p: [number, number] | null, r: number): boolean => {
		if (p === null) return false;
		ctx.moveTo(p[0] + r, p[1]);
		ctx.arc(p[0], p[1], r, 0, 2 * Math.PI);
		return true;
	};

	// Duplicate pairs: dashed lines in the outline colour.
	if (model.duplicates.length > 0) {
		let any = false;
		ctx.beginPath();
		for (const [a, b] of model.duplicates) {
			const pa = screen(a);
			const pb = screen(b);
			if (pa === null || pb === null) continue;
			ctx.moveTo(pa[0], pa[1]);
			ctx.lineTo(pb[0], pb[1]);
			any = true;
		}
		if (any) {
			ctx.setLineDash([4, 3]);
			ctx.strokeStyle = colours.outline;
			ctx.lineWidth = 1.5;
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	// The chunk path: a polyline in chunk order, broken where a point has no position.
	if (model.chunkPath.length > 1) {
		let any = false;
		let pen = false;
		// A point counts once it is an end of a drawn segment (the first end is counted with the second).
		let run = 0;
		ctx.beginPath();
		for (const i of model.chunkPath) {
			const p = screen(i);
			if (p === null) {
				pen = false;
				run = 0;
				continue;
			}
			if (pen) {
				ctx.lineTo(p[0], p[1]);
				any = true;
				drawn.chunkPath += run === 1 ? 2 : 1;
			} else ctx.moveTo(p[0], p[1]);
			pen = true;
			run += 1;
		}
		if (any) {
			ctx.strokeStyle = colours.accent;
			ctx.lineWidth = 1.5;
			ctx.stroke();
		}
	}

	// Neighbour links from the selected point.
	const from = model.selected === null ? null : screen(model.selected);
	if (from !== null && model.neighbours.length > 0) {
		let any = false;
		ctx.beginPath();
		for (const end of model.neighbours) {
			const p = at(end);
			if (p === null) continue;
			ctx.moveTo(from[0], from[1]);
			ctx.lineTo(p[0], p[1]);
			any = true;
			drawn.links += 1;
		}
		if (any) {
			ctx.strokeStyle = colours.accent;
			ctx.lineWidth = 1;
			ctx.stroke();
		}
	}

	// Rays from the star to the true top-k.
	const star = model.star ? place(model.star) : null;
	if (star !== null && model.rays.length > 0) {
		let any = false;
		ctx.beginPath();
		for (const end of model.rays) {
			const p = at(end);
			if (p === null) continue;
			ctx.moveTo(star[0], star[1]);
			ctx.lineTo(p[0], p[1]);
			any = true;
			drawn.rays += 1;
		}
		if (any) {
			ctx.setLineDash(model.star?.exact === false ? [6, 3] : []);
			ctx.strokeStyle = colours.accent;
			ctx.lineWidth = 1.25;
			ctx.stroke();
			ctx.setLineDash([]);
		}
	}

	// Hollow out-of-sample points.
	if (model.hollow.length > 0) {
		let any = false;
		ctx.beginPath();
		for (const p of model.hollow) any = ring(place(p), 4.5) || any;
		if (any) {
			ctx.strokeStyle = colours.other;
			ctx.lineWidth = 2;
			ctx.stroke();
		}
	}

	// Outliers: thin rings in the outline colour.
	if (model.outliers.length > 0) {
		let any = false;
		ctx.beginPath();
		for (const i of model.outliers) any = ring(screen(i), 7) || any;
		if (any) {
			ctx.strokeStyle = colours.outline;
			ctx.lineWidth = 1;
			ctx.stroke();
		}
	}

	// Highlighted points: accent rings (grown by the one-off pulse).
	if (model.highlight.length > 0) {
		let any = false;
		ctx.beginPath();
		const r = 6.5 + 6 * Math.max(0, Math.min(1, model.pulse));
		for (const i of model.highlight) any = ring(screen(i), r) || any;
		if (any) {
			ctx.strokeStyle = colours.accent;
			ctx.lineWidth = 2;
			ctx.stroke();
		}
	}

	// The star: a five-pointed star filled with the accent, edged with the surface.
	if (star !== null) {
		drawn.star = true;
		const outer = 9;
		const inner = 4;
		ctx.beginPath();
		for (let v = 0; v < 10; v += 1) {
			const angle = -Math.PI / 2 + (v * Math.PI) / 5;
			const r = v % 2 === 0 ? outer : inner;
			const x = star[0] + r * Math.cos(angle);
			const y = star[1] + r * Math.sin(angle);
			if (v === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.closePath();
		ctx.fillStyle = colours.accent;
		ctx.fill();
		ctx.strokeStyle = colours.outline;
		ctx.lineWidth = 1;
		ctx.stroke();
	}

	// Hover (outline colour), selection (accent, thicker), keyboard focus (dashed accent).
	const hover = model.hovered === null || model.hovered === model.selected ? null : screen(model.hovered);
	if (hover !== null) {
		ctx.beginPath();
		ring(hover, 7);
		ctx.strokeStyle = colours.outline;
		ctx.lineWidth = 1.5;
		ctx.stroke();
	}
	if (from !== null) {
		ctx.beginPath();
		ring(from, 9);
		ctx.strokeStyle = colours.accent;
		ctx.lineWidth = 2.5;
		ctx.stroke();
	}
	const focus = model.focused === null ? null : screen(model.focused);
	if (focus !== null) {
		ctx.beginPath();
		ring(focus, 12);
		ctx.setLineDash([3, 2]);
		ctx.strokeStyle = colours.accent;
		ctx.lineWidth = 2;
		ctx.stroke();
		ctx.setLineDash([]);
	}

	// The lasso outline being drawn.
	if (model.lasso.length >= 4) {
		ctx.beginPath();
		ctx.moveTo(model.lasso[0] as number, model.lasso[1] as number);
		for (let v = 2; v + 1 < model.lasso.length; v += 2) ctx.lineTo(model.lasso[v] as number, model.lasso[v + 1] as number);
		ctx.closePath();
		ctx.setLineDash([5, 4]);
		ctx.strokeStyle = colours.accent;
		ctx.lineWidth = 1.5;
		ctx.stroke();
		ctx.setLineDash([]);
	}
	return drawn;
}

// =============================================================================
// THE EDGE LAYER
// =============================================================================

/** Alpha steps of the edge layer (one path, one stroke each). */
export const EDGE_BUCKETS = 8;

/** Something segments are drawn into: a Path2D in the browser, a recorder in tests. */
export interface IPathSink {
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
}

/**
 * The alpha bucket of every edge: linear in similarity between the set's
 * weakest (0) and strongest (EDGE_BUCKETS - 1) edge.
 *
 * @param edges - The edges.
 * @returns One bucket per edge.
 */
export function edgeBuckets(edges: IEdgeSet): Uint8Array {
	const out = new Uint8Array(edges.count);
	let lo = Infinity;
	let hi = -Infinity;
	for (let e = 0; e < edges.count; e += 1) {
		const s = edges.sim[e] as number;
		if (s < lo) lo = s;
		if (s > hi) hi = s;
	}
	for (let e = 0; e < edges.count; e += 1) {
		const t = hi > lo ? ((edges.sim[e] as number) - lo) / (hi - lo) : 1;
		out[e] = Math.min(EDGE_BUCKETS - 1, Math.max(0, Math.round(t * (EDGE_BUCKETS - 1))));
	}
	return out;
}

/**
 * The opacity of a bucket (weakest faintest).
 *
 * @param bucket - 0..EDGE_BUCKETS-1.
 * @returns Alpha, 0.15 to 0.8.
 */
export function edgeAlpha(bucket: number): number {
	return 0.15 + (0.65 * Math.max(0, Math.min(EDGE_BUCKETS - 1, bucket))) / (EDGE_BUCKETS - 1);
}

/**
 * Build one path per bucket.
 *
 * @param edges - The edges.
 * @param buckets - From {@link edgeBuckets}.
 * @param at - Where a point is (layout units in 2D, screen pixels in 3D), or null when it has no position.
 * @param makePath - A new empty path.
 * @returns The paths (null for an empty bucket) and the segments drawn.
 */
export function buildEdgePaths<P extends IPathSink>(edges: IEdgeSet, buckets: Uint8Array, at: (i: number) => [number, number] | null, makePath: () => P): { paths: Array<P | null>; segments: number } {
	const paths: Array<P | null> = new Array(EDGE_BUCKETS).fill(null);
	let segments = 0;
	for (let e = 0; e < edges.count; e += 1) {
		const pa = at(edges.a[e] as number);
		const pb = at(edges.b[e] as number);
		if (pa === null || pb === null) continue;
		const b = buckets[e] ?? 0;
		let path = paths[b] ?? null;
		if (path === null) {
			path = makePath();
			paths[b] = path;
		}
		path.moveTo(pa[0], pa[1]);
		path.lineTo(pb[0], pb[1]);
		segments += 1;
	}
	return { paths, segments };
}

/**
 * Stroke the bucket paths (the caller set the transform).
 *
 * @param ctx - The edge canvas's context.
 * @param paths - From {@link buildEdgePaths}.
 * @param colour - The edge colour.
 * @param lineWidth - In the transform's units.
 * @returns Strokes made (at most EDGE_BUCKETS).
 */
export function strokeEdgePaths(ctx: CanvasRenderingContext2D, paths: ReadonlyArray<Path2D | null>, colour: string, lineWidth: number): number {
	let strokes = 0;
	ctx.strokeStyle = colour;
	ctx.lineWidth = lineWidth;
	paths.forEach((path, b) => {
		if (path === null) return;
		ctx.globalAlpha = edgeAlpha(b);
		ctx.stroke(path);
		strokes += 1;
	});
	ctx.globalAlpha = 1;
	return strokes;
}

/**
 * The canvas transform that draws layout units where the 2D camera draws the
 * points (device pixels), and the line width of one CSS pixel in those units.
 *
 * @param camera - The 2D camera.
 * @param vp - The viewport (CSS pixels).
 * @param dpr - devicePixelRatio.
 * @returns setTransform's a..f and the line width.
 */
export function edgeTransform2d(camera: ICamera2D, vp: IViewport, dpr: number): { a: number; b: number; c: number; d: number; e: number; f: number; lineWidth: number } {
	const s = camera.scale;
	return { a: dpr * s, b: 0, c: 0, d: -dpr * s, e: dpr * (vp.width / 2 - camera.cx * s), f: dpr * (vp.height / 2 + camera.cy * s), lineWidth: s > 0 ? 1 / s : 1 };
}

// =============================================================================
// EXTRAS: star B, hover edges, cluster labels
// =============================================================================

/** One cluster label to draw. */
export interface IClusterLabel {
	cluster: number;
	/** The point it is drawn at (the group's medoid). */
	at: number;
	text: string;
}

/** What the overlay draws besides IOverlayModel. */
export interface IOverlayExtras {
	/** The compared question's star (Search's Compare), or null. */
	starB: IStar | null;
	/** From star B to its true top-k. */
	raysB: IOverlayEnd[];
	/** The hovered point's edges, drawn thicker (point pairs). */
	hoverEdges: Array<[number, number]>;
	/** Cluster labels, largest groups first. */
	labels: IClusterLabel[];
	/** False when zoomed out past the labels' threshold. */
	showLabels: boolean;
	/** The hovered label's cluster: its points get a ring. */
	clusterHighlight: number[];
}

/** What drawExtras drew. */
export interface IExtrasDrawn {
	starB: boolean;
	raysB: number;
	labels: number;
	/** Screen boxes of the drawn labels (hover hit-testing). */
	boxes: Array<{ cluster: number; x: number; y: number; w: number; h: number }>;
	hoverEdges: number;
}

/** Labels drawn per frame at most. */
export const MAX_LABELS = 50;

/** Terms of a label drawn on the canvas (the Clusters tab shows them all). */
const LABEL_TERMS = 3;

/**
 * The canvas root's data attributes for the extras (`data-star-b`, `data-rays-b`, `data-labels`).
 *
 * @param drawn - What drawExtras drew.
 * @returns dataset entries (camelCase keys).
 */
export function extrasDataset(drawn: IExtrasDrawn): { starB: string; raysB: string; labels: string } {
	return { starB: drawn.starB ? '1' : '0', raysB: String(drawn.raysB), labels: String(drawn.labels) };
}

/**
 * Draw the extras on the overlay (after drawOverlay).
 *
 * @param ctx - The overlay's 2D context (CSS-pixel transform set).
 * @param extras - What to draw.
 * @param screen - Screen position of a sample point, or null.
 * @param place - Screen position of a layout place, or null.
 * @param colours - Resolved colours.
 * @returns What was drawn.
 */
export function drawExtras(ctx: CanvasRenderingContext2D, extras: IOverlayExtras, screen: (index: number) => [number, number] | null, place: (p: IPlace) => [number, number] | null, colours: IOverlayColours): IExtrasDrawn {
	const drawn: IExtrasDrawn = { starB: false, raysB: 0, labels: 0, boxes: [], hoverEdges: 0 };
	const at = (end: IOverlayEnd): [number, number] | null => (end.index !== undefined ? screen(end.index) : end.at ? place(end.at) : null);

	// The hovered point's edges, thicker, in the accent.
	if (extras.hoverEdges.length > 0) {
		ctx.beginPath();
		for (const [a, b] of extras.hoverEdges) {
			const pa = screen(a);
			const pb = screen(b);
			if (pa === null || pb === null) continue;
			ctx.moveTo(pa[0], pa[1]);
			ctx.lineTo(pb[0], pb[1]);
			drawn.hoverEdges += 1;
		}
		if (drawn.hoverEdges > 0) {
			ctx.strokeStyle = colours.accent;
			ctx.lineWidth = 2;
			ctx.stroke();
		}
	}

	// The hovered label's cluster: thin accent rings.
	if (extras.clusterHighlight.length > 0) {
		let any = false;
		ctx.beginPath();
		for (const i of extras.clusterHighlight) {
			const p = screen(i);
			if (p === null) continue;
			ctx.moveTo(p[0] + 6, p[1]);
			ctx.arc(p[0], p[1], 6, 0, 2 * Math.PI);
			any = true;
		}
		if (any) {
			ctx.strokeStyle = colours.accent;
			ctx.lineWidth = 1.5;
			ctx.stroke();
		}
	}

	// Star B: rays dotted, the star hollow (filled with the surface, edged with the accent).
	const star = extras.starB ? place(extras.starB) : null;
	if (star !== null) {
		if (extras.raysB.length > 0) {
			ctx.beginPath();
			for (const end of extras.raysB) {
				const p = at(end);
				if (p === null) continue;
				ctx.moveTo(star[0], star[1]);
				ctx.lineTo(p[0], p[1]);
				drawn.raysB += 1;
			}
			if (drawn.raysB > 0) {
				ctx.setLineDash([2, 3]);
				ctx.strokeStyle = colours.accent;
				ctx.lineWidth = 1.25;
				ctx.stroke();
				ctx.setLineDash([]);
			}
		}
		ctx.beginPath();
		for (let v = 0; v < 10; v += 1) {
			const angle = -Math.PI / 2 + (v * Math.PI) / 5;
			const r = v % 2 === 0 ? 9 : 4;
			const x = star[0] + r * Math.cos(angle);
			const y = star[1] + r * Math.sin(angle);
			if (v === 0) ctx.moveTo(x, y);
			else ctx.lineTo(x, y);
		}
		ctx.closePath();
		ctx.fillStyle = colours.surface;
		ctx.fill();
		ctx.strokeStyle = colours.accent;
		ctx.lineWidth = 2;
		ctx.stroke();
		drawn.starB = true;
	}

	// Cluster labels at their medoids: largest groups first, none over another.
	if (extras.showLabels && extras.labels.length > 0) {
		ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.lineJoin = 'round';
		for (const label of extras.labels) {
			if (drawn.labels >= MAX_LABELS) break;
			const p = screen(label.at);
			if (p === null) continue;
			const text = label.text.split(' · ').slice(0, LABEL_TERMS).join(' · ');
			const measured = ctx.measureText ? ctx.measureText(text) : null;
			const w = (measured && Number.isFinite(measured.width) ? measured.width : text.length * 6) + 6;
			const h = 15;
			const box = { cluster: label.cluster, x: p[0] - w / 2, y: p[1] - 14 - h / 2, w, h };
			if (drawn.boxes.some((o) => box.x < o.x + o.w && o.x < box.x + box.w && box.y < o.y + o.h && o.y < box.y + box.h)) continue;
			ctx.lineWidth = 3;
			ctx.strokeStyle = colours.surface;
			ctx.strokeText(text, p[0], p[1] - 14);
			ctx.fillStyle = colours.text;
			ctx.fillText(text, p[0], p[1] - 14);
			drawn.boxes.push(box);
			drawn.labels += 1;
		}
	}
	return drawn;
}
