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

import { MouseEvent, ReactElement, ReactNode, useState } from 'react';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { Divider, ListItemIcon, ListItemText } from '@mui/material';

import { Option } from '../../types/ui';

/**
 * Props for the {@link DropdownMenu} component.
 * Defines the trigger button appearance and the menu content (either children or options).
 */
interface IProps {
	/** Unique identifier used to generate accessible HTML IDs for the button and menu. */
	id: string | number;
	/** Text label displayed on the trigger button. */
	label: string;
	/** Optional custom children rendered inside the Menu, taking precedence over options. */
	children?: ReactNode;
	/** Optional icon rendered to the left of the label inside the trigger button. */
	icon?: ReactNode;
	/** Declarative option list rendered as MenuItems when no children are provided. */
	options?: Option[];
}

/**
 * Renders a button that opens a dropdown menu on click.
 * Supports two modes: either render custom children inside the menu, or
 * pass an array of {@link Option} objects to automatically generate MenuItems
 * (with optional icons and dividers). Used throughout the application for
 * action menus, toolbar dropdowns, and context-style menus.
 *
 * @param props - The component props conforming to {@link IProps}.
 * @returns A Button and an associated Menu with ARIA attributes for accessibility.
 */
export default function DropdownMenu({ id, label, icon, children, options }: IProps): ReactElement {
	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
	const open = Boolean(anchorEl);

	const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
		setAnchorEl(event.currentTarget);
	};

	const handleClose = () => {
		setAnchorEl(null);
	};

	// Generate deterministic ARIA IDs from the component id prop
	const buttonId = `dropdown-menu-button-${id}`;
	const menuId = `dropdown-menu-${id}`;

	return (
		<>
			<Button
				id={buttonId}
				aria-controls={open ? menuId : undefined}
				aria-haspopup="true"
				aria-expanded={open ? 'true' : undefined}
				onClick={handleClick}
				variant="outlined"
				color="secondary"
				sx={{ backgroundColor: '#fff', minWidth: ' fit-content' }}
			>
				<span style={{ display: 'inline-flex', marginRight: '0.5rem' }}>{icon}</span>
				{label}
			</Button>
			<Menu
				id={menuId}
				anchorEl={anchorEl}
				open={open}
				onClose={handleClose}
				slotProps={{
					paper: {
						'aria-labelledby': buttonId,
					},
				}}
			>
				{/* Prefer custom children; fall back to auto-generated items from options */}
				{children}
				{!children &&
					options &&
					options.length > 0 &&
					options.map(({ label, disabled, icon, handleClick }, index) => {
						// Sentinel label "border" renders a visual divider instead of a menu item
						if (label === 'border') {
							return (
								<Divider
									key={index}
									component="li"
									sx={{ margin: '0 !important' }}
								/>
							);
						}
						return (
							<MenuItem
								key={index}
								disabled={disabled}
								onClick={(event) => {
									// Guard: skip if no click handler was provided for this option
									if (!handleClick) {
										return;
									}

									// Execute the option's handler then close the menu
									handleClick(event);
									handleClose();
								}}
							>
								{icon && (
									<ListItemIcon
										sx={{
											width: '1.75rem',
											height: 'auto',
											marginRight: '0.85rem',
											display: 'flex',
											justifyConent: 'center',
											alignItems: 'center',
											minWidth: 'unset !important',
										}}
									>
										{icon}
									</ListItemIcon>
								)}
								{label && (
									<ListItemText
										sx={{
											fontWeight: 800,
											fontSize: '0.75rem',
										}}
									>
										{label}
									</ListItemText>
								)}
							</MenuItem>
						);
					})}
			</Menu>
		</>
	);
}
