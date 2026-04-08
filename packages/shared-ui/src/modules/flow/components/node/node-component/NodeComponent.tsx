// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// =============================================================================

/**
 * NodeComponent — Renders a service-catalog-based pipeline node on the canvas.
 *
 * This is the top-level component that all concrete node types (LLM, Database,
 * Filter, etc.) delegate to for their shared visual structure. It assembles
 * the node from six sub-components, rendered top to bottom:
 *
 *   1. {@link NodeTop}    — Invoke target diamond handles (above the node border)
 *   2. {@link NodeHeader} — Icon, title, class type subtitle, gear, overflow menu
 *   3. {@link NodeLanes}  — Input/output data-lane handles with inside-line curves
 *   4. {@link NodeStatus} — Pipeline execution status (only during active runs)
 *   5. {@link NodeTools}  — Invoke source type labels (LLM, Memory, Tool)
 *   6. {@link NodeBottom} — Bottom corner cap + invoke source diamond handles
 *
 * The bottom corner cap's background color is computed from section visibility
 * flags so it always matches the last visible section above it:
 *
 *   - Start with header color (background.paper)
 *   - If lanes are visible → switch to lane color (background.default)
 *   - If status is visible → switch back to header color (background.paper)
 *   - If invoke sources exist → stay on header color (background.paper)
 *
 * Service metadata (icon, lanes, classType, invoke config) is looked up at
 * render time from the service catalog via `node.data.provider` — not stored
 * on the node itself.
 */

import React, { ReactElement, useMemo } from 'react';
import { Edge, Position } from '@xyflow/react';

import { useFlow } from '../../../hooks';
import { useFlowGraph } from '../../../context/FlowGraphContext';
import { useFlowProject } from '../../../context/FlowProjectContext';
import { getIconPath } from '../../../util/get-icon-path';
import ConditionalRender from '../../ConditionalRender';
import { INodeData, IService, IServiceCatalog, IServiceLane, INodeLayout, IServiceCapabilities, ITaskState } from '../../../types';

import NodeTop from './top';
import NodeHeader from './header';
import NodeLanes from './lanes';
import NodeStatus from './status';
import RunButton from './run-button';
import { InvokeHandle } from '../../handles';

// =============================================================================
// Props
// =============================================================================

/**
 * Props for the Node orchestrator component.
 *
 * ReactFlow passes these as flat props to registered node type components.
 * Service metadata (icon, lanes, classType, invoke config) is looked up
 * at render time from the service catalog via `data.provider`.
 */
interface INodeProps {
	/** Unique node ID assigned by ReactFlow. */
	id: string;

	/** Strongly-typed node data containing provider, config, connections. */
	data: INodeData;

	/** Node type discriminator (e.g. NodeType.Default). */
	type?: string;

	/** Whether this node is currently selected on the canvas. */
	selected?: boolean;

	/** ID of the parent group node, if this node belongs to a group. */
	parentId?: string;

	/** Additional content rendered inside the header area. */
	children?: ReactElement;

	/** Lane layout direction; defaults to 'horizontal'. */
	layout?: INodeLayout;

	/** Optional click handler forwarded to the node header. */
	handleClick?: () => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders a complete pipeline node on the canvas.
 *
 * Receives flat props from ReactFlow and looks up service metadata
 * (icon, lanes, classType, invoke config) from the service catalog
 * at render time via `data.provider`.
 */
export default function NodeComponent({ id, data, type, parentId, children, layout = 'horizontal', handleClick }: INodeProps): ReactElement {
	// Pull shared canvas state from the flow context
	const { nodes, taskStatuses, componentPipeCounts, totalPipes, servicesJson, edges } = useFlow();
	const { setQuickAddState } = useFlowGraph();
	const { onOpenStatus, onOpenLink, serverHost } = useFlowProject();

	// =========================================================================
	// Service lookup — all service metadata comes from here, not from data
	// =========================================================================

	const catalog = useMemo(() => (servicesJson ?? {}) as IServiceCatalog, [servicesJson]);

	/** The service definition for this node's provider. */
	const service: IService | undefined = catalog[data.provider];

	// Service-derived fields
	const icon = getIconPath(service?.icon);
	const classType = service?.classType;
	const lanes = service?.lanes as Record<string, IServiceLane> | undefined;
	const capabilities = service?.capabilities ?? 0;
	const documentation = service?.documentation;
	const invokeConfig = service?.invoke;

	// =========================================================================
	// Display info — user-entered name/description falls back to service title
	// =========================================================================

	const displayTitle = data.name || service?.title;
	const displayDescription = data.description || service?.description;

	// =========================================================================
	// Invoke logic
	// =========================================================================

	/** Whether this node can be invoked by other nodes (shows a diamond target handle on top). */
	const isInvocable = (IServiceCapabilities.Invoke & capabilities) === IServiceCapabilities.Invoke;

	/** Whether this node's service is flagged as experimental. */
	const isExperimental = (IServiceCapabilities.Experimental & capabilities) === IServiceCapabilities.Experimental;

	/** Keys of invoke channels this node can source (e.g. ["llm", "memory", "tool"]). */
	const invokeSourceKeys = useMemo(() => Object.keys(invokeConfig ?? {}), [invokeConfig]);

	/** True when at least one crewai sub-agent is connected — tools are unused in hierarchical mode. */
	const hasCrewaiConnection = useMemo(() => edges.some((e) => e.source === id && e.sourceHandle === 'invoke-source.crewai'), [edges, id]);

	/** True when this node is connected via the 'tool' channel to a parent running in hierarchical (crewai) mode. */
	const isInactiveInHierarchical = useMemo(() => {
		const parentIds = edges.filter((e) => e.target === id && e.sourceHandle === 'invoke-source.tool').map((e) => e.source);
		return parentIds.some((parentId) => edges.some((e) => e.source === parentId && e.sourceHandle === 'invoke-source.crewai'));
	}, [edges, id]);

	/** Whether this node has any invoke source channels. */
	const hasInvokeSource = invokeSourceKeys.length > 0;

	// =========================================================================
	// Parent group resolution
	// =========================================================================

	/** Resolved parent ID from the live node list (may differ from prop during moves). */
	const mostRecentParentId = useMemo(() => {
		if (!parentId) return parentId;
		const thisNode = nodes.find((n) => n.id === id);
		return thisNode?.parentId;
	}, [nodes, parentId, id]);

	// =========================================================================
	// Runtime status
	// =========================================================================

	/** Whether this is a source node (has a Run button). */
	const isSourceNode = classType?.includes('source') || false;

	/** Task status for this node from DAP events. */
	const taskStatus = taskStatuses?.[id];

	/** Error count for the source node badge (from failedCount or errors array). */
	const errorCount = useMemo(() => {
		if (!isSourceNode || !taskStatus) return 0;
		return Math.max(taskStatus.failedCount || 0, taskStatus.errors?.length || 0);
	}, [isSourceNode, taskStatus]);

	/** Warning count for the source node badge. */
	const warningCount = useMemo(() => {
		if (!isSourceNode || !taskStatus) return 0;
		return taskStatus.warnings?.length || 0;
	}, [isSourceNode, taskStatus]);

	// =========================================================================
	// Section visibility flags — drive the bottom cap background color
	// =========================================================================

	/** Any lane key (including _ prefixed hidden lanes) means lanes render. */
	const hasLanes = Object.keys(lanes ?? {}).length > 0;

	/** Status section is visible when running OR when completed status should persist. */
	const hasStatus = isSourceNode ? !!(taskStatus && taskStatus.state !== ITaskState.NONE) : !!(componentPipeCounts && id in componentPipeCounts && (totalPipes ?? 0) > 0);

	// Bottom cap color:
	//   - If the node has lanes, status, OR invoke source diamonds, use canvas bg
	//   - If NONE of those are present (header only), match the header titleBar color
	const bottomCapMatchesHeader = !hasLanes && !hasStatus && !hasInvokeSource;

	// =========================================================================
	// Render
	// =========================================================================

	return (
		<>
			{/* Play/stop button on source nodes — slides out from the left edge */}
			{isSourceNode && <RunButton nodeId={id} />}

			{/* Top cap + optional invoke target diamond */}
			<NodeTop id={id} edges={edges} isInvocable={isInvocable} setQuickAddState={setQuickAddState} />

			{/* Header — icon, title, class type, gear, overflow menu, error badge */}
			<NodeHeader id={id} icon={icon} title={displayTitle} handleClick={handleClick} nodeType={type} hideEdit={false} formDataValid={data.formDataValid} description={displayDescription} documentation={documentation} parentId={mostRecentParentId} classType={classType} errorCount={isSourceNode ? errorCount : undefined} warningCount={isSourceNode ? warningCount : undefined} onBadgeClick={isSourceNode && onOpenStatus ? () => onOpenStatus(id) : undefined} isExperimental={isExperimental} />
			{children}

			{/* Data lanes — input/output handles */}
			<ConditionalRender condition={hasLanes}>
				<NodeLanes nodeId={id} lanes={lanes!} layout={layout} data={data} />
			</ConditionalRender>

			{/* Pipeline execution status — persists after completion for source nodes */}
			<ConditionalRender condition={hasStatus}>
				<NodeStatus componentProvider={id} isSourceNode={isSourceNode} taskStatus={taskStatus} componentPipeCounts={componentPipeCounts} totalPipes={totalPipes} onOpenStatus={onOpenStatus} onOpenLink={onOpenLink} serverHost={serverHost} displayName={displayTitle} />
			</ConditionalRender>

			{/* Spacer to reserve vertical space for invoke source labels */}
			<ConditionalRender condition={hasInvokeSource}>
				<div style={{ height: '20px', backgroundColor: 'var(--rr-bg-paper)' }} />
			</ConditionalRender>

			{/* Bottom corner cap */}
			{bottomCapMatchesHeader ? <div className="rr-corner-cap-bottom-header" /> : <div style={{ height: '4px', borderRadius: '0 0 4px 4px', backgroundColor: 'var(--rr-bg-paper)' }} />}

			{/* Invoke source diamonds — positioned on the bottom edge, labels above */}
			<ConditionalRender condition={hasInvokeSource}>
				<div
					style={{
						position: 'absolute',
						bottom: 0,
						left: 0,
						right: 0,
						display: 'flex',
						justifyContent: 'center',
						transform: 'translateY(50%)',
						zIndex: 1,
					}}
				>
					{invokeSourceKeys.map((key: string) => (
						<InvokeHandle
							key={key}
							id={`invoke-source.${key}`}
							type="source"
							position={Position.Bottom}
							invokeType={key}
							isConnected={edges.some((edge: Edge) => edge.sourceHandle === `invoke-source.${key}` && edge.source === id)}
							disabled={key === 'tool' && hasCrewaiConnection}
							tooltip={key === 'tool' && hasCrewaiConnection ? 'Tools are not active in hierarchical mode' : undefined}
							onClick={(e: React.MouseEvent) =>
								setQuickAddState({
									nodeId: id,
									handleId: `invoke-source.${key}`,
									laneType: '',
									isSource: true,
									position: { x: e.clientX, y: e.clientY },
									mode: 'invoke',
									invokeKey: key,
								})
							}
						/>
					))}
				</div>
			</ConditionalRender>

			{/* Dim overlay — shown when this tool is wired to a manager running in hierarchical mode */}
			{isInactiveInHierarchical && (
				<div
					title="Not active in hierarchical mode"
					style={{
						position: 'absolute',
						top: '-9px',
						right: 0,
						bottom: 0,
						left: 0,
						borderRadius: '4px',
						backgroundColor: 'var(--rr-bg-paper)',
						opacity: 0.6,
						zIndex: 10,
						pointerEvents: 'none',
					}}
				/>
			)}
		</>
	);
}
