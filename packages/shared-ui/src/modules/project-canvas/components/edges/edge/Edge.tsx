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

import { useState } from 'react';
import {
	BaseEdge,
	EdgeLabelRenderer,
	getBezierPath,
	useReactFlow,
	type EdgeProps,
} from '@xyflow/react';
import { IconButton } from '@mui/material';
import { DeleteForever } from '@mui/icons-material';
import { styles } from './index.style';

/**
 * Custom edge component rendered between connected nodes on the project canvas.
 *
 * Renders a bezier-curve edge with an interactive delete button that appears when
 * the edge is selected or hovered. Handles both standard data-flow edges and invoke
 * edges, adjusting the bezier path offset accordingly so that the curve connects
 * cleanly to the appropriate handle position.
 *
 * @param props - Standard ReactFlow EdgeProps including source/target coordinates,
 *   positions, styling, and selection state.
 * @returns The rendered SVG group containing the edge path and optional delete button.
 */
export default function CustomEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	style = {},
	markerEnd,
	selected,
	sourceHandleId,
}: EdgeProps) {
	/** Whether the mouse is currently hovering over this edge. */
	const [hovered, setHovered] = useState<boolean>(false);
	const { setEdges } = useReactFlow();

	// Detect invoke edges by checking the source handle ID -- invoke edges
	// run vertically (top-to-bottom) so the offset is applied to Y instead of X.
	/** Whether this edge originates from an invoke handle (affects path offset direction). */
	const invokeEdge = sourceHandleId?.toLowerCase().includes('invoke');

	/** Pixel offset applied to bezier endpoints so the curve does not overlap the handle. */
	const sizeDelta = 8;

	// Compute the bezier path, shifting source/target endpoints away from the
	// handle center so the curve visually starts/ends at the handle edge.
	// For data-flow edges the offset is horizontal; for invoke edges it is vertical.
	const [edgePath, labelX, labelY] = getBezierPath({
		sourceX: !invokeEdge ? sourceX - sizeDelta : sourceX,
		sourceY: invokeEdge ? sourceY - sizeDelta : sourceY,
		sourcePosition,
		targetX: !invokeEdge ? targetX + sizeDelta : targetX,
		targetY: invokeEdge ? targetY + sizeDelta : targetY,
		targetPosition,
	});

	/**
	 * Removes this edge from the canvas by filtering it out of the edges array.
	 */
	const onEdgeClick = () => setEdges((edges) => edges.filter((edge) => edge.id !== id));

	return (
		// Track hover state on the SVG group so the delete button can appear on hover
		<g onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
			<BaseEdge path={edgePath} markerEnd={markerEnd} style={{ ...style, ...(invokeEdge ? { strokeDasharray: '2,4', strokeLinecap: 'round' as const } : {}) }} />
			{/* Show the delete button at the midpoint of the edge when selected or hovered */}
			{(selected || hovered) && (
				<EdgeLabelRenderer>
					<div
						style={{
							position: 'absolute',
							// Center the button on the midpoint of the bezier curve
							transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
						}}
						className="nopan"
					>
						<IconButton sx={styles.button} onClick={onEdgeClick}>
							<DeleteForever />
						</IconButton>
					</div>
				</EdgeLabelRenderer>
			)}
		</g>
	);
}
