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

import { useCallback } from 'react';
import { Node } from '@xyflow/react';
import { useFlow } from '../../../FlowContext';
import { NodeType } from '../../../../../constants';

/**
 * Hook that provides a handler for ungrouping selected nodes on the project canvas.
 * Detaches child nodes from their parent group and then deletes the group node itself,
 * returning the children to top-level canvas positions. This is the inverse operation
 * of the useGroup hook.
 *
 * @returns A memoized callback that ungroups the current selection.
 */
export function useUngroup() {
	const { selectedNodes, ungroupNode, deleteNodesById } = useFlow();

	const ungroupHandler = useCallback(() => {
		// Collect IDs of all selected nodes to detach children from their parent groups
		const selectedNodeIds = selectedNodes.map((n: Node) => n.id);
		// Detach child nodes: clears parentId and converts positions to absolute canvas coords
		ungroupNode(selectedNodeIds);

		// After children are freed, remove the now-empty group container nodes themselves
		const groupsSelected = selectedNodes.filter((n: Node) => n.type === NodeType.Group);
		if (groupsSelected.length > 0) {
			deleteNodesById(groupsSelected.map((n: Node) => n.id));
		}
	}, [selectedNodes, ungroupNode, deleteNodesById]);

	return ungroupHandler;
}
