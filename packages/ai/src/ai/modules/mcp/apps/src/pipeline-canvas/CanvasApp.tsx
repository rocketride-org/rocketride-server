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
import { useEffect, useMemo, useRef, type CSSProperties, type ReactElement } from 'react';
import { Background, Controls, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, type Node, type NodeChange } from '@xyflow/react';
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
import { placeNodes, type CanvasModel } from './model';

/** Fixed canvas height, in px: iframe auto-resize collapses % and vh heights. */
export const CANVAS_HEIGHT = 420;

const FIT_VIEW_OPTIONS = { padding: 0.12, maxZoom: 1.25 };
const PRO_OPTIONS = { hideAttribution: true };

/**
 * The builder's node header shows an edit gear when it is told the node's
 * type. A read-only canvas has no config panel, so the default node is
 * registered without its type and the gear is never drawn.
 */
function ReadOnlyNode(props: { id: string; data: INodeData; selected?: boolean; parentId?: string }): ReactElement {
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

const S: Record<string, CSSProperties> = {
	canvas: {
		position: 'relative',
		height: CANVAS_HEIGHT,
		borderRadius: 10,
		overflow: 'hidden',
		border: '1px solid var(--rr-line)',
		background: 'var(--rr-bg-default)',
	},
};

type GraphModel = Extract<CanvasModel, { kind: 'graph' }>;

/** Applies only the size React Flow measures; nothing else can change. */
function onlyDimensions(changes: NodeChange<FlowNode>[]): NodeChange<FlowNode>[] {
	return changes.filter((change) => change.type === 'dimensions');
}

function Flow({ model }: { model: GraphModel }): ReactElement {
	const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(model.nodes as unknown as FlowNode[]);
	const initialized = useNodesInitialized();
	const { fitView, getNodes } = useReactFlow();
	const relaidOut = useRef(false);

	// A pipeline saved without positions was placed with estimated sizes.
	// Once the browser has measured every node, place it again with the real
	// sizes, so tall nodes never overlap, then fit the view.
	useEffect(() => {
		if (!initialized) return;
		if (model.laidOut && !relaidOut.current) {
			relaidOut.current = true;
			const sizes = new Map(getNodes().map((node: Node) => [node.id, { width: node.measured?.width ?? 180, height: node.measured?.height ?? 90 }]));
			setNodes((current) => placeNodes(current as never, model.edges, false, (id) => sizes.get(id)!) as unknown as FlowNode[]);
		}
		requestAnimationFrame(() => fitView(FIT_VIEW_OPTIONS));
	}, [initialized, model, getNodes, setNodes, fitView]);

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
						<Controls showInteractive={false} fitViewOptions={FIT_VIEW_OPTIONS} position="bottom-right" />
					</ReactFlow>
				</ReadOnlyFlowGraphProvider>
			</ReadOnlyFlowProjectProvider>
		</ReadOnlyFlowPreferencesProvider>
	);
}

function Header({ model }: { model: GraphModel }): ReactElement {
	const { summary } = model;
	const count = summary.node_count ?? model.nodes.length;
	const shown = summary.nodes?.length ?? model.nodes.length;
	return (
		<div className="rr-canvas-head">
			<div className="rr-canvas-title">
				<span className="rr-canvas-name">{summary.name || summary.path?.split('/').pop() || 'Pipeline'}</span>
				<span className="rr-canvas-pill">Read only</span>
			</div>
			<div className="rr-canvas-meta">
				<span>
					{count} {count === 1 ? 'node' : 'nodes'}
				</span>
				{summary.path && <span className="rr-canvas-path">{summary.path}</span>}
			</div>
			{summary.truncated && <div className="rr-canvas-note">Showing the first {shown} of {count} nodes.</div>}
		</div>
	);
}

/** One tool result, drawn. Remounted for every result (see main.tsx). */
export function CanvasApp({ model }: { model: CanvasModel }): ReactElement {
	useMemo(() => {
		if (model.kind === 'graph') registerServiceIcons({ services: model.services as never, icons: model.icons });
	}, [model]);

	if (model.kind === 'error') {
		return (
			<div className="rr-card rr-canvas-error" role="alert">
				<div>{model.message}</div>
				{model.hint && <div className="rr-canvas-hint">{model.hint}</div>}
			</div>
		);
	}
	if (model.kind === 'empty') {
		return <div className="rr-card empty">This pipeline has no nodes yet.</div>;
	}
	return (
		<div className="rr-canvas">
			<Header model={model} />
			<div style={S.canvas}>
				<ReactFlowProvider>
					<Flow model={model} />
				</ReactFlowProvider>
			</div>
		</div>
	);
}
