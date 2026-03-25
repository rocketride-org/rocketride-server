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
 * Lanes — Input and output data-lane handles for a canvas node.
 *
 * Each node in the pipeline canvas can have multiple typed input lanes
 * (targets on the left) and output lanes (sources on the right). This
 * component is responsible for:
 *
 *   - Rendering labelled circular handles for each visible input and output lane.
 *   - Drawing SVG inside-lines (via {@link InsideLines}) between connected
 *     input/output pairs within the node body.
 *   - Validating new connections to enforce type compatibility and invoke constraints.
 *
 * Hidden internal lanes (keys prefixed with `_`) are not rendered as input
 * handles but may still produce output lanes that are shown on the right side.
 *
 * Returns null when the node has no visible lanes (no non-internal inputs
 * and no output lanes).
 */

import { ReactElement, useCallback, useMemo, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { Position } from '@xyflow/react';

import { IServiceCatalog, IServiceLane, INodeData, INodeLayout } from '../../../../types';

import styles from './index.style';
import { LaneHandle } from '../../../handles';
import { useFlow } from '../../../../hooks';
import { sortOutputLanes, getOutputLaneDisplayValues, renameLanes } from '../../../../util/helpers';
import ConditionalRender from '../../../ConditionalRender';
import InsideLines from './InsideLines';

interface IProps {
	nodeId: string;
	lanes: Record<string, IServiceLane>;
	layout?: INodeLayout;
	data: INodeData;
	/** When true, renders GroupLines instead of InsideLines. */
	isGroup?: boolean;
}

const RedAsterisk = (
	<span
		style={{
			color: '#d32f2f',
			fontWeight: 800,
		}}
	>
		*
	</span>
);

export default function NodeLanes({ nodeId, lanes, layout, data, isGroup: _isGroup }: IProps): ReactElement | null {
	const { edges, servicesJson: _servicesJson, setQuickAddState } = useFlow();
	const servicesJson = useMemo(() => (_servicesJson ?? {}) as IServiceCatalog, [_servicesJson]);

	// Service-level display fields looked up from catalog at render time
	const service = servicesJson[data.provider];
	const title = data.name || service?.title;
	const tile = service?.tile;
	const [boxEl, setBoxEl] = useState<HTMLElement | null>(null);
	const boxRef = useCallback((node: HTMLElement | null) => {
		setBoxEl(node);
	}, []);

	const inputLanes = useMemo(() => {
		const _inputLanes = Object.keys(lanes ?? {});
		return _inputLanes
			.map((lane: string) => ({
				type: lane,
				targetId: `target-${lane}`,
				label: renameLanes(lane),
			}))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [lanes]);

	const outputLanes = useMemo(() => {
		const uniqueOutputTypes = new Set<string>();
		const outputLanesByType = new Map<string, { type: string; required: boolean; sourceId: string; label: string }>();

		inputLanes.forEach((inputLane: { type: string; targetId: string; label: string }) => {
			const sortedOutputLaneList = sortOutputLanes(lanes[inputLane?.type]);
			sortedOutputLaneList.forEach((outputLane) => {
				const { type, required, sourceId, label } = getOutputLaneDisplayValues(outputLane);
				if (!uniqueOutputTypes.has(type)) {
					uniqueOutputTypes.add(type);
					outputLanesByType.set(type, { type, required, sourceId, label });
				}
			});
		});

		const deduplicatedLanes = Array.from(outputLanesByType.values()).sort((a, b) => a.label.localeCompare(b.label));
		return inputLanes.map(() => deduplicatedLanes);
	}, [lanes, inputLanes]);

	const isInputConnected = useCallback((targetId: string) => edges.some((edge) => edge.targetHandle === targetId && edge.target === nodeId), [edges, nodeId]);

	const isOutputConnected = useCallback((sourceId: string) => edges.some((edge) => edge.sourceHandle === sourceId && edge.source === nodeId), [edges, nodeId]);

	const uniqueOutputLanes = useMemo(() => outputLanes[0] || [], [outputLanes]);

	const anyInputConnected = useMemo(() => {
		return inputLanes.some((inputLane) => isInputConnected(inputLane.targetId));
	}, [inputLanes, isInputConnected]);

	const inputLanesWithConnections = useMemo(() => {
		return inputLanes
			.filter((inputLane) => !inputLane.type.startsWith('_'))
			.map((inputLane, index, visibleInputs) => ({
				key: inputLane.type,
				connected: isInputConnected(inputLane.targetId),
				index: index,
				totalInputs: visibleInputs.length,
				outputMapping: lanes[inputLane.type]?.map((outputLane) => (typeof outputLane === 'string' ? outputLane : outputLane.type)),
			}));
	}, [inputLanes, isInputConnected, lanes]);

	const outputLanesWithConnections = useMemo(() => {
		return uniqueOutputLanes.map((outputLane: { type: string; sourceId: string }) => ({
			key: outputLane.type,
			connected: isOutputConnected(outputLane.sourceId),
		}));
	}, [uniqueOutputLanes, isOutputConnected]);

	const hasVisibleLanes = inputLanes.some((lane) => !lane.type.startsWith('_')) || uniqueOutputLanes.length > 0;
	if (!hasVisibleLanes) return null;

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
				<ConditionalRender condition={boxEl && anyInputConnected}>
					<InsideLines parentEl={boxEl!} inputConnected={anyInputConnected} inputLanes={inputLanesWithConnections} outputLanes={outputLanesWithConnections} />
				</ConditionalRender>

				<Box
					sx={{
						...styles.connectionBox,
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'space-evenly',
						height: '100%',
					}}
				>
					<ConditionalRender condition={inputLanes.length > 0}>
						<>
							{inputLanes.map((inputLane: { type: string; targetId: string; label: string }) => {
								const { label, targetId, type } = inputLane;
								const showInputLane = !type.startsWith('_');
								const inputConnected = isInputConnected(targetId);

								return (
									showInputLane && (
										<Box sx={styles.connectionType} key={`input-${title}-${type}`}>
											<Typography
												component="span"
												sx={{
													...styles.label,
													...styles.body,
												}}
											>
												{label}
												<LaneHandle
													id={targetId}
													type="target"
													position={layout === 'horizontal' ? Position.Left : Position.Top}
													isConnected={inputConnected}
													onClick={(e) =>
														setQuickAddState({
															nodeId,
															handleId: targetId,
															laneType: type,
															isSource: false,
															position: { x: e.clientX, y: e.clientY },
														})
													}
													color="var(--rr-border)"
												/>
											</Typography>
										</Box>
									)
								);
							})}
						</>
					</ConditionalRender>
				</Box>

				<Box
					sx={{
						...styles.connectionBox,
						display: 'flex',
						flexDirection: 'column',
						justifyContent: 'space-evenly',
						height: '100%',
					}}
				>
					<ConditionalRender condition={uniqueOutputLanes.length > 0}>
						<>
							{uniqueOutputLanes.map((outputLane: { type: string; required: string | boolean; sourceId: string; label: string }) => {
								const { type, required, sourceId, label } = outputLane;

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
											<LaneHandle
												id={sourceId}
												type="source"
												position={layout === 'horizontal' ? Position.Right : Position.Bottom}
												isConnected={isOutputConnected(sourceId)}
												color="var(--rr-border)"
												onClick={(e) =>
													setQuickAddState({
														nodeId,
														handleId: sourceId,
														laneType: type,
														isSource: true,
														position: { x: e.clientX, y: e.clientY },
													})
												}
											/>
										</Typography>
									</Box>
								);
							})}
						</>
					</ConditionalRender>
				</Box>
			</Box>
		</>
	);
}
