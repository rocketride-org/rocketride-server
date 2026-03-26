// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG Inc.
// =============================================================================

/**
 * FlowEdge — Custom edge component for the flow canvas.
 *
 * Renders a bezier-curve edge with an interactive delete button that
 * appears when the edge is selected or hovered. Handles both standard
 * data-flow edges and invoke edges, adjusting the bezier path offset
 * accordingly so the curve connects cleanly to the appropriate handle.
 *
 * Invoke edges are rendered with a dashed stroke to visually distinguish
 * control-flow from data-flow connections.
 */

import { useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react';
import { IconButton } from '@mui/material';
import { DeleteForever } from '@mui/icons-material';

/** Pixel offset applied to bezier endpoints so the curve doesn't overlap the handle. */
const HANDLE_OFFSET = 8;

/** Styles for the delete button that appears on hover/selection. */
const styles = {
	button: {
		backgroundColor: 'var(--rr-bg-surface)',
		padding: '0.2rem',
		border: '1px solid',
		borderColor: 'var(--rr-border)',
		'&:hover': {
			backgroundColor: 'var(--rr-bg-surface)',
			borderColor: 'var(--rr-accent)',
		},
		'& > svg': {
			fontSize: '1rem',
		},
	},
};

/**
 * Renders a custom bezier edge between two nodes.
 *
 * @param props - Standard ReactFlow EdgeProps.
 */
export default function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style = {}, markerEnd, selected, sourceHandleId }: EdgeProps) {
	/** Whether the mouse is currently hovering over this edge. */
	const [hovered, setHovered] = useState(false);
	const { setEdges } = useReactFlow();

	// Invoke edges run vertically (top-to-bottom) so the offset is applied
	// to Y instead of X. Detect by checking the source handle ID.
	const isInvokeEdge = sourceHandleId?.toLowerCase().includes('invoke');

	// Compute the bezier path, shifting endpoints away from the handle center
	// so the curve visually starts/ends at the handle edge.
	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX: !isInvokeEdge ? sourceX - HANDLE_OFFSET : sourceX,
		sourceY: isInvokeEdge ? sourceY - HANDLE_OFFSET : sourceY,
		sourcePosition,
		targetX: !isInvokeEdge ? targetX + HANDLE_OFFSET : targetX,
		targetY: isInvokeEdge ? targetY + HANDLE_OFFSET : targetY,
		targetPosition,
	});

	/** Removes this edge from the canvas. */
	const onDelete = () => setEdges((edges) => edges.filter((e) => e.id !== id));

	// Invoke edges use a dashed stroke to distinguish control-flow from data-flow
	const edgeStyle = {
		...style,
		...(isInvokeEdge ? { strokeDasharray: '2,4', strokeLinecap: 'round' as const } : {}),
	};

	return (
		<g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
			<BaseEdge path={edgePath} markerEnd={markerEnd} style={edgeStyle} />

			{/* Delete button at the midpoint — visible on hover or selection */}
			{(selected || hovered) && (
				<EdgeLabelRenderer>
					<div
						style={{
							position: 'absolute',
							transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
						}}
						className="nopan"
					>
						<IconButton sx={styles.button} onClick={onDelete}>
							<DeleteForever />
						</IconButton>
					</div>
				</EdgeLabelRenderer>
			)}
		</g>
	);
}
