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

import { ReactElement, useState } from 'react';
import { Node as NodeProps, NodeResizer } from '@xyflow/react';
import { Box, IconButton, Tooltip } from '@mui/material';
import { LockOpen, Lock, LayersClear, DeleteOutline } from '@mui/icons-material';
import { NodeType } from '../../../../../constants';
import { useFlow } from '../../../FlowContext';
import { brandOrange } from '../../../../../theme';
import { useTranslation } from 'react-i18next';

/**
 * Data shape for a group node, extending base node data with an optional
 * lock flag that prevents resizing and child rearrangement.
 */
interface GroupNodeData {
	isLocked?: boolean;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	[key: string]: any;
}

/**
 * Props for the GroupNode component, combining React Flow node props
 * with the group-specific data shape and a discriminated node type.
 */
interface IProps extends NodeProps<GroupNodeData> {
	type: NodeType;
}

/** Styles for the outer container that fills the group node's allocated space. */
const containerStyles = {
	height: '100%',
	left: 0,
	position: 'absolute',
	top: 0,
	width: '100%',
};

/** Styles for the toolbar that floats above the group, containing lock/delete/ungroup buttons. */
const buttonContainerStyles = {
	alignItems: 'center',
	display: 'flex',
	justifyContent: 'space-between',
	left: 0,
	position: 'absolute',
	top: -28,
	width: '100%',
	zIndex: 10,
};

/**
 * Renders a resizable group node on the project canvas that can contain
 * other nodes. Provides lock, delete, and ungroup controls in a floating
 * toolbar that appears on hover or selection. When locked, the group
 * cannot be resized to prevent accidental layout changes.
 *
 * @param id - Unique identifier of this group node.
 * @param data - Group node data including the optional `isLocked` flag.
 */
export default function GroupNode({ id, data }: IProps): ReactElement {
	const { t } = useTranslation();
	const { selectedNodeId, toggleGroupLock, deleteNodesById } = useFlow();
	const [isHovered, setIsHovered] = useState(false);
	// Default to unlocked if isLocked is not explicitly set in the node data
	const isLocked = data?.isLocked !== undefined ? data.isLocked : false;

	// Determine selection state to decide whether to show the floating toolbar
	const isSelected = selectedNodeId === id;

	/** Toggles the lock state of the group, preventing or allowing resize operations. */
	const handleLockToggle = () => {
		toggleGroupLock?.(id);
	};

	/** Deletes the group node and all of its child nodes from the canvas. */
	const handleDelete = () => {
		// Second argument `true` means also delete children inside the group
		deleteNodesById?.([id], true);
	};

	/** Removes the group container while keeping its child nodes intact on the canvas. */
	const handleUngroup = () => {
		// Second argument `false` means keep children on the canvas after removing the group
		deleteNodesById?.([id], false);
	};

	const groupNodeStyles = {
		borderRadius: '4px',
		height: '100%',
		position: 'relative',
		width: '100%',
		'&:hover': {
			outline: `1px dashed ${brandOrange}`,
		},
	};

	const lockedTooltip = isLocked ? t('projects.groups.unlock') : t('projects.groups.lock');

	return (
		<Box
			sx={containerStyles}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			{!isLocked && <NodeResizer minWidth={100} minHeight={80} />}
			{(isSelected || isHovered) && (
				<Box sx={buttonContainerStyles}>
					<Box>
						<Tooltip title={lockedTooltip as string}>
							<IconButton onClick={handleLockToggle} size="small">
								{isLocked ? (
									<Lock fontSize="small" />
								) : (
									<LockOpen fontSize="small" />
								)}
							</IconButton>
						</Tooltip>
						<Tooltip title={t('projects.groups.delete')}>
							<IconButton
								onClick={handleDelete}
								size="small"
								disabled={false}
							>
								<DeleteOutline fontSize="small" />
							</IconButton>
						</Tooltip>
						<Tooltip title={t('projects.groups.ungroup')}>
							<IconButton
								onClick={handleUngroup}
								size="small"
								disabled={false}
							>
								<LayersClear fontSize="small" />
							</IconButton>
						</Tooltip>
					</Box>
				</Box>
			)}
			<Box sx={groupNodeStyles}>{/* Content of the group node can go here if needed */}</Box>
		</Box>
	);
}
