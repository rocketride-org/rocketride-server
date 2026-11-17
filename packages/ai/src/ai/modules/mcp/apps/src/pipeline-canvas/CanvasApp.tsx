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
import { Background, MiniMap, ReactFlow, ReactFlowProvider, getViewportForBounds, useNodesInitialized, useNodesState, useReactFlow, useStore, type NodeChange, type Viewport } from '@xyflow/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import '@xyflow/react/dist/style.css';

import '@app-shared/tools/pipelines/panels/design/canvas/components/reactflow-overrides.css';
import NodeComponent from '@app-shared/tools/pipelines/panels/design/canvas/components/node/node-component/NodeComponent';
import NodeGroup from '@app-shared/tools/pipelines/panels/design/canvas/components/node/node-group/NodeGroup';
import NodeAnnotation from '@app-shared/tools/pipelines/panels/design/canvas/components/node/node-annotation/NodeAnnotation';
import FlowEdge from '@app-shared/tools/pipelines/panels/design/canvas/components/edge/FlowEdge';
import { Icon, registerServiceIcons } from '@app-shared/tools/pipelines/panels/design/canvas/util/Icon';
import { INodeType, IServiceCapabilities, type IProject, type INodeData, type IServiceCatalog } from '@app-shared/tools/pipelines/panels/design/canvas/types';

import { ReadOnlyFlowGraphProvider, type FlowNode } from './stand-ins/FlowGraphContext';
import { ReadOnlyFlowProjectProvider } from './stand-ins/FlowProjectContext';
import { ReadOnlyFlowPreferencesProvider } from './stand-ins/FlowPreferencesContext';
import { ESTIMATED_NODE_SIZE, displayPath, mainFlow, placeNodes, type CanvasModel } from './model';
import { LAYER_GAP, edgesThroughNodes } from './layout';

/**
 * Canvas height bounds, in px. The height follows the drawing's shape inside
 * these bounds, always as a pixel value: host auto-resize measures the
 * document, and a % or vh height would collapse the widget.
 */
export const CANVAS_MAX_HEIGHT = 560;
export const CANVAS_MIN_HEIGHT = 160;
/** On a phone-width frame the canvas stays shorter, so it never fills the whole chat. */
const NARROW_FRAME = 480;
const NARROW_MAX_HEIGHT = 420;

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
/** Two neighbouring labels fill at most twice this share of the gap between their nodes. */
const LABEL_GAP_SHARE = 0.46;
/** The widest a label grows, in px. */
const LABEL_MAX_WIDTH = 190;
/** Height of the builder's top cap and header row at zoom 1, used until the header is measured. */
const NODE_HEADER_HEIGHT = 46;
/** The smallest label heights, one line and two lines, in px. */
const LABEL_MIN_HEIGHT = 20;
const LABEL_MIN_HEIGHT_TWO_LINES = 30;
/** Full screen fits the whole drawing while nodes stay at least this wide on screen. */
const FULL_FIT_MIN_NODE_WIDTH = 90;
/** Otherwise full screen opens at the zoom that draws a typical node this wide. */
const FULL_READ_NODE_WIDTH = 120;
/** Under this frame width the full-screen minimap would cover too much of the drawing. */
const MINIMAP_MIN_FRAME_WIDTH = 480;
/** The inline canvas of a truncated pipeline stays short: 200 thumbnails are an overview, not a read. */
const TRUNCATED_MAX_HEIGHT = 320;

const FIT_PADDING = 0.04;
const FIT_MAX_ZOOM = 1.25;
/** Room around the nodes for the overview labels, in flow units: their side overhang and their upward growth. */
const LABEL_MARGIN_X = 30;
const LABEL_MARGIN_TOP = 6;

/**
 * Fit the whole drawing, nodes and their overview labels, into the frame.
 * React Flow's fitView fits the nodes only, so a label wider than its node
 * would be cut by the frame's edge.
 */
function useFitAll(): (options?: { duration?: number }) => void {
	const { getNodes, getNodesBounds, setViewport } = useReactFlow();
	const width = useStore((s) => s.width);
	const height = useStore((s) => s.height);
	return useCallback(
		(options?: { duration?: number }) => {
			const box = getNodesBounds(getNodes());
			if (!box.width || !width || !height) return;
			const padded = { x: box.x - LABEL_MARGIN_X, y: box.y - LABEL_MARGIN_TOP, width: box.width + 2 * LABEL_MARGIN_X, height: box.height + LABEL_MARGIN_TOP };
			setViewport(getViewportForBounds(padded, width, height, 0.02, FIT_MAX_ZOOM, FIT_PADDING), options);
		},
		[getNodes, getNodesBounds, setViewport, width, height]
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

const EDGE_TYPES = { default: FlowEdge };

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
	const padded = { width: bounds.width + 2 * LABEL_MARGIN_X, height: bounds.height + LABEL_MARGIN_TOP };
	const wanted = (inner * padded.height) / padded.width + width * 2 * FIT_PADDING;
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

function ToolButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }): ReactElement {
	return (
		<button type="button" className="rr-canvas-tool" title={label} aria-label={label} onClick={onClick}>
			<Svg path={icon} />
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
	// Inline, the toolbar is Fit and Expand: zooming in a chat reply is for full screen.
	// A host without full screen keeps the zoom buttons inline. On a touch screen pinch
	// zooms, so the zoom buttons give their room back to the canvas.
	const zoomButtons = !coarse && (active || !host.canFullScreen);
	return (
		<div className="rr-canvas-tools" role="toolbar" aria-label="View">
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
			{host.canFullScreen && (
				<button type="button" className="rr-canvas-tool rr-canvas-expand" onClick={() => host.request(active ? 'inline' : 'fullscreen')} aria-label={active ? 'Close full screen' : 'Expand to full screen'}>
					<Svg path={active ? COLLAPSE_ICON : EXPAND_ICON} />
					<span>{active ? 'Close' : 'Expand'}</span>
				</button>
			)}
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

/**
 * The nearest node on each side of every node whose label band it shares,
 * and the gap to it in flow units. A label band is the node's header, or the
 * height of a two-line label when that is taller at this zoom. `blocked`
 * marks a node that overlaps another in its band, whose label stays as wide
 * as the node. Worked out once per placement and zoom step.
 */
function useNeighbours(zoom: number): Map<string, { left: Neighbour; right: Neighbour; blocked: boolean }> {
	const nodes = useStore((s) => s.nodes);
	const nodeLookup = useStore((s) => s.nodeLookup);
	const step = Math.round(zoom * 50) / 50;
	return useMemo(() => {
		const boxes = [...nodeLookup.values()].filter((node) => node.type === INodeType.Default && node.measured?.width).map((node) => ({ id: node.id, x: node.internals.positionAbsolute.x, y: node.internals.positionAbsolute.y, w: node.measured!.width!, h: Math.max(headerBottom(node.id), LABEL_MIN_HEIGHT_TWO_LINES / Math.max(step, 0.02)) }));
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
	}, [nodes, nodeLookup, step]);
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
	const neighbours = useNeighbours(zoom);
	const labels: ReactElement[] = [];
	const placed: Array<{ left: number; top: number; right: number; bottom: number }> = [];
	const ordered = [...nodeLookup.values()].filter((node) => zoom < OVERVIEW_ZOOM && node.type === INodeType.Default && node.measured?.width).sort((a, b) => a.internals.positionAbsolute.y - b.internals.positionAbsolute.y || a.internals.positionAbsolute.x - b.internals.positionAbsolute.x);
	// What each label wants past its node's width: as wide as its title on one line.
	const items = ordered.map((node) => {
		const data = node.data as INodeData;
		const service = services[data.provider] as { title?: string; icon?: string; capabilities?: number } | undefined;
		const title = data.name || service?.title || data.provider;
		const experimental = ((service?.capabilities ?? 0) & IServiceCapabilities.Experimental) === IServiceCapabilities.Experimental;
		const nodeWidth = node.measured!.width! * zoom;
		const needed = textWidth(title, LABEL_FONT) + LABEL_CHROME + (experimental ? 9 : 0);
		return { node, service, title, experimental, nodeWidth, needed, wants: Math.max(0, Math.min(LABEL_MAX_WIDTH, needed) - nodeWidth) };
	});
	const wants = new Map(items.map((item) => [item.node.id, item.wants]));
	for (const { node, service, title, experimental, nodeWidth, needed, wants: own } of items) {
		// Two neighbours share the gap between them by how much each title needs,
		// leaving a sliver so their labels never meet. A side with no neighbour
		// takes what a neighbour one column gap away would leave, up to the frame's edge.
		const near = neighbours.get(node.id);
		const nodeLeft = node.internals.positionAbsolute.x * zoom + tx;
		// A node panned out of the frame has no label at the frame's edge.
		if (nodeLeft + nodeWidth <= 0 || nodeLeft >= frameWidth) continue;
		const reach = (side: Neighbour, open: number) => {
			if (!side) return Math.min(own, Math.max(0, open), LAYER_GAP * zoom * 2 * LABEL_GAP_SHARE);
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
		if (width < LABEL_MIN_WIDTH) continue;
		// A title that does not fit one line takes two, broken between words (or
		// after a hyphen), never inside one: in the label font when the longest
		// word fits, else the smaller one, else without the icon. When it still
		// does not fit, the label is one line cut short with an ellipsis (the
		// node's tooltip has the whole title).
		let narrow = needed > width;
		let font = LABEL_FONT;
		let icon = !!service?.icon;
		let short = false;
		if (narrow) {
			const words = title.split(/\s+|(?<=-)/);
			const fits = (size: number, withIcon: boolean) => Math.max(...words.map((word) => textWidth(word, size))) <= width - LABEL_CHROME_NARROW - (experimental ? 9 : 0) + (withIcon ? 0 : LABEL_ICON);
			if (width < LABEL_WIDE || !fits(LABEL_FONT, icon)) font = LABEL_FONT_NARROW;
			if (!fits(font, icon)) {
				icon = false;
				if (!fits(font, false)) {
					narrow = false;
					short = true;
				}
			}
		}
		const { x, y } = node.internals.positionAbsolute;
		const header = headerBottom(node.id) * zoom;
		const height = Math.max(header, narrow ? (font === LABEL_FONT ? LABEL_MIN_HEIGHT_TWO_LINES + 3 : LABEL_MIN_HEIGHT_TWO_LINES) : LABEL_MIN_HEIGHT);
		// Inside the frame: a label wider than its node must not be cut by the edge.
		const left = Math.max(2, Math.min(x * zoom + tx - toLeft, frameWidth - width - 2));
		// A label taller than a node at the bottom of the frame moves up to stay inside it.
		const nodeTop = y * zoom + ty;
		const top = nodeTop < frameHeight ? Math.min(nodeTop, frameHeight - height - 2) : nodeTop;
		const box = { left, top, right: left + width, bottom: top + height };
		if (placed.some((p) => box.left < p.right && p.left < box.right && box.top < p.bottom && p.top < box.bottom)) continue;
		placed.push(box);
		labels.push(
			<div key={node.id} className={narrow ? 'rr-overview-label rr-overview-narrow' : short ? 'rr-overview-label rr-overview-short' : 'rr-overview-label'} style={{ left, top, width, height, fontSize: short ? LABEL_FONT_NARROW : font }}>
				{icon && service?.icon && <Icon name={service.icon} width="12" height="12" className="rr-overview-icon" />}
				<span className="rr-overview-title">{title}</span>
				{experimental && <i className="rr-overview-badge" title="Experimental" />}
			</div>
		);
	}
	// When no label fits, the hint under the drawing says how to read the names.
	const cue = ordered.length > 0 && labels.length === 0;
	useEffect(() => onCue(cue), [cue, onCue]);
	if (!labels.length) return null;
	return (
		<div className="rr-overview" aria-hidden="true">
			{labels}
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
		setNodes((current) => placeNodes(current as never, model.edges, false, sizeOf, { width: frameWidth, height: active ? frameHeight : CANVAS_MAX_HEIGHT }) as unknown as FlowNode[]);
		setPlacement((n) => n + 1);
	}, [initialized, model.edges, getInternalNode, setNodes, frameWidth, frameHeight, active]);

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
	const mode = useRef<{ active: boolean; inlineView: Viewport | null; inlineMoved: boolean }>({ active: false, inlineView: null, inlineMoved: false });
	useEffect(() => {
		if (!ready || !frameWidth || !frameHeight) return;
		const state = mode.current;
		const leaving = !active && state.active;
		if (active && !state.active) {
			state.inlineView = getViewport();
			state.inlineMoved = moved.current;
			moved.current = false;
		} else if (leaving) {
			moved.current = state.inlineMoved;
		}
		state.active = active;
		const frame = requestAnimationFrame(() => {
			if (moved.current && !leaving) return;
			if (leaving && state.inlineMoved && state.inlineView) {
				setViewport(state.inlineView);
				return;
			}
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
				// A phone-width frame fits the whole drawing (the labels keep it readable); a wider one
				// opens at a reading zoom when the fit would draw nodes too small.
				if (frameWidth >= NARROW_FRAME && fitZoom * typical < FULL_FIT_MIN_NODE_WIDTH) {
					const zoom = Math.min(1.25, FULL_READ_NODE_WIDTH / typical);
					setViewport({ x: 24 - all.x * zoom, y: 24 - all.y * zoom, zoom });
					return;
				}
			}
			fitAll();
		});
		return () => cancelAnimationFrame(frame);
	}, [ready, frameWidth, frameHeight, active, placement, fitAll, getNodes, getNodesBounds, getInternalNode, getViewport, setViewport, moved]);

	// A connection that cannot avoid crossing a node (a long flow wrapped in a
	// narrow frame) is drawn over it, not hidden behind it, so it never looks
	// like it ends there.
	const edges = useMemo(() => {
		if (!initialized) return model.edges;
		const positions: Record<string, { x: number; y: number }> = {};
		const sizes: Record<string, { width: number; height: number }> = {};
		for (const node of nodes) {
			const internal = getInternalNode(node.id);
			if (node.type !== INodeType.Default || !internal?.measured?.width || !internal.measured.height) continue;
			positions[node.id] = internal.internals.positionAbsolute;
			sizes[node.id] = { width: internal.measured.width, height: internal.measured.height };
		}
		const sizeOf = (id: string) => sizes[id];
		return model.edges.map((edge) => {
			const control = !!edge.sourceHandle?.startsWith('invoke-source');
			return edgesThroughNodes(positions, [{ source: edge.source, target: edge.target, control }], sizeOf) ? { ...edge, zIndex: 1 } : edge;
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

function Header({ summary, count, shown, missing, tools }: { summary: GraphModel['summary']; count: number; shown: number; missing: string[]; tools?: ReactElement }): ReactElement {
	const file = displayPath(summary.path, summary.workspace);
	const stem = file.replace(/^.*\//, '').replace(/\.pipe(\.json)?$/, '');
	const name = summary.name || stem || 'Pipeline';
	// A pipeline without its own name is titled by its file name; the file is then shown only when it adds a folder.
	const showFile = !!file && (summary.name ? summary.name !== stem : file !== `${stem}.pipe` && file !== `${stem}.pipe.json`);
	return (
		<div className="rr-canvas-head">
			<div className="rr-canvas-heading">
				<div className="rr-canvas-title">
					<span className="rr-canvas-name" title={name}>
						{name}
					</span>
					<span className="rr-canvas-pill">Read only</span>
				</div>
				<div className="rr-canvas-meta">
					<span className="rr-canvas-count">
						{count} {count === 1 ? 'node' : 'nodes'}
					</span>
					{showFile && (
						<span className="rr-canvas-path" title={file}>
							{file}
						</span>
					)}
				</div>
				{summary.description && (
					<div className="rr-canvas-description" title={summary.description}>
						{summary.description}
					</div>
				)}
			</div>
			{(summary.truncated || missing.length > 0) && (
				<div className="rr-canvas-notes" role="status">
					{summary.truncated && (
						<div>
							Showing the first {shown} of {count} nodes. The builder shows all of it.
						</div>
					)}
					{missing.length > 0 && <div>{missing.length === 1 ? `${missing[0]} isn't installed on this engine, so it is drawn with a plain icon.` : `${missing.join(', ')} aren't installed on this engine, so they are drawn with a plain icon.`}</div>}
				</div>
			)}
			{tools}
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
	const headRef = useRef<HTMLDivElement>(null);
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

	const headBottom = headRef.current?.getBoundingClientRect().bottom ?? 90;
	const inlineMax = model.summary.truncated ? TRUNCATED_MAX_HEIGHT : width && width < NARROW_FRAME ? NARROW_MAX_HEIGHT : CANVAS_MAX_HEIGHT;
	// Full screen leaves room under the drawing for the hint (up to two lines) and the host's safe area.
	const height = active ? Math.max(CANVAS_MIN_HEIGHT, viewportHeight - headBottom - 56 - host.safeBottom) : width ? inlineHeight(width, bounds, inlineMax) : CANVAS_MIN_HEIGHT;
	const [cueNeeded, setCueNeeded] = useState(false);
	const cue = host.canFullScreen ? (coarse ? 'Tap to expand and read the names.' : 'Expand or zoom in to read the names.') : 'Zoom in to read the names.';
	// On a touch screen a tap on the inline canvas opens full screen, where every gesture works.
	const onTap = () => {
		if (coarse && !active && host.canFullScreen) host.request('fullscreen');
	};

	const hint = active ? (coarse ? 'Drag to move, pinch to zoom.' : 'Drag or scroll to move. Pinch or Ctrl + scroll zooms. Esc closes.') : coarse ? (host.canFullScreen ? 'Tap to expand. Two fingers move or zoom here.' : 'Two fingers move or zoom.') : 'Drag to move. Pinch or Ctrl + scroll to zoom.';
	// On a phone the drawing is small: one line says what the pipeline does.
	const flowLine = useMemo(() => mainFlow(model.summary), [model.summary]);

	return (
		<div className={`rr-canvas${active ? ' rr-canvas-full' : ''}${coarse ? ' rr-canvas-coarse' : ''}`}>
			<div ref={headRef}>
				<Header summary={model.summary} count={model.summary.node_count ?? model.nodes.length} shown={model.summary.nodes?.length ?? model.nodes.length} missing={model.missingProviders} tools={<Toolbar host={host} moved={moved} coarse={coarse} />} />
			</div>
			<div ref={boxRef} className="rr-canvas-frame" style={{ height }} tabIndex={0} role="region" aria-label={`Read-only diagram of ${model.summary.name || 'the pipeline'}. Arrow keys move it, plus and minus zoom.`} aria-describedby="rr-canvas-text" onKeyDown={onKeyDown} onClick={onTap}>
				{width > 0 && <Flow model={model} host={host} moved={moved} onBounds={onBounds} onCue={setCueNeeded} />}
			</div>
			<div className="rr-canvas-howto">{cueNeeded && !active ? `${cue} ${hint}` : hint}</div>
			{flowLine && <div className="rr-canvas-flow">{flowLine}</div>}
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
				<Header summary={model.summary} count={0} shown={0} missing={[]} />
				<div className="rr-card rr-canvas-empty" role="status">
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
