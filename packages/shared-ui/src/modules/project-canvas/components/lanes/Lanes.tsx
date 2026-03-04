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

import React, { ReactElement, useCallback, useMemo, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { Connection, Edge, Position } from '@xyflow/react';

import {
	IDynamicForms,
} from '../../../../services/dynamic-forms/types';

import styles from './index.style';
import Handle from '../Handle';
import { useFlow } from '../../FlowContext';
import { sortOutputLanes, getOutputLaneDisplayValues, Lane, renameLanes } from '../../helpers';
import { INodeData, NodeLayout } from '../../types';
import theme from '../../../../theme';
import InsideLines from './InsideLines';

/**
 * Props for the Lanes component.
 *
 * Describes the node identity, its input/output lane configuration,
 * the layout orientation, and the full node data payload needed
 * to render handles, invoke connections, and lane labels.
 */
interface IProps {
	/** Unique identifier of the node that owns these lanes. */
	nodeId: string;
	/** Map of input lane type names to their corresponding output lane definitions. */
	lanes: Record<string, Lane>;
	/** Layout direction of the node -- affects handle placement (left/right vs top/bottom). */
	layout?: NodeLayout;
	/** Full data payload of the node, including title, class type, provider, etc. */
	data: INodeData;
}

/**
 * A red asterisk indicator rendered next to required output lanes
 * to visually signal that the output connection is mandatory.
 */
const RedAsterisk = (
	<span
		style={{
			color: theme.palette.error.main,
			fontWeight: 800,
		}}
	>
		*
	</span>
);

/**
 * Renders the input and output data lanes (connection ports) for a canvas node.
 *
 * Each node in the project canvas can have multiple typed input lanes (targets) and
 * output lanes (sources). This component is responsible for:
 * - Rendering labeled handles for each input and output lane.
 * - Drawing inside-lines (SVG curves) between connected input/output pairs within the node.
 * - Rendering invoke handles at the top/bottom for method-invocation style connections.
 * - Validating new connections to enforce type compatibility and invoke constraints.
 *
 * @param props - The node ID, lane definitions, layout direction, and node data.
 * @returns The rendered lanes section with handles, labels, inside lines, and invoke handles.
 */
export default function Lanes({ nodeId, lanes, layout, data }: IProps): ReactElement {
	// Destructure node data fields needed for lane rendering and invoke logic
	const { title, tile } = data;

	const { onHandleClick, selectedHandle, edges, nodeMap, servicesJson: _servicesJson } = useFlow();
	// Default to empty object to avoid null checks throughout invoke map logic
	const servicesJson = useMemo(() => (_servicesJson ?? {}) as IDynamicForms, [_servicesJson]);
	// Callback ref that triggers a re-render once the lanes container mounts,
	// ensuring InsideLines can measure handle positions on the initial paint.
	const [boxEl, setBoxEl] = useState<HTMLElement | null>(null);
	const boxRef = useCallback((node: HTMLElement | null) => {
		setBoxEl(node);
	}, []);


	/**
	 * Sorted list of input lane descriptors derived from the `lanes` prop keys.
	 * Each entry includes the lane type, a target handle ID, and a display label.
	 */
	const inputLanes = useMemo(() => {
		// Each key in the lanes map represents an input lane type
		const _inputLanes = Object.keys(lanes ?? {});
		// Build descriptors with a deterministic handle ID and human-readable label, then sort alphabetically
		return _inputLanes
			.map((lane: string) => ({
				type: lane,
				targetId: `target-${lane}`,
				label: renameLanes(lane),
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [lanes]);

	/**
	 * Deduplicated list of output lane descriptors, replicated per input lane.
	 * Each output appears only once regardless of how many inputs reference it.
	 * Contains type, required flag, source handle ID, and display label.
	 */
	const outputLanes = useMemo(() => {
		// Collect all unique output lane types across all input lanes,
		// deduplicating by type so each output handle is rendered exactly once
		const uniqueOutputTypes = new Set<string>();
		const outputLanesByType = new Map<
			string,
			{ type: string; required: boolean; sourceId: string; label: string }
		>();

		inputLanes.forEach((inputLane: { type: string; targetId: string; label: string }) => {
			// Sort outputs for consistent ordering before deduplication
			const sortedOutputLaneList = sortOutputLanes(lanes[inputLane?.type]);

			sortedOutputLaneList.forEach((outputLane) => {
				const { type, required, sourceId, label } = getOutputLaneDisplayValues(outputLane);

				// Skip duplicates -- an output type shared by multiple inputs only needs one handle
				if (!uniqueOutputTypes.has(type)) {
					uniqueOutputTypes.add(type);
					outputLanesByType.set(type, {
						type,
						required,
						sourceId,
						label,
					});
				}
			});
		});

		// Alphabetically sort the unique output list, then replicate for every input lane
		// (the per-input-lane array structure is preserved for compatibility with InsideLines)
		const deduplicatedLanes = Array.from(outputLanesByType.values()).sort((a, b) =>
			a.label.localeCompare(b.label)
		);
		return inputLanes.map(() => deduplicatedLanes);
	}, [lanes, inputLanes]);

	/**
	 * Wraps the FlowContext `onHandleClick` to stop event propagation before
	 * forwarding the handle selection, preventing the click from also selecting
	 * or dragging the parent node.
	 */
	const _onHandleClick = (
		event: React.MouseEvent | MouseEvent,
		nodeId: string,
		handleId: string,
		keys: string[],
		inputLaneKey?: string
	) => {
		// Stop propagation so clicking a handle does not also select/drag the node
		event.stopPropagation();
		onHandleClick(nodeId, handleId, keys, inputLaneKey);
	};

	/**
	 * Returns whether the given input target handle has at least one incoming edge.
	 */
	const isInputConnected = useCallback(
		(targetId: string) =>
			edges.some((edge) => edge.targetHandle === targetId && edge.target === nodeId),
		[edges, nodeId]
	);
	/**
	 * Returns whether the given output source handle has at least one outgoing edge.
	 */
	const isOutputConnected = useCallback(
		(sourceId: string) =>
			edges.some((edge) => edge.sourceHandle === sourceId && edge.source === nodeId),
		[edges, nodeId]
	);

	/**
	 * Validates whether a proposed edge connection is allowed.
	 *
	 * Rules enforced:
	 * - Self-connections (same source and target node) are rejected.
	 * - Invoke connections must connect nodes on the same parent level and
	 *   respect the min/max cardinality defined in the invoke configuration.
	 * - Data-lane connections must match source and target handle types.
	 */
	const validateConnection = useCallback(
		(edge: Edge | Connection) => {
			// Prevent self-connections (connecting a node to itself)
			if (edge.source === edge.target) {
				return false;
			}

			// --- Invoke edge validation ---
			if (
				edge.sourceHandle === 'invoke-source' &&
				edge.targetHandle?.indexOf('invoke-target') !== -1
			) {
				// Extract the invoked class type from the target handle ID (last segment)
				const invokeType = edge?.targetHandle?.split('-').at(-1);

				const sourceNode = nodeMap?.[edge.source];
				const targetNode = nodeMap?.[edge.target];

				// Invoke connections are only valid between nodes at the same hierarchy level
				if (sourceNode?.parentId != targetNode?.parentId) return false;

				// Look up cardinality constraints (min/max) from the source node's invoke config
				const invoke = (sourceNode?.data as INodeData)?.invoke?.[invokeType!] as { min?: number; max?: number } | undefined;

				// If no cardinality limits are defined, the connection is always allowed
				if (invoke == null || (invoke != null && invoke.min == null && invoke.max == null))
					return true;

				// Count existing invoke edges of the same type from this source to enforce max
				const _edges = edges.filter(
					(e: Edge) =>
						e.sourceHandle === 'invoke-source' &&
						e.source === edge.source &&
						e.targetHandle === edge.targetHandle
				);

				// Reject if the max cardinality would be exceeded
				if (_edges.length >= invoke.max!) return false;

				return true;
			}

			// --- Data-lane edge validation ---
			else {
				// Extract the lane type from handle IDs (format: "source-<type>" / "target-<type>")
				// and only allow connections between matching types
				const sourceHandleType = edge?.sourceHandle?.split('-')?.[1];
				const tagetHandleType = edge?.targetHandle?.split('-')?.[1];
				return sourceHandleType === tagetHandleType;
			}
		},
		[nodeMap, edges]
	);

	/** Unique deduplicated output lanes taken from the first input lane (all are identical after deduplication). */
	const uniqueOutputLanes = useMemo(() => outputLanes[0] || [], [outputLanes]);

	/** Whether at least one input lane on this node is connected, used to trigger InsideLines rendering. */
	const anyInputConnected = useMemo(() => {
		return inputLanes.some((inputLane) => isInputConnected(inputLane.targetId));
	}, [inputLanes, isInputConnected]);

	/** Input lanes enriched with connection status and output mapping for InsideLines rendering. */
	const inputLanesWithConnections = useMemo(() => {
		return inputLanes
			// Filter out hidden internal lanes (prefixed with underscore)
			.filter((inputLane) => !inputLane.type.startsWith('_'))
			.map((inputLane, index, visibleInputs) => ({
				key: inputLane.type,
				connected: isInputConnected(inputLane.targetId),
				index: index,
				totalInputs: visibleInputs.length,
				// Map each input to its corresponding output lane types for InsideLines curve routing
				outputMapping: lanes[inputLane.type]?.map((outputLane) =>
					typeof outputLane === 'string' ? outputLane : outputLane.type
				),
			}));

	}, [inputLanes, isInputConnected, lanes]);

	/** Output lanes enriched with connection status for InsideLines rendering. */
	const outputLanesWithConnections = useMemo(() => {
		return uniqueOutputLanes.map((outputLane: { type: string; sourceId: string }) => ({
			key: outputLane.type,
			connected: isOutputConnected(outputLane.sourceId),
		}));
	 
	}, [uniqueOutputLanes, isOutputConnected]);

	return (
		<>
			<Box
				key={tile?.join(',')}
				ref={boxRef}
				sx={{
					...styles.lanes,
					...styles.connections,
					height: '100%',
				}}
			>
				{/* Render inside lines when inputs and outputs are connected */}
				{boxEl && anyInputConnected && (
					<InsideLines
						parentEl={boxEl}
						inputConnected={anyInputConnected}
						inputLanes={inputLanesWithConnections}
						outputLanes={outputLanesWithConnections}
					/>
				)}

				{/* Input lanes container - vertically centered */}
				<Box
					sx={{
						...styles.connectionBox,
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'space-evenly',
						height: '100%',
					}}
				>
					{inputLanes.length > 0 && (
						<>
							{inputLanes.map((inputLane: { type: string; targetId: string; label: string }) => {
								const { label, targetId, type } = inputLane;

								// Hide internal lanes (prefixed with underscore) from the UI
								const showInputLane = !type.startsWith('_');
								const inputConnected = isInputConnected(targetId);

								// Determine if this specific handle is the one the user currently has selected
								const inputHandleSelected = selectedHandle
									? selectedHandle[0] === nodeId &&
										selectedHandle[1] === 'target' &&
										selectedHandle[2].some((key) => key === type)
									: false;

								return (
									showInputLane && (
										<Box
											sx={styles.connectionType}
											key={`input-${title}-${type}`}
										>
											<Typography
												component="span"
												sx={{
													...styles.label,
													...styles.body,
												}}
											>
												{label}
												<Handle
													id={targetId}
													type="target"
													position={
														layout === 'horizontal'
															? Position.Left
															: Position.Top
													}
													isConnected={inputConnected}
													isValidConnection={validateConnection}
													selected={inputHandleSelected}
													onClick={(event) =>
														_onHandleClick(event, nodeId, 'target', [
															type,
														])
													}
													color="#56565A"
												/>
											</Typography>
										</Box>
									)
								);
							})}
						</>
					)}
				</Box>

				{/* Output lanes container - vertically centered */}
				<Box
					sx={{
						...styles.connectionBox,
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'space-evenly',
						height: '100%',
					}}
				>
					{uniqueOutputLanes.length > 0 && (
						<>
							{uniqueOutputLanes.map((outputLane: { type: string; required: string | boolean; sourceId: string; label: string }) => {
								const { type, required, sourceId, label } = outputLane;

								// Check selection state so the handle can render a highlighted style
								let outputLaneSelected = false;

								if (selectedHandle) {
									outputLaneSelected =
										selectedHandle[0] === nodeId &&
										selectedHandle[1] === 'source' &&
										selectedHandle[2].some((key) => key === type);
								}

								return (
									<Box
										key={`output-${title}-${type}`}
										sx={{
											...styles.connectionType,
											justifyContent: 'end',
										}}
									>
										<Typography
											component="span"
											sx={{
												...styles.label,
												...styles.body,
											}}
										>
											{label}
											{required && RedAsterisk}
											<Handle
												id={sourceId}
												type="source"
												position={
													layout === 'horizontal'
														? Position.Right
														: Position.Bottom
												}
												isValidConnection={validateConnection}
												isConnected={isOutputConnected(sourceId)}
												selected={outputLaneSelected}
												onClick={(event) =>
													_onHandleClick(
														event,
														nodeId,
														'source',
														[type],
														undefined
													)
												}
												color="#56565A"
											/>
										</Typography>
									</Box>
								);
							})}
						</>
					)}
				</Box>
			</Box>
			{/* Invoke handles are now rendered in Node.tsx on the corner caps */}
		</>
	);
}
