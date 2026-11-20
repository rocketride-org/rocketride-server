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
// VECTOR-UI — PointCanvas (the map itself: WebGL1 points, overlay, pointer and keys)
// =============================================================================
//
// Draws the sample with the WebGL1 renderer (Canvas2D when WebGL is not
// available) and an overlay canvas on top, and turns pointer, wheel and key
// events into map actions through the pure modules in src/map:
//
//   - drag pans (2D) or orbits (3D); the wheel zooms about the pointer; a click
//     picks the nearest point; in lasso mode a drag draws the outline and the
//     release selects what is inside;
//   - arrow keys move the keyboard focus to the nearest point in that 90° sector,
//     +/- zoom, 0 fits; Enter, Escape and L are handed to the map view;
//   - hover shows a tooltip; the overlay draws rings, links, the star and rays.
//
// Canvas rules: the size is observed (ResizeObserver), the backing store is
// never 0x0 and follows devicePixelRatio, the map redraws when revealed, a lost
// WebGL context is restored by the renderer, and frames are drawn on demand
// (requestAnimationFrame, coalesced) without a React render per frame. The
// container is the only focusable element and handles its own keys; it never
// stops an event from propagating and registers no window listeners.
//
// The container's data attributes are what the browser lanes read (the map is
// a canvas, so what they cannot read from text they read here):
//   data-points     points drawn (hidden ones left out)
//   data-renderer   'webgl' | 'canvas2d' | 'none'
//   data-mode       'detailed' | 'light'
//   data-layout     the layout shown: 'pca' | 'neighbour-graph' | 'tsne'
//   data-selected / data-focused   the inspected / keyboard-focused point, '' for none
//   data-selection  points in the lasso selection, '' for none
//   data-overlap-pca / data-overlap-layout   kNN overlaps (4 dp), '' before a run
// and, written by each frame (what it DREW, not what was asked):
//   data-star ('1'/'0'), data-rays, data-links, data-chunk-path,
//   data-star-b ('1'/'0'), data-rays-b, data-labels (cluster labels),
//   data-edges (segments of the edge layer's last redraw), data-edge-strokes,
//   data-draw-count (frames drawn so far), data-camera, data-draw-p95.
// The hover box is role="tooltip" (data-map-tooltip holds the point index).
//
// The similarity edges (Neighbours or Tree) have their own canvas UNDER the
// points, redrawn only when the camera, the size or the edge set changes (in
// 2D the paths are built once per edge set, in layout units, and stroked
// through the camera's transform: map/overlay.ts). They fade in unless reduced
// motion is asked for. When two frames that drew edges each take over 33 ms,
// onSlowEdges is called once per edge set (the view may draw fewer). Hovering
// a point thickens its edges; hovering a cluster label rings its points.
// onSnapshotter receives the function the map's PNG uses: it copies the edge
// layer, the points (the renderer's snapshot) and the overlay, in that order.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PointCanvasProps as ContractPointCanvasProps, MapLayout } from '../contract/types';
import { boundsOf, cameraSignature, dollyCamera, fitCamera, fitCamera3D, orbitCamera, panBy, projectToScreen, viewMatrix, zoomAt } from '../map/camera';
import type { ICamera2D, IViewport, MapCamera } from '../map/camera';
import { recallCamera, rememberCamera } from '../map/cameraMemory';
import { opaqueOver, parseColor } from '../map/contrast';
import { incidentEdges } from '../map/graph';
import type { IEdgeSet } from '../map/graph';
import { createFrameStats, createGesture, keyAction, wheelZoomFactor } from '../map/interaction';
import type { KeyAction } from '../map/interaction';
import { lassoSelect, simplifyPath } from '../map/lasso';
import { buildEdgePaths, drawExtras, drawOverlay, edgeBuckets, edgeTransform2d, extrasDataset, overlayDataset, strokeEdgePaths } from '../map/overlay';
import type { IClusterLabel, IExtrasDrawn, IOverlayDrawn, IOverlayModel, IPlace } from '../map/overlay';
import { buildScreenIndex, nearestInSector, pickNearest } from '../map/picking';
import type { IScreenIndex } from '../map/picking';
import type { IStar } from '../map/queryProjection';
import { createCanvas2dRenderer } from '../map/renderer.canvas2d';
import { createWebglRenderer, packPoints, sizeCanvas } from '../map/renderer.webgl';
import type { IPointData, IPointRenderer } from '../map/renderer.webgl';
import { MAP_STYLES, ensureMapStyle } from '../map/styles';
import type { IMapPalette } from '../map/tokens';

/** Props: the frozen ones plus what the map view supplies. */
export interface PointCanvasProps extends ContractPointCanvasProps {
	/** RGBA bytes per point (skips parsing `colours`). */
	rgba?: Uint8Array | null;
	/** 1 per point drawn with the outline. */
	outlined?: Uint8Array | null;
	/** 1 per hidden point (removed document). */
	hidden?: Uint8Array | null;
	/** 1 per emphasised point (larger, outlined). */
	emphasised?: Uint8Array | null;
	/** Overlay marks (rings, links, star, rays, path, duplicates, outliers). */
	overlay?: Partial<Omit<IOverlayModel, 'hovered' | 'lasso'>>;
	palette?: IMapPalette | null;
	/** Point diameter in CSS pixels. */
	pointSizePx?: number;
	/** Camera memory key (the connection). */
	cameraKey?: string;
	/** Change to refit the camera to the points. */
	fitToken?: number;
	/** Bring a point into view (a new `seq` each time). */
	centreOn?: { index: number; seq: number } | null;
	/** False while the tab is hidden: nothing is drawn. */
	visible?: boolean;
	/** Accessible name of the map. */
	label?: string;
	/** Tooltip text of a point. */
	describe?(index: number): string;
	/** The keyboard focus moved to a point. */
	onFocusMove?(index: number): void;
	/** Enter, Escape or L on the map. */
	onKeyAction?(action: KeyAction): void;
	/** Which renderer runs. */
	onRendererInfo?(kind: 'webgl' | 'canvas2d' | 'none'): void;
	/** The layout shown (data-layout; 'pca' when not given). */
	layout?: MapLayout;
	/** Points in the lasso selection (data-selection), or null for none. */
	selectionCount?: number | null;
	/** kNN overlaps of the last refined layout and of PCA (data-overlap-layout / data-overlap-pca), or null before a run. */
	overlap?: { layout: number | null; pca: number | null } | null;
	/** Similarity edges drawn under the points (none when absent). */
	edges?: IEdgeSet | null;
	/** The compared question's star (B) and its rays. */
	starB?: IStar | null;
	raysB?: IOverlayModel['rays'];
	/** Cluster labels, largest groups first (drawn at their medoids). */
	clusterLabels?: readonly IClusterLabel[];
	/** Each point's cluster (-1: none), so hovering a label rings its points. */
	clusterOf?: ArrayLike<number> | null;
	/** No fade-in of the edges. */
	reducedMotion?: boolean;
	/** Two frames that drew edges took over 33 ms each (called once per edge set). */
	onSlowEdges?(): void;
	/**
	 * Receives the PNG's copy function while a renderer runs (null when it is let go): it returns a new canvas
	 * at the map's backing size holding the edge layer, the points and the overlay, or null when the map is
	 * not drawn (a lost context).
	 */
	onSnapshotter?(snapshot: (() => HTMLCanvasElement | null) | null): void;
	/** Put the camera here (a saved view; a new `seq` each time). */
	cameraOverride?: { camera: MapCamera; seq: number } | null;
}

/** Labels hide below this fraction of the fitted zoom. */
export const LABEL_MIN_ZOOM = 0.6;

/** A frame slower than this counts towards dropping edges. */
const SLOW_FRAME_MS = 33;

/** Nothing drawn (no overlay context). */
const NOTHING_DRAWN: IOverlayDrawn = { star: false, rays: 0, links: 0, chunkPath: 0 };
const NO_EXTRAS_DRAWN: IExtrasDrawn = { starB: false, raysB: 0, labels: 0, boxes: [], hoverEdges: 0 };

/** The edge layer's cached paths and what they were built from. */
interface IEdgeCache {
	edges: IEdgeSet | null;
	positions: Float32Array | null;
	dims: number;
	/** World-space paths (2D); rebuilt per frame in 3D. */
	paths: Array<Path2D | null>;
	segments: number;
	/** camera|size|dpr|colour of the last redraw ('' forces one). */
	drawnKey: string;
	/** Frames over SLOW_FRAME_MS that drew edges, and whether onSlowEdges was called for this set. */
	slow: number;
	fired: boolean;
}

/** An overlap for its data attribute: 4 decimals, '' when there is none. */
const overlapAttr = (value: number | null | undefined): string => (typeof value === 'number' && Number.isFinite(value) ? value.toFixed(4) : '');

/** Points canvas and overlay share the container's size. */
const LAYER: React.CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };

/** RGBA bytes from CSS colours (parsed once per distinct colour). */
function rgbaOf(colours: readonly string[]): Uint8Array {
	const out = new Uint8Array(colours.length * 4);
	const cache = new Map<string, [number, number, number]>();
	colours.forEach((colour, i) => {
		let rgb = cache.get(colour);
		if (!rgb) {
			const c = parseColor(colour) ?? { r: 128, g: 128, b: 128 };
			rgb = [c.r, c.g, c.b];
			cache.set(colour, rgb);
		}
		out[4 * i] = rgb[0];
		out[4 * i + 1] = rgb[1];
		out[4 * i + 2] = rgb[2];
		out[4 * i + 3] = 255;
	});
	return out;
}

/**
 * The point map canvas.
 *
 * @param props - Points, colours, overlay and handlers.
 * @returns The canvas host.
 */
export function PointCanvas(props: PointCanvasProps): React.ReactElement {
	const containerRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const edgeRef = useRef<HTMLCanvasElement>(null);
	const overlayRef = useRef<HTMLCanvasElement>(null);
	const edgeCacheRef = useRef<IEdgeCache>({ edges: null, positions: null, dims: 2, paths: [], segments: 0, drawnKey: '', slow: 0, fired: false });
	const fitScaleRef = useRef<number | null>(null);
	const labelBoxesRef = useRef<IExtrasDrawn['boxes']>([]);
	const hoveredClusterRef = useRef<number | null>(null);
	const rendererRef = useRef<IPointRenderer | null>(null);
	const cameraRef = useRef<MapCamera | null>(null);
	const sizeRef = useRef({ width: 0, height: 0, dpr: 1 });
	const screenRef = useRef<{ xy: Float32Array; depth: Float32Array; index: IScreenIndex | null }>({ xy: new Float32Array(0), depth: new Float32Array(0), index: null });
	const gestureRef = useRef(createGesture());
	const lassoRef = useRef<number[]>([]);
	const hoveredRef = useRef<number | null>(null);
	const frameRef = useRef(0);
	const statsRef = useRef(createFrameStats());
	const drawCountRef = useRef(0);
	const propsRef = useRef(props);
	propsRef.current = props;
	// 'pending' until the map is first shown (no context is created for a hidden map).
	const [rendererKind, setRendererKind] = useState<'webgl' | 'canvas2d' | 'none' | 'pending'>('pending');
	const wanted = props.visible !== false;
	const [tooltip, setTooltip] = useState<{ index: number; x: number; y: number } | null>(null);

	const data: IPointData = useMemo(
		() => packPoints({ positions: props.positions, dims: props.dimensions, rgba: props.rgba ?? rgbaOf(props.colours), outlined: props.outlined ?? null, hidden: props.hidden ?? null, emphasised: props.emphasised ?? null, hollow: null }),
		[props.positions, props.dimensions, props.rgba, props.colours, props.outlined, props.hidden, props.emphasised],
	);
	const dataRef = useRef(data);
	dataRef.current = data;
	const visibleCount = useMemo(() => {
		let hidden = 0;
		if (props.hidden) for (let i = 0; i < data.count; i += 1) hidden += props.hidden[i] ? 1 : 0;
		return data.count - hidden;
	}, [data, props.hidden]);

	/** The viewport in CSS pixels. */
	const viewport = (): IViewport => ({ width: Math.max(1, sizeRef.current.width), height: Math.max(1, sizeRef.current.height) });

	/** Overlay and outline colours of the current palette. */
	const colours = useMemo(() => {
		const p = props.palette;
		const surface = p?.surfaces.default ?? '#ffffff';
		const bg = parseColor(surface) ?? { r: 255, g: 255, b: 255 };
		const outline = opaqueOver(p?.outline ?? '#1a1a1a', bg) ?? { r: 26, g: 26, b: 26 };
		return {
			overlay: { accent: p?.accent ?? '#0078d4', outline: p?.outline ?? '#1a1a1a', other: p?.other ?? '#666666', text: p?.text ?? '#1a1a1a', surface },
			outlineRgb: [outline.r / 255, outline.g / 255, outline.b / 255] as [number, number, number],
		};
	}, [props.palette]);
	const coloursRef = useRef(colours);
	coloursRef.current = colours;

	/** Fit the camera to the visible points. */
	const fit = useCallback((): void => {
		const p = propsRef.current;
		if (sizeRef.current.width <= 0 || sizeRef.current.height <= 0) {
			// Not laid out yet (a hidden tab): the first frame with a real size fits.
			cameraRef.current = null;
			return;
		}
		const vp = viewport();
		if (p.dimensions === 3) cameraRef.current = fitCamera3D(p.positions, p.hidden ?? null);
		else {
			const bounds = boundsOf(p.positions, 2, p.hidden ?? null);
			cameraRef.current = bounds ? fitCamera(bounds, vp, 28) : { mode: '2d', cx: 0, cy: 0, scale: 1 };
			fitScaleRef.current = cameraRef.current.scale;
		}
		if (p.cameraKey) rememberCamera(p.cameraKey, cameraRef.current);
	}, []);

	/**
	 * Redraw the edge layer when the camera, the size, the colour or the edge set changed.
	 *
	 * @returns True when it drew (the frame counts towards the slow-frame rule).
	 */
	const drawEdges = useCallback((camera: MapCamera, vp: IViewport): boolean => {
		const canvas = edgeRef.current;
		const ctx = canvas ? canvas.getContext('2d') : null;
		if (!canvas || !ctx) return false;
		const p = propsRef.current;
		const edges = p.edges ?? null;
		const cache = edgeCacheRef.current;
		const size = sizeRef.current;
		const colour = coloursRef.current.overlay.other;
		const positions = dataRef.current.positions;
		if (cache.edges !== edges) {
			cache.slow = 0;
			cache.fired = false;
		}
		const rebuild = cache.edges !== edges || cache.positions !== positions || camera.mode === '3d';
		const key = `${cameraSignature(camera)}|${size.width}x${size.height}@${size.dpr}|${colour}`;
		if (!rebuild && key === cache.drawnKey) return false;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		cache.drawnKey = key;
		if (edges === null || edges.count === 0) {
			cache.edges = edges;
			cache.positions = positions;
			cache.paths = [];
			cache.segments = 0;
			return false;
		}
		const makePath = (): Path2D => new Path2D();
		if (camera.mode === '2d') {
			if (rebuild) {
				// Layout units (x, y of the packed points): built once per edge set and stroked through the camera.
				const built = buildEdgePaths(edges, edgeBuckets(edges), (i) => (i < dataRef.current.count ? [positions[3 * i] as number, positions[3 * i + 1] as number] : null), makePath);
				cache.paths = built.paths;
				cache.segments = built.segments;
			}
			const t = edgeTransform2d(camera, vp, size.dpr);
			ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
			strokeEdgePaths(ctx, cache.paths, colour, t.lineWidth);
		} else {
			const xy = screenRef.current.xy;
			const hidden = p.hidden ?? null;
			const built = buildEdgePaths(edges, edgeBuckets(edges), (i) => {
				if (hidden && hidden[i]) return null;
				const x = xy[2 * i] as number;
				const y = xy[2 * i + 1] as number;
				return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
			}, makePath);
			cache.paths = built.paths;
			cache.segments = built.segments;
			ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
			strokeEdgePaths(ctx, cache.paths, colour, 1);
		}
		cache.edges = edges;
		cache.positions = positions;
		return true;
	}, []);

	/** Draw one frame now. */
	const draw = useCallback((): void => {
		const p = propsRef.current;
		const renderer = rendererRef.current;
		const size = sizeRef.current;
		if (p.visible === false || renderer === null || size.width <= 0 || size.height <= 0) return;
		if (cameraRef.current === null || (cameraRef.current.mode === '3d') !== (p.dimensions === 3)) fit();
		const camera = cameraRef.current as MapCamera;
		const started = typeof performance !== 'undefined' ? performance.now() : Date.now();
		const vp = viewport();
		const matrix = viewMatrix(camera, vp);
		renderer.render({ matrix, pointSizePx: p.pointSizePx ?? 5, dpr: size.dpr });
		const points = dataRef.current;
		const screen = screenRef.current;
		if (screen.xy.length !== points.count * 2) {
			screen.xy = new Float32Array(points.count * 2);
			screen.depth = new Float32Array(points.count);
		}
		projectToScreen(points.positions, 3, matrix, vp, screen.xy, screen.depth);
		screen.index = null;
		const overlay = overlayRef.current;
		const ctx = overlay ? overlay.getContext('2d') : null;
		let drawn = NOTHING_DRAWN;
		let extras = NO_EXTRAS_DRAWN;
		if (ctx && overlay) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, overlay.width, overlay.height);
			ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
			const hidden = p.hidden ?? null;
			const screenOf = (i: number): [number, number] | null => {
				if (i < 0 || i >= points.count || (hidden && hidden[i])) return null;
				const x = screen.xy[2 * i] as number;
				const y = screen.xy[2 * i + 1] as number;
				return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
			};
			const one = new Float32Array(3);
			const out = new Float32Array(2);
			const placeOf = (place: IPlace): [number, number] | null => {
				one[0] = place.x;
				one[1] = place.y;
				one[2] = place.z ?? 0;
				projectToScreen(one, 3, matrix, vp, out);
				return Number.isFinite(out[0] as number) && Number.isFinite(out[1] as number) ? [out[0] as number, out[1] as number] : null;
			};
			const o = p.overlay ?? {};
			const model: IOverlayModel = {
				hovered: hoveredRef.current,
				selected: o.selected ?? null,
				focused: o.focused ?? null,
				highlight: o.highlight ?? [],
				neighbours: o.neighbours ?? [],
				hollow: o.hollow ?? [],
				star: o.star ?? null,
				rays: o.rays ?? [],
				chunkPath: o.chunkPath ?? [],
				duplicates: o.duplicates ?? [],
				outliers: o.outliers ?? [],
				lasso: lassoRef.current,
				pulse: o.pulse ?? 0,
			};
			drawn = drawOverlay(ctx, model, screenOf, placeOf, coloursRef.current.overlay, size.dpr);
			const edgesNow = p.edges ?? null;
			const hovered = hoveredRef.current;
			const hoverEdges: Array<[number, number]> = hovered !== null && edgesNow !== null ? incidentEdges(edgesNow, hovered).map((e) => [edgesNow.a[e] as number, edgesNow.b[e] as number]) : [];
			const cluster = hoveredClusterRef.current;
			const clusterOf = p.clusterOf ?? null;
			const clusterHighlight: number[] = [];
			if (cluster !== null && clusterOf !== null) for (let i = 0; i < points.count; i += 1) if (clusterOf[i] === cluster) clusterHighlight.push(i);
			const fitScale = fitScaleRef.current;
			const showLabels = camera.mode === '3d' || fitScale === null || camera.scale >= LABEL_MIN_ZOOM * fitScale;
			extras = drawExtras(ctx, { starB: p.starB ?? null, raysB: p.raysB ?? [], hoverEdges, labels: [...(p.clusterLabels ?? [])], showLabels, clusterHighlight }, screenOf, placeOf, coloursRef.current.overlay);
			labelBoxesRef.current = extras.boxes;
		}
		const edgesDrawn = drawEdges(camera, vp);
		const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
		statsRef.current.record(ended - started);
		drawCountRef.current += 1;
		const cache = edgeCacheRef.current;
		if (edgesDrawn && ended - started > SLOW_FRAME_MS) {
			cache.slow += 1;
			if (cache.slow >= 2 && !cache.fired) {
				cache.fired = true;
				p.onSlowEdges?.();
			}
		}
		const el = containerRef.current;
		if (el) {
			// What this frame drew, for the browser lanes (React never renders these attributes).
			Object.assign(el.dataset, overlayDataset(drawn));
			Object.assign(el.dataset, extrasDataset(extras));
			el.dataset.edges = String(cache.segments);
			el.dataset.edgeStrokes = String(cache.paths.filter((path) => path !== null).length);
			el.dataset.drawCount = String(drawCountRef.current);
			el.dataset.camera = cameraSignature(camera);
			if (statsRef.current.count() % 30 === 0) el.dataset.drawP95 = String(Math.round((statsRef.current.p95() ?? 0) * 10) / 10);
		}
	}, [fit, drawEdges]);

	/** Ask for a frame (coalesced). */
	const requestDraw = useCallback((): void => {
		if (frameRef.current !== 0 || typeof requestAnimationFrame !== 'function') return;
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = 0;
			draw();
		});
	}, [draw]);

	// The renderer: WebGL1 first, Canvas2D when WebGL is unavailable. Created on
	// the first reveal, never for a map mounted hidden: browsers cap the live
	// WebGL contexts of a page (~16) and drop the oldest past it.
	useEffect(() => {
		ensureMapStyle();
		const canvas = canvasRef.current;
		if (!canvas || !wanted || rendererRef.current !== null) return;
		const renderer = createWebglRenderer(canvas, () => requestDraw()) ?? createCanvas2dRenderer(canvas);
		rendererRef.current = renderer;
		const kind = renderer ? renderer.kind : 'none';
		setRendererKind(kind);
		propsRef.current.onRendererInfo?.(kind);
	}, [requestDraw, wanted]);

	// The renderer is let go on unmount only (hiding the tab keeps it).
	useEffect(
		() => () => {
			if (frameRef.current !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current);
			frameRef.current = 0;
			rendererRef.current?.destroy();
			rendererRef.current = null;
		},
		[],
	);

	// Size: observed; a hidden tab measures 0 and is skipped (never a 0x0 store).
	const measure = useCallback((): void => {
		const el = containerRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const dpr = typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
		if (rect.width <= 0 || rect.height <= 0) return;
		const before = sizeRef.current;
		sizeRef.current = { width: rect.width, height: rect.height, dpr };
		rendererRef.current?.resize(rect.width, rect.height, dpr);
		if (overlayRef.current) sizeCanvas(overlayRef.current, rect.width, rect.height, dpr);
		if (edgeRef.current) sizeCanvas(edgeRef.current, rect.width, rect.height, dpr);
		if (cameraRef.current !== null && cameraRef.current.mode === '2d' && before.width > 0 && before.height > 0) {
			// Keep the same layout in view when the box changes size.
			const scale = cameraRef.current.scale * Math.min(rect.width / before.width, rect.height / before.height);
			cameraRef.current = { ...cameraRef.current, scale: Number.isFinite(scale) && scale > 0 ? scale : cameraRef.current.scale };
		}
		requestDraw();
	}, [requestDraw]);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return undefined;
		measure();
		if (typeof ResizeObserver === 'undefined') return undefined;
		const observer = new ResizeObserver(() => measure());
		observer.observe(el);
		return () => observer.disconnect();
	}, [measure]);

	// Redraw when revealed.
	useEffect(() => {
		if (props.visible !== false) {
			measure();
			requestDraw();
		}
	}, [props.visible, measure, requestDraw]);

	// Camera of this connection.
	useEffect(() => {
		cameraRef.current = props.cameraKey ? recallCamera(props.cameraKey) : null;
		requestDraw();
	}, [props.cameraKey, requestDraw]);

	// New points (layout, colours, masks): upload and draw.
	useEffect(() => {
		rendererRef.current?.setPoints(data, colours.outlineRgb);
		screenRef.current.index = null;
		requestDraw();
	}, [data, colours, rendererKind, requestDraw]);

	// Overlay, extras or size changes.
	useEffect(() => {
		requestDraw();
	}, [props.overlay, props.pointSizePx, props.starB, props.raysB, props.clusterLabels, requestDraw]);

	// A new edge set: drawn on the next frame, faded in unless reduced motion is asked for.
	useEffect(() => {
		const canvas = edgeRef.current;
		edgeCacheRef.current.drawnKey = '';
		requestDraw();
		if (!canvas || propsRef.current.reducedMotion || !props.edges || props.edges.count === 0 || typeof requestAnimationFrame !== 'function') {
			if (canvas) canvas.style.opacity = '1';
			return undefined;
		}
		canvas.style.opacity = '0';
		const raf = requestAnimationFrame(() => {
			canvas.style.opacity = '1';
		});
		return () => cancelAnimationFrame(raf);
	}, [props.edges, requestDraw]);

	// The PNG's copy: the edge layer, the points (drawn again by the renderer) and the overlay, in that order.
	useEffect(() => {
		const report = propsRef.current.onSnapshotter;
		if (!report) return undefined;
		if (rendererRef.current === null) {
			report(null);
			return undefined;
		}
		report((): HTMLCanvasElement | null => {
			const renderer = rendererRef.current;
			const points = canvasRef.current;
			if (renderer === null || renderer.lost || !points || typeof document === 'undefined') return null;
			draw();
			const out = document.createElement('canvas');
			out.width = points.width;
			out.height = points.height;
			const target = out.getContext('2d');
			if (!target) return null;
			if (edgeRef.current) target.drawImage(edgeRef.current, 0, 0);
			if (!renderer.snapshot(target)) return null;
			if (overlayRef.current) target.drawImage(overlayRef.current, 0, 0);
			return out;
		});
		return () => report(null);
	}, [rendererKind, draw]);

	// Refit on request.
	useEffect(() => {
		if (props.fitToken === undefined) return;
		fit();
		requestDraw();
	}, [props.fitToken, fit, requestDraw]);

	// A saved view's camera.
	useEffect(() => {
		const target = props.cameraOverride;
		if (!target) return;
		cameraRef.current = target.camera;
		if (propsRef.current.cameraKey) rememberCamera(propsRef.current.cameraKey, target.camera);
		requestDraw();
	}, [props.cameraOverride, requestDraw]);

	// Bring a point into view.
	useEffect(() => {
		const target = props.centreOn;
		const camera = cameraRef.current;
		if (!target || camera === null || camera.mode !== '2d') return;
		const p = propsRef.current;
		const x = p.positions[target.index * 2];
		const y = p.positions[target.index * 2 + 1];
		if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
		cameraRef.current = { ...camera, cx: x, cy: y };
		if (p.cameraKey) rememberCamera(p.cameraKey, cameraRef.current);
		requestDraw();
	}, [props.centreOn, requestDraw]);

	/** The point under a screen position. */
	const pick = useCallback((x: number, y: number): number | null => {
		const screen = screenRef.current;
		if (screen.xy.length === 0) return null;
		if (screen.index === null) screen.index = buildScreenIndex(screen.xy, viewport(), propsRef.current.hidden ?? null, propsRef.current.dimensions === 3 ? screen.depth : null);
		return pickNearest(screen.index, x, y, Math.max(8, propsRef.current.pointSizePx ?? 5));
	}, []);

	/** Pointer position relative to the container. */
	const local = (event: { clientX: number; clientY: number }): [number, number] => {
		const rect = containerRef.current?.getBoundingClientRect();
		return rect ? [event.clientX - rect.left, event.clientY - rect.top] : [event.clientX, event.clientY];
	};

	/** Apply a camera change and remember it. */
	const setCamera = (camera: MapCamera): void => {
		cameraRef.current = camera;
		const key = propsRef.current.cameraKey;
		if (key) rememberCamera(key, camera);
		requestDraw();
	};

	// Pointer and wheel (native listeners: the wheel must be able to prevent page scrolling).
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return undefined;
		const gesture = gestureRef.current;
		const onDown = (event: PointerEvent): void => {
			if (event.button !== 0) return;
			const [x, y] = local(event);
			try {
				// Keeps a drag going outside the canvas; it throws for a pointer the browser no longer tracks.
				if (typeof el.setPointerCapture === 'function') el.setPointerCapture(event.pointerId);
			} catch {
				// The gesture still works inside the canvas.
			}
			gesture.down(x, y, propsRef.current.lasso);
		};
		const onMove = (event: PointerEvent): void => {
			const [x, y] = local(event);
			if (gesture.active) {
				for (const e of gesture.move(x, y)) {
					if (e.type !== 'pan' || cameraRef.current === null) continue;
					const camera = cameraRef.current;
					setCamera(camera.mode === '2d' ? panBy(camera, e.dx, e.dy) : orbitCamera(camera, -e.dx * 0.01, e.dy * 0.01));
				}
				if (propsRef.current.lasso) {
					lassoRef.current = gesture.path();
					requestDraw();
				}
				return;
			}
			const index = pick(x, y);
			if (index !== hoveredRef.current) {
				hoveredRef.current = index;
				propsRef.current.onHover(index);
				setTooltip(index === null ? null : { index, x, y });
				requestDraw();
			}
			// Over a cluster label (and no point): ring that cluster's points.
			const box = index === null ? labelBoxesRef.current.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) : undefined;
			const cluster = box ? box.cluster : null;
			if (cluster !== hoveredClusterRef.current) {
				hoveredClusterRef.current = cluster;
				requestDraw();
			}
		};
		const onUp = (event: PointerEvent): void => {
			const [x, y] = local(event);
			for (const e of gesture.up(x, y)) {
				if (e.type === 'click') propsRef.current.onPick(pick(e.x, e.y));
				else if (e.type === 'lasso') {
					const outline = simplifyPath(e.path, 3);
					propsRef.current.onLasso(lassoSelect(screenRef.current.xy, outline, propsRef.current.hidden ?? null));
				}
			}
			lassoRef.current = [];
			requestDraw();
		};
		const onCancel = (): void => {
			gesture.cancel();
			lassoRef.current = [];
			hoveredClusterRef.current = null;
			if (hoveredRef.current !== null) {
				hoveredRef.current = null;
				propsRef.current.onHover(null);
				setTooltip(null);
			}
			requestDraw();
		};
		const onWheel = (event: WheelEvent): void => {
			const camera = cameraRef.current;
			if (camera === null) return;
			event.preventDefault();
			const factor = wheelZoomFactor(event.deltaY, event.deltaMode);
			const [x, y] = local(event);
			setCamera(camera.mode === '2d' ? zoomAt(camera, viewport(), x, y, factor, { min: 1e-4, max: 1e6 }) : dollyCamera(camera, 1 / factor));
		};
		el.addEventListener('pointerdown', onDown);
		el.addEventListener('pointermove', onMove);
		el.addEventListener('pointerup', onUp);
		el.addEventListener('pointercancel', onCancel);
		el.addEventListener('pointerleave', onCancel);
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			el.removeEventListener('pointerdown', onDown);
			el.removeEventListener('pointermove', onMove);
			el.removeEventListener('pointerup', onUp);
			el.removeEventListener('pointercancel', onCancel);
			el.removeEventListener('pointerleave', onCancel);
			el.removeEventListener('wheel', onWheel);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [pick, requestDraw]);

	/** Keys on the focused map (the container's own handler; nothing is stopped). */
	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
		const action = keyAction(event.key, event);
		if (action === null) return;
		event.preventDefault();
		const camera = cameraRef.current;
		const vp = viewport();
		switch (action) {
			case 'left':
			case 'right':
			case 'up':
			case 'down': {
				const next = nearestInSector(screenRef.current.xy, props.overlay?.focused ?? null, action, vp, props.hidden ?? null);
				if (next !== null) {
					props.onFocusMove?.(next);
					const x = screenRef.current.xy[2 * next] as number;
					const y = screenRef.current.xy[2 * next + 1] as number;
					if (camera && camera.mode === '2d' && (x < 24 || y < 24 || x > vp.width - 24 || y > vp.height - 24)) setCamera(panBy(camera as ICamera2D, vp.width / 2 - x, vp.height / 2 - y));
				}
				break;
			}
			case 'zoom-in':
			case 'zoom-out':
				if (camera) setCamera(camera.mode === '2d' ? zoomAt(camera, vp, vp.width / 2, vp.height / 2, action === 'zoom-in' ? 1.25 : 0.8) : dollyCamera(camera, action === 'zoom-in' ? 0.8 : 1.25));
				break;
			case 'fit':
				fit();
				requestDraw();
				break;
			default:
				props.onKeyAction?.(action as KeyAction);
		}
	};

	const tooltipText = tooltip !== null ? (props.describe?.(tooltip.index) ?? `Point ${tooltip.index + 1}`) : '';
	return (
		<div
			ref={containerRef}
			className="vector-map-canvas"
			role="application"
			aria-roledescription="point map"
			aria-label={props.label ?? `Map of ${visibleCount} chunks. Arrow keys move between points, Enter inspects, Escape clears, L toggles the lasso, plus and minus zoom, 0 fits.`}
			tabIndex={0}
			data-points={visibleCount}
			data-renderer={rendererKind}
			data-dimensions={props.dimensions}
			data-mode={props.sample.mode}
			data-layout={props.layout ?? 'pca'}
			data-selected={props.overlay?.selected ?? ''}
			data-focused={props.overlay?.focused ?? ''}
			data-selection={props.selectionCount ?? ''}
			data-overlap-pca={overlapAttr(props.overlap?.pca)}
			data-overlap-layout={overlapAttr(props.overlap?.layout)}
			onKeyDown={onKeyDown}
			style={{ position: 'relative', flex: 1, minHeight: 240, overflow: 'hidden', background: 'var(--rr-bg-default)', cursor: props.lasso ? 'crosshair' : 'grab', touchAction: 'none', userSelect: 'none' }}
		>
			<canvas ref={edgeRef} style={{ ...LAYER, pointerEvents: 'none', transition: props.reducedMotion ? 'none' : 'opacity 250ms ease-out' }} aria-hidden="true" data-layer="edges" />
			<canvas ref={canvasRef} style={LAYER} aria-hidden="true" />
			<canvas ref={overlayRef} style={{ ...LAYER, pointerEvents: 'none' }} aria-hidden="true" />
			{tooltip !== null ? (
				<div role="tooltip" data-map-tooltip={tooltip.index} style={{ ...MAP_STYLES.tooltip, left: Math.min(tooltip.x + 14, Math.max(0, sizeRef.current.width - 330)), top: tooltip.y + 14 }}>
					{tooltipText}
				</div>
			) : null}
			{rendererKind === 'none' ? <p style={{ ...MAP_STYLES.note, position: 'absolute', left: 12, top: 12 }}>This browser cannot draw the map (no canvas). Use the Table instead.</p> : null}
		</div>
	);
}

export default PointCanvas;
