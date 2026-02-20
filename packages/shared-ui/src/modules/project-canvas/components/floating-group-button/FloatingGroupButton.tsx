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

import { ReactElement, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { min, max } from 'lodash';
import { Node, useReactFlow } from '@xyflow/react';
import { Box, Button } from '@mui/material';
import { Layers } from '@mui/icons-material';

import { useFlow } from '../../FlowContext';
import { NodeType } from '../../../../constants';

import styles from './index.style';

/**
 * Floating action button that allows users to group multiple selected canvas nodes.
 *
 * This component appears above the bounding box of the current node selection when
 * two or more ungrouped, non-group nodes are selected. Clicking the button invokes
 * `groupSelectedNodes` from the FlowContext, creating a new group node that contains
 * all currently selected nodes. The button is hidden when the selection includes
 * nodes that are already grouped or are group-type nodes themselves.
 *
 * @returns The floating group button element, or null if grouping is not applicable.
 */
export default function FloatingGroupButton(): ReactElement {
	const { t } = useTranslation();
	const { selectedNodes, groupSelectedNodes } = useFlow();
	const { flowToScreenPosition } = useReactFlow();

	/**
	 * Whether any of the selected nodes is already inside a group or is itself a group node.
	 * When true the group button is hidden because re-grouping is not supported.
	 */
	const isGrouped = useMemo(
		() =>
			selectedNodes.some(
				(node: Node) =>
					node.parentId ||
					NodeType.Group === node.type ||
					NodeType.RemoteGroup === node.type
			),
		[selectedNodes]
	);

	/**
	 * Bounding box (position and dimensions) that encloses all selected nodes,
	 * with padding applied. Used to position the group button and to size the
	 * new group node when grouping is triggered.
	 */
	const { x, y, width, height } = useMemo(() => {
		// Determine the extreme edges of all selected nodes to form a tight bounding box
		const minXPos: number = min(selectedNodes.map((node: Node) => node.position.x)) ?? 0;
		const minYPos: number = min(selectedNodes.map((node: Node) => node.position.y)) ?? 0;

		// Use measured dimensions so the bounding box accounts for the actual rendered size
		const maxXPos: number =
			max(selectedNodes.map((node: Node) => node.position.x + (node.measured?.width ?? 0))) ??
			0;

		const maxYPos: number =
			max(
				selectedNodes.map((node: Node) => node.position.y + (node.measured?.height ?? 0))
			) ?? 0;

		// Add 100px padding (50px on each side) so the group frame is not flush against children
		const width = maxXPos - minXPos + 100;
		const height = maxYPos - minYPos + 100;

		return {
			x: minXPos - 50,
			y: minYPos - 50,
			width,
			height,
		};
	}, [selectedNodes]);

	/**
	 * Groups the currently selected nodes into a new group node, provided none
	 * of the selected nodes are already group-type nodes. Delegates to
	 * `groupSelectedNodes` from FlowContext with the computed bounding box.
	 */
	const handleGroupNodes = useCallback(() => {
		// Guard: prevent nesting groups by checking whether any selected node is already a group
		const hasGroupNodes = selectedNodes.some(
			(node: Node) => NodeType.Group === node.type || NodeType.RemoteGroup === node.type
		);

		if (hasGroupNodes) return;

		// Delegate to FlowContext which creates a new group node with the computed bounding box
		groupSelectedNodes(
			{
				width,
				height,
			},
			{
				x,
				y,
			}
		);

	}, [selectedNodes, x, y, width, height, groupSelectedNodes]);

	/**
	 * Screen-space coordinates for positioning the floating button above the
	 * bounding box of the selected nodes. Converts from flow coordinates to
	 * screen pixels so the button stays anchored relative to the viewport.
	 */
	const { x: buttonLeft, y: buttonTop } = useMemo(
		() => flowToScreenPosition({ x: x, y: y - 60 }),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[x, y, height, width, flowToScreenPosition]
	);

	// Only show the group button when 2+ ungrouped, non-group nodes are selected
	if (selectedNodes.length < 2 || isGrouped) return null as unknown as ReactElement;

	return (
		<Box
			sx={{
				...styles.root,
				top: buttonTop,
				left: buttonLeft,
			}}
		>
			<Button
				variant="outlined"
				sx={{
					...styles.paper,
					...styles.button,
				}}
				title={t('projects.controls.groupNodes')}
				onClick={() => handleGroupNodes()}
				startIcon={<Layers />}
			>
				{t('projects.controls.groupNodes')}
			</Button>
		</Box>
	);
}
