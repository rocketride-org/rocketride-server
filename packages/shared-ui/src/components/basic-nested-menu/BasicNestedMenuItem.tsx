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

import { ReactElement, useState } from 'react';
import { Menu, MenuItem, ListItemText } from '@mui/material';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import { IMenuItem } from './BasicNestedMenu';

/**
 * Props for the {@link BasicNestedMenuItem} component.
 * Defines the data and callbacks needed to render a single item within a nested menu.
 */
interface IProps {
	/** Unique key identifying this menu item, passed back via onChange on selection. */
	itemKey: string;
	/** Display text shown for this menu item. */
	label: string;
	/** The data value associated with this item, emitted when selected. */
	value?: unknown;
	/** Child menu items. When present, clicking this item opens a submenu instead of selecting it. */
	items?: IMenuItem[];
	/** Callback invoked when a leaf item is selected, providing its key and value. */
	onChange: (key: string, value: unknown) => void;
}

/**
 * Renders a single item within a {@link BasicNestedMenu}.
 * If the item has child items, it displays a right-arrow indicator and opens
 * a submenu on click. If it is a leaf item, clicking it triggers the onChange
 * callback with the item's key and value. This component is used recursively
 * to build arbitrarily deep menu hierarchies.
 *
 * @param props - The component props conforming to {@link IProps}.
 * @returns A MenuItem that either opens a submenu or fires a selection callback.
 */
export default function BasicNestedMenuItem({
	itemKey,
	label,
	value,
	items,
	onChange,
}: IProps): ReactElement {
	// Track the DOM anchor for positioning the submenu popover
	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
	const open = Boolean(anchorEl);

	const onClick = (event: React.MouseEvent<HTMLElement>) => {
		// Only open submenu if this item has children; leaf nodes are handled separately
		if (!items?.length) {
			return;
		}
		setAnchorEl(event.currentTarget);
	};

	const handleClose = () => {
		setAnchorEl(null);
	};

	// Recursively build child menu items for the submenu tier
	const children = (items ?? []).map((c: IMenuItem) => (
		<BasicNestedMenuItem
			key={c.key}
			itemKey={c.key}
			label={c.label}
			value={c.value}
			onChange={onChange}
			items={c.items}
		/>
	));

	return (
		<>
			{/* Branch nodes open a submenu on click; leaf nodes fire the selection callback */}
			<MenuItem onClick={children.length ? onClick : () => onChange(itemKey, value)}>
				<ListItemText>{label}</ListItemText>
				{/* Show a right-arrow chevron only when this item has a submenu */}
				{children.length ? <NavigateNextIcon /> : null}
			</MenuItem>
			<Menu
				anchorOrigin={{
					vertical: 'top',
					horizontal: 'right',
				}}
				transformOrigin={{
					vertical: 'top',
					horizontal: 'left',
				}}
				open={open}
				anchorEl={anchorEl}
				onClose={handleClose}
			>
				{children}
			</Menu>
		</>
	);
}
