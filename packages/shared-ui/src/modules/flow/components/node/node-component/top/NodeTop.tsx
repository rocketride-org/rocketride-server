// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * NodeTop — Top corner cap with optional invoke target diamond handle.
 *
 * Always renders the rounded top cap of the node card. When `isInvocable`
 * is true, also renders a diamond-shaped InvokeHandle centered on the
 * top edge so the node can receive invoke (control-flow) connections.
 */

import React, { ReactElement } from 'react';
import { Edge, Position } from '@xyflow/react';
import { InvokeHandle } from '../../../handles';
import ConditionalRender from '../../../ConditionalRender';
import { IQuickAddState } from '../../../../context/FlowGraphContext';

// =============================================================================
// Types
// =============================================================================

/**
 * Props for the NodeTop component.
 */
interface INodeTopProps {
	/** Unique node ID, used to match edges. */
	id: string;
	/** All edges in the flow, used to determine if the handle is connected. */
	edges: Edge[];
	/** Whether this node can be invoked — controls diamond visibility. */
	isInvocable: boolean;
	/** Setter for the quick-add popup state, enabling click-to-add on invoke handles. */
	setQuickAddState?: (state: IQuickAddState | null) => void;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the top corner cap and an optional invoke target diamond.
 */
export default function NodeTop({ id, edges, isInvocable, setQuickAddState }: INodeTopProps): ReactElement {
	return (
		<>
			{/* Invoke target diamond — centered on the top edge */}
			<ConditionalRender condition={isInvocable}>
				<div
					style={{
						position: 'absolute',
						top: 0,
						left: 0,
						right: 0,
						display: 'flex',
						justifyContent: 'center',
						transform: 'translateY(-50%)',
						zIndex: 1,
					}}
				>
					<InvokeHandle
						id="invoke-target"
						type="target"
						position={Position.Top}
						isConnected={edges.some((edge: Edge) => edge.targetHandle === 'invoke-target' && edge.target === id)}
						onClick={
							setQuickAddState
								? (e: React.MouseEvent) =>
										setQuickAddState({
											nodeId: id,
											handleId: 'invoke-target',
											laneType: '',
											isSource: false,
											position: { x: e.clientX, y: e.clientY },
											mode: 'invoke',
										})
								: undefined
						}
					/>
				</div>
			</ConditionalRender>

			{/* Top corner cap — rounded top border, matches header background */}
			<div className="rr-corner-cap-top" />
		</>
	);
}
