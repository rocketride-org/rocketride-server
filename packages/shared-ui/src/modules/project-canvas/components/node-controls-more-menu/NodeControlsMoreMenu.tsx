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

import { MouseEvent, ReactElement, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHoriz } from '@mui/icons-material';
import { IconButton, List, ListItemButton, Popover, Typography } from '@mui/material';

import { styles } from './index.style';
import { styles as controlStyles } from '../node-controls/index.style';
import { useFlow } from '../../FlowContext';
import { NodeType } from '../../../../constants';

/**
 * Props for the NodeControlsMoreMenu component.
 *
 * Identifies the target node so the menu can dispatch the correct actions
 * and conditionally render menu items based on the node type.
 */
export interface IProps {
	/** ID of the node this menu belongs to. */
	nodeId: string;
	/** Type of the node, used to conditionally show menu items (e.g. "Open" for default nodes). */
	nodeType: NodeType;
}

/**
 * Secondary "more options" popover menu rendered as a horizontal-dots icon inside
 * the node controls toolbar.
 *
 * Provides additional node-level actions such as opening the node editor panel.
 * Only the "Open" action is currently enabled, and it is restricted to default
 * (non-group) node types. Placeholder menu items for duplicate and documentation
 * are included as commented-out code for future implementation.
 *
 * @param props - The node ID and node type.
 * @returns The icon button and its associated popover menu.
 */
export default function NodeControlsMoreMenu({ nodeId: _nodeId, nodeType }: IProps): ReactElement {
	const { onEditNode } = useFlow();

	const { t } = useTranslation();
	const [anchorEl, setAnchorEl] = useState<HTMLButtonElement | null>(null);

	const open = Boolean(anchorEl);
	const id = open ? 'simple-popover' : undefined;

	/** Closes the popover menu by clearing the anchor element. */
	const handleClose = () => {
		setAnchorEl(null);
	};

	return (
		<>
			<IconButton
				aria-label="more options"
				aria-describedby={`${id}-more-button`}
				sx={controlStyles.nodeToolbarButton}
			>
				<MoreHoriz
					onClick={(event: MouseEvent<SVGSVGElement>) =>
						setAnchorEl(event.currentTarget as unknown as HTMLButtonElement)
					}
				/>
			</IconButton>
			<Popover
				id={`${id}-more-button`}
				open={Boolean(anchorEl)}
				anchorEl={anchorEl}
				onClose={handleClose}
				anchorOrigin={{
					vertical: 'top',
					horizontal: 'right',
				}}
				transformOrigin={{
					vertical: 'bottom',
					horizontal: 'left',
				}}
			>
				<List onBlur={handleClose} onFocus={(e) => e.stopPropagation()} tabIndex={0}>
					{nodeType === NodeType.Default && (
						<ListItemButton
							sx={styles.menuItemButton}
							onClick={() => {
								onEditNode();
								handleClose();
							}}
						>
							<Typography sx={styles.menuItemText}>
								{t('projects.nodeControls.open')}
							</Typography>
						</ListItemButton>
					)}
					{/* <ListItemButton sx={styles.menuItemButton} disable={disableButtons}>
						<Typography sx={styles.menuItemText}>
							{t('projects.nodeControls.duplicate')}
						</Typography>
					</ListItemButton>
					<ListItemButton sx={styles.menuItemButton}>
						<Typography sx={styles.menuItemText}>
							{t('projects.nodeControls.documentation')}
						</Typography>
					</ListItemButton> */}
				</List>
			</Popover>
		</>
	);
}
