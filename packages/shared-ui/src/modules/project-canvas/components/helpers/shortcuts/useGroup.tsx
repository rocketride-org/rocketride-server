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
import { min, max } from 'lodash';
import { useFlow } from '../../../FlowContext';
import { NodeType } from '../../../../../constants';

/**
 * Hook that provides a handler for grouping the currently selected canvas nodes.
 * Calculates a bounding box around all selected nodes and delegates to the flow
 * context's groupSelectedNodes method. Grouping is skipped when the selection
 * already contains group/remote-group nodes or nodes that belong to an existing group,
 * preventing nested or conflicting group hierarchies.
 *
 * @returns A memoized callback that groups the current selection into a new group node.
 */
export function useGroup() {
	const { selectedNodes, groupSelectedNodes } = useFlow();

	const groupHandler = useCallback(() => {
		if (selectedNodes.length === 0) return;

		// Prevent grouping if the selection already contains group nodes (would nest groups)
		const hasGroupNodes = selectedNodes.some(
			(node: Node) => NodeType.Group === node.type || NodeType.RemoteGroup === node.type
		);

		// Prevent grouping nodes that already belong to another group (would steal children)
		const hasNodesWithParents = selectedNodes.some((node: Node) => !!node.parentId);

		if (hasGroupNodes || hasNodesWithParents) return;

		// Compute the bounding box of all selected nodes to determine group size and position
		const minXPos: number = min(selectedNodes.map((node: Node) => node.position.x)) ?? 0;
		const minYPos: number = min(selectedNodes.map((node: Node) => node.position.y)) ?? 0;
		const maxXPos: number =
			max(selectedNodes.map((node: Node) => node.position.x + (node.measured?.width ?? 0))) ??
			0;
		const maxYPos: number =
			max(
				selectedNodes.map((node: Node) => node.position.y + (node.measured?.height ?? 0))
			) ?? 0;

		// Add 100px padding (50px on each side) so child nodes sit comfortably inside
		const width = maxXPos - minXPos + 100;
		const height = maxYPos - minYPos + 100;
		// Position the group 50px before the top-left corner of the bounding box to center the padding
		groupSelectedNodes({ width, height }, { x: minXPos - 50, y: minYPos - 50 });
	}, [selectedNodes, groupSelectedNodes]);

	return groupHandler;
}
