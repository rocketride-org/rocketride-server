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

/**
 * Generic "more options" overflow menu (vertical dots icon button).
 *
 * Used in node headers and other canvas elements to surface contextual
 * actions such as open, duplicate, delete, and documentation links.
 * Each menu item can display a label, optional keyboard shortcut chips,
 * and a disabled state. Special "border" label entries render as dividers.
 */

import React, { ReactElement, useState } from 'react';
import { Menu, MenuItem, SxProps, Divider } from '@mui/material';
import { MoreVertical } from 'lucide-react';

import { Option } from '../../../../../../../types/ui';
import KeyboardChip from '../KeyboardChip';

// =============================================================================
// Types
// =============================================================================

/**
 * Props for the MoreMenu component.
 */
interface IMoreMenuProps {
	/** Menu option definitions including labels, click handlers, keyboard shortcuts, and disabled state. */
	options: Option[];
	/** When true the trigger icon button is disabled. */
	isDisabled?: boolean;
	/** Optional MUI sx overrides applied to the trigger IconButton. */
	buttonSx?: SxProps;
}

// =============================================================================
// Component
// =============================================================================

export default function MoreMenu({ options, isDisabled, buttonSx }: IMoreMenuProps): ReactElement {
	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
	const isMenuOpen = Boolean(anchorEl);

	/** Opens the menu, stopping propagation to prevent node selection/drag. */
	const handleMenuClick = (event: React.MouseEvent<HTMLElement>) => {
		event.stopPropagation();
		setAnchorEl(event.currentTarget);
	};

	/** Closes the menu by clearing the anchor element. */
	const handleMenuClose = () => {
		setAnchorEl(null);
	};

	return (
		<>
			<button aria-label="More options" onMouseDown={(event) => event.stopPropagation()} onClick={handleMenuClick} disabled={isDisabled} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', ...(typeof buttonSx === 'object' && !Array.isArray(buttonSx) ? (buttonSx as React.CSSProperties) : {}) }}>
				<MoreVertical size={18} />
			</button>

			<Menu
				anchorEl={anchorEl}
				open={isMenuOpen}
				onClose={(event: React.MouseEvent<HTMLElement>, reason: 'backdropClick' | 'escapeKeyDown') => {
					if (reason === 'backdropClick') event.stopPropagation();
					handleMenuClose();
				}}
				MenuListProps={{
					'aria-labelledby': 'more-options-button',
					sx: { padding: '6px' },
				}}
			>
				{options.map(({ handleClick, label, keys, disabled }, index) => {
					// "border" entries render as horizontal dividers
					if (label === 'border') {
						return <Divider key={index} component="li" sx={{ margin: '0 !important' }} />;
					}

					return (
						<MenuItem
							key={index}
							disabled={disabled}
							onClick={(event) => {
								event.stopPropagation();
								if (!handleClick) return;
								handleClick(event);
								handleMenuClose();
							}}
							sx={{ display: 'flex', justifyContent: 'space-between' }}
						>
							<span style={{ fontWeight: 800, fontSize: '0.75rem' }}>{label} </span>
							<span style={{ fontSize: '0.725rem' }}>{keys?.length ? keys.map((value: string, i: number) => <KeyboardChip key={i} text={value} />) : null}</span>
						</MenuItem>
					);
				})}
			</Menu>
		</>
	);
}
