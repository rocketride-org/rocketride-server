/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 *
 * Read-only stand-in for the builder's FlowGraphContext (see resolve.ts).
 * It holds the nodes and edges the widget draws. Every editing function is
 * a no-op, so nothing the reused node components call can change the graph.
 */
import { createContext, useContext, useMemo, useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import type { Edge } from '@xyflow/react';

import type { FlowNode, IFlowGraphContext, IQuickAddState } from '@app-shared/tools/pipelines/panels/design/canvas/context/FlowGraphContext';

export type { FlowNode, IFlowGraphContext, IQuickAddState };

const noop = (): void => undefined;

const FlowGraphContext = createContext<IFlowGraphContext | null>(null);

/** Builds the read-only context value for `nodes` and `edges`. */
export function readOnlyGraph(nodes: FlowNode[], edges: Edge[], canvasRef: RefObject<HTMLDivElement>): IFlowGraphContext {
	return {
		canvasRef,
		nodes,
		edges,
		nodeMap: Object.fromEntries(nodes.map((node) => [node.id, node])),
		setNodes: noop,
		setEdges: noop,
		onNodesChange: noop,
		onEdgesChange: noop,
		onEdgeConnect: noop,
		isValidConnection: () => false,
		onDragOver: noop,
		onDrop: noop,
		onNodeDragStop: noop,
		addNode: () => '',
		updateNode: () => undefined,
		deleteNode: noop,
		onNodesDelete: noop,
		tempNode: undefined,
		setTempNode: noop,
		focusOnNode: noop,
		editingNodeId: undefined,
		setEditingNodeId: noop,
		onContentUpdated: noop,
		quickAddState: null,
		setQuickAddState: noop,
		loadData: () => 0,
		loadCanvas: noop,
		isFlowReady: true,
		configSnackbar: null,
		setConfigSnackbar: noop,
	};
}

/** Provides the read-only graph to the reused node and edge components. */
export function ReadOnlyFlowGraphProvider({ nodes, edges, children }: { nodes: FlowNode[]; edges: Edge[]; children: ReactNode }): ReactElement {
	const canvasRef = useRef<HTMLDivElement>(null);
	const value = useMemo(() => readOnlyGraph(nodes, edges, canvasRef), [nodes, edges]);
	return <FlowGraphContext.Provider value={value}>{children}</FlowGraphContext.Provider>;
}

/** Same contract as the builder's hook: throws outside the provider. */
export function useFlowGraph(): IFlowGraphContext {
	const ctx = useContext(FlowGraphContext);
	if (!ctx) throw new Error('useFlowGraph must be used within ReadOnlyFlowGraphProvider');
	return ctx;
}
