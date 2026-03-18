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

import React, { ReactElement, useCallback, useMemo } from 'react';
import { Box } from '@mui/material';
import { Connection, Edge, Node as NodeProps, Position } from '@xyflow/react';

import { styles } from './index.style';
import { useFlow } from '../../../FlowContext';
import { Lane } from '../../../helpers';
import { INodeData, NodeLayout } from '../../../types';
import { NodeType } from '../../../../../constants';
import { DynamicFormsCapabilities, IDynamicForm } from '../../../../../services/dynamic-forms/types';
import Lanes from '../../lanes/Lanes';
import RunButton from '../../run-button/RunButton';
import ProjectNodeHeader from '../../node-header/ProjectNodeHeader';
import NodeFooter from '../../node-footer';
import InvokeHandle from '../../handles/invoke/InvokeHandle';

/**
 * Props for the generic canvas Node wrapper component.
 * Extends React Flow's NodeProps with application-specific fields like
 * node data, layout direction, and an optional click handler.
 */
interface IProps extends NodeProps {
	id: string;
	data: INodeData;
	children: ReactElement;
	type: NodeType;
	layout?: NodeLayout;
	handleClick?: () => void;
	parentId?: string;
}

/**
 * Generic pipeline node component that renders the standard node chrome
 * on the project canvas: header with icon/title, data lanes (input/output
 * handles), a run button for source nodes, and a footer with provider info.
 * All concrete node types (e.g. LLM, Database, Filter) delegate to this
 * component for their shared visual structure.
 *
 * @param id - Unique node identifier within the flow.
 * @param data - Typed node data containing title, icon, lanes, form state, etc.
 * @param children - Additional content rendered inside the header area.
 * @param parentId - ID of the parent group node, if any.
 * @param type - Discriminated node type enum value.
 * @param layout - Lane layout direction; defaults to 'horizontal'.
 * @param handleClick - Optional click handler forwarded to the node header.
 */
export default function Node({
	id,
	data,
	children,
	parentId,
	type,
	layout = 'horizontal',
	handleClick,
}: IProps): ReactElement {
	// Destructure the rich node data bag into individual rendering props
	const {
		name,
		description,
		lanes,
		icon,
		classType,
		formDataValid,
		provider,
		documentation,
		Pipe,
	} = data;

	const { nodes, taskStatuses, componentPipeCounts, totalPipes, servicesJson, edges, selectedHandle, onHandleClick, nodeMap } = useFlow();

	// --- Invoke handle logic (moved from Lanes so handles can be rendered on corner caps) ---
	const { invoke, capabilities } = data;
	const _servicesJson = useMemo(() => (servicesJson ?? {}) as Record<string, IDynamicForm>, [servicesJson]);

	const isInvoke =
		(DynamicFormsCapabilities.Invoke & (capabilities ?? 0)) === DynamicFormsCapabilities.Invoke;

	const invokeSources = useMemo(() => new Set(
		Object.values(_servicesJson)
			.filter((s: IDynamicForm) => s.invoke)
			.map((s: IDynamicForm) => Object.keys(s.invoke ?? {}))
			.flat()
	), [_servicesJson]);

	const invokeTargets = useMemo(() => {
		const targets = new Set(Array.isArray(classType) ? classType : [classType]);
		return invokeSources.intersection(targets);
	}, [classType, invokeSources]);

	const invokeConfig = useMemo(() => {
		if (!provider) return undefined;
		const svc = _servicesJson[provider];
		return svc?.invoke;
	}, [provider, _servicesJson]);

	const invokeSourceKeys = useMemo(() => Object.keys(invokeConfig ?? {}), [invokeConfig]);
	const hasInvokeSource = invokeSourceKeys.length > 0;

	const validateConnection = useCallback(
		(edge: Edge | Connection) => {
			if (edge.source === edge.target) return false;
			if (edge.sourceHandle?.startsWith('invoke-source') && edge.targetHandle?.indexOf('invoke-target') !== -1) {
				const invokeType = edge?.targetHandle?.split('-').at(-1);
				// Ensure the source invoke key matches the target class type
				const sourceKey = edge.sourceHandle?.split('-').slice(2).join('-');
				if (sourceKey && invokeType && sourceKey !== invokeType) return false;
				const sourceNode = nodeMap?.[edge.source];
				const targetNode = nodeMap?.[edge.target];
				if (sourceNode?.parentId != targetNode?.parentId) return false;
				const inv = (sourceNode?.data as INodeData)?.invoke?.[invokeType!] as { min?: number; max?: number } | undefined;
				if (inv == null || (inv != null && inv.min == null && inv.max == null)) return true;
				const existing = edges.filter(
					(e: Edge) => e.sourceHandle?.startsWith('invoke-source') && e.source === edge.source && e.targetHandle === edge.targetHandle
				);
				if (existing.length >= inv.max!) return false;
				return true;
			}
			return true;
		},
		[nodeMap, edges]
	);

	const handleInvokeClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>, handleId: string, keys: string[]) => {
			event.stopPropagation();
			onHandleClick(id, handleId, keys);
		},
		[id, onHandleClick]
	);

	// Look up service catalog title and description from the provider
	const serviceInfo = (servicesJson as Record<string, { title?: string; description?: string }> | undefined)?.[provider as string];
	const displayTitle = name || serviceInfo?.title;
	const displayDescription = description || serviceInfo?.description;

	/**
	 * Resolves the most recent parent ID for this node by looking it up
	 * in the current nodes array. This is necessary because the parentId
	 * prop may be stale after group operations (e.g. ungroup/regroup).
	 */
	const mostRecentParentId = useMemo(() => {
		// If no parent, pass through as-is (undefined)
		if (!parentId) {
			return parentId;
		}
		// Look up the node from the live nodes array to get its current parentId
		const thisNode = nodes.find((n: NodeProps) => n.id === id);

		return thisNode?.parentId;
	}, [nodes, parentId, id]);

	// Always show the edit button since every node has a Details panel
	// for name and description, even if there is no RJSF configuration form.
	const showEditButton = true;

	/** Whether this node is classified as a source node, which renders a run button. */
	const isSourceNode = useMemo(() => classType?.includes('source') || false, [classType]);

	/** Task status for this node (id must match backend status_update source). Updated when host receives status_update and merges into taskStatuses. */
	const taskStatus = taskStatuses?.[id];

	return (
		<>
			{isSourceNode && <RunButton nodeId={id} />}
			{/* Top invoke target handles — positioned above the node border */}
			{isInvoke && invokeTargets.size > 0 && (
				<Box sx={{ position: 'absolute', top: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', transform: 'translateY(-50%)', zIndex: 1 }}>
					{Array.from(invokeTargets).map((value: string) => (
						<InvokeHandle
							key={value}
							id={`invoke-target-${value}`}
							type="target"
							position={Position.Top}
							isConnected={edges.some(
								(edge: Edge) =>
									edge.targetHandle === `invoke-target-${value}` &&
									edge.target === id
							)}
							isValidConnection={validateConnection}
							selected={
								selectedHandle
									? selectedHandle[0] === id &&
										selectedHandle[1] === `invoke-target-${value}`
									: false
							}
							onClick={(event) =>
								handleInvokeClick(event, `invoke-target-${value}`, [value])
							}
						/>
					))}
				</Box>
			)}
			<Box key={id} sx={{ ...styles.nodeContent, ...(hasInvokeSource ? { paddingBottom: '1.2rem' } : {}) }}>
				<Box sx={styles.cornerCapTop} />
				<Box sx={styles.headerWrapper}>
					<ProjectNodeHeader
						id={id}
						icon={icon}
						title={displayTitle}
						handleClick={handleClick}
						nodeType={type}
						hideEdit={!showEditButton}
						formDataValid={formDataValid}
						description={displayDescription}
						documentation={documentation}
						parentId={mostRecentParentId}
					classType={classType}
					/>
					{children}
				</Box>
				<Lanes nodeId={id} lanes={lanes as Record<string, Lane>} layout={layout} data={data} />
				<NodeFooter
					componentProvider={id}
					isSourceNode={isSourceNode}
					taskStatus={taskStatus}
					componentPipeCounts={componentPipeCounts}
					totalPipes={totalPipes}
				/>
				<Box sx={styles.cornerCapBottom} />
			</Box>
			{/* Bottom invoke source handles — diamonds on the bottom edge, labels inside the node */}
			{hasInvokeSource && (
				<Box sx={{ position: 'absolute', bottom: 0, left: 0, right: 0, display: 'flex', justifyContent: 'center', transform: 'translateY(50%)', zIndex: 1 }}>
					{invokeSourceKeys.map((key: string) => (
						<InvokeHandle
							key={key}
							id={`invoke-source-${key}`}
							type="source"
							position={Position.Bottom}
							invokeType={key}
							isConnected={edges.some(
								(edge: Edge) =>
									edge.sourceHandle === `invoke-source-${key}` && edge.source === id
							)}
							isValidConnection={validateConnection}
							selected={
								selectedHandle
									? selectedHandle[0] === id && selectedHandle[1] === `invoke-source-${key}`
									: false
							}
							onClick={(event) =>
								handleInvokeClick(event, `invoke-source-${key}`, [key])
							}
						/>
					))}
				</Box>
			)}
		</>
	);
}
