/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Read-only drawing of one saved pipeline, made with the builder's own node
 * and edge components (registered the way the builder's FlowCanvas does).
 * The editor contexts those components read are swapped for read-only
 * stand-ins at build time (resolve.ts). Nothing here can drag, connect,
 * select, delete or run anything: the user can only pan and zoom.
 *
 * Inline in a chat the canvas never traps the chat's scrolling: the mouse
 * wheel and a one-finger swipe scroll the chat, and the canvas moves with a
 * drag (mouse), two fingers (touch) or the buttons. Full screen, when the
 * host offers it, is the place to explore: there the wheel pans and every
 * gesture goes to the canvas.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactElement } from 'react';
import { Background, BaseEdge, MiniMap, ReactFlow, ReactFlowProvider, getViewportForBounds, useNodesInitialized, useNodesState, useReactFlow, useStore, type EdgeProps, type NodeChange, type Viewport } from '@xyflow/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import '@xyflow/react/dist/style.css';

import '@app-shared/tools/pipelines/panels/design/canvas/components/reactflow-overrides.css';
import NodeComponent from '@app-shared/tools/pipelines/panels/design/canvas/components/node/node-component/NodeComponent';
import NodeGroup from '@app-shared/tools/pipelines/panels/design/canvas/components/node/node-group/NodeGroup';
import NodeAnnotation from '@app-shared/tools/pipelines/panels/design/canvas/components/node/node-annotation/NodeAnnotation';
import FlowEdge from '@app-shared/tools/pipelines/panels/design/canvas/components/edge/FlowEdge';
import { Icon, registerServiceIcons } from '@app-shared/tools/pipelines/panels/design/canvas/util/Icon';
import { INodeType, type IProject, type INodeData, type IServiceCatalog } from '@app-shared/tools/pipelines/panels/design/canvas/types';

import { ReadOnlyFlowGraphProvider, type FlowNode } from './stand-ins/FlowGraphContext';
import { ReadOnlyFlowProjectProvider } from './stand-ins/FlowProjectContext';
import { ReadOnlyFlowPreferencesProvider } from './stand-ins/FlowPreferencesContext';
import { ESTIMATED_NODE_SIZE, displayPath, placeNodes, type CanvasModel, type ViewPipelineSummary } from './model';
import { LAYER_GAP, WRAP_OFFSET, bandGaps, edgesThroughNodes, wrapCenterY, wrapCorners, wrapTrunkX, type Positions } from './layout';

/**
 * Canvas height bounds, in px. The height follows the drawing's shape inside
 * these bounds, always as a pixel value: host auto-resize measures the
 * document, and a % or vh height would collapse the widget.
 */
export const CANVAS_MAX_HEIGHT = 620;
export const CANVAS_MIN_HEIGHT = 200;
/** On a phone-width frame the canvas stays shorter, so it never fills the whole chat. */
const NARROW_FRAME = 480;
const NARROW_MAX_HEIGHT = 480;

/**
 * Below this zoom the builder's node titles (12 px at zoom 1) are smaller than
 * the overview labels, so labels are drawn over them. At 1 the two are the
 * same size: zooming in never makes a name smaller.
 */
export const OVERVIEW_ZOOM = 1;
/** A label narrower than this on screen is not drawn: it could not hold a word. */
const LABEL_MIN_WIDTH = 40;
/** Below this on-screen width a two-line label uses the smaller font. */
const LABEL_WIDE = 90;
/** Label text sizes, one line and two lines, and the space the icon, gap and padding take. */
const LABEL_FONT = 12;
const LABEL_FONT_NARROW = 10.5;
/** Icon, gap, padding and border of a label, one line and two lines (see canvas.css). */
const LABEL_CHROME = 12 + 5 + 14 + 2;
const LABEL_CHROME_NARROW = 12 + 3 + 6 + 2;
const LABEL_ICON = 12 + 3;
/** Labels whose anchor lines are this close, in px, form one row. */
const ROW_TOLERANCE = 8;
/** A label keeps its icon while this much room is left for text beside it, about six letters. */
const LABEL_TEXT_MIN = 34;
/** Two neighbouring labels fill at most twice this share of the gap between their nodes. */
const LABEL_GAP_SHARE = 0.46;
/** The widest a label grows, in px. */
const LABEL_MAX_WIDTH = 190;
/** Height of the builder's top cap and header row at zoom 1, used until the header is measured. */
const NODE_HEADER_HEIGHT = 46;
/** The smallest label heights, one line and two lines, in px. */
const LABEL_MIN_HEIGHT = 20;
const LABEL_MIN_HEIGHT_TWO_LINES = 30;
/** The tallest label: two lines in the label font. */
const LABEL_TALLEST = 33;
/** Full screen fits the whole drawing while nodes stay at least this wide on screen. */
const FULL_FIT_MIN_NODE_WIDTH = 90;
/** Otherwise full screen opens at the zoom that draws a typical node this wide. */
const FULL_READ_NODE_WIDTH = 120;
const FULL_READ_NODE_WIDTH_NARROW = 100;
/** Under this frame width the full-screen minimap would cover too much of the drawing. */
const MINIMAP_MIN_FRAME_WIDTH = 320;
/** The inline canvas of a truncated pipeline stays short: 200 thumbnails are an overview, not a read. */
const TRUNCATED_MAX_HEIGHT = 360;

const FIT_PADDING = 0.04;
/** The band at the top of the drawing the name and the view buttons sit on, in px. */
const OVERLAY_TOP = 36;
const FIT_MAX_ZOOM = 1.25;
/** Room beside the drawing for the overview labels' side overhang, in flow units. */
const LABEL_MARGIN_X = 30;

/**
 * Room above the top row, in flow units, for overview labels at `zoom`: a
 * label's bottom sits on its node's header bottom and it grows up from there.
 */
function labelHeadroom(zoom: number): number {
	return zoom < OVERVIEW_ZOOM ? Math.max(0, LABEL_TALLEST - NODE_HEADER_HEIGHT * zoom) / zoom : 0;
}

/**
 * Fit the whole drawing, nodes and their overview labels, into the frame.
 * React Flow's fitView fits the nodes only, so a label wider than its node
 * would be cut by the frame's edge, and one on the top row by its top.
 */
function useFitAll(): (options?: { duration?: number }) => void {
	const { getNodes, getNodesBounds, setViewport } = useReactFlow();
	const width = useStore((s) => s.width);
	const height = useStore((s) => s.height);
	const edges = useStore((s) => s.edges);
	return useCallback(
		(options?: { duration?: number }) => {
			const nodes = getNodes();
			const box = getNodesBounds(nodes);
			if (!box.width || !width || !height) return;
			// An invoked node's label grows down from its top, past a short node's bottom.
			const invoked = new Set(edges.filter((edge) => edge.sourceHandle?.startsWith('invoke-source')).map((edge) => edge.target));
			const footroom = (zoom: number) => (zoom < OVERVIEW_ZOOM ? Math.max(0, ...nodes.filter((node) => invoked.has(node.id) && node.measured?.height).map((node) => node.position.y + Math.max(node.measured!.height!, LABEL_TALLEST / zoom) - (box.y + box.height))) : 0);
			const fit = (zoom: number) => {
				const top = labelHeadroom(zoom) + OVERLAY_TOP / zoom;
				return getViewportForBounds({ x: box.x - LABEL_MARGIN_X, y: box.y - top, width: box.width + 2 * LABEL_MARGIN_X, height: box.height + top + footroom(zoom) }, width, height, 0.02, FIT_MAX_ZOOM, FIT_PADDING);
			};
			// The room depends on the zoom it leads to; a few rounds settle it.
			let view = fit(OVERVIEW_ZOOM);
			for (let i = 0; i < 3; i++) view = fit(view.zoom);
			setViewport(view, options);
		},
		[getNodes, getNodesBounds, setViewport, width, height, edges]
	);
}
const PRO_OPTIONS = { hideAttribution: true };
const PAN_STEP = 80;

/** Animation length, or none when the person asked for reduced motion. */
function motion(ms: number): number {
	return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms;
}

/**
 * The builder's node header shows an edit gear when it is told the node's
 * type. A read-only canvas has no config panel, so each node is registered
 * without its type and the gear is never drawn.
 */
function ReadOnlyNode(props: { id: string; data: INodeData; parentId?: string }): ReactElement {
	return <NodeComponent id={props.id} data={props.data} parentId={props.parentId} />;
}

function ReadOnlyGroup(props: { id: string; data: INodeData; parentId?: string }): ReactElement {
	return <NodeGroup id={props.id} data={props.data} parentId={props.parentId} />;
}

function ReadOnlyAnnotation(props: { id: string; data: INodeData; parentId?: string }): ReactElement {
	return <NodeAnnotation id={props.id} data={props.data} parentId={props.parentId} selected={false} />;
}

const NODE_TYPES = {
	[INodeType.Default]: ReadOnlyNode,
	[INodeType.Group]: ReadOnlyGroup,
	[INodeType.Annotation]: ReadOnlyAnnotation,
};

/** The builder's edge pulls each end 8 px into its handle (FlowEdge HANDLE_OFFSET). */
const HANDLE_OFFSET = 8;

/** An SVG path through `points` with each corner rounded by up to `radius`. */
function roundedPath(points: Array<[number, number]>, radius: number): string {
	let d = `M${points[0][0]},${points[0][1]}`;
	for (let i = 1; i < points.length - 1; i++) {
		const [px, py] = points[i - 1];
		const [x, y] = points[i];
		const [nx, ny] = points[i + 1];
		const r = Math.min(radius, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
		const ax = x - Math.sign(x - px) * r;
		const ay = y - Math.sign(y - py) * r;
		const bx = x + Math.sign(nx - x) * r;
		const by = y + Math.sign(ny - y) * r;
		d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`;
	}
	const [lx, ly] = points[points.length - 1];
	return `${d} L${lx},${ly}`;
}

/**
 * A connection into a later band of a flow the widget wrapped. It has the
 * builder edge's stroke, but runs right out of its source to a drop clear of
 * the nodes and labels below it (see wrapTrunkX), down into the gap above its
 * target's band, across, and down into the target, so it never crosses the
 * drawing. Only a layout the widget made has bands.
 */
function WrapEdge({ sourceX, sourceY, targetX, targetY, style, markerEnd, data }: EdgeProps): ReactElement | null {
	const route = data as { centerY?: number; trunkX?: number } | undefined;
	if (![sourceX, sourceY, targetX, targetY, route?.centerY, route?.trunkX].every(Number.isFinite)) return null;
	const points = wrapCorners(sourceX - HANDLE_OFFSET, sourceY, targetX + HANDLE_OFFSET, targetY, Math.max(route!.trunkX!, sourceX + WRAP_OFFSET), route!.centerY!);
	return <BaseEdge path={roundedPath(points, 8)} markerEnd={markerEnd} style={style} />;
}

const EDGE_TYPES = { default: FlowEdge, wrap: WrapEdge };

type GraphModel = Extract<CanvasModel, { kind: 'graph' }>;
type DisplayMode = 'inline' | 'fullscreen' | 'pip';

interface Bounds {
	width: number;
	height: number;
}

/** Applies only the size React Flow measures; nothing else can change. */
function onlyDimensions(changes: NodeChange<FlowNode>[]): NodeChange<FlowNode>[] {
	return changes.filter((change) => change.type === 'dimensions');
}

/** The drawing's size from node positions and estimated sizes, before the browser measures. */
function estimatedBounds(nodes: GraphModel['nodes']): Bounds {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const node of nodes) {
		if (node.parentId) continue;
		const box = node as unknown as { width?: number; height?: number };
		minX = Math.min(minX, node.position.x);
		minY = Math.min(minY, node.position.y);
		maxX = Math.max(maxX, node.position.x + (box.width ?? ESTIMATED_NODE_SIZE.width));
		maxY = Math.max(maxY, node.position.y + (box.height ?? ESTIMATED_NODE_SIZE.height));
	}
	if (!Number.isFinite(minX)) return { width: 1, height: 1 };
	return { width: Math.max(maxX - minX, 1), height: Math.max(maxY - minY, 1) };
}

/** The inline canvas height that shows the whole drawing at its fitted zoom without empty bands. */
function inlineHeight(width: number, bounds: Bounds, max: number): number {
	const inner = width * (1 - 2 * FIT_PADDING);
	const zoom = inner / (bounds.width + 2 * LABEL_MARGIN_X);
	const wanted = zoom * (bounds.height + labelHeadroom(zoom)) + width * 2 * FIT_PADDING + OVERLAY_TOP;
	return Math.round(Math.min(max, Math.max(CANVAS_MIN_HEIGHT, wanted)));
}

/** True on a touch screen (a coarse primary pointer), kept current. */
function useCoarsePointer(): boolean {
	const query = '(pointer: coarse)';
	const [coarse, setCoarse] = useState(() => window.matchMedia(query).matches);
	useEffect(() => {
		const mq = window.matchMedia(query);
		const update = () => setCoarse(mq.matches);
		mq.addEventListener('change', update);
		return () => mq.removeEventListener('change', update);
	}, []);
	return coarse;
}

interface HostView {
	mode: DisplayMode;
	canFullScreen: boolean;
	/** Bottom inset the host asks content to keep clear of (a composer, a home bar). */
	safeBottom: number;
	request: (mode: DisplayMode) => void;
}

/** The host's display mode, whether it offers full screen, and its safe area, kept current. */
function useHostView(app?: App): HostView {
	const read = useCallback(() => {
		const context = app?.getHostContext();
		return {
			mode: (context?.displayMode as DisplayMode | undefined) ?? 'inline',
			canFullScreen: !!context?.availableDisplayModes?.includes('fullscreen'),
			safeBottom: Number(context?.safeAreaInsets?.bottom ?? 0) || 0,
		};
	}, [app]);
	const [state, setState] = useState(read);
	useEffect(() => {
		if (!app) return;
		const update = () => setState(read());
		app.addEventListener('hostcontextchanged', update);
		return () => app.removeEventListener('hostcontextchanged', update);
	}, [app, read]);
	const request = useCallback(
		(mode: DisplayMode) => {
			app
				?.requestDisplayMode({ mode })
				.then((result) => setState((current) => ({ ...current, mode: (result?.mode as DisplayMode) ?? current.mode })))
				.catch(() => undefined);
		},
		[app]
	);
	return useMemo(() => ({ ...state, request }), [state, request]);
}

// 24 px icons, drawn with currentColor.
const ZOOM_IN_ICON = 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z';
const ZOOM_OUT_ICON = 'M5 11h14v2H5v-2z';
const FIT_ICON = 'M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4zM9 9h6v6H9V9z';
const EXPAND_ICON = 'M3 3h7v2H5v5H3V3zm11 0h7v7h-2V5h-5V3zM3 14h2v5h5v2H3v-7zm16 0h2v7h-7v-2h5v-5z';
const COLLAPSE_ICON = 'M8 3h2v7H3V8h5V3zm6 0h2v5h5v2h-7V3zM3 14h7v7H8v-5H3v-2zm11 0h7v2h-5v5h-2v-7z';

function Svg({ path }: { path: string }): ReactElement {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			<path d={path} />
		</svg>
	);
}

/** A small icon button: the face is drawn smaller than the hit area, which is 44 px on a touch screen. */
function ToolButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }): ReactElement {
	return (
		<button type="button" className="rr-canvas-tool" title={label} aria-label={label} onClick={onClick}>
			<span className="rr-canvas-tool-face">
				<Svg path={icon} />
			</span>
		</button>
	);
}

/**
 * Zoom by `factor` around the middle of the nodes in view, not the middle of
 * the frame, which can be the empty space between two rows.
 */
function useZoomAroundNodes(): (factor: number) => void {
	const { getViewport, setViewport, getNodes, getNodesBounds } = useReactFlow();
	const width = useStore((s) => s.width);
	const height = useStore((s) => s.height);
	return useCallback(
		(factor: number) => {
			const { x, y, zoom } = getViewport();
			const inView = getNodes().filter((node) => {
				const box = getNodesBounds([node]);
				const left = box.x * zoom + x;
				const top = box.y * zoom + y;
				return left + box.width * zoom > 0 && top + box.height * zoom > 0 && left < width && top < height;
			});
			const box = getNodesBounds(inView.length ? inView : getNodes());
			const cx = box.x + box.width / 2;
			const cy = box.y + box.height / 2;
			const next = Math.min(2, Math.max(0.02, zoom * factor));
			// Keep that point where it is on screen.
			const sx = cx * zoom + x;
			const sy = cy * zoom + y;
			setViewport({ x: sx - cx * next, y: sy - cy * next, zoom: next }, { duration: motion(150) });
		},
		[getViewport, setViewport, getNodes, getNodesBounds, width, height]
	);
}

function Toolbar({ host, moved, coarse }: { host: HostView; moved: MutableRefObject<boolean>; coarse: boolean }): ReactElement {
	const fitAll = useFitAll();
	const zoomBy = useZoomAroundNodes();
	const active = host.mode === 'fullscreen';
	// Inline, the buttons are Fit and Expand: zooming in a chat reply is for full screen.
	// A host without full screen keeps the zoom buttons inline. On a touch screen pinch
	// zooms, so there are no zoom buttons.
	const zoomButtons = !coarse && (active || !host.canFullScreen);
	return (
		// A tap on a button is not a tap on the drawing (which opens full screen on touch).
		<div className="rr-canvas-tools" role="toolbar" aria-label="View" onClick={(event) => event.stopPropagation()}>
			{zoomButtons && (
				<ToolButton
					label="Zoom out"
					icon={ZOOM_OUT_ICON}
					onClick={() => {
						moved.current = true;
						zoomBy(1 / 1.25);
					}}
				/>
			)}
			{zoomButtons && (
				<ToolButton
					label="Zoom in"
					icon={ZOOM_IN_ICON}
					onClick={() => {
						moved.current = true;
						zoomBy(1.25);
					}}
				/>
			)}
			<ToolButton
				label="Fit to view"
				icon={FIT_ICON}
				onClick={() => {
					moved.current = false;
					fitAll({ duration: motion(200) });
				}}
			/>
			{host.canFullScreen && <ToolButton label={active ? 'Close full screen' : 'Expand to full screen'} icon={active ? COLLAPSE_ICON : EXPAND_ICON} onClick={() => host.request(active ? 'inline' : 'fullscreen')} />}
		</div>
	);
}

/** Bottom of the builder header of each node, at zoom 1, read once from the DOM. */
const headerBottoms = new Map<string, number>();

function headerBottom(id: string): number {
	const known = headerBottoms.get(id);
	if (known) return known;
	const header = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] .rr-node-header`) as HTMLElement | null;
	if (!header) return NODE_HEADER_HEIGHT;
	const bottom = header.offsetTop + header.offsetHeight;
	if (bottom > 0) headerBottoms.set(id, bottom);
	return bottom || NODE_HEADER_HEIGHT;
}

type Neighbour = { id: string; gap: number } | null;

/** One overview label before the row pass settles its height, font and icon. */
type Draft = {
	id: string;
	title: string;
	service?: { icon?: string };
	/** Grows down from the node's top (an invoked node), else up from its header bottom. */
	down: boolean;
	/** The node is wholly in the frame. */
	inside: boolean;
	nodeLeft: number;
	nodeWidth: number;
	/** How far the label reaches left of its node. */
	toLeft: number;
	width: number;
	nodeTop: number;
	nodeHeader: number;
	/** The line the label sits on: its node's header bottom, or an invoked node's top. */
	anchor: number;
	row: number;
	icon: boolean;
	font: number;
	lines: number;
	height: number;
};

/**
 * The nearest node on each side of every node whose label band it shares,
 * and the gap to it in flow units. A label band is the node's header, or the
 * height of a two-line label when that is taller at this zoom, ending on the
 * header bottom (or starting at the node's top for an invoked node, see
 * OverviewLabels). `blocked`
 * marks a node that overlaps another in its band, whose label stays as wide
 * as the node. Worked out once per placement and zoom step.
 */
function useNeighbours(zoom: number, invoked: Set<string>): Map<string, { left: Neighbour; right: Neighbour; blocked: boolean }> {
	const nodes = useStore((s) => s.nodes);
	const nodeLookup = useStore((s) => s.nodeLookup);
	const step = Math.round(zoom * 50) / 50;
	return useMemo(() => {
		const boxes = [...nodeLookup.values()]
			.filter((node) => node.type === INodeType.Default && node.measured?.width)
			.map((node) => {
				const top = node.internals.positionAbsolute.y;
				// A row lines its labels up within ROW_TOLERANCE px, so a band reaches that much further.
				const slack = ROW_TOLERANCE / Math.max(step, 0.02);
				const h = Math.max(headerBottom(node.id), LABEL_TALLEST / Math.max(step, 0.02)) + slack;
				const y = invoked.has(node.id) ? top - slack : top + headerBottom(node.id) + slack - h;
				return { id: node.id, x: node.internals.positionAbsolute.x, y, w: node.measured!.width!, h };
			});
		const result = new Map<string, { left: Neighbour; right: Neighbour; blocked: boolean }>();
		for (const box of boxes) {
			let left: Neighbour = null;
			let right: Neighbour = null;
			let blocked = false;
			for (const other of boxes) {
				if (other === box || other.y > box.y + box.h || other.y + other.h < box.y) continue;
				if (other.x >= box.x + box.w) {
					const gap = other.x - (box.x + box.w);
					if (!right || gap < right.gap) right = { id: other.id, gap };
				} else if (other.x + other.w <= box.x) {
					const gap = box.x - (other.x + other.w);
					if (!left || gap < left.gap) left = { id: other.id, gap };
				} else blocked = true;
			}
			result.set(box.id, { left, right, blocked });
		}
		return result;
	}, [nodes, nodeLookup, step, invoked]);
}

/** Width of `text` in the labels' font, measured once per text and size. */
const textWidths = new Map<string, number>();
let measurer: CanvasRenderingContext2D | null = null;

function textWidth(text: string, size: number): number {
	const key = `${size}|${text}`;
	const known = textWidths.get(key);
	if (known !== undefined) return known;
	measurer ??= document.createElement('canvas').getContext('2d');
	if (!measurer) return text.length * size * 0.6;
	// The labels' font (canvas.css): the theme's family, else the page's.
	const family = getComputedStyle(document.documentElement).getPropertyValue('--rr-font-family').trim() || getComputedStyle(document.body).fontFamily || 'sans-serif';
	measurer.font = `500 ${size}px ${family}`;
	// A pixel of slack per side, for rounding and hinting.
	const width = measurer.measureText(text).width + 2;
	textWidths.set(key, width);
	return width;
}

/**
 * Larger titles over the builder's node headers when the drawing is zoomed
 * out too far to read them, in the spirit of React Flow's contextual zoom.
 * A label is its node's header drawn larger: the same place, width, colours,
 * border and font, the icon first. It widens past the node only when the
 * title does not fit, into the gaps to its neighbours, which two neighbours
 * share by how much each title needs. A narrow one wraps to two lines. It grows down over the lanes (unreadable
 * at this zoom), never up, so the node's top edge stays where it is. A label
 * that would overlap another is dropped, as map labels are. Labels stay
 * inside the frame. When no label fits, the hint says how to read the names.
 * Labels ignore the pointer; the node under each one has the full title as
 * its tooltip.
 */
function OverviewLabels({ services, onCue }: { services: IServiceCatalog; onCue: (needed: boolean) => void }): ReactElement | null {
	const [tx, ty, zoom] = useStore((s) => s.transform);
	const frameWidth = useStore((s) => s.width);
	const frameHeight = useStore((s) => s.height);
	const nodeLookup = useStore((s) => s.nodeLookup);
	// Nodes an invoke connection enters from the top (an agent's LLM, memory and tools).
	const edges = useStore((s) => s.edges);
	const invoked = useMemo(() => new Set(edges.filter((edge) => edge.sourceHandle?.startsWith('invoke-source')).map((edge) => edge.target)), [edges]);
	const neighbours = useNeighbours(zoom, invoked);
	const drafts: Draft[] = [];
	const ordered = [...nodeLookup.values()].filter((node) => zoom < OVERVIEW_ZOOM && node.type === INodeType.Default && node.measured?.width).sort((a, b) => a.internals.positionAbsolute.y - b.internals.positionAbsolute.y || a.internals.positionAbsolute.x - b.internals.positionAbsolute.x);
	// What each label wants past its node's width: as wide as its title on one line.
	const items = ordered.map((node) => {
		const data = node.data as INodeData;
		const service = services[data.provider] as { title?: string; icon?: string } | undefined;
		const title = data.name || service?.title || data.provider;
		const nodeWidth = node.measured!.width! * zoom;
		const needed = textWidth(title, LABEL_FONT) + LABEL_CHROME;
		return { node, service, title, nodeWidth, wants: Math.max(0, Math.min(LABEL_MAX_WIDTH, needed) - nodeWidth) };
	});
	const wants = new Map(items.map((item) => [item.node.id, item.wants]));
	for (const { node, service, title, nodeWidth, wants: own } of items) {
		// Two neighbours share the gap between them by how much each title needs,
		// leaving a sliver so their labels never meet; a short title leaves its
		// share to its neighbour. A side with no neighbour takes its share of
		// one column gap (the reach wrapTrunkX allows for), up to the frame's edge.
		const near = neighbours.get(node.id);
		const nodeLeft = node.internals.positionAbsolute.x * zoom + tx;
		// A node panned out of the frame has no label at the frame's edge.
		if (nodeLeft + nodeWidth <= 0 || nodeLeft >= frameWidth) continue;
		const reach = (side: Neighbour, open: number) => {
			if (!side) return Math.min(own, Math.max(0, open), LAYER_GAP * zoom * LABEL_GAP_SHARE);
			const room = side.gap * zoom * 2 * LABEL_GAP_SHARE;
			const other = wants.get(side.id) ?? 0;
			return own + other <= room ? own : (room * own) / Math.max(own + other, 1);
		};
		const maxLeft = near?.blocked ? 0 : reach(near?.left ?? null, nodeLeft - 2);
		const maxRight = near?.blocked ? 0 : reach(near?.right ?? null, frameWidth - 2 - (nodeLeft + nodeWidth));
		// Centred on the node when both sides allow it, else shifted to the roomier side.
		let toLeft = Math.min(maxLeft, own / 2);
		const toRight = Math.min(maxRight, own - toLeft);
		toLeft = Math.min(maxLeft, own - toRight);
		const width = nodeWidth + toLeft + toRight;
		// Too narrow to hold a short word: no label (the node's tooltip has the title).
		if (width < LABEL_MIN_WIDTH || width - LABEL_CHROME_NARROW + LABEL_ICON < textWidth('Data', LABEL_FONT_NARROW)) continue;
		const nodeTop = node.internals.positionAbsolute.y * zoom + ty;
		const nodeHeader = headerBottom(node.id) * zoom;
		const down = invoked.has(node.id);
		const inside = nodeLeft >= 0 && nodeLeft + nodeWidth <= frameWidth && nodeTop >= 0 && nodeTop + node.measured!.height! * zoom <= frameHeight;
		drafts.push({ id: node.id, title, service, down, inside, nodeLeft, nodeWidth, toLeft, width, nodeTop, nodeHeader, anchor: down ? nodeTop : nodeTop + nodeHeader, row: 0, icon: false, font: LABEL_FONT, lines: 1, height: 0 });
	}

	// One node is never drawn two ways: labels with the same title take the
	// narrowest width among them, keeping each one's place on its node.
	const byTitle = new Map<string, Draft[]>();
	for (const draft of drafts) byTitle.set(draft.title, [...(byTitle.get(draft.title) ?? []), draft]);
	for (const same of byTitle.values()) {
		const extra = Math.min(...same.map((d) => d.width - d.nodeWidth));
		for (const draft of same) {
			const own = draft.width - draft.nodeWidth;
			draft.toLeft = own > 0 ? (draft.toLeft * extra) / own : 0;
			draft.width = draft.nodeWidth + extra;
		}
	}

	// A row is every label whose anchor line (its node's header bottom, or an
	// invoked node's top) is within 8 px of the next one's.
	const sorted = [...drafts].sort((a, b) => Number(a.down) - Number(b.down) || a.anchor - b.anchor);
	sorted.forEach((draft, i) => {
		const previous = sorted[i - 1];
		draft.row = previous && previous.down === draft.down && draft.anchor - previous.anchor <= ROW_TOLERANCE ? previous.row : i;
	});

	// A row, every label with a title that also appears in it, and every label
	// on the same visual line decide together: all show the icon or none do,
	// and all use one font size.
	const parent = new Map(drafts.map((d) => [d, d]));
	const find = (d: Draft): Draft => (parent.get(d) === d ? d : find(parent.get(d)!));
	const join = (a: Draft, b: Draft) => parent.set(find(a), find(b));
	const firstOfRow = new Map<number, Draft>();
	const firstOfTitle = new Map<string, Draft>();
	for (const draft of drafts) {
		if (firstOfRow.has(draft.row)) join(draft, firstOfRow.get(draft.row)!);
		else firstOfRow.set(draft.row, draft);
		if (firstOfTitle.has(draft.title)) join(draft, firstOfTitle.get(draft.title)!);
		else firstOfTitle.set(draft.title, draft);
	}
	// Labels that sit on one visual line decide together too, whichever way
	// they grow: their boxes overlap by half or more.
	const extent = (d: Draft) => {
		const height = Math.max(d.nodeHeader, LABEL_MIN_HEIGHT_TWO_LINES);
		return d.down ? [d.anchor, d.anchor + height] : [d.anchor - height, d.anchor];
	};
	for (const a of drafts) {
		for (const b of drafts) {
			if (a === b) continue;
			const [at, ab] = extent(a);
			const [bt, bb] = extent(b);
			if (Math.min(ab, bb) - Math.max(at, bt) >= Math.min(ab - at, bb - bt) / 2) join(a, b);
		}
	}
	const groups = new Map<Draft, Draft[]>();
	for (const draft of drafts) groups.set(find(draft), [...(groups.get(find(draft)) ?? []), draft]);
	const wordsOf = (title: string) => title.split(/\s+|(?<=-)/).filter(Boolean);
	const longest = (title: string, size: number) => Math.max(...wordsOf(title).map((word) => textWidth(word, size)));
	for (const group of groups.values()) {
		// The icon leads, as on the node, when every label in the group still
		// has room beside it for each word of its title (and a few letters).
		const icon = group.every((d) => !d.service?.icon || d.width - LABEL_CHROME_NARROW >= Math.max(LABEL_TEXT_MIN, longest(d.title, LABEL_FONT_NARROW)));
		for (const draft of group) draft.icon = icon && !!draft.service?.icon;
		const room = (d: Draft, chrome: number) => d.width - chrome + (d.icon ? 0 : LABEL_ICON);
		// The label font when the title fits one line in it, or two lines with
		// every word fitting on a wide label; the smaller font otherwise.
		const fontFor = (d: Draft) => (textWidth(d.title, LABEL_FONT) <= room(d, LABEL_CHROME) || (d.width >= LABEL_WIDE && longest(d.title, LABEL_FONT) <= room(d, LABEL_CHROME_NARROW)) ? LABEL_FONT : LABEL_FONT_NARROW);
		const font = Math.min(...group.map(fontFor));
		for (const draft of group) {
			draft.font = font;
			// One line when the title fits; else two, broken between words (never
			// inside one; the second ends in an ellipsis when the title runs on).
			// A word too long for a line leaves one line, cut short.
			const chrome = font === LABEL_FONT && textWidth(draft.title, font) <= room(draft, LABEL_CHROME) ? LABEL_CHROME : LABEL_CHROME_NARROW;
			draft.lines = textWidth(draft.title, font) <= room(draft, chrome) || longest(draft.title, font) > room(draft, LABEL_CHROME_NARROW) ? 1 : 2;
		}
	}

	// Labels in one row share one height and line up: up-growing labels on
	// the row's lowest header bottom, down-growing ones on its highest top.
	const rows = new Map<number, Draft[]>();
	for (const draft of drafts) rows.set(draft.row, [...(rows.get(draft.row) ?? []), draft]);
	for (const row of rows.values()) {
		const line = row[0].down ? Math.min(...row.map((d) => d.anchor)) : Math.max(...row.map((d) => d.anchor));
		const height = Math.max(...row.map((d) => Math.max(d.down ? d.nodeHeader : line - d.nodeTop, d.lines === 2 ? (d.font === LABEL_FONT ? LABEL_TALLEST : LABEL_MIN_HEIGHT_TWO_LINES) : LABEL_MIN_HEIGHT)));
		for (const draft of row) {
			draft.height = height;
			draft.anchor = line;
		}
	}
	// A group (its rows, and the labels that share a title with them) takes its
	// tallest row's height, so equal titles are the same size too.
	for (const group of groups.values()) {
		const height = Math.max(...group.map((d) => d.height));
		for (const draft of group) draft.height = height;
	}

	// A label stays on its node: one whose node the frame cuts is cut the same
	// way, as map labels are. When two would overlap, the one whose node is
	// wholly in view wins.
	const labels: ReactElement[] = [];
	const placed: Array<{ id: string; left: number; top: number; right: number; bottom: number }> = [];
	for (const draft of [...drafts].sort((a, b) => Number(b.inside) - Number(a.inside))) {
		// A label's bottom sits on its node's header bottom: it covers the header
		// and grows up, so the lanes and their connections stay in view. An
		// invoked node's invoke connection comes in from above, so its label
		// starts at the node's top and grows down over its own lanes instead.
		const left = draft.nodeLeft - draft.toLeft;
		const top = draft.down ? draft.anchor : draft.anchor - draft.height;
		const box = { id: draft.id, left, top, right: left + draft.width, bottom: top + draft.height };
		if (placed.some((p) => box.left < p.right && p.left < box.right && box.top < p.bottom && p.top < box.bottom)) continue;
		placed.push(box);
		const kind = draft.lines === 2 ? ' rr-overview-narrow' : draft.font === LABEL_FONT_NARROW ? ' rr-overview-short' : '';
		labels.push(
			<div key={draft.id} data-node={draft.id} className={`rr-overview-label${kind}`} style={{ left, top, width: draft.width, height: draft.height, fontSize: draft.font }}>
				{draft.icon && draft.service?.icon && <Icon name={draft.service.icon} width="12" height="12" className="rr-overview-icon" />}
				<span className="rr-overview-title">{draft.title}</span>
			</div>
		);
	}

	// A connection that runs under a label other than its own ends' would
	// read as passing through that node. It is drawn again above the labels,
	// with the same path and stroke, so it reads as crossing over.
	const [over, setOver] = useState<Array<{ id: string; d: string; invoke: boolean }>>([]);
	const placedKey = placed.map((p) => `${p.id}:${Math.round(p.left)},${Math.round(p.top)},${Math.round(p.right)},${Math.round(p.bottom)}`).join('|');
	useLayoutEffect(() => {
		const next: Array<{ id: string; d: string; invoke: boolean }> = [];
		for (const edge of placed.length ? edges : []) {
			const path = document.querySelector(`.react-flow__edge[data-id="${CSS.escape(edge.id)}"] .react-flow__edge-path`) as SVGPathElement | null;
			const foreign = placed.filter((p) => p.id !== edge.source && p.id !== edge.target);
			if (!path || !foreign.length) continue;
			const total = path.getTotalLength();
			const step = Math.max(0.5, 1 / zoom);
			let under = 0;
			for (let at = 0; at <= total; at += step) {
				const point = path.getPointAtLength(at);
				const x = point.x * zoom + tx;
				const y = point.y * zoom + ty;
				if (foreign.some((p) => x > p.left && x < p.right && y > p.top && y < p.bottom)) under += step * zoom;
			}
			if (under > 2) next.push({ id: edge.id, d: path.getAttribute('d') ?? '', invoke: !!edge.sourceHandle?.startsWith('invoke-source') });
		}
		setOver((current) => (current.length === next.length && current.every((o, i) => o.id === next[i].id && o.d === next[i].d) ? current : next));
		// placedKey stands for `placed`, which is a new array on every render.
	}, [placedKey, edges, tx, ty, zoom]);

	// When no label fits, a cue in the drawing says how to read the names.
	const cue = ordered.length > 0 && labels.length === 0;
	useEffect(() => onCue(cue), [cue, onCue]);
	if (!labels.length) return null;
	return (
		<div className="rr-overview" aria-hidden="true">
			{labels}
			{over.length > 0 && (
				<svg className="rr-overview-edges">
					<g transform={`translate(${tx} ${ty}) scale(${zoom})`}>
						{over.map((edge) => (
							<path key={edge.id} data-edge={edge.id} d={edge.d} className={edge.invoke ? 'rr-overview-edge rr-overview-invoke' : 'rr-overview-edge'} />
						))}
					</g>
				</svg>
			)}
		</div>
	);
}

/** True when every node is inside the visible frame. */
function useWholeDrawingVisible(): boolean {
	const [tx, ty, zoom] = useStore((s) => s.transform);
	const width = useStore((s) => s.width);
	const height = useStore((s) => s.height);
	const nodeLookup = useStore((s) => s.nodeLookup);
	for (const node of nodeLookup.values()) {
		if (node.parentId || !node.measured?.width || !node.measured?.height) continue;
		const { x, y } = node.internals.positionAbsolute;
		const left = x * zoom + tx;
		const top = y * zoom + ty;
		if (left < 0 || top < 0 || left + node.measured.width * zoom > width || top + node.measured.height * zoom > height) return false;
	}
	return true;
}

function FullScreenMiniMap({ safeBottom }: { safeBottom: number }): ReactElement | null {
	const whole = useWholeDrawingVisible();
	const frameWidth = useStore((s) => s.width);
	if (whole || frameWidth < MINIMAP_MIN_FRAME_WIDTH) return null;
	return <MiniMap pannable zoomable position="bottom-right" nodeClassName="rr-minimap-node" ariaLabel="Overview of the whole pipeline" style={{ marginBottom: 16 + safeBottom }} />;
}

function Flow({ model, host, moved, onBounds, onCue }: { model: GraphModel; host: HostView; moved: MutableRefObject<boolean>; onBounds: (bounds: Bounds) => void; onCue: (needed: boolean) => void }): ReactElement {
	const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(model.nodes as unknown as FlowNode[]);
	const initialized = useNodesInitialized();
	const { getInternalNode, getNodesBounds, setViewport, getViewport, getNodes } = useReactFlow();
	const fitAll = useFitAll();
	const frameWidth = useStore((s) => s.width);
	const frameHeight = useStore((s) => s.height);
	const active = host.mode === 'fullscreen';
	const placed = useRef(!model.laidOut);
	const [ready, setReady] = useState(false);
	const [placement, setPlacement] = useState(0);

	// A pipeline saved without positions was placed with estimated sizes.
	// Once the browser has measured every node, place it again with the real
	// sizes and the real frame, so nothing overlaps and a long flow wraps to
	// suit the frame.
	// A layout the widget made suits its frame, so it is made again for full screen and back.
	const placedFor = useRef(active);
	if (model.laidOut && placedFor.current !== active) {
		placedFor.current = active;
		placed.current = false;
	}
	useEffect(() => {
		if (!initialized || placed.current || !frameWidth) return;
		placed.current = true;
		const sizeOf = (id: string) => {
			const measured = getInternalNode(id)?.measured;
			return { width: measured?.width ?? ESTIMATED_NODE_SIZE.width, height: measured?.height ?? ESTIMATED_NODE_SIZE.height };
		};
		// Inline, the layout aims at the height the frame can grow to.
		const inlineMax = model.summary.truncated ? TRUNCATED_MAX_HEIGHT : frameWidth < NARROW_FRAME ? NARROW_MAX_HEIGHT : CANVAS_MAX_HEIGHT;
		setNodes((current) => placeNodes(current as never, model.edges, false, sizeOf, { width: frameWidth, height: active ? frameHeight : inlineMax }) as unknown as FlowNode[]);
		setPlacement((n) => n + 1);
	}, [initialized, model.edges, model.summary.truncated, getInternalNode, setNodes, frameWidth, frameHeight, active]);

	// Once the final placement is measured, report the drawing's real size,
	// which sets the frame's height.
	useEffect(() => {
		if (!initialized || !placed.current) return;
		const frame = requestAnimationFrame(() => {
			const box = getNodesBounds(getNodes());
			if (box.width > 0 && box.height > 0) onBounds({ width: box.width, height: box.height });
			setReady(true);
		});
		return () => cancelAnimationFrame(frame);
	}, [initialized, nodes, getNodesBounds, getNodes, onBounds]);

	// Each mode keeps its own view. Inline fits the whole drawing whenever the
	// frame changes size, unless the user has moved it. Full screen opens on
	// the sources at a readable zoom when the whole drawing would be too small
	// there, and keeps the user's place once they move. Closing full screen
	// brings back the inline view as it was.
	const mode = useRef<{ active: boolean; inlineView: Viewport | null; inlineMoved: boolean; restore: boolean }>({ active: false, inlineView: null, inlineMoved: false, restore: false });
	useEffect(() => {
		if (!ready || !frameWidth || !frameHeight) return;
		const state = mode.current;
		if (active && !state.active) {
			state.inlineView = getViewport();
			state.inlineMoved = moved.current;
			state.restore = false;
			moved.current = false;
		} else if (!active && state.active) {
			moved.current = state.inlineMoved;
			// Pending until a frame applies it: the inline placement and the frame's
			// resize re-run this effect, and the re-run cancels the frame below.
			state.restore = state.inlineMoved;
		}
		state.active = active;
		const frame = requestAnimationFrame(() => {
			if (state.restore && state.inlineView) {
				state.restore = false;
				setViewport(state.inlineView);
				return;
			}
			if (moved.current) return;
			if (active) {
				// Fit while nodes stay readable-sized; otherwise open at a reading
				// zoom on the drawing's top-left corner (where the flow starts).
				const all = getNodesBounds(getNodes());
				const fitZoom = Math.min(frameWidth / all.width, frameHeight / all.height) * (1 - 2 * FIT_PADDING);
				const widths = getNodes()
					.map((node) => getInternalNode(node.id)?.measured?.width ?? 0)
					.filter((w) => w > 0)
					.sort((a, b) => a - b);
				const typical = widths[Math.floor(widths.length / 2)] ?? ESTIMATED_NODE_SIZE.width;
				// When the fit would draw nodes too small, full screen opens at a reading
				// zoom (a bit smaller on a phone, so about three columns show) and the
				// minimap shows the rest. Fit is one tap away.
				if (fitZoom * typical < FULL_FIT_MIN_NODE_WIDTH) {
					const zoom = Math.min(1.25, (frameWidth < NARROW_FRAME ? FULL_READ_NODE_WIDTH_NARROW : FULL_READ_NODE_WIDTH) / typical);
					setViewport({ x: 24 - all.x * zoom, y: OVERLAY_TOP + 12 - all.y * zoom, zoom });
					return;
				}
			}
			fitAll();
		});
		return () => cancelAnimationFrame(frame);
	}, [ready, frameWidth, frameHeight, active, placement, fitAll, getNodes, getNodesBounds, getInternalNode, getViewport, setViewport, moved]);

	// A connection into a later band of a wrapped flow runs through the gap
	// above that band. A connection that still crosses a node (a saved layout
	// can have one) is drawn over it, not hidden behind it, so it never looks
	// like it ends there.
	const edges = useMemo(() => {
		if (!initialized) return model.edges;
		const positions: Positions = {};
		const sizes: Record<string, { width: number; height: number }> = {};
		for (const node of nodes) {
			const internal = getInternalNode(node.id);
			if (node.type !== INodeType.Default || !internal?.measured?.width || !internal.measured.height) continue;
			const band = (node.data as { layoutBand?: number }).layoutBand;
			// A top-level node's position from this render's state: the store's copy lags a placement by one render.
			positions[node.id] = { ...(node.parentId ? internal.internals.positionAbsolute : node.position), band };
			sizes[node.id] = { width: internal.measured.width, height: internal.measured.height };
		}
		const sizeOf = (id: string) => sizes[id];
		const gaps = bandGaps(positions);
		return model.edges.map((edge) => {
			const link = { source: edge.source, target: edge.target, control: !!edge.sourceHandle?.startsWith('invoke-source') };
			const centerY = wrapCenterY(positions, link, gaps);
			const routed = centerY === undefined ? edge : { ...edge, type: 'wrap', data: { ...edge.data, centerY, trunkX: wrapTrunkX(positions, link, sizeOf, centerY) } };
			return edgesThroughNodes(positions, [link], sizeOf) ? { ...routed, zIndex: 1 } : routed;
		});
	}, [initialized, nodes, model.edges, getInternalNode]);

	const project = useMemo(() => ({ components: [] }) as unknown as IProject, []);

	// Every node carries its full title and kind as a tooltip, for a label cut short.
	useEffect(() => {
		if (!initialized) return;
		for (const node of nodes) {
			const element = document.querySelector(`.react-flow__node[data-id="${CSS.escape(node.id)}"]`);
			if (!element || node.type !== INodeType.Default) continue;
			const data = node.data as INodeData;
			const service = model.services[data.provider] as { title?: string } | undefined;
			const title = data.name || service?.title || data.provider;
			element.setAttribute('title', title === data.provider ? title : `${title} (${data.provider})`);
		}
	}, [initialized, nodes, model.services]);

	return (
		<ReadOnlyFlowPreferencesProvider>
			<ReadOnlyFlowProjectProvider project={project} servicesJson={model.services}>
				<ReadOnlyFlowGraphProvider nodes={nodes} edges={edges}>
					<ReactFlow
						nodes={nodes}
						edges={edges}
						nodeTypes={NODE_TYPES}
						edgeTypes={EDGE_TYPES}
						onNodesChange={(changes) => onNodesChange(onlyDimensions(changes))}
						onMoveStart={(event) => {
							if (event) moved.current = true;
						}}
						nodesDraggable={false}
						nodesConnectable={false}
						nodesFocusable={false}
						edgesFocusable={false}
						elementsSelectable={false}
						deleteKeyCode={null}
						selectionKeyCode={null}
						multiSelectionKeyCode={null}
						// Inline: the wheel scrolls the chat (pinch or Ctrl + wheel zooms).
						// Full screen: the wheel pans and the canvas keeps every event.
						zoomOnScroll={false}
						panOnScroll={active}
						preventScrolling={active}
						zoomOnPinch
						panOnDrag
						zoomOnDoubleClick
						// Space presses a focused view button; nothing pans with it.
						panActivationKeyCode={null}
						minZoom={0.02}
						maxZoom={2}
						proOptions={PRO_OPTIONS}
					>
						<Background color="var(--rr-text-disabled)" gap={20} style={{ backgroundColor: 'var(--rr-bg-default)' }} />
						<OverviewLabels services={model.services} onCue={onCue} />
						{active && <FullScreenMiniMap safeBottom={host.safeBottom} />}
					</ReactFlow>
				</ReadOnlyFlowGraphProvider>
			</ReadOnlyFlowProjectProvider>
		</ReadOnlyFlowPreferencesProvider>
	);
}

/** Keyboard on the focused frame: arrows pan, + and - zoom, 0 fits. Escape is handled once, on the window, in full screen. */
function useFrameKeys(moved: MutableRefObject<boolean>): (event: KeyboardEvent<HTMLDivElement>) => void {
	const { getViewport, setViewport } = useReactFlow();
	const zoomBy = useZoomAroundNodes();
	const fitAll = useFitAll();
	return (event) => {
		const step: Record<string, [number, number]> = { ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] };
		if (step[event.key]) {
			const { x, y, zoom } = getViewport();
			moved.current = true;
			setViewport({ x: x + step[event.key][0], y: y + step[event.key][1], zoom }, { duration: motion(100) });
		} else if (event.key === '+' || event.key === '=') {
			moved.current = true;
			zoomBy(1.25);
		} else if (event.key === '-') {
			moved.current = true;
			zoomBy(1 / 1.25);
		} else if (event.key === '0') {
			moved.current = false;
			fitAll({ duration: motion(200) });
		} else {
			return;
		}
		event.preventDefault();
	};
}

/** The pipeline's name, or its file name when it has none. */
function pipelineName(summary: ViewPipelineSummary): string {
	const file = displayPath(summary.path, summary.workspace);
	const stem = file.replace(/^.*\//, '').replace(/\.pipe(\.json)?$/, '');
	return summary.name || stem || 'Pipeline';
}

/** The two notes shown only when they apply: a cut-short drawing, and node types this engine lacks. */
function Notes({ truncated, count, shown, missing }: { truncated: boolean; count: number; shown: number; missing: string[] }): ReactElement | null {
	const notes = [truncated ? `Showing the first ${shown} of ${count} nodes. The builder shows all of it.` : '', missing.length === 1 ? `${missing[0]} isn't installed on this engine, so it is drawn with a plain icon.` : missing.length > 1 ? `${missing.join(', ')} aren't installed on this engine, so they are drawn with a plain icon.` : ''].filter(Boolean);
	if (!notes.length) return null;
	return (
		<div className="rr-canvas-notes" role="status">
			{notes.join(' ')}
		</div>
	);
}

/** The drawing as text, for screen readers: every node, then every connection. */
function TextAlternative({ summary }: { summary: GraphModel['summary'] }): ReactElement {
	const titles = new Map((summary.nodes ?? []).map((node) => [node.id, node.title || node.provider]));
	return (
		<div className="rr-sr-only" id="rr-canvas-text">
			<p>Nodes:</p>
			<ul>
				{(summary.nodes ?? []).map((node) => (
					<li key={node.id}>
						{node.title || node.provider} ({node.provider})
					</li>
				))}
			</ul>
			<p>Connections:</p>
			<ul>
				{(summary.connections ?? []).map((c, i) => (
					<li key={i}>
						{titles.get(c.from) ?? c.from} to {titles.get(c.to) ?? c.to}, {c.lane ? `${c.lane} lane` : `invokes as ${c.control}`}
					</li>
				))}
			</ul>
		</div>
	);
}

function Graph({ model, host }: { model: GraphModel; host: HostView }): ReactElement {
	const coarse = useCoarsePointer();
	const active = host.mode === 'fullscreen';
	const moved = useRef(false);
	const boxRef = useRef<HTMLDivElement>(null);
	const notesRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [bounds, setBounds] = useState<Bounds>(() => estimatedBounds(model.nodes));
	const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight);
	const onKeyDown = useFrameKeys(moved);

	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!box) return;
		setWidth(box.clientWidth);
		const observer = new ResizeObserver(() => setWidth(box.clientWidth));
		observer.observe(box);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!active) return;
		const onResize = () => setViewportHeight(window.innerHeight);
		const onEscape = (event: globalThis.KeyboardEvent) => {
			if (event.key === 'Escape') host.request('inline');
		};
		onResize();
		window.addEventListener('resize', onResize);
		window.addEventListener('keydown', onEscape);
		return () => {
			window.removeEventListener('resize', onResize);
			window.removeEventListener('keydown', onEscape);
		};
	}, [active, host]);

	// Inline on a touch screen, one finger scrolls the chat: a one-finger touch
	// never reaches the canvas (two fingers still pan and zoom it). Map embeds
	// call this cooperative gesture handling.
	useEffect(() => {
		const box = boxRef.current;
		if (!box || active || !coarse) return;
		const oneFinger = (event: TouchEvent) => {
			if (event.touches.length === 1) event.stopPropagation();
		};
		box.addEventListener('touchstart', oneFinger, { capture: true, passive: true });
		return () => box.removeEventListener('touchstart', oneFinger, { capture: true });
	}, [active, coarse]);

	const onBounds = useCallback((next: Bounds) => setBounds((current) => (Math.abs(current.width - next.width) < 1 && Math.abs(current.height - next.height) < 1 ? current : next)), []);

	const inlineMax = model.summary.truncated ? TRUNCATED_MAX_HEIGHT : width && width < NARROW_FRAME ? NARROW_MAX_HEIGHT : CANVAS_MAX_HEIGHT;
	// Full screen: the drawing takes the window, less the notes line and the host's safe area.
	const frameTop = boxRef.current?.getBoundingClientRect().top ?? 12;
	const notesHeight = notesRef.current?.getBoundingClientRect().height ?? 0;
	const height = active ? Math.max(CANVAS_MIN_HEIGHT, viewportHeight - frameTop - notesHeight - 16 - host.safeBottom) : width ? inlineHeight(width, bounds, inlineMax) : CANVAS_MIN_HEIGHT;
	const [cueNeeded, setCueNeeded] = useState(false);
	// Shown only when the names are too small to read.
	const cue = active || !host.canFullScreen ? 'Zoom in to read the names' : coarse ? 'Tap to read the names' : 'Expand or zoom in to read the names';
	// On a touch screen a tap on the inline canvas opens full screen, where every gesture works.
	const onTap = () => {
		if (coarse && !active && host.canFullScreen) host.request('fullscreen');
	};
	const name = pipelineName(model.summary);
	// The name stops short of the view buttons (see Toolbar for which show).
	const tools = 1 + (host.canFullScreen ? 1 : 0) + (!coarse && (active || !host.canFullScreen) ? 2 : 0);
	const count = model.summary.node_count ?? model.nodes.length;
	const shown = model.summary.nodes?.length ?? model.nodes.length;
	const described = [`Read-only diagram of ${name}, ${count} ${count === 1 ? 'node' : 'nodes'}${model.summary.truncated ? `, the first ${shown} drawn` : ''}.`, model.summary.description ? `${model.summary.description.replace(/[.\s]+$/, '')}.` : '', 'Arrow keys move it, plus and minus zoom.'].filter(Boolean).join(' ');

	return (
		<div className={`rr-canvas${active ? ' rr-canvas-full' : ''}${coarse ? ' rr-canvas-coarse' : ''}`}>
			<div ref={boxRef} className="rr-canvas-frame" style={{ height }} tabIndex={0} role="region" aria-label={described} aria-describedby="rr-canvas-text" onKeyDown={onKeyDown} onClick={onTap}>
				{width > 0 && <Flow model={model} host={host} moved={moved} onBounds={onBounds} onCue={setCueNeeded} />}
				<div className="rr-canvas-name" title={name} style={{ maxWidth: `calc(100% - ${tools * (coarse ? 44 : 32) + 24}px)` }}>
					{name}
				</div>
				<Toolbar host={host} moved={moved} coarse={coarse} />
				{cueNeeded && <div className="rr-canvas-cue">{cue}</div>}
			</div>
			<div ref={notesRef}>
				<Notes truncated={!!model.summary.truncated} count={count} shown={shown} missing={model.missingProviders} />
			</div>
			<TextAlternative summary={model.summary} />
		</div>
	);
}

function ErrorCard({ message, hint }: { message: string; hint?: string }): ReactElement {
	return (
		<div className="rr-card rr-canvas-error" role="alert">
			<svg viewBox="0 0 24 24" aria-hidden="true" className="rr-canvas-error-icon">
				<path d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm-1 5v7h2V7h-2zm0 9v2h2v-2h-2z" />
			</svg>
			<div>
				<div className="rr-canvas-error-title">Couldn't open this pipeline</div>
				<div className="rr-canvas-error-message">{message}</div>
				{hint && <div className="rr-canvas-hint">{hint}</div>}
			</div>
		</div>
	);
}

/** One tool result, drawn. Remounted for every result (see main.tsx). */
export function CanvasApp({ model, app }: { model: CanvasModel; app?: App }): ReactElement {
	useMemo(() => {
		if (model.kind === 'graph') registerServiceIcons({ services: model.services as never, icons: model.icons });
	}, [model]);
	const host = useHostView(app);

	if (model.kind === 'error') return <ErrorCard message={model.message} hint={model.hint} />;
	if (model.kind === 'empty') {
		return (
			<div className="rr-canvas">
				<div className="rr-card rr-canvas-empty" role="status">
					<div className="rr-canvas-empty-name" title={pipelineName(model.summary)}>
						{pipelineName(model.summary)}
					</div>
					This pipeline has no nodes yet. Open it in the builder to add some.
				</div>
			</div>
		);
	}
	return (
		<ReactFlowProvider>
			<Graph model={model} host={host} />
		</ReactFlowProvider>
	);
}
