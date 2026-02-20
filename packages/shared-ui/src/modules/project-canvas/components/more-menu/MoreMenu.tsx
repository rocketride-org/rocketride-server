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
import { IconButton, Menu, MenuItem, SxProps, Typography, Divider } from '@mui/material';
import { MoreVert } from '@mui/icons-material';
import pxToRem from '../../../../utils/pxToRem';

import KeyboardChip from '../KeyboardChip';
import { Option } from '../../../../types/ui';

/**
 * Props for the MoreMenu component.
 *
 * Configures the list of menu items, the disabled state of the trigger button,
 * and optional style overrides for the icon button.
 */
interface IProps {
	/** Array of menu option definitions including labels, click handlers, keyboard shortcuts, and disabled state. */
	options: Option[];
	/** When true the trigger icon button is disabled and the menu cannot be opened. */
	isDisabled?: boolean;
	/** Optional MUI sx overrides applied to the trigger IconButton. */
	buttonSx?: SxProps;
}

/**
 * A generic "more options" overflow menu rendered as a vertical-dots icon button.
 *
 * Used throughout the project canvas (e.g. in node headers) to surface contextual
 * actions such as open, duplicate, delete, and documentation links. Each menu item
 * can display a label, optional keyboard shortcut chips, and a disabled state.
 * Special "border" label entries render as visual dividers between option groups.
 *
 * @param props - Menu options, disabled flag, and optional button styling.
 * @returns The icon button and its associated popover menu.
 */
export default function MoreMenu({ options, isDisabled, buttonSx }: IProps): ReactElement {
	const { t } = useTranslation();

	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
	const isMenuOpen = Boolean(anchorEl);

	/**
	 * Opens the menu by setting the anchor element and stops event propagation
	 * so the click does not bubble up to parent node handlers.
	 */
	const handleMenuClick = (event: React.MouseEvent<HTMLElement>) => {
		// Prevent the click from propagating to the canvas/node and triggering selection or drag
		event.stopPropagation();

		// Anchor the menu popup to the button that was clicked
		setAnchorEl(event.currentTarget);
	};

	/** Closes the menu by clearing the anchor element. */
	const handleMenuClose = () => {
		setAnchorEl(null);
	};

	return (
		<>
			{/* Stop mouseDown propagation separately so ReactFlow does not initiate a node drag */}
			<IconButton
				aria-label={t('common.moreMenu.moreOptions')}
				onMouseDown={(event) => {
					event.stopPropagation();
				}}
				onClick={handleMenuClick}
				disabled={isDisabled}
				sx={{ ...buttonSx }}
			>
				<MoreVert sx={{ fontSize: '1.75rem' }} />
			</IconButton>
			<Menu
				anchorEl={anchorEl}
				open={isMenuOpen}
				onClose={(
					event: React.MouseEvent<HTMLElement>,
					reason: 'backdropClick' | 'escapeKeyDown'
				) => {
					// Only stop propagation on backdrop clicks to prevent the click from
					// reaching the canvas; Escape key does not produce a positional event
					if (reason === 'backdropClick') {
						event.stopPropagation();
					}

					handleMenuClose();
				}}
				MenuListProps={{
					'aria-labelledby': 'more-options-button',
					sx: {
						padding: `${pxToRem(6)}rem`,
					},
				}}
			>
				{options.map(({ handleClick, label, keys, disabled }, index) => {
					// Special sentinel value: "border" entries render as horizontal dividers
					if (label === 'border') {
						return (
							<Divider key={index} component="li" sx={{ margin: '0 !important' }} />
						);
					}

					return (
						<MenuItem
							key={index}
							disabled={disabled}
							onClick={(event) => {
								// Prevent click from reaching the canvas or node beneath the menu
								event.stopPropagation();

								if (!handleClick) {
									return;
								}

								// Execute the action and close the menu in sequence
								handleClick(event);
								handleMenuClose();
							}}
							sx={{
								display: 'flex',
								justifyContent: 'space-between',
							}}
						>
							<Typography
								sx={{
									fontWeight: 800,
									fontSize: '0.75rem',
								}}
							>
								{label}{' '}
							</Typography>
							<Typography sx={{ fontSize: '0.725rem' }}>
								{keys &&
									keys.length !== 0 &&
									keys.map((value: string, index: number) => (
										<KeyboardChip key={index} text={value} />
									))}
							</Typography>
						</MenuItem>
					);
				})}
			</Menu>
		</>
	);
}
