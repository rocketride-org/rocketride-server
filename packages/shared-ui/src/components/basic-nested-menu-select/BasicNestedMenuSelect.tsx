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

import { ReactElement, useState, useMemo } from 'react';
import { Box, TextField, MenuItem } from '@mui/material';
import BasicNestedMenu, { IMenuItem } from '../basic-nested-menu/BasicNestedMenu';

/**
 * Flattens a tree of {@link IMenuItem} objects into a single-level array using
 * breadth-first traversal. Only items that have both a value and a label are
 * included in the result. This is used to populate hidden MUI MenuItem elements
 * so the TextField select can display the currently selected value label.
 *
 * @param items - The hierarchical menu items to flatten.
 * @returns A flat array of items with key, value, valueLabel, and label properties.
 */
const flatten = (
	items: IMenuItem[] = []
): { key: string; value: unknown; valueLabel: string; label: string }[] => {
	const allItems: {
		key: string;
		value: unknown;
		valueLabel: string;
		label: string;
	}[] = [];
	// Seed the BFS queue with all top-level items
	const queue: IMenuItem[] = [...items];

	while (queue.length) {
		const curr = queue.shift();

		// Only collect items that represent selectable leaves (have both value and label)
		if (curr?.value && curr?.label) {
			const { key, value, label, valueLabel } = curr;
			allItems.push({
				key: key ?? '',
				value: value ?? '',
				valueLabel: valueLabel ?? '',
				label: label ?? '',
			});
		}

		// Enqueue child items to continue the breadth-first traversal
		if (curr?.items) {
			for (const next of curr.items) queue.push(next);
		}
	}

	return allItems;
};

/**
 * Props for the {@link BasicNestedMenuSelect} component.
 * Combines a text field display with a nested menu for hierarchical selection.
 */
export interface IProps {
	/** Optional label displayed on the select TextField. */
	label?: string;
	/** The currently selected item's key, used to show the matching valueLabel in the TextField. */
	keyValue: string;
	/** The hierarchical menu items available for selection. */
	items?: IMenuItem[];
	/** Callback invoked when a leaf menu item is selected, providing its key and value. */
	onChange: (key: string, value: unknown) => void;
}

/**
 * Renders a select-style input that opens a nested (multi-level) dropdown menu.
 * Combines a read-only MUI TextField (displaying the currently selected value)
 * with a {@link BasicNestedMenu} popover. This component is used wherever the UI
 * needs a form-style select widget that supports hierarchical option categories.
 *
 * @param props - The component props conforming to {@link IProps}.
 * @returns A Box containing a TextField select and an anchored BasicNestedMenu.
 */
export default function BasicNestedMenuSelect({
	label,
	keyValue = '',
	items,
	onChange,
}: IProps): ReactElement {
	// Anchor element controls both the open state and positioning of the nested menu
	const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);

	const onOpen = (event: React.MouseEvent<HTMLElement>) => {
		// Prevent default to stop MUI's native select dropdown from opening
		event.preventDefault();
		// Toggle: if already open (anchor set), close it; otherwise anchor to the clicked element
		setAnchorEl(anchorEl ? null : event.currentTarget);
	};

	const onClose = () => {
		setAnchorEl(null);
	};

	// Flatten the tree and keep only items with a valueLabel so the
	// TextField select can resolve a display label for the current selection
	const menuItems = useMemo(() => flatten(items).filter((i) => i.valueLabel), [items]);

	// Render hidden MenuItems inside the TextField select -- MUI requires
	// matching MenuItem children to display the selected value's label
	const menuItemElements = menuItems.map(
		(m) => (
			<MenuItem sx={{ display: 'none' }} key={m.key} value={m.key}>
				{m.valueLabel}
			</MenuItem>
		)
	);

	return (
		<Box sx={{ minWidth: 150, width: 1 }}>
			<TextField
				required
				fullWidth={true}
				size="small"
				label={label}
				value={keyValue}
				onMouseDown={onOpen}
				SelectProps={{
					MenuProps: {
						disableScrollLock: true,
					},
				}}
				InputProps={{
					readOnly: true,
				}}
				select
			>
				{menuItemElements}
			</TextField>
			<BasicNestedMenu
				anchorEl={anchorEl}
				items={items}
				onClose={onClose}
				onChange={onChange}
			/>
		</Box>
	);
}
