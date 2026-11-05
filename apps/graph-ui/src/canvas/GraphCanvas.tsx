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
// CANVAS - THE GRAPH VIEW (React Flow + the layouts)
// =============================================================================
//
// Loaded lazily (see GraphView.tsx), so the editor, the Table, the Raw view and
// the history open without React Flow or the layout code. It receives plain
// props - the model, colours, captions, styles, selection, focus and callbacks -
// and imports nothing from the shell, so it can be exercised on its own.
//
// Behaviour
//   - One node is tabbable (the focused one); arrow keys move focus to a
//     neighbour, Enter inspects, Space selects, E expands, C collapses, Delete
//     dismisses, P finds a path, R shows the node's next relationship, the Menu
//     key or Shift+F10 opens its menu, Escape clears the selection, ? shows the
//     keys (graph/keynav.ts). React Flow's own keyboard handling is off.
//   - A click on a node selects it alone; Shift, Ctrl or Cmd-click adds it to
//     the selection or takes it out (`onNodeClick`). A double click expands it.
//   - A relationship can be clicked (`onSelectRelationship`) through its hit path
//     in the edge layer; React Flow is given no edges, so its edge events never fire.
//   - A right-click on a node, a relationship or the empty canvas asks for a
//     menu (`onContextMenu`, at the pointer); the view draws the menu.
//   - Escape clears the selection, then a shown path; with nothing to clear the
//     canvas leaves Escape alone (no preventDefault), so full screen gets it.
//   - Dragging a node pins it where it is dropped.
//   - The view is fitted when a layout lands and on Fit, never on a resize: the
//     inspector opening beside the canvas must not move the node just clicked
//     (the second click of a double-click would miss it). A resize keeps the view
//     where it is, and only pans to keep the focused node inside it.
//   - Force, Tree or Left to right layout (`layoutMode`); a found `path` is laid
//     out left to right on a row of its own and everything else is dimmed.
//   - The view can centre a node, fit, re-run the layout and export the drawing
//     as SVG or PNG through `handleRef`.
//   - Every change is announced through `announce` (the app's live region).
//   - Under reduced motion nodes jump instead of gliding and the view fits
//     without animation.
// =============================================================================

import React, { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ControlButton, Controls, ReactFlow, ReactFlowProvider, applyNodeChanges, getViewportForBounds, useReactFlow, useStore, useStoreApi } from '@xyflow/react';
import type { NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { captionOf } from '../graph/captions';
import { colorFor, parseColor, readableOn } from '../graph/colors';
import type { ILabelColor, Rgb } from '../graph/colors';
import type { Point } from '../graph/geometry';
import { edgeSlots } from '../graph/geometry';
import { clickMode, handled, keyAction, nextRelationship } from '../graph/keynav';
import { relationshipsOf } from '../graph/model';
import type { IGraphModel } from '../graph/model';
import type { GraphId } from '../graph/types';
import type { BadgeMode, LabelSize } from '../graph/userData';
import { STATIC_LAYOUT_ABOVE } from '../graph/budgets';
import { LABELS_MAX_EDGES, edgeHitWidth, labelsVisibleAt, sameShallow, stabilise, zoomLevel } from './stable';
import { ensureCanvasStyle, useReducedMotion, useThemeMode } from './environment';
import { FLOW_INTERACTION_PROPS } from './flowProps';
import { EdgeLayer, edgePaint } from './EdgeLayer';
import { contentBounds } from './fitBounds';
import type { EdgePointerHandler, IEdgeDraw } from './EdgeLayer';
import { buildSvg, cssResolver, exportResult, rasterise } from './exportImage';
import type { ExportResult, IExportEdge, IExportNode } from './exportImage';
import { GraphNodeView, NODE_DIAMETER, SIZE_DIAMETER } from './GraphNodeView';
import type { GraphFlowNode } from './GraphNodeView';
import { ACCENT_TOKEN, CANVAS_TEXT_TOKEN } from './tokens';
import { useGraphLayout } from './useGraphLayout';
import type { IExpandHint, LayoutMode, LayoutStatus } from './useGraphLayout';

// The layout modes are defined beside the layouts, the export result beside the export; the view imports them from here.
export type { LayoutMode };
export type { ExportFailure, ExportResult } from './exportImage';

// =============================================================================
// TYPES
// =============================================================================

/** What a context menu was asked for on. */
export type CanvasMenuTarget = { kind: 'node'; id: GraphId } | { kind: 'relationship'; id: GraphId } | { kind: 'pane' };

/** What the view can ask of a mounted canvas. */
export interface IGraphCanvasHandle {
	centerOn(id: GraphId): void;
	/** Move keyboard focus to a node (a menu or panel giving focus back). False when it could not: focus it elsewhere. */
	focusNode(id: GraphId): boolean;
	fit(): void;
	relayout(): void;
	/** The drawing as an image, or why there is none: too large (a PNG only), not ready (nothing laid out yet), render failed. */
	exportImage(format: 'svg' | 'png'): Promise<ExportResult>;
}

/** How one label's nodes are drawn (from the connection's style). */
export interface INodeLook {
	badge: string;
	size: LabelSize;
	badgeMode: BadgeMode;
}

/** Props of the graph view. */
export interface IGraphCanvasProps {
	model: IGraphModel;
	/** Colour per label (from `assignLabelColors`). */
	colors: ReadonlyMap<string, ILabelColor>;
	/** The caption chosen per label (property name, or the id/label specials). */
	captions: ReadonlyMap<string, string>;
	selected: ReadonlySet<GraphId>;
	/** Relationships to draw highlighted (a found path). */
	highlighted?: ReadonlySet<GraphId>;
	focusedId: GraphId | null;
	/** Nodes the database answered for with a different element under the same id. */
	staleIds?: ReadonlySet<GraphId>;
	/** Relationships the database answered for with a different relationship under the same id (a separate id space). */
	staleRelationshipIds?: ReadonlySet<GraphId>;
	/** True when a write ran after the graph was drawn: every element is suspect. */
	allStale?: boolean;
	/** Seed text for the layout (same text, same graph, same layout). */
	seedKey: string;
	/** Where new nodes from an expansion start. */
	expandHint: IExpandHint | null;
	onFocus(id: GraphId): void;
	onInspect(id: GraphId): void;
	onToggleSelect(id: GraphId): void;
	onExpand(id: GraphId): void;
	onCollapse(id: GraphId): void;
	onDismiss(id: GraphId): void;
	onFindPath(): void;
	onClearSelection(): void;
	onHelp(): void;
	/** Say something through the app's live region. */
	announce(text: string): void;
	/** Told when the layout falls back or recovers, so the app can show a notice. */
	onLayoutStatus?(status: LayoutStatus): void;
	/** The selected relationship, drawn selected. */
	selectedRelationshipId?: GraphId | null;
	/** A relationship was clicked, or R picked it. */
	onSelectRelationship?(id: GraphId): void;
	/** A node was clicked: `only` for a plain click, `toggle` with Shift, Ctrl or Cmd. Absent: a click toggles. */
	onNodeClick?(id: GraphId, mode: 'only' | 'toggle'): void;
	/** A context menu was asked for, at client coordinates. */
	onContextMenu?(target: CanvasMenuTarget, at: { x: number; y: number }): void;
	/** Nodes matching a search (the rest are dimmed), or null for no search. */
	matchIds?: ReadonlySet<GraphId> | null;
	/** Elements to keep at full strength (the rest are dimmed), or null. A shown `path` takes precedence. */
	focusIds?: { nodes: ReadonlySet<GraphId>; relationships: ReadonlySet<GraphId> } | null;
	/** A found path, in order: laid out left to right on a row of its own, everything else dimmed. */
	path?: { nodes: readonly GraphId[]; relationships: readonly GraphId[] } | null;
	/** Stop showing the path (Escape, once nothing is selected). */
	onClearPath?(): void;
	/** Refit whenever the canvas changes size, until the user pans or zooms (the old behaviour). Default: never on a resize. */
	refitOnResize?: boolean;
	/** Called once, when the canvas has mounted and placed its first layout: from then on the handle can export. */
	onReady?(): void;
	/** How each label's nodes are drawn, by label. */
	looks?: ReadonlyMap<string, INodeLook>;
	/** A colour per relationship type. */
	typeColors?: ReadonlyMap<string, string>;
	layoutMode?: LayoutMode;
	/** Whether a re-layout keeps the nodes the user dragged where they are. */
	keepPinned?: boolean;
	handleRef?: React.Ref<IGraphCanvasHandle>;
}

// =============================================================================
// HELPERS
// =============================================================================

/** The text colour that reads on a CSS colour, resolving `var(--x)` through the document. */
function textOn(fill: string, resolved: Map<string, string>): string {
	const cached = resolved.get(fill);
	if (cached) return cached;
	let rgb: Rgb | null = parseColor(fill);
	const variable = /^var\((--[a-z0-9-]+)\)$/i.exec(fill);
	if (!rgb && variable && typeof document !== 'undefined') rgb = parseColor(getComputedStyle(document.documentElement).getPropertyValue(variable[1]));
	const color = rgb ? readableOn(rgb) : '#000000';
	resolved.set(fill, color);
	return color;
}

// =============================================================================
// INNER CANVAS (needs the React Flow provider for fitView)
// =============================================================================

/** Off-screen but available to assistive technology. */
const VISUALLY_HIDDEN: CSSProperties = { position: 'absolute', width: 1, height: 1, margin: -1, padding: 0, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 };

/** The room left around what is fitted, as a share of the canvas. */
const FIT_PADDING = 0.2;
/** The smallest zoom the canvas allows (the same value the flow is given). */
const FLOW_MIN_ZOOM = FLOW_INTERACTION_PROPS.minZoom;
/** Fit never magnifies: a graph of two nodes is shown at normal size, not as two huge circles. */
const FIT_MAX_ZOOM = 1;
const NO_IDS: ReadonlySet<GraphId> = new Set();
const NO_LOOKS: ReadonlyMap<string, INodeLook> = new Map();
const NO_TYPE_COLORS: ReadonlyMap<string, string> = new Map();
const NODE_TYPES = { graphNode: GraphNodeView };
/** React Flow draws no edges of its own: the layer does (see EdgeLayer.tsx). */
const NO_EDGES: never[] = [];
/**
 * The Menu key and Shift+F10 make the browser fire its own context menu event at the focused node as well; the key
 * already opened the menu, so that event is ignored for this long afterwards.
 */
const KEYBOARD_MENU_ECHO_MS = 600;
/** How far inside the canvas edge a resize keeps the focused node (screen pixels beyond its circle). */
const KEEP_IN_VIEW_MARGIN = 16;

/**
 * The canvas proper.
 *
 * @param props - See {@link IGraphCanvasProps}.
 * @returns The view.
 */
function CanvasInner(props: IGraphCanvasProps): React.ReactElement {
	const { model, colors, captions, selected, focusedId, onLayoutStatus } = props;
	const highlighted = props.highlighted ?? NO_IDS;
	const staleIds = props.staleIds ?? NO_IDS;
	const staleRelationshipIds = props.staleRelationshipIds ?? NO_IDS;
	const allStale = props.allStale === true;
	const looks = props.looks ?? NO_LOOKS;
	const typeColors = props.typeColors ?? NO_TYPE_COLORS;
	const selectedRelationshipId = props.selectedRelationshipId ?? null;
	const matchIds = props.matchIds ?? null;
	const path = props.path ?? null;
	// Relationships take the pointer only when the view does something with it.
	const interactiveEdges = props.onSelectRelationship !== undefined || props.onContextMenu !== undefined;
	const flow = useReactFlow();
	const helpId = useId();
	const reduced = useReducedMotion();
	const mode = useThemeMode();
	const container = useRef<HTMLDivElement | null>(null);
	const focusFromKeyboard = useRef(false);
	const keyboardMenuAt = useRef(0);
	const textColors = useRef(new Map<string, string>());
	const layoutPositions = useRef<ReadonlyMap<GraphId, Point>>(new Map());

	// Each node's diameter (its label's size), read by the fit, the drop and the export through a ref.
	const diameters = useMemo(() => {
		const out = new Map<GraphId, number>();
		for (const [id, node] of model.nodes) out.set(id, SIZE_DIAMETER[looks.get(node.labels[0] ?? '')?.size ?? 'M']);
		return out;
	}, [model.nodes, looks]);
	const largest = useMemo(() => {
		let most = NODE_DIAMETER;
		for (const d of diameters.values()) most = Math.max(most, d);
		return most;
	}, [diameters]);
	const diametersRef = useRef(diameters);
	diametersRef.current = diameters;
	const radiusOf = useCallback((id: string): number => (diametersRef.current.get(id) ?? NODE_DIAMETER) / 2, []);

	// The layout: a re-layout is asked for through the handle; a tree is rooted at the selected node.
	const [relayoutNonce, setRelayoutNonce] = useState(0);
	const root = useMemo(() => {
		for (const id of selected) if (model.nodes.has(id)) return id;
		return null;
	}, [selected, model.nodes]);
	const pathTypes = useMemo(() => (path ? path.relationships.map((id) => model.relationships.get(id)?.type ?? '') : []), [path, model.relationships]);
	const layout = useGraphLayout(model, props.seedKey, props.expandHint, { mode: props.layoutMode ?? 'force', nonce: relayoutNonce, keepPinned: props.keepPinned ?? true, root, path: path?.nodes ?? null, pathTypes, diameter: largest });
	// The latest callbacks, readable from handlers that must keep one identity.
	const latest = useRef(props);
	useLayoutEffect(() => {
		latest.current = props;
	});

	useEffect(() => {
		layoutPositions.current = layout.positions;
	}, [layout.positions]);
	useEffect(ensureCanvasStyle, []);
	useEffect(() => {
		// Theme switches change what `var(--rr-chart-*)` resolves to.
		textColors.current = new Map();
	}, [mode]);
	useEffect(() => {
		onLayoutStatus?.(layout.status);
	}, [layout.status, onLayoutStatus]);

	// Fit the view when a layout lands (not on every drag). The fit waits until React Flow
	// holds every node AND the canvas has a size: a graph laid out while its tab is hidden
	// is fitted when the tab is shown, because a ResizeObserver retries the pending fit.
	const wanted = useRef(0);
	const pendingFit = useRef(false);
	// The relationships as drawn (set each render below), so a fit can include loops, curves and labels.
	const edgesRef = useRef<readonly IEdgeDraw[]>([]);
	// True once the user pans or zooms: a resize then keeps their view instead of refitting.
	const userMoved = useRef(false);
	const flowRef = useRef(flow);
	const reducedRef = useRef(reduced);
	useEffect(() => {
		flowRef.current = flow;
		reducedRef.current = reduced;
	});
	const tryFit = useCallback(() => {
		if (!pendingFit.current) return;
		const el = container.current;
		if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
		if (flowRef.current.getNodes().length < wanted.current) return;
		// No point animating a tab nobody is looking at.
		const duration = reducedRef.current || document.hidden ? 0 : 300;
		// Fit everything that is DRAWN, not just the node circles: a loop on the topmost node, a bowed parallel
		// relationship and the type labels all reach beyond the circles (see fitBounds.ts), each at its own size.
		const bounds = contentBounds(layoutPositions.current, edgesRef.current, radiusOf);
		if (!bounds) return;
		const viewport = getViewportForBounds(bounds, el.clientWidth, el.clientHeight, FLOW_MIN_ZOOM, FIT_MAX_ZOOM, FIT_PADDING);
		void flowRef.current.setViewport(viewport, { duration }).then((done) => {
			if (done) pendingFit.current = false;
		});
	}, [radiusOf]);
	/** The fit button: fit again now, and take the view back from the user's pan or zoom. */
	const refit = useCallback(() => {
		userMoved.current = false;
		pendingFit.current = true;
		tryFit();
	}, [tryFit]);
	useEffect(() => {
		if (layout.version === 0) return undefined;
		pendingFit.current = true;
		let tries = 0;
		let timer = 0;
		const poll = (): void => {
			tryFit();
			if (pendingFit.current && tries++ < 60) timer = window.setTimeout(poll, 50);
		};
		userMoved.current = false;
		timer = window.setTimeout(poll, 16);
		return () => window.clearTimeout(timer);
	}, [layout.version, tryFit]);
	/** After a resize, pan only as far as it takes to keep the focused node inside the canvas. */
	const keepFocusedInView = useCallback(
		(width: number, height: number) => {
			const id = latest.current.focusedId;
			const at = id === null ? undefined : layoutPositions.current.get(id);
			if (id === null || !at) return;
			const { x, y, zoom } = flowRef.current.getViewport();
			const reach = radiusOf(id) * zoom + KEEP_IN_VIEW_MARGIN;
			const sx = x + at.x * zoom;
			const sy = y + at.y * zoom;
			const dx = sx < reach ? reach - sx : sx > width - reach ? width - reach - sx : 0;
			const dy = sy < reach ? reach - sy : sy > height - reach ? height - reach - sy : 0;
			if (dx !== 0 || dy !== 0) void flowRef.current.setViewport({ x: x + dx, y: y + dy, zoom }, { duration: 0 });
		},
		[radiusOf]
	);
	useEffect(() => {
		const el = container.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		// The canvas changes size when the inspector opens beside it, the status line grows or the divider moves. None of
		// that refits: a fit re-zooms the graph and moves the node under the pointer. The view stays as it is (only the
		// focused node is kept inside it); a fit that is still owed (a layout landed while the tab was hidden) happens now.
		const observer = new ResizeObserver(() => {
			if (el.clientWidth === 0 || el.clientHeight === 0) return;
			if (latest.current.refitOnResize === true && !userMoved.current) pendingFit.current = true;
			if (pendingFit.current) tryFit();
			else keepFocusedInView(el.clientWidth, el.clientHeight);
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [tryFit, keepFocusedInView]);

	// Ready once the first layout is placed (the handle is set by then): the view enables Export on it. Once per mount.
	const readyTold = useRef(false);
	useEffect(() => {
		if (layout.version === 0 || readyTold.current) return;
		readyTold.current = true;
		latest.current.onReady?.();
	}, [layout.version]);

	// Glide into place only after a layout, never while dragging.
	useEffect(() => {
		const el = container.current;
		if (!el || reduced || layout.version === 0) return undefined;
		el.classList.add('graph-ui-animating');
		const handle = window.setTimeout(() => el.classList.remove('graph-ui-animating'), 340);
		return () => window.clearTimeout(handle);
	}, [layout.version, reduced]);

	// Relationship counts per node, for the spoken label.
	const counts = useMemo(() => {
		const out = new Map<GraphId, number>();
		for (const id of model.nodes.keys()) out.set(id, relationshipsOf(model, id).length);
		return out;
	}, [model]);

	// What stays at full strength: the shown path, else what the view asked for. A search dims what it does not match.
	const focus = useMemo(() => (path ? { nodes: new Set(path.nodes), relationships: new Set(path.relationships) } : (props.focusIds ?? null)), [path, props.focusIds]);

	const nodeCache = useRef(new Map<string, GraphFlowNode>());
	const edgeCache = useRef(new Map<string, IEdgeDraw>());
	const nodes = useMemo((): GraphFlowNode[] => {
		const list: GraphFlowNode[] = [];
		// Exactly one node is in the tab order: the one that has focus (or the first when none does).
		const tabbable = focusedId !== null && model.nodes.has(focusedId) ? focusedId : (model.nodes.keys().next().value as GraphId | undefined);
		for (const [id, node] of model.nodes) {
			const at = layout.positions.get(id);
			if (!at) continue;
			const label = node.labels[0] ?? '';
			const look = looks.get(label);
			const diameter = diameters.get(id) ?? NODE_DIAMETER;
			const fill = colorFor(colors, label).fill;
			const caption = captionOf(node, captions.get(label));
			const shown = counts.get(id) ?? 0;
			// A selected node is never dimmed: its ring must show at full strength (a click off the path, or off a search).
			const dim = !selected.has(id) && ((focus !== null && !focus.nodes.has(id)) || (matchIds !== null && !matchIds.has(id)));
			const spoken = `${caption}, ${node.labels.length > 0 ? node.labels.join(' ') : 'no label'}, ${shown} ${shown === 1 ? 'relationship' : 'relationships'} shown${selected.has(id) ? ', selected' : ''}${model.expansions.has(id) ? ', expanded' : ''}${allStale || staleIds.has(id) ? ', out of date' : ''}`;
			list.push({
				id,
				type: 'graphNode',
				position: { x: at.x - diameter / 2, y: at.y - diameter / 2 },
				width: diameter,
				height: diameter,
				focusable: id === tabbable,
				ariaLabel: spoken,
				data: { caption, fill, textColor: textOn(fill, textColors.current), badge: look?.badge ?? (label[0] ?? '•').toUpperCase(), badgeMode: look?.badgeMode ?? 'initials', diameter, dim, selected: selected.has(id), expanded: model.expansions.has(id), stale: allStale || staleIds.has(id) },
			});
		}
		// Unchanged nodes keep their object, so a click or a focus move redoes the nodes that changed, not all of them.
		return stabilise(nodeCache.current, list, (a, b) => a.position.x === b.position.x && a.position.y === b.position.y && a.width === b.width && a.focusable === b.focusable && a.ariaLabel === b.ariaLabel && sameShallow(a.data, b.data));
		// textColors is a ref reset on theme change, which re-derives the nodes through `mode` below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [model, layout.positions, colors, captions, selected, focusedId, counts, mode, staleIds, allStale, looks, diameters, focus, matchIds]);

	// React Flow needs the node list as state it can apply drag changes to. Applying a
	// change replaces only the node it concerns, so a drag does not re-adopt every node.
	const [flowNodes, setFlowNodes] = useState<GraphFlowNode[]>(nodes);
	useEffect(() => {
		wanted.current = nodes.length;
		setFlowNodes(nodes);
	}, [nodes]);
	const flowNodesRef = useRef(flowNodes);
	flowNodesRef.current = flowNodes;

	const edges = useMemo((): IEdgeDraw[] => {
		const specs = [...model.relationships.values()].map((r) => ({ id: r.id, source: r.start, target: r.end }));
		const slots = edgeSlots(specs);
		const list: IEdgeDraw[] = [];
		for (const r of model.relationships.values()) {
			const slot = slots.get(r.id);
			const a = model.nodes.get(r.start);
			const b = model.nodes.get(r.end);
			if (!slot || !a || !b || !layout.positions.has(r.start) || !layout.positions.has(r.end)) continue;
			const stale = allStale || staleRelationshipIds.has(r.id);
			const chosen = r.id === selectedRelationshipId;
			list.push({
				id: r.id,
				source: r.start,
				target: r.end,
				ariaLabel: `${r.type} from ${captionOf(a, captions.get(a.labels[0] ?? ''))} to ${captionOf(b, captions.get(b.labels[0] ?? ''))}${chosen ? ', selected' : ''}${stale ? ', out of date' : ''}`,
				slot,
				type: r.type,
				highlighted: selected.has(r.start) || selected.has(r.end) || highlighted.has(r.id),
				selected: chosen,
				stale,
				dim: !chosen && ((focus !== null && !focus.relationships.has(r.id)) || (matchIds !== null && !matchIds.has(r.start) && !matchIds.has(r.end))),
				color: typeColors.get(r.type) ?? null,
				sourceRadius: (diameters.get(r.start) ?? NODE_DIAMETER) / 2,
				targetRadius: (diameters.get(r.end) ?? NODE_DIAMETER) / 2,
			});
		}
		// Unchanged relationships keep their object (see stable.ts).
		return stabilise(edgeCache.current, list, (x, y) => x.source === y.source && x.target === y.target && x.ariaLabel === y.ariaLabel && x.type === y.type && x.highlighted === y.highlighted && x.selected === y.selected && x.stale === y.stale && x.dim === y.dim && x.color === y.color && x.sourceRadius === y.sourceRadius && x.targetRadius === y.targetRadius && sameShallow(x.slot as unknown as Record<string, unknown>, y.slot as unknown as Record<string, unknown>));
	}, [model, layout.positions, captions, selected, highlighted, staleRelationshipIds, allStale, selectedRelationshipId, focus, matchIds, typeColors, diameters]);

	edgesRef.current = edges;

	// Where every node is on screen right now (a drag included): the edge layer draws from these.
	const centers = useMemo(() => {
		const map = new Map<GraphId, Point>();
		for (const n of flowNodes) map.set(n.id, { x: n.position.x + n.data.diameter / 2, y: n.position.y + n.data.diameter / 2 });
		return map;
	}, [flowNodes]);

	// Relationship type labels: hundreds of rotated text labels are unreadable zoomed out and are the most expensive
	// thing to repaint, so they are drawn only when they can be read (see stable.ts). The zoom is read as a LEVEL: this
	// component re-renders when the level changes, not on every pan or zoom step.
	const level = useStore((state) => zoomLevel(state.transform[2]));

	// The relationships' hit band is drawn in canvas units inside the scaled viewport: as the view zooms out, it is widened
	// in steps (edgeHitWidth) so it is never under 12 screen pixels. One stylesheet variable on the container carries it,
	// set from a store subscription: no relationship re-renders on a zoom step, and the pan offset is never read.
	const flowStore = useStoreApi();
	useEffect(() => {
		const el = container.current;
		if (!el) return undefined;
		let shown = 0;
		const follow = (state: { transform: [number, number, number] }): void => {
			const width = edgeHitWidth(state.transform[2]);
			if (width === shown) return;
			shown = width;
			el.style.setProperty('--graph-ui-edge-hit', `${width}px`);
		};
		follow(flowStore.getState());
		return flowStore.subscribe(follow);
	}, [flowStore]);
	const edgeLabels = labelsVisibleAt(level, edges.length);

	// Focus follows the model when the change came from the keyboard. Node ids are NOT unique
	// across nodes and relationships (FalkorDB counts them separately), so the lookup is
	// scoped to node elements; and an element that is not (yet) in the tab order is made
	// programmatically focusable first.
	useEffect(() => {
		if (!focusFromKeyboard.current || focusedId === null) return;
		const el = container.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(focusedId)}"]`);
		if (!el) return;
		focusFromKeyboard.current = false;
		if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
		el.focus({ preventScroll: true });
		const at = layout.positions.get(focusedId);
		if (at) void flow.setCenter(at.x, at.y, { zoom: flow.getZoom(), duration: reduced || document.hidden ? 0 : 200 });
	}, [focusedId, flowNodes, flow, layout.positions, reduced]);

	// Tab (or a click) puts DOM focus on a node: keep the app's notion of the focused node in step.
	const onFocusCapture = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
		const target = event.target as HTMLElement;
		if (!target.classList.contains('react-flow__node')) return;
		const id = target.getAttribute('data-id');
		if (id !== null && id !== latest.current.focusedId) latest.current.onFocus(id);
	}, []);

	/**
	 * Give DOM focus to a node's element, without scrolling or panning. Only the roving node is in the tab order, so any
	 * other is made focusable first. Node and relationship ids overlap (FalkorDB), so the lookup is scoped to nodes.
	 *
	 * @param id - The node.
	 * @returns True when the node now has focus.
	 */
	const focusElement = useCallback((id: GraphId): boolean => {
		const el = container.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
		if (!el) return false;
		if (!el.hasAttribute('tabindex')) el.tabIndex = -1;
		el.focus({ preventScroll: true });
		return document.activeElement === el;
	}, []);

	/** Open a node's menu from the keyboard, at the node (a key press has no pointer position). */
	const openNodeMenu = useCallback((id: GraphId) => {
		const p = latest.current;
		if (!p.onContextMenu) return;
		keyboardMenuAt.current = Date.now();
		const rect = (container.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`) ?? container.current)?.getBoundingClientRect();
		p.onContextMenu({ kind: 'node', id }, rect ? { x: rect.right, y: rect.bottom } : { x: 0, y: 0 });
	}, []);

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			// Only keys pressed on a node (or the canvas itself) are ours; never steal typing from a control inside it.
			const target = event.target as HTMLElement;
			if (target !== event.currentTarget && !target.classList.contains('react-flow__node')) return;
			const p = latest.current;
			// Escape is the canvas's only while it has something to clear; otherwise it is left to the page (full screen).
			const clearable = p.selected.size > 0 || (p.selectedRelationshipId ?? null) !== null ? 'selection' : p.path && p.path.nodes.length > 0 && p.onClearPath ? 'path' : null;
			const action = keyAction({ model: p.model, positions: layoutPositions.current, focusedId: p.focusedId, clearable }, { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey });
			if (!handled(action)) return;
			event.preventDefault();
			switch (action.type) {
				case 'focus':
					focusFromKeyboard.current = true;
					p.onFocus(action.id);
					break;
				case 'inspect':
					p.onInspect(action.id);
					break;
				case 'toggle-select':
					p.onToggleSelect(action.id);
					break;
				case 'expand':
					p.onExpand(action.id);
					break;
				case 'collapse':
					p.onCollapse(action.id);
					break;
				case 'dismiss':
					p.onDismiss(action.id);
					break;
				case 'next-relationship': {
					if (!p.onSelectRelationship) break;
					const next = nextRelationship(p.model, action.id, p.selectedRelationshipId ?? null);
					if (next === null) p.announce('No relationships of this node are drawn.');
					else p.onSelectRelationship(next);
					break;
				}
				case 'context-menu':
					openNodeMenu(action.id);
					break;
				case 'find-path':
					p.onFindPath();
					break;
				case 'clear-selection':
					p.onClearSelection();
					break;
				case 'clear-path':
					p.onClearPath?.();
					break;
				case 'help':
					p.onHelp();
					break;
				default:
					break;
			}
		},
		[openNodeMenu]
	);

	const { pin } = layout;
	const onNodesChange = useCallback(
		(changes: NodeChange<GraphFlowNode>[]) => {
			// Drags move the dragged node; a drop pins it. Nothing else changes the list: the model owns it.
			setFlowNodes((previous) => applyNodeChanges(changes, previous));
			for (const change of changes) {
				if (change.type !== 'position' || !change.position || change.dragging !== false) continue;
				const half = (diametersRef.current.get(change.id) ?? NODE_DIAMETER) / 2;
				pin(change.id, { x: change.position.x + half, y: change.position.y + half });
			}
		},
		[pin]
	);

	const onNodeClick = useCallback(
		(event: React.MouseEvent, node: GraphFlowNode) => {
			const p = latest.current;
			// The press gave DOM focus to whatever focusable element holds the canvas (only the roving node is focusable),
			// and the canvas keys would stop reaching it: the clicked node takes keyboard focus and becomes the roving node.
			// No pan: the node is already under the pointer.
			focusElement(node.id);
			p.onFocus(node.id);
			if (p.onNodeClick) p.onNodeClick(node.id, clickMode(event));
			else p.onToggleSelect(node.id);
		},
		[focusElement]
	);
	const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: GraphFlowNode) => latest.current.onExpand(node.id), []);
	const onNodeContextMenu = useCallback(
		(event: React.MouseEvent, node: GraphFlowNode) => {
			const p = latest.current;
			if (!p.onContextMenu) return;
			event.preventDefault();
			// The browser's own event for a Menu key or Shift+F10 the canvas already answered.
			if (Date.now() - keyboardMenuAt.current < KEYBOARD_MENU_ECHO_MS) return;
			p.onFocus(node.id);
			// A context menu asked for from the keyboard some other way has no pointer position: open it at the node.
			if (event.clientX === 0 && event.clientY === 0) openNodeMenu(node.id);
			else p.onContextMenu({ kind: 'node', id: node.id }, { x: event.clientX, y: event.clientY });
		},
		[openNodeMenu]
	);
	const onPaneContextMenu = useCallback((event: MouseEvent | React.MouseEvent) => {
		const p = latest.current;
		if (!p.onContextMenu) return;
		event.preventDefault();
		p.onContextMenu({ kind: 'pane' }, { x: event.clientX, y: event.clientY });
	}, []);
	const onEdgeClick = useCallback<EdgePointerHandler>((id) => latest.current.onSelectRelationship?.(id), []);
	const onEdgeContextMenu = useCallback<EdgePointerHandler>((id, event) => {
		const p = latest.current;
		if (!p.onContextMenu) return;
		event.preventDefault();
		p.onContextMenu({ kind: 'relationship', id }, { x: event.clientX, y: event.clientY });
	}, []);

	/** The whole drawing as an SVG (or that SVG as a PNG), in the colours the canvas shows now. */
	const exportDrawing = useCallback(async (format: 'svg' | 'png'): Promise<ExportResult> => {
		const el = container.current;
		if (!el) return { blob: null, reason: 'not-ready' };
		const nodesOut: IExportNode[] = flowNodesRef.current.map((n) => ({ id: n.id, x: n.position.x + n.data.diameter / 2, y: n.position.y + n.data.diameter / 2, radius: n.data.diameter / 2, fill: n.data.fill, textColor: n.data.textColor, badge: n.data.badge, badgeMode: n.data.badgeMode, caption: n.data.caption, dim: n.data.dim, stale: n.data.stale, selected: n.data.selected }));
		const edgesOut: IExportEdge[] = edgesRef.current.map((e) => {
			const paint = edgePaint(e);
			return { id: e.id, source: e.source, target: e.target, slot: e.slot, type: e.type, stroke: paint.stroke, width: paint.width, dashed: e.stale, dim: e.dim };
		});
		const theme = { background: 'var(--rr-bg-default)', text: `var(${CANVAS_TEXT_TOKEN})`, halo: 'var(--rr-bg-paper)', border: 'var(--rr-text-primary)', accent: `var(${ACCENT_TOKEN})` };
		// Nothing placed yet (the first layout has not landed) builds nothing: not ready.
		const built = buildSvg(nodesOut, edgesOut, theme, { resolve: cssResolver(el), labels: edgesOut.length <= LABELS_MAX_EDGES });
		return exportResult(format, built, rasterise);
	}, []);

	useImperativeHandle(
		props.handleRef,
		() => ({
			centerOn(id: GraphId) {
				const at = layoutPositions.current.get(id);
				if (!at) return;
				// The view now shows what was asked for: a resize keeps it rather than refitting.
				userMoved.current = true;
				void flowRef.current.setCenter(at.x, at.y, { zoom: flowRef.current.getZoom(), duration: reducedRef.current || document.hidden ? 0 : 300 });
			},
			focusNode(id: GraphId): boolean {
				if (!latest.current.model.nodes.has(id)) return false;
				return focusElement(id);
			},
			fit: refit,
			relayout: () => setRelayoutNonce((n) => n + 1),
			exportImage: exportDrawing,
		}),
		[refit, exportDrawing, focusElement]
	);

	return (
		<div ref={container} className="graph-ui-canvas" data-edge-labels={edgeLabels ? 'on' : 'off'} style={{ width: '100%', height: '100%', minHeight: 0 }} onKeyDown={onKeyDown} onFocus={onFocusCapture} role="group" aria-roledescription="graph" aria-label="Graph" aria-describedby={helpId}>
			<div id={helpId} style={VISUALLY_HIDDEN}>
				{"Arrow keys move between connected nodes. Enter opens the inspector, Space selects, E expands, C collapses, Delete dismisses, P finds a path between two selected nodes, R shows the focused node's next relationship, the Menu key or Shift+F10 opens its actions, question mark lists every key. The Table tab lists the same results."}
			</div>
			<ReactFlow
				nodes={flowNodes}
				edges={NO_EDGES}
				nodeTypes={NODE_TYPES}
				colorMode={mode}
				onNodesChange={onNodesChange}
				onNodeClick={onNodeClick}
				onNodeDoubleClick={onNodeDoubleClick}
				onNodeContextMenu={onNodeContextMenu}
				onPaneContextMenu={onPaneContextMenu}
				onMoveStart={(event) => {
					// A null event is the library moving the view itself (fitView); only the user's own pan or zoom counts.
					if (event !== null) userMoved.current = true;
				}}
				onlyRenderVisibleElements={flowNodes.length > STATIC_LAYOUT_ABOVE * 3}
				proOptions={{ hideAttribution: true }}
				{...FLOW_INTERACTION_PROPS}
			>
				<EdgeLayer edges={edges} centers={centers} onEdgeClick={interactiveEdges ? onEdgeClick : undefined} onEdgeContextMenu={interactiveEdges ? onEdgeContextMenu : undefined} />
				{/* The stock fit button fits node boxes only; this one fits everything drawn, like the automatic fit. */}
				<Controls showInteractive={false} showFitView={false} position="bottom-left">
					<ControlButton className="react-flow__controls-fitview" title="fit view" aria-label="fit view" onClick={refit}>
						<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
							<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" />
						</svg>
					</ControlButton>
				</Controls>
			</ReactFlow>
		</div>
	);
}

/**
 * The graph view.
 *
 * @param props - See {@link IGraphCanvasProps}.
 * @returns The view inside its own React Flow provider.
 */
export default function GraphCanvas(props: IGraphCanvasProps): React.ReactElement {
	return (
		<ReactFlowProvider>
			<CanvasInner {...props} />
		</ReactFlowProvider>
	);
}
