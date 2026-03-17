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

import { useMemo } from 'react';
import { Edge, Node } from '@xyflow/react';
import { useFlow } from '../modules/project-canvas/FlowContext';

/**
 * Subset of the FlowContext providing only the edges and nodes needed for connection checks.
 * Used to avoid depending on the full FlowContext shape in this hook.
 */
interface FlowContextSubset {
	edges?: Edge[];
	nodes?: Node[];
}

/**
 * Custom hook that checks if a node has a specific lane connection in the specified direction.
 *
 * @param nodeId - The ID of the node to check (e.g., "classify-1", "classify-2")
 * @param lane - The lane name to check for (e.g., "text", "image", or provider name)
 * @param direction - There are from and to connections. From connections are outgoing connections, to connections are incoming connections.
 * @returns boolean indicating whether the node has the specified lane connection
 */
export function useConnectedLane(
	nodeId: string,
	lane: string,
	direction: 'from' | 'to' = 'from'
): boolean {
	const { edges, nodes } = useFlow() as FlowContextSubset;

	// Memoize the result so we only re-compute when the graph topology or query params change
	return useMemo(() => {
		// Guard: context may not yet have loaded edges/nodes
		if (!edges || !nodes) return false;

		if (direction === 'from') {
			// Check outgoing connections (edges where this node is the source)
			return edges.some((edge) => {
				if (edge.source !== nodeId) return false;
				// Handle IDs follow the convention "prefix-lane", so split and extract the lane segment
				if (edge.targetHandle) {
					const handleParts = edge.targetHandle.split('-');
					const edgeLane = handleParts[1]; // e.g., "source-text" -> "text"
					return edgeLane === lane;
				}
				return false;
			});
		} else if (direction === 'to') {
			// Check incoming connections (edges where this node is the target)
			return edges.some((edge) => {
				if (edge.target !== nodeId) return false;

				// Invoke edges use a special "invoke-source" handle and encode the class type differently
				if (edge.sourceHandle?.startsWith('invoke-source')) {
					if (edge.sourceHandle) {
						const handleParts = edge.sourceHandle.split('-');
						// Rejoin everything after "invoke-" to support multi-segment class types
						const classType = handleParts.slice(1).join('-');
						return classType === lane;
					}
				} else {
					// Regular lane connections: extract lane from the source handle
					if (edge.sourceHandle) {
						const handleParts = edge.sourceHandle.split('-');
						const edgeLane = handleParts[1]; // e.g., "target-text" -> "text"
						return edgeLane === lane;
					}
				}
				return false;
			});
		}

		return false;
	}, [edges, nodes, nodeId, lane, direction]);
}
