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

import { ReactElement } from 'react';
import { Menu } from '@mui/material';
import BasicNestedMenuItem from './BasicNestedMenuItem';

/**
 * Represents a single item within a nested menu tree.
 * Each item can be a leaf (with a value) or a branch (with child items),
 * enabling arbitrarily deep menu hierarchies for category-based selection.
 */
export interface IMenuItem {
	/** Unique identifier for the menu item, used as the React key and selection key. */
	key: string;
	/** Display text shown in the menu for this item. */
	label: string;
	/** The data value associated with this item, emitted when the item is selected. */
	value?: unknown;
	/** Human-readable label representing the selected value, used in display contexts like selects. */
	valueLabel?: string;
	/** Child menu items that form a submenu. When present, this item acts as a branch node. */
	items?: IMenuItem[];
}

/**
 * Props for the {@link BasicNestedMenu} component.
 * Controls the menu anchor positioning, item data, and selection/close callbacks.
 */
export interface IProps {
	/** The DOM element the menu is anchored to. When null, the menu is closed. */
	anchorEl: Element | null;
	/** The tree of menu items to display. */
	items?: IMenuItem[];
	/** Callback invoked when the menu should close (e.g., clicking outside). */
	onClose?: () => void;
	/** Callback invoked when a leaf menu item is selected, providing its key and value. */
	onChange: (key: string, value: unknown) => void;
}

/**
 * Renders an MUI-based nested (multi-level) dropdown menu.
 * Used wherever the UI needs hierarchical menu selection, such as category pickers
 * or grouped option lists. The menu anchors to a specified DOM element and
 * delegates rendering of individual items (including recursive submenus) to
 * {@link BasicNestedMenuItem}.
 *
 * @param props - The component props conforming to {@link IProps}.
 * @returns A positioned MUI Menu containing recursively nested menu items.
 */
export default function BasicNestedMenu({
	anchorEl,
	items,
	onClose,
	onChange,
}: IProps): ReactElement {
	// Derive open state from the anchor element -- null means closed
	const open = Boolean(anchorEl);

	// Map the hierarchical item data into BasicNestedMenuItem components,
	// defaulting to an empty array when no items are provided
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
		<Menu
			anchorOrigin={{
				vertical: 'bottom',
				horizontal: 'left',
			}}
			transformOrigin={{
				vertical: 'top',
				horizontal: 'left',
			}}
			open={open}
			anchorEl={anchorEl}
			onClose={onClose}
		>
			{children}
		</Menu>
	);
}
