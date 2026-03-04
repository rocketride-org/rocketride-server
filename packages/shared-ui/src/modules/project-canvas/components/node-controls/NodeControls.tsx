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

import { ReactElement, useMemo } from 'react';
import { IconButton } from '@mui/material';
import { Delete, FileCopy, LayersClear } from '@mui/icons-material';
import { Node, NodeToolbar, Position } from '@xyflow/react';
import { styles } from './index.style';
import { useFlow } from '../../FlowContext';
import { NodeType } from '../../../../constants';

/**
 * Props for the NodeControls component.
 *
 * Identifies the target node and controls which action buttons are visible
 * based on node type, parent membership, and hover state.
 */
interface IProps {
	/** ID of the node these controls belong to. */
	nodeId: string;
	/** Type of the node, used to determine which buttons to show. */
	nodeType: NodeType;
	/** If set, the node belongs to a group and an "ungroup" button is shown. */
	parentId?: string;
	/** Whether the toolbar is currently visible (controlled by parent hover state). */
	isVisible?: boolean;
	/** Callback invoked when the mouse enters the toolbar area. */
	handleMouseEnter?: () => void;
	/** Callback invoked when the mouse leaves the toolbar area. */
	handleMouseLeave?: () => void;
}

/**
 * Floating toolbar displayed above a canvas node providing quick-action buttons
 * for copy, delete, and ungroup operations.
 *
 * Renders inside a ReactFlow NodeToolbar positioned above the node. The set of
 * visible buttons adapts based on the node type: group nodes hide the copy button,
 * group-type nodes hide the delete button, and the ungroup button only appears
 * for nodes that are children of a group.
 *
 * @param props - Node identity, type, parent membership, and visibility callbacks.
 * @returns The NodeToolbar with contextually appropriate action buttons.
 */
export default function NodeControls({
	nodeId,
	nodeType,
	parentId,
	isVisible,
	handleMouseEnter,
	handleMouseLeave,
}: IProps): ReactElement {
	const { deleteNodesById, ungroupNode, nodes, addNode } = useFlow();

	// Mirror the global disable flag to a local name for readability in the JSX
	const disableButtons = false;

	/**
	 * Duplicates a node by creating a copy with a slight position offset.
	 * Only works for single nodes (not multi-select). The duplicate inherits
	 * the same data and type as the original.
	 *
	 * @param nodeId - The ID of the node to duplicate.
	 */
	const copy = (nodeId: string) => {
		// Find the node to duplicate from the current nodes array
		const filteredNodes = nodes.filter((currentNode: Node) => currentNode.id === nodeId);

		if (!filteredNodes[0]) return;

		// Only single-node duplication is supported; multi-select copy is handled elsewhere
		if (filteredNodes.length === 1) {
			const { data, position, type } = filteredNodes[0];
			// Offset the duplicate slightly so it does not stack directly on top of the original
			const _position = {
				x: position.x + 10,
				y: position.y + 10,
			};

			addNode(data as Record<string, unknown>, _position, type as NodeType);
			return;
		}
	};

	/** Copy is hidden for group and remote-group nodes since they cannot be trivially duplicated. */
	const showCopyButton = useMemo(
		() => nodeType !== NodeType.Group && nodeType !== NodeType.RemoteGroup,
		[nodeType]
	);

	/** Delete is hidden for group nodes; they are removed by ungrouping instead. */
	const showDeleteButton = useMemo(() => nodeType !== NodeType.Group, [nodeType]);

	/** Ungroup is only available when the node belongs to a group (has a parentId). */
	const showUngroupButton = useMemo(() => parentId != null, [parentId]);

	return (
		<NodeToolbar
			align="center"
			offset={4}
			position={Position.Top}
			isVisible={isVisible}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			{showCopyButton && (
				<IconButton
					aria-label="copy"
					sx={styles.nodeToolbarButton}
					onClick={() => copy(nodeId)}
					disabled={disableButtons}
				>
					<FileCopy />
				</IconButton>
			)}
			{showDeleteButton && (
				<IconButton
					aria-label="delete"
					color="error"
					sx={styles.nodeToolbarButton}
					onClick={() => deleteNodesById([nodeId])}
					disabled={disableButtons}
				>
					<Delete />
				</IconButton>
			)}
			{showUngroupButton && (
				<IconButton
					aria-label="ungroup"
					sx={styles.nodeToolbarButton}
					onClick={() => ungroupNode([nodeId])}
					disabled={disableButtons}
				>
					<LayersClear />
				</IconButton>
			)}
		</NodeToolbar>
	);
}
