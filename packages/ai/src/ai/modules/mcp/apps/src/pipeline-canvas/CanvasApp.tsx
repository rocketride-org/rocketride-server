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
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Background, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, type NodeChange } from '@xyflow/react';
import type { App } from '@modelcontextprotocol/ext-apps';
import '@xyflow/react/dist/style.css';

import '@app-shared/tools/pipelines/panels/design/canvas/components/reactflow-overrides.css';
import NodeComponent from '@app-shared/tools/pipelines/panels/design/canvas/components/node/node-component/NodeComponent';
import NodeGroup from '@app-shared/tools/pipelines/panels/design/canvas/components/node/node-group/NodeGroup';
import NodeAnnotation from '@app-shared/tools/pipelines/panels/design/canvas/components/node/node-annotation/NodeAnnotation';
import FlowEdge from '@app-shared/tools/pipelines/panels/design/canvas/components/edge/FlowEdge';
import { registerServiceIcons } from '@app-shared/tools/pipelines/panels/design/canvas/util/Icon';
import { INodeType, type IProject, type INodeData } from '@app-shared/tools/pipelines/panels/design/canvas/types';

import { ReadOnlyFlowGraphProvider, type FlowNode } from './stand-ins/FlowGraphContext';
import { ReadOnlyFlowProjectProvider } from './stand-ins/FlowProjectContext';
import { ReadOnlyFlowPreferencesProvider } from './stand-ins/FlowPreferencesContext';
import { ESTIMATED_NODE_SIZE, displayPath, placeNodes, type CanvasModel } from './model';

/**
 * Canvas height bounds, in px. The height follows the graph's shape inside
 * these bounds, always as a pixel value: host auto-resize measures the
 * document, and a % or vh height would collapse the widget.
 */
export const CANVAS_MAX_HEIGHT = 420;
export const CANVAS_MIN_HEIGHT = 260;

const FIT_PADDING = 0.08;
const FIT_VIEW_OPTIONS = { padding: FIT_PADDING, maxZoom: 1.25 };
const PRO_OPTIONS = { hideAttribution: true };

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

/** Applies only the size React Flow measures; nothing else can change. */
function onlyDimensions(changes: NodeChange<FlowNode>[]): NodeChange<FlowNode>[] {
	return changes.filter((change) => change.type === 'dimensions');
}

/** Width over height of the drawing, from node positions and sizes. */
function graphAspect(nodes: GraphModel['nodes']): number {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const node of nodes) {
		if (node.parentId) continue;
		const box = node as unknown as { width?: number; height?: number };
		const width = box.width ?? ESTIMATED_NODE_SIZE.width;
		const height = box.height ?? ESTIMATED_NODE_SIZE.height;
		minX = Math.min(minX, node.position.x);
		minY = Math.min(minY, node.position.y);
		maxX = Math.max(maxX, node.position.x + width);
		maxY = Math.max(maxY, node.position.y + height);
	}
	if (!Number.isFinite(minX)) return 1;
	return Math.max(maxX - minX, 1) / Math.max(maxY - minY, 1);
}

/** The canvas height that shows the whole graph at its fitted zoom without empty bands. */
function canvasHeight(width: number, aspect: number): number {
	const wanted = (width * (1 - 2 * FIT_PADDING)) / aspect + width * 2 * FIT_PADDING;
	return Math.round(Math.min(CANVAS_MAX_HEIGHT, Math.max(CANVAS_MIN_HEIGHT, wanted)));
}

interface FullScreen {
	/** True when the host offers full screen; the button shows only then. */
	available: boolean;
	active: boolean;
	toggle: () => void;
}

const EXPAND_ICON = 'M3 3h7v2H5v5H3V3zm11 0h7v7h-2V5h-5V3zM3 14h2v5h5v2H3v-7zm16 0h2v7h-7v-2h5v-5z';
const COLLAPSE_ICON = 'M8 3h2v7H3V8h5V3zm6 0h2v5h5v2h-7V3zM3 14h7v7H8v-5H3v-2zm11 0h7v2h-5v5h-2v-7z';

const ZOOM_IN_ICON = 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z';
const ZOOM_OUT_ICON = 'M5 11h14v2H5v-2z';
const FIT_ICON = 'M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4zM9 9h6v6H9V9z';

function ToolButton({ label, icon, onClick }: { label: string; icon: string; onClick: () => void }): ReactElement {
	return (
		<button type="button" className="rr-canvas-tool" onClick={onClick} title={label} aria-label={label}>
			<svg viewBox="0 0 24 24" aria-hidden="true">
				<path d={icon} />
			</svg>
		</button>
	);
}

/** Under the drawing, so it never covers a node: what the canvas allows, and the view buttons. */
function Toolbar({ fullScreen }: { fullScreen: FullScreen }): ReactElement {
	const { zoomIn, zoomOut, fitView } = useReactFlow();
	return (
		<div className="rr-canvas-bar">
			<span className="rr-canvas-howto">Drag to move, pinch to zoom.</span>
			<div className="rr-canvas-tools" role="toolbar" aria-label="View">
				<ToolButton label="Zoom out" icon={ZOOM_OUT_ICON} onClick={() => zoomOut({ duration: 150 })} />
				<ToolButton label="Zoom in" icon={ZOOM_IN_ICON} onClick={() => zoomIn({ duration: 150 })} />
				<ToolButton label="Fit to view" icon={FIT_ICON} onClick={() => fitView({ ...FIT_VIEW_OPTIONS, duration: 200 })} />
				{fullScreen.available && <ToolButton label={fullScreen.active ? 'Exit full screen' : 'Full screen'} icon={fullScreen.active ? COLLAPSE_ICON : EXPAND_ICON} onClick={fullScreen.toggle} />}
			</div>
		</div>
	);
}

function Flow({ model, fullScreen }: { model: GraphModel; fullScreen: FullScreen }): ReactElement {
	const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(model.nodes as unknown as FlowNode[]);
	const initialized = useNodesInitialized();
	const { fitView, getInternalNode } = useReactFlow();
	const relaidOut = useRef(false);
	const fitted = useRef(false);

	// A pipeline saved without positions was placed with estimated sizes.
	// Once the browser has measured every node, place it again with the real
	// sizes, so tall nodes never overlap.
	useEffect(() => {
		if (!initialized || !model.laidOut || relaidOut.current) return;
		relaidOut.current = true;
		const sizeOf = (id: string) => {
			const measured = getInternalNode(id)?.measured;
			return { width: measured?.width ?? ESTIMATED_NODE_SIZE.width, height: measured?.height ?? ESTIMATED_NODE_SIZE.height };
		};
		setNodes((current) => placeNodes(current as never, model.edges, false, sizeOf) as unknown as FlowNode[]);
	}, [initialized, model, getInternalNode, setNodes]);

	// Fit the whole graph once, after the final placement. Later changes
	// never move the view the user has panned or zoomed.
	useEffect(() => {
		if (!initialized || fitted.current || (model.laidOut && !relaidOut.current)) return;
		fitted.current = true;
		requestAnimationFrame(() => fitView(FIT_VIEW_OPTIONS));
	}, [initialized, nodes, model.laidOut, fitView]);

	// Entering or leaving full screen changes the canvas size: fit again.
	const firstMode = useRef(true);
	useEffect(() => {
		if (firstMode.current) {
			firstMode.current = false;
			return;
		}
		const timer = window.setTimeout(() => fitView(FIT_VIEW_OPTIONS), 150);
		return () => window.clearTimeout(timer);
	}, [fullScreen.active, fitView]);

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
						nodesDraggable={false}
						nodesConnectable={false}
						nodesFocusable={false}
						edgesFocusable={false}
						elementsSelectable={false}
						deleteKeyCode={null}
						selectionKeyCode={null}
						multiSelectionKeyCode={null}
						// Wheel and two-finger scroll keep scrolling the chat; pinch,
						// the zoom buttons and double-click zoom the canvas.
						zoomOnScroll={false}
						panOnScroll={false}
						preventScrolling={false}
						zoomOnPinch
						panOnDrag
						minZoom={0.1}
						maxZoom={2}
						fitView
						fitViewOptions={FIT_VIEW_OPTIONS}
						proOptions={PRO_OPTIONS}
					>
						<Background color="var(--rr-text-disabled)" gap={20} style={{ backgroundColor: 'var(--rr-bg-default)' }} />
					</ReactFlow>
				</ReadOnlyFlowGraphProvider>
			</ReadOnlyFlowProjectProvider>
		</ReadOnlyFlowPreferencesProvider>
	);
}

function Header({ summary, count, shown }: { summary: GraphModel['summary']; count: number; shown: number }): ReactElement {
	const file = displayPath(summary.path, summary.workspace);
	return (
		<div className="rr-canvas-head">
			<div className="rr-canvas-title">
				<span className="rr-canvas-name">{summary.name || file || 'Pipeline'}</span>
				<span className="rr-canvas-pill">Read only</span>
			</div>
			<div className="rr-canvas-meta">
				<span className="rr-canvas-count">
					{count} {count === 1 ? 'node' : 'nodes'}
				</span>
				{file && (
					<span className="rr-canvas-path" title={summary.path}>
						{file}
					</span>
				)}
			</div>
			{summary.truncated && (
				<div className="rr-canvas-note" role="status">
					Showing the first {shown} of {count} nodes.
				</div>
			)}
		</div>
	);
}

type DisplayMode = 'inline' | 'fullscreen' | 'pip';

/** The host's display mode and whether it offers full screen, kept current. */
function useDisplayMode(app?: App): { mode: DisplayMode; canFullScreen: boolean; request: (mode: DisplayMode) => void } {
	const read = useCallback(() => {
		const context = app?.getHostContext();
		return {
			mode: (context?.displayMode as DisplayMode | undefined) ?? 'inline',
			canFullScreen: !!context?.availableDisplayModes?.includes('fullscreen'),
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
	return { ...state, request };
}

/** One tool result, drawn. Remounted for every result (see main.tsx). */
export function CanvasApp({ model, app }: { model: CanvasModel; app?: App }): ReactElement {
	useMemo(() => {
		if (model.kind === 'graph') registerServiceIcons({ services: model.services as never, icons: model.icons });
	}, [model]);

	const boxRef = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!box) return;
		setWidth(box.clientWidth);
		const observer = new ResizeObserver(() => setWidth(box.clientWidth));
		observer.observe(box);
		return () => observer.disconnect();
	}, [model.kind]);

	const aspect = useMemo(() => (model.kind === 'graph' ? graphAspect(model.nodes) : 1), [model]);

	const display = useDisplayMode(app);
	const active = display.mode === 'fullscreen';
	const fullScreen: FullScreen = useMemo(
		() => ({ available: display.canFullScreen, active, toggle: () => display.request(active ? 'inline' : 'fullscreen') }),
		[display, active]
	);
	// In full screen the host sizes the frame, so the canvas fills the window below the header.
	const headRef = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState(() => window.innerHeight);
	useEffect(() => {
		if (!active) return;
		const onResize = () => setViewport(window.innerHeight);
		onResize();
		window.addEventListener('resize', onResize);
		return () => window.removeEventListener('resize', onResize);
	}, [active]);

	if (model.kind === 'error') {
		return (
			<div className="rr-card rr-canvas-error" role="alert">
				<div className="rr-canvas-error-message">{model.message}</div>
				{model.hint && <div className="rr-canvas-hint">{model.hint}</div>}
			</div>
		);
	}
	if (model.kind === 'empty') {
		return (
			<div className="rr-canvas">
				<Header summary={model.summary} count={0} shown={0} />
				<div className="rr-card rr-canvas-empty" role="status">
					This pipeline has no nodes yet.
				</div>
			</div>
		);
	}
	const inlineHeight = width ? canvasHeight(width, aspect) : CANVAS_MAX_HEIGHT;
	// Leave room for the toolbar (40 px) and the page margin under the drawing.
	const fullHeight = Math.max(CANVAS_MIN_HEIGHT, viewport - (headRef.current?.getBoundingClientRect().bottom ?? 120) - 64);
	return (
		<div className={active ? 'rr-canvas rr-canvas-full' : 'rr-canvas'}>
			<div ref={headRef}>
				<Header summary={model.summary} count={model.summary.node_count ?? model.nodes.length} shown={model.summary.nodes?.length ?? model.nodes.length} />
			</div>
			<ReactFlowProvider>
				<div ref={boxRef} className="rr-canvas-frame" style={{ height: active ? fullHeight : inlineHeight }} aria-label={`Read-only diagram of ${model.summary.name || 'the pipeline'}`} role="region">
					{width > 0 && <Flow model={model} fullScreen={fullScreen} />}
				</div>
				<Toolbar fullScreen={fullScreen} />
			</ReactFlowProvider>
		</div>
	);
}
