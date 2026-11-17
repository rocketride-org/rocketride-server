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
import { Background, MiniMap, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, useStore, type NodeChange, type Viewport } from '@xyflow/react';
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
import { ESTIMATED_NODE_SIZE, displayPath, placeNodes, type CanvasModel } from './model';

/**
 * Canvas height bounds, in px. The height follows the drawing's shape inside
 * these bounds, always as a pixel value: host auto-resize measures the
 * document, and a % or vh height would collapse the widget.
 */
export const CANVAS_MAX_HEIGHT = 560;
export const CANVAS_MIN_HEIGHT = 200;

/** Below this zoom the builder's node titles are too small to read, so larger labels are drawn over them. */
export const OVERVIEW_ZOOM = 0.9;
/** A node narrower than this on screen gets no label: the label could not hold its icon. */
const LABEL_MIN_WIDTH = 40;
/** Below this on-screen width a label uses a smaller font. */
const LABEL_WIDE = 90;
/** Height of the builder's top cap and header row at zoom 1, used until the header is measured. */
const NODE_HEADER_HEIGHT = 46;
/** The smallest label height, in px. */
const LABEL_MIN_HEIGHT = 20;
/** The inline canvas of a truncated pipeline stays short: 200 thumbnails are an overview, not a read. */
const TRUNCATED_MAX_HEIGHT = 320;

const FIT_PADDING = 0.04;
const FIT_VIEW_OPTIONS = { padding: FIT_PADDING, maxZoom: 1.25 };
const PRO_OPTIONS = { hideAttribution: true };
const PAN_STEP = 80;

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
	const wanted = (inner * bounds.height) / bounds.width + width * 2 * FIT_PADDING;
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
			app?.requestDisplayMode({ mode })
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

function Toolbar({ host, moved }: { host: HostView; moved: MutableRefObject<boolean> }): ReactElement {
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	const active = host.mode === 'fullscreen';
	return (
		<div className="rr-canvas-tools" role="toolbar" aria-label="View">
			<ToolButton
				label="Zoom out"
				icon={ZOOM_OUT_ICON}
				onClick={() => {
					moved.current = true;
					zoomOut({ duration: 150 });
				}}
			/>
			<ToolButton
				label="Zoom in"
				icon={ZOOM_IN_ICON}
				onClick={() => {
					moved.current = true;
					zoomIn({ duration: 150 });
				}}
			/>
			<ToolButton
				label="Fit to view"
				icon={FIT_ICON}
				onClick={() => {
					moved.current = false;
					fitView({ ...FIT_VIEW_OPTIONS, duration: 200 });
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

/**
 * Larger titles over the builder's node headers when the drawing is zoomed
 * out too far to read them, in the spirit of React Flow's contextual zoom.
 * Each label sits on the header of its node (same width, the header's
 * colours and font), icon first, so the node keeps its shape and its lanes
 * and only the title grows. When the header is shorter on screen than the
 * label, the label grows upward from the header's bottom edge, so the lanes
 * stay clear. When even the icon would not fit, a cue says how to read the
 * names. Labels ignore the pointer.
 */
function OverviewLabels({ services, cue }: { services: IServiceCatalog; cue: string }): ReactElement | null {
	const [tx, ty, zoom] = useStore((s) => s.transform);
	const nodeLookup = useStore((s) => s.nodeLookup);
	if (zoom >= OVERVIEW_ZOOM) return null;
	const labels: ReactElement[] = [];
	let nodes = 0;
	for (const node of nodeLookup.values()) {
		if (node.type !== INodeType.Default || !node.measured?.width) continue;
		nodes += 1;
		const width = node.measured.width * zoom;
		if (width < LABEL_MIN_WIDTH) continue;
		const data = node.data as INodeData;
		const service = services[data.provider] as { title?: string; icon?: string } | undefined;
		const title = data.name || service?.title || data.provider;
		const { x, y } = node.internals.positionAbsolute;
		const narrow = width < LABEL_WIDE;
		const header = headerBottom(node.id) * zoom;
		const height = Math.max(header, LABEL_MIN_HEIGHT);
		labels.push(
			<div key={node.id} className={narrow ? 'rr-overview-label rr-overview-narrow' : 'rr-overview-label'} style={{ left: x * zoom + tx, top: y * zoom + ty + header - height, width, height }}>
				{service?.icon && <Icon name={service.icon} width="14" height="14" className="rr-overview-icon" />}
				<span>{title}</span>
			</div>
		);
	}
	return (
		<div className="rr-overview" aria-hidden="true">
			{labels}
			{nodes > 0 && labels.length === 0 && <div className="rr-overview-cue">{cue}</div>}
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
	if (whole) return null;
	return <MiniMap pannable zoomable position="bottom-right" nodeClassName="rr-minimap-node" ariaLabel="Overview of the whole pipeline" style={{ marginBottom: 16 + safeBottom }} />;
}

function Flow({ model, host, moved, onBounds, cue }: { model: GraphModel; host: HostView; moved: MutableRefObject<boolean>; onBounds: (bounds: Bounds) => void; cue: string }): ReactElement {
	const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(model.nodes as unknown as FlowNode[]);
	const initialized = useNodesInitialized();
	const { fitView, getInternalNode, getNodesBounds, setViewport, getViewport, getNodes } = useReactFlow();
	const frameWidth = useStore((s) => s.width);
	const frameHeight = useStore((s) => s.height);
	const active = host.mode === 'fullscreen';
	const placed = useRef(!model.laidOut);
	const [ready, setReady] = useState(false);

	// A pipeline saved without positions was placed with estimated sizes.
	// Once the browser has measured every node, place it again with the real
	// sizes and the real frame, so nothing overlaps and a long flow wraps to
	// suit the frame.
	useEffect(() => {
		if (!initialized || placed.current || !frameWidth) return;
		placed.current = true;
		const sizeOf = (id: string) => {
			const measured = getInternalNode(id)?.measured;
			return { width: measured?.width ?? ESTIMATED_NODE_SIZE.width, height: measured?.height ?? ESTIMATED_NODE_SIZE.height };
		};
		setNodes((current) => placeNodes(current as never, model.edges, false, sizeOf, { width: frameWidth, height: CANVAS_MAX_HEIGHT }) as unknown as FlowNode[]);
	}, [initialized, model.edges, getInternalNode, setNodes, frameWidth]);

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
				const all = getNodesBounds(getNodes());
				const fitZoom = Math.min(frameWidth / all.width, frameHeight / all.height);
				if (fitZoom < 0.8) {
					const targets = new Set(model.edges.map((edge) => edge.target));
					const sources = getNodes().filter((node) => !node.parentId && !targets.has(node.id));
					const box = getNodesBounds(sources.length ? sources : getNodes());
					const zoom = Math.min(1, (frameHeight - 48) / Math.max(box.height, 1));
					setViewport({ x: 24 - box.x * zoom, y: frameHeight / 2 - (box.y + box.height / 2) * zoom, zoom });
					return;
				}
			}
			fitView(FIT_VIEW_OPTIONS);
		});
		return () => cancelAnimationFrame(frame);
	}, [ready, frameWidth, frameHeight, active, fitView, getNodes, getNodesBounds, getViewport, setViewport, model.edges, moved]);

	const project = useMemo(() => ({ components: [] }) as unknown as IProject, []);

	return (
		<ReadOnlyFlowPreferencesProvider>
			<ReadOnlyFlowProjectProvider project={project} servicesJson={model.services}>
				<ReadOnlyFlowGraphProvider nodes={nodes} edges={model.edges}>
					<ReactFlow
						nodes={nodes}
						edges={model.edges}
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
						<OverviewLabels services={model.services} cue={cue} />
						{active && <FullScreenMiniMap safeBottom={host.safeBottom} />}
					</ReactFlow>
				</ReadOnlyFlowGraphProvider>
			</ReadOnlyFlowProjectProvider>
		</ReadOnlyFlowPreferencesProvider>
	);
}

/** Keyboard on the focused frame: arrows pan, + and - zoom, 0 fits. Escape is handled once, on the window, in full screen. */
function useFrameKeys(moved: MutableRefObject<boolean>): (event: KeyboardEvent<HTMLDivElement>) => void {
	const { getViewport, setViewport, zoomIn, zoomOut, fitView } = useReactFlow();
	return (event) => {
		const step: Record<string, [number, number]> = { ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] };
		if (step[event.key]) {
			const { x, y, zoom } = getViewport();
			moved.current = true;
			setViewport({ x: x + step[event.key][0], y: y + step[event.key][1], zoom }, { duration: 100 });
		} else if (event.key === '+' || event.key === '=') {
			moved.current = true;
			zoomIn({ duration: 150 });
		} else if (event.key === '-') {
			moved.current = true;
			zoomOut({ duration: 150 });
		} else if (event.key === '0') {
			moved.current = false;
			fitView({ ...FIT_VIEW_OPTIONS, duration: 200 });
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
				{summary.description && <div className="rr-canvas-description">{summary.description}</div>}
			</div>
			{(summary.truncated || missing.length > 0) && (
				<div className="rr-canvas-notes" role="status">
					{summary.truncated && (
						<div>
							Showing the first {shown} of {count} nodes. The builder shows all of it.
						</div>
					)}
					{missing.length > 0 && (
						<div>
							{missing.length === 1 ? `${missing[0]} isn't installed on this engine, so it is drawn with a plain icon.` : `${missing.join(', ')} aren't installed on this engine, so they are drawn with a plain icon.`}
						</div>
					)}
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
	const inlineMax = model.summary.truncated ? TRUNCATED_MAX_HEIGHT : CANVAS_MAX_HEIGHT;
	const height = active ? Math.max(CANVAS_MIN_HEIGHT, viewportHeight - headBottom - 40 - host.safeBottom) : width ? inlineHeight(width, bounds, inlineMax) : CANVAS_MIN_HEIGHT;
	const cue = host.canFullScreen ? (coarse ? 'Tap to expand and read the names' : 'Expand or zoom in to read the names') : 'Zoom in to read the names';
	// On a touch screen a tap on the inline canvas opens full screen, where every gesture works.
	const onTap = () => {
		if (coarse && !active && host.canFullScreen) host.request('fullscreen');
	};

	const hint = active
		? coarse
			? 'Drag to move, pinch to zoom.'
			: 'Drag or scroll to move. Ctrl + scroll zooms. Esc closes.'
		: coarse
			? host.canFullScreen
				? 'Tap to expand. Two fingers move or zoom here.'
				: 'Use two fingers to move or zoom.'
			: 'Drag to move. Ctrl + scroll or double-click to zoom.';

	return (
		<div className={`rr-canvas${active ? ' rr-canvas-full' : ''}${coarse ? ' rr-canvas-coarse' : ''}`}>
			<div ref={headRef}>
				<Header
					summary={model.summary}
					count={model.summary.node_count ?? model.nodes.length}
					shown={model.summary.nodes?.length ?? model.nodes.length}
					missing={model.missingProviders}
					tools={<Toolbar host={host} moved={moved} />}
				/>
			</div>
			<div
				ref={boxRef}
				className="rr-canvas-frame"
				style={{ height }}
				tabIndex={0}
				role="region"
				aria-label={`Read-only diagram of ${model.summary.name || 'the pipeline'}. Arrow keys move it, plus and minus zoom.`}
				aria-describedby="rr-canvas-text"
				onKeyDown={onKeyDown}
				onClick={onTap}
			>
				{width > 0 && <Flow model={model} host={host} moved={moved} onBounds={onBounds} cue={cue} />}
			</div>
			<div className="rr-canvas-howto">{hint}</div>
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
					This pipeline has no nodes yet.
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
