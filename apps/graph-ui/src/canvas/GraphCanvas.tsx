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
// CANVAS - THE GRAPH VIEW (React Flow + the layout worker)
// =============================================================================
//
// Loaded lazily (see GraphView.tsx), so the editor, the Table, the Raw view and
// the history open without React Flow or the layout code. It receives plain
// props - the model, colours, captions, selection, focus and callbacks - and
// imports nothing from the shell, so it can be exercised on its own.
//
// Behaviour
//   - One node is tabbable (the focused one); arrow keys move focus to a
//     neighbour, Enter inspects, Space selects, E expands, C collapses, Delete
//     dismisses, P finds a path, Escape clears the selection, ? shows the keys
//     (graph/keynav.ts). React Flow's own keyboard handling is off.
//   - A double click on a node expands it; a click selects it.
//   - Dragging a node pins it where it is dropped.
//   - Every change is announced through `announce` (the app's live region).
//   - Under reduced motion nodes jump instead of gliding and the view fits
//     without animation.
// =============================================================================

import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ControlButton, Controls, ReactFlow, ReactFlowProvider, applyNodeChanges, getViewportForBounds, useReactFlow, useStore } from '@xyflow/react';
import type { NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { captionOf } from '../graph/captions';
import { colorFor, parseColor, readableOn } from '../graph/colors';
import type { ILabelColor, Rgb } from '../graph/colors';
import type { Point } from '../graph/geometry';
import { edgeSlots } from '../graph/geometry';
import { handled, keyAction } from '../graph/keynav';
import { relationshipsOf } from '../graph/model';
import type { IGraphModel } from '../graph/model';
import type { GraphId } from '../graph/types';
import { STATIC_LAYOUT_ABOVE } from '../graph/budgets';
import { labelsVisibleAt, sameShallow, stabilise, zoomLevel } from './stable';
import { ensureCanvasStyle, useReducedMotion, useThemeMode } from './environment';
import { FLOW_INTERACTION_PROPS } from './flowProps';
import { EdgeLayer } from './EdgeLayer';
import { contentBounds } from './fitBounds';
import type { IEdgeDraw } from './EdgeLayer';
import { GraphNodeView, NODE_DIAMETER } from './GraphNodeView';
import type { GraphFlowNode } from './GraphNodeView';
import { useGraphLayout } from './useGraphLayout';
import type { IExpandHint, LayoutStatus } from './useGraphLayout';

// =============================================================================
// TYPES
// =============================================================================

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
const NODE_TYPES = { graphNode: GraphNodeView };
/** React Flow draws no edges of its own: the layer does (see EdgeLayer.tsx). */
const NO_EDGES: never[] = [];

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
	const flow = useReactFlow();
	const helpId = useId();
	const reduced = useReducedMotion();
	const mode = useThemeMode();
	const container = useRef<HTMLDivElement | null>(null);
	const focusFromKeyboard = useRef(false);
	const textColors = useRef(new Map<string, string>());
	const layoutPositions = useRef<ReadonlyMap<GraphId, Point>>(new Map());
	const layout = useGraphLayout(model, props.seedKey, props.expandHint);
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
		// relationship and the type labels all reach beyond the circles (see fitBounds.ts).
		const bounds = contentBounds(layoutPositions.current, edgesRef.current);
		if (!bounds) return;
		const viewport = getViewportForBounds(bounds, el.clientWidth, el.clientHeight, FLOW_MIN_ZOOM, FIT_MAX_ZOOM, FIT_PADDING);
		void flowRef.current.setViewport(viewport, { duration }).then((done) => {
			if (done) pendingFit.current = false;
		});
	}, []);
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
	useEffect(() => {
		const el = container.current;
		if (!el || typeof ResizeObserver === 'undefined') return undefined;
		// The canvas can change size after the fit (a notice or the result line appears around it):
		// until the user takes the view over, the whole graph stays in it.
		const observer = new ResizeObserver(() => {
			if (!userMoved.current) pendingFit.current = true;
			tryFit();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [tryFit]);

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
			const fill = colorFor(colors, label).fill;
			const caption = captionOf(node, captions.get(label));
			const shown = counts.get(id) ?? 0;
			const spoken = `${caption}, ${node.labels.length > 0 ? node.labels.join(' ') : 'no label'}, ${shown} ${shown === 1 ? 'relationship' : 'relationships'} shown${selected.has(id) ? ', selected' : ''}${model.expansions.has(id) ? ', expanded' : ''}${allStale || staleIds.has(id) ? ', out of date' : ''}`;
			list.push({
				id,
				type: 'graphNode',
				position: { x: at.x - NODE_DIAMETER / 2, y: at.y - NODE_DIAMETER / 2 },
				width: NODE_DIAMETER,
				height: NODE_DIAMETER,
				focusable: id === tabbable,
				ariaLabel: spoken,
				data: { caption, fill, textColor: textOn(fill, textColors.current), initial: (label[0] ?? '•').toUpperCase(), selected: selected.has(id), expanded: model.expansions.has(id), stale: allStale || staleIds.has(id) },
			});
		}
		// Unchanged nodes keep their object, so a click or a focus move redoes the nodes that changed, not all of them.
		return stabilise(nodeCache.current, list, (a, b) => a.position.x === b.position.x && a.position.y === b.position.y && a.focusable === b.focusable && a.ariaLabel === b.ariaLabel && sameShallow(a.data, b.data));
		// textColors is a ref reset on theme change, which re-derives the nodes through `mode` below.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [model, layout.positions, colors, captions, selected, focusedId, counts, mode, staleIds, allStale]);

	// React Flow needs the node list as state it can apply drag changes to. Applying a
	// change replaces only the node it concerns, so a drag does not re-adopt every node.
	const [flowNodes, setFlowNodes] = useState<GraphFlowNode[]>(nodes);
	useEffect(() => {
		wanted.current = nodes.length;
		setFlowNodes(nodes);
	}, [nodes]);

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
			list.push({
				id: r.id,
				source: r.start,
				target: r.end,
				ariaLabel: `${r.type} from ${captionOf(a, captions.get(a.labels[0] ?? ''))} to ${captionOf(b, captions.get(b.labels[0] ?? ''))}${stale ? ', out of date' : ''}`,
				slot,
				type: r.type,
				highlighted: selected.has(r.start) || selected.has(r.end) || highlighted.has(r.id),
				stale,
			});
		}
		// Unchanged relationships keep their object (see stable.ts).
		return stabilise(edgeCache.current, list, (x, y) => x.source === y.source && x.target === y.target && x.ariaLabel === y.ariaLabel && x.type === y.type && x.highlighted === y.highlighted && x.stale === y.stale && sameShallow(x.slot as unknown as Record<string, unknown>, y.slot as unknown as Record<string, unknown>));
	}, [model, layout.positions, captions, selected, highlighted, staleRelationshipIds, allStale]);

	edgesRef.current = edges;

	// Where every node is on screen right now (a drag included): the edge layer draws from these.
	const centers = useMemo(() => {
		const map = new Map<GraphId, Point>();
		for (const n of flowNodes) map.set(n.id, { x: n.position.x + NODE_DIAMETER / 2, y: n.position.y + NODE_DIAMETER / 2 });
		return map;
	}, [flowNodes]);

	// Relationship type labels: hundreds of rotated text labels are unreadable zoomed out and are the most expensive
	// thing to repaint, so they are drawn only when they can be read (see stable.ts). The zoom is read as a LEVEL: this
	// component re-renders when the level changes, not on every pan or zoom step.
	const level = useStore((state) => zoomLevel(state.transform[2]));
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

	const onKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			// Only keys pressed on a node (or the canvas itself) are ours; never steal typing from a control inside it.
			const target = event.target as HTMLElement;
			if (target !== event.currentTarget && !target.classList.contains('react-flow__node')) return;
			const p = latest.current;
			const action = keyAction({ model: p.model, positions: layoutPositions.current, focusedId: p.focusedId }, { key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey });
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
				case 'find-path':
					p.onFindPath();
					break;
				case 'clear-selection':
					p.onClearSelection();
					break;
				case 'help':
					p.onHelp();
					break;
				default:
					break;
			}
		},
		[]
	);

	const { pin } = layout;
	const onNodesChange = useCallback(
		(changes: NodeChange<GraphFlowNode>[]) => {
			// Drags move the dragged node; a drop pins it. Nothing else changes the list: the model owns it.
			setFlowNodes((previous) => applyNodeChanges(changes, previous));
			for (const change of changes) {
				if (change.type === 'position' && change.position && change.dragging === false) pin(change.id, { x: change.position.x + NODE_DIAMETER / 2, y: change.position.y + NODE_DIAMETER / 2 });
			}
		},
		[pin]
	);

	const onNodeClick = useCallback((_event: React.MouseEvent, node: GraphFlowNode) => {
		latest.current.onFocus(node.id);
		latest.current.onToggleSelect(node.id);
	}, []);
	const onNodeDoubleClick = useCallback((_event: React.MouseEvent, node: GraphFlowNode) => latest.current.onExpand(node.id), []);

	return (
		<div ref={container} className="graph-ui-canvas" data-edge-labels={edgeLabels ? 'on' : 'off'} style={{ width: '100%', height: '100%', minHeight: 0 }} onKeyDown={onKeyDown} onFocus={onFocusCapture} role="group" aria-roledescription="graph" aria-label="Graph" aria-describedby={helpId}>
			<div id={helpId} style={VISUALLY_HIDDEN}>
				Arrow keys move between connected nodes. Enter opens the inspector, Space selects, E expands, C collapses, Delete dismisses, P finds a path between two selected nodes, question mark lists every key. The Table tab lists the same results.
			</div>
			<ReactFlow
				nodes={flowNodes}
				edges={NO_EDGES}
				nodeTypes={NODE_TYPES}
				colorMode={mode}
				onNodesChange={onNodesChange}
				onNodeClick={onNodeClick}
				onNodeDoubleClick={onNodeDoubleClick}
				onMoveStart={(event) => {
					// A null event is the library moving the view itself (fitView); only the user's own pan or zoom counts.
					if (event !== null) userMoved.current = true;
				}}
				onlyRenderVisibleElements={flowNodes.length > STATIC_LAYOUT_ABOVE * 3}
				proOptions={{ hideAttribution: true }}
				{...FLOW_INTERACTION_PROPS}
			>
				<EdgeLayer edges={edges} centers={centers} />
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
