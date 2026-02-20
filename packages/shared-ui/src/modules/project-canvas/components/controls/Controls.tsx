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
import { useTranslation } from 'react-i18next';
import { Panel, useReactFlow } from '@xyflow/react';
import { Box, IconButton, Paper, Tooltip, Menu, MenuItem } from '@mui/material';
import { grey } from '@mui/material/colors';
import { AddBox, MoreVert } from '@mui/icons-material';

import NoteIcon from '../../../../assets/icons/NoteIcon';
import FitIcon from '../../../../assets/icons/FitIcon';
import LockIcon from '../../../../assets/icons/LockIcon';
import styles from './index.style';
import UnockIcon from '../../../../assets/icons/UnlockIcon';
import OpenLogsButton from '../OpenLogsButton';
import ZoomOutIcon from '../../../../assets/icons/ZoomOutIcon';
import ZoomInIcon from '../../../../assets/icons/ZoomInIcon';
import CurveArrowIcon from '../../../../assets/icons/CurveArrowIcon';

/**
 * Represents a single entry in the "more options" overflow menu
 * within the canvas controls toolbar.
 */
interface MoreOption {
	/** Callback invoked when this menu item is clicked. */
	handleClick: () => void;
	/** Display label for the menu item. */
	label: string;
}

/**
 * Props for the Controls component.
 * Configures which toolbar buttons are shown and their associated callbacks.
 */
interface IProps {
	/** Display name of the current pipeline item (used for context). */
	itemName?: string;
	/** Whether the canvas is currently locked (user-controlled). When true, edits are disabled. */
	isLocked?: boolean;
	/** Callback to toggle the canvas lock. If undefined, the lock button is hidden. */
	handleLock?: () => void;
	/** When true, renders the log history button in the toolbar. */
	enableLog?: boolean;
	/** When true, the save button is disabled (e.g., because there are no changes). */
	disableSave?: boolean;
	/** When true, the Save As option is disabled. */
	disableSaveAs?: boolean;
	/** Additional overflow menu options rendered under the "more" button. */
	moreOptions?: MoreOption[];
	/** Callback to open the create-node panel. If undefined, the add-node button is hidden. */
	addNode?: () => void;
	/** Callback to add an annotation note to the canvas. If undefined, the button is hidden. */
	addAnnotationNote?: () => void;
	/** Callback to undo the last change. If undefined, the undo button is hidden. */
	undo?: () => void;
	/** Callback to redo the last undone change. If undefined, the redo button is hidden. */
	redo?: () => void;
	/** Whether to show the fit-to-view button. Defaults to true. */
	enableFitView?: boolean;
	/** Whether to show the zoom in/out buttons. Defaults to true. */
	enableZoom?: boolean;
}

/**
 * Renders the bottom-center controls toolbar on the ReactFlow canvas.
 * Contains buttons for adding nodes, adding annotations, viewing logs,
 * locking/unlocking the canvas, fit-to-view, zoom in/out, undo/redo,
 * and an overflow "more options" menu. Button visibility is controlled
 * by the feature flags and callbacks passed through props.
 *
 * @param props - Toolbar configuration and action callbacks.
 * @returns The rendered controls toolbar panel.
 */
export default function Controls({
	enableLog,
	isLocked,
	addNode,
	addAnnotationNote,
	handleLock,
	undo,
	redo,
	moreOptions,
	enableFitView = true,
	enableZoom = true,
}: IProps): ReactElement {
	const { t } = useTranslation();
	// Access ReactFlow viewport manipulation methods for fit-to-view and zoom controls
	const { fitView, zoomOut, zoomIn } = useReactFlow();

	// Anchor element state for the "more options" overflow menu
	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
	const isMenuOpen = Boolean(anchorEl);

	/** Opens the "more options" overflow menu anchored to the clicked element. */
	const handleMenuClick = (event: React.MouseEvent<HTMLElement>) => {
		setAnchorEl(event.currentTarget);
	};

	/** Closes the "more options" overflow menu. */
	const handleMenuClose = () => {
		setAnchorEl(null);
	};

	// Only render the overflow menu section if there are options to show
	const showMoreOptionsBlock = moreOptions && moreOptions.length > 0;

	return (
		<Panel style={styles.root} position="bottom-center">
			<Paper id="canvas-controls" style={styles.paper}>
				<Box sx={styles.box}>
					{addNode && (
						<Tooltip title={t('flow.tooltip.addNode')}>
							<IconButton
								onClick={() => addNode()}
								size="small"
								sx={{
									...styles.iconButton,
									...styles.addNodeButton,
									...styles.shrinkMuiIconButton,
								}}
							>
								<AddBox color={'primary'} fontSize="large" />
							</IconButton>
						</Tooltip>
					)}
					{addAnnotationNote && (
						<Tooltip title={t('flow.tooltip.createNote')}>
							<IconButton
								onClick={() => addAnnotationNote()}
								size="small"
								sx={{
									...styles.iconButton,
								}}
							>
								<NoteIcon color={grey[700]} />
							</IconButton>
						</Tooltip>
					)}
					{enableLog && (
						<OpenLogsButton styles={{ iconButton: styles.shrinkMuiIconButton }} />
					)}
					{handleLock && (
						<Tooltip
							title={isLocked ? t('flow.tooltip.unlock') : t('flow.tooltip.lock')}
						>
							<IconButton
								onClick={handleLock}
								aria-label={
									isLocked ? t('flow.tooltip.unlock') : t('flow.tooltip.lock')
								}
								size="small"
								sx={styles.iconButton}
							>
								{isLocked ? (
									<LockIcon color={grey[700]} />
								) : (
									<UnockIcon color={grey[700]} />
								)}
							</IconButton>
						</Tooltip>
					)}
				</Box>
				<Box
					sx={{
						...styles.box,
						borderRight: showMoreOptionsBlock ? '1px solid rgba(0,0,0,0.25)' : 'none',
					}}
				>
					{enableFitView && (
						<Tooltip title={t('flow.tooltip.fitScreen')}>
							<IconButton
								aria-label={t('flow.tooltip.fitScreen')}
								onClick={() => fitView()}
								size="small"
								sx={styles.iconButton}
							>
								<FitIcon color={grey[700]} />
							</IconButton>
						</Tooltip>
					)}
					{enableZoom && (
						<>
							<Tooltip title={t('flow.tooltip.zoomOut')}>
								<IconButton
									onClick={() => zoomOut()}
									size="small"
									sx={{ ...styles.iconButton }}
								>
									<ZoomOutIcon color={grey[700]} />
								</IconButton>
							</Tooltip>
							<Tooltip title={t('flow.tooltip.zoomIn')}>
								<IconButton
									onClick={() => zoomIn()}
									size="small"
									sx={{ ...styles.iconButton }}
								>
									<ZoomInIcon color={grey[700]} />
								</IconButton>
							</Tooltip>
						</>
					)}
					{undo && (
						<Tooltip title={t('flow.tooltip.undo')}>
							<IconButton
								onClick={() => undo()}
								size="small"
								sx={{ ...styles.iconButton }}
							>
								<CurveArrowIcon color={grey[700]} />
							</IconButton>
						</Tooltip>
					)}
					{redo && (
						<Tooltip title={t('flow.tooltip.redo')}>
							<IconButton
								onClick={() => redo()}
								size="small"
								sx={{ ...styles.iconButton }}
							>
								<CurveArrowIcon
									color={grey[700]}
									style={{ transform: 'scaleX(-1)' }}
								/>
							</IconButton>
						</Tooltip>
					)}
				</Box>
				{showMoreOptionsBlock && (
					<Box sx={styles.box}>
						{moreOptions && moreOptions.length > 0 && (
							<>
								<Tooltip title={t('flow.tooltip.moreOptions')}>
									<IconButton
										aria-label={t('flow.tooltip.moreOptions')}
										onClick={handleMenuClick}
										disabled={false}
										sx={{
											...styles.iconButton,
											...styles.shrinkMuiIconButton,
										}}
									>
										<MoreVert sx={styles.muiIcon} />
									</IconButton>
								</Tooltip>

								<Menu
									anchorEl={anchorEl}
									open={isMenuOpen}
									onClose={handleMenuClose}
									MenuListProps={{
										'aria-labelledby': 'more-options-button',
									}}
								>
									{moreOptions.map(({ handleClick, label }) => (
										<MenuItem
											key={label}
											onClick={() => {
												handleClick();
												handleMenuClose();
											}}
										>
											{label}
										</MenuItem>
									))}
								</Menu>
							</>
						)}
					</Box>
				)}
			</Paper>
		</Panel>
	);
}
