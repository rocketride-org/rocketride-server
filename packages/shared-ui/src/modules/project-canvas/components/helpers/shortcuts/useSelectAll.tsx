// =============================================================================
// MIT License
// Copyright (c) 2026 RocketRide Inc.
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

import { useCallback } from 'react';
import { Node } from '@xyflow/react';
import { useFlow } from '../../../FlowContext';

/**
 * Hook that provides a handler for selecting all nodes on the project canvas.
 * Marks every node's selected flag as true and updates both the node array and
 * the selectedNodes collection in the flow context, enabling bulk operations
 * such as group, delete, or copy on the entire pipeline.
 *
 * @returns A memoized callback that selects all canvas nodes.
 */
export function useSelectAll() {
	const { nodes, setNodes, setSelectedNodes } = useFlow();

	const selectAll = useCallback(() => {
		// Guard against empty canvas
		if (!nodes?.length) return;

		// Clone every node with its selected flag set to true
		const allNodesSelected = nodes.map((n: Node) => ({
			...n,
			selected: true,
		}));

		// Update both the node array and the selected-nodes collection in sync
		setNodes(allNodesSelected);
		setSelectedNodes(allNodesSelected);
	}, [nodes, setNodes, setSelectedNodes]);

	return selectAll;
}
