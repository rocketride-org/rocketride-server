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
import { Grid } from '@mui/material';
import { IQueryBuilderConfig, IQueryBuilderData } from './types';
import BasicNestedMenuSelect from '../basic-nested-menu-select/BasicNestedMenuSelect';
import { QueryBuilderOperator } from './QueryBuilderOperator';
import { QueryBuilderUnit } from './QueryBuilderUnit';
import { QueryBuilderInput } from './QueryBuilderInput';
import { IMenuItem } from '../basic-nested-menu/BasicNestedMenu';

/**
 * Props for the {@link QueryBuilderItem} component.
 */
interface IQueryBuilderItemProps {
	/** Configuration for the currently selected field, providing operator/unit/type metadata. */
	config: IQueryBuilderConfig;
	/** Zero-based index of this row within the query builder's data array. */
	index: number;
	/** Nested menu items for the field selector dropdown, built from the config tree. */
	menuItems: IMenuItem[];
	/** The current data state for this query row. */
	data: IQueryBuilderData;
	/** Callback invoked when any part of this row changes (field, operator, value, or unit). */
	onChange: (index: number, data: Partial<IQueryBuilderData>) => void;
}

/**
 * Renders a single query builder row, composing the field selector (nested menu),
 * an optional operator dropdown, the value input control, and an optional unit dropdown
 * into a horizontal layout. Acts as the coordination layer between the row's sub-components,
 * translating individual field changes into the unified onChange callback.
 *
 * @param props - See {@link IQueryBuilderItemProps} for available props.
 * @returns A horizontal Grid row containing the field selector, operator, input, and unit controls.
 */
export function QueryBuilderItem({
	config,
	index,
	menuItems,
	data,
	onChange,
}: IQueryBuilderItemProps): ReactElement {
	/**
	 * Handles field selection changes from the nested menu. Extracts the `select`
	 * and `column` values from the menu item and propagates them upstream.
	 *
	 * @param key - The config key of the newly selected field.
	 * @param value - The value object containing `select` and `column` identifiers.
	 */
	// TODO: Fix typing
	const onChangeSelect = (key: string, value: unknown) => {
		// Cast the opaque menu value to extract the field's select/column identifiers
		const val = value as Record<string, string>;
		onChange(index, {
			selectKey: key,
			select: val.select,
			column: val.column,
		});
	};
	/**
	 * Handles operator selection changes and propagates them upstream.
	 *
	 * @param value - The new operator value string.
	 */
	const onChangeOperator = (value: string) => {
		onChange(index, { operator: value });
	};
	/**
	 * Handles filter value changes from the input control and propagates them upstream.
	 *
	 * @param value - The new filter value entered by the user.
	 */
	const onChangeValue = (value: unknown) => {
		onChange(index, { value: value });
	};
	/**
	 * Handles unit selection changes and propagates them upstream.
	 *
	 * @param value - The new unit value string.
	 */
	const onChangeUnit = (value: string) => {
		onChange(index, { unit: value });
	};
	return (
		<Grid container direction="row" spacing={1}>
			<Grid item>
				<BasicNestedMenuSelect
					keyValue={data.selectKey}
					items={menuItems}
					onChange={onChangeSelect}
				/>
			</Grid>
			{config?.operator && (
				<Grid item>
					<QueryBuilderOperator
						config={config}
						value={data.operator}
						onChange={onChangeOperator}
					/>
				</Grid>
			)}
			{config && (
				<Grid item xs>
					<QueryBuilderInput
						config={config}
						operator={data.operator}
						value={data.value}
						onChange={onChangeValue}
					/>
				</Grid>
			)}
			{config?.unit && (
				<Grid item>
					<QueryBuilderUnit config={config} value={data.unit} onChange={onChangeUnit} />
				</Grid>
			)}
		</Grid>
	);
}
