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

import { ReactElement, useMemo } from 'react';
import { Grid, Button } from '@mui/material';
import { IQueryBuilderData, IQueryBuilderConfig, IQueryBuilderConfigFlat } from './types';
import { QueryBuilderItem } from './QueryBuilderItem';
import { IMenuItem } from '../basic-nested-menu/BasicNestedMenu';
import QueryBuilderDraggableContainer from './QueryBuilderDraggableContainer';
import QueryBuilderDraggable from './QueryBuilderDraggable';
import { arrayMove } from '@dnd-kit/sortable';
import { uuid } from '../../utils/uuid';
import { SxProps } from '@mui/material';
import { buildMenuItems, findFirstConfigWithValue, flattenConfig } from './helpers';

/**
 * Props for the {@link QueryBuilder} component.
 */
export interface IProps {
	/** Optional MUI `sx` styling overrides applied to the root container. */
	sx?: SxProps;
	/** Label text displayed on the "Add Query" button at the bottom of the builder. */
	addLabel: string;
	/** The current list of query rows, each representing a user-configured filter condition. */
	data: IQueryBuilderData[];
	/** Callback invoked whenever the query data changes (add, remove, reorder, or edit a row). */
	onChange: (data: IQueryBuilderData[]) => void;
	/** Hierarchical configuration defining available fields, operators, and units. */
	config: IQueryBuilderConfig[];
}

/**
 * A dynamic, drag-and-drop query builder component that allows users to construct
 * multiple filter conditions against a configurable set of fields. Each row lets the
 * user select a field from a nested menu, choose an operator and optional unit, and
 * enter a filter value. Rows can be reordered via drag-and-drop or removed individually.
 *
 * Used in data-filtering UIs where users need to build complex, multi-condition queries.
 *
 * @param props - See {@link IProps} for available props.
 * @returns The rendered query builder with draggable filter rows and an add button.
 */
export default function QueryBuilder({
	sx,
	addLabel,
	data,
	onChange,
	config,
}: IProps): ReactElement {
	const items = data;

	// Flatten config so we have a fast lookup
	const flat: IQueryBuilderConfigFlat = useMemo(() => flattenConfig(config), [config]);

	// Create menu items
	const menuItems: IMenuItem[] = useMemo(() => buildMenuItems(config), [config]);

	// Finds the first config in the tree with a value
	const firstConfig = useMemo(
		() => findFirstConfigWithValue(config),
		[config]
	);

	/**
	 * Constructs or updates a query row by merging previous item state with new partial data.
	 * Automatically resets the value when the field selection changes, and defaults the
	 * operator/unit to the first available option when a new field is selected.
	 *
	 * @param itemConfig - The configuration for the currently selected field.
	 * @param prevItem - The previous state of the query row.
	 * @param data - Partial data to merge into the row (e.g., new select, operator, or value).
	 * @returns The fully constructed query row data object.
	 */
	const _buildItem = (
		itemConfig: IQueryBuilderConfig,
		prevItem: Partial<IQueryBuilderData>,
		data: Partial<IQueryBuilderData> = {}
	): IQueryBuilderData => {
		// Merge previous row state with incoming partial changes
		const updatedItem = { ...prevItem, ...data };

		// Reset value if select changed, since the old value is no longer valid
		// for the newly selected field type
		if (data.selectKey) {
			updatedItem.value = '';
		}

		// Auto-select the first available operator when the field changes,
		// or when the row is being initialized and no operator has been set yet
		if (
			(data.select && itemConfig?.operator) ||
			(!prevItem.operator && !data.operator && itemConfig?.operator)
		) {
			updatedItem.operator = itemConfig.operator[0].value;
		}

		// Auto-select the first available unit when the field changes,
		// or when the row is being initialized and no unit has been set yet
		if (
			(data.select && itemConfig?.unit) ||
			(!prevItem.unit && !data.unit && itemConfig?.unit)
		) {
			updatedItem.unit = itemConfig.unit[0].value;
		}

		return updatedItem as IQueryBuilderData;
	};

	/**
	 * Handles changes to a single query row at the given index. Resolves the correct
	 * field configuration, builds the updated row, and propagates the change upstream.
	 *
	 * @param index - The zero-based index of the row being changed.
	 * @param data - The partial data representing the change (e.g., new operator or value).
	 * @throws Error if a new selectKey is provided that does not exist in the flat config.
	 */
	const _onChange = (index: number, data: Partial<IQueryBuilderData>) => {
		// Guard: reject unknown field keys to catch config mismatches early
		if (data.select && data.selectKey && !(data.selectKey in flat)) {
			throw new Error(`Config does not contain "${data.select}"`);
		}

		// Clone the items array to avoid mutating the current state
		const updatedItems = [...items];
		const prevItem = updatedItems[index];

		// Resolve the field config: use the new selectKey if the field changed,
		// otherwise fall back to the existing row's selectKey
		const itemConfig: IQueryBuilderConfig = data.selectKey
			? flat[data.selectKey]
			: flat[prevItem.selectKey];
		const updatedItem = _buildItem(itemConfig, prevItem, data);

		updatedItems[index] = updatedItem;

		onChange(updatedItems);
	};

	/**
	 * Removes a query row by its unique identifier.
	 *
	 * @param id - The unique ID of the row to remove.
	 */
	const onClickRemove = (id: string) => {
		onChange(items.filter((data: IQueryBuilderData) => data.id !== id));
	};

	const itemElements = items.map((data: IQueryBuilderData, index: number) => (
		<QueryBuilderDraggable key={data.id} id={data.id} onClickRemove={onClickRemove}>
			<QueryBuilderItem
				config={flat[data.selectKey]}
				index={index}
				data={data}
				menuItems={menuItems}
				onChange={_onChange}
			/>
		</QueryBuilderDraggable>
	));

	/**
	 * Appends a new query row initialized with the first available config field.
	 * Generates a unique ID for the row and applies default operator/unit values.
	 */
	const onClickAddQuery = () => {
		// Bail out if no selectable field exists in the config tree
		if (!firstConfig) return;
		// Extract field identifiers from the first available leaf config
		const configValue = firstConfig.value as Record<string, string>;
		const item: IQueryBuilderData = {
			id: `item-${uuid()}`,
			selectKey: firstConfig.key,
			select: configValue.select ?? '',
			column: configValue.column ?? '',
			value: '',
		};
		// Apply default operator/unit via _buildItem before appending the new row
		const updatedItem = _buildItem(firstConfig, item);
		onChange([...items, updatedItem]);
	};

	/**
	 * Reorders query rows by moving the item at index `a` to index `b`.
	 * Invoked by the drag-and-drop container when the user finishes dragging a row.
	 *
	 * @param a - The original index of the dragged item.
	 * @param b - The target index where the item should be placed.
	 */
	const onReorder = (a: number, b: number) => {
		onChange(arrayMove(items, a, b));
	};

	return (
		<Grid container sx={sx} spacing={1} direction="column">
			<Grid item>
				<QueryBuilderDraggableContainer items={items} onReorder={onReorder}>
					{itemElements}
				</QueryBuilderDraggableContainer>
			</Grid>
			<Grid item>
				<Button variant="outlined" fullWidth={true} onClick={onClickAddQuery}>
					{addLabel}
				</Button>
			</Grid>
		</Grid>
	);
}
