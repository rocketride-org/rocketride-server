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

import { ReactElement, ChangeEvent } from 'react';
import { TextField, MenuItem } from '@mui/material';
import { IQueryBuilderConfig } from './types';

/**
 * Props for the {@link QueryBuilderUnit} component.
 */
interface IQueryBuilderUnitProps {
	/** Configuration for the selected field, whose `unit` array populates the dropdown options. */
	config: IQueryBuilderConfig;
	/** The currently selected unit value. */
	value?: string;
	/** Callback invoked when the user selects a different unit. */
	onChange: (value: string) => void;
}

/**
 * Renders a dropdown select field for choosing a measurement unit within a query row.
 * The available units are derived from the field's configuration (e.g., Bytes, KB, MB
 * for size-related fields). This component is only rendered when the field config
 * includes a `unit` array.
 *
 * @param props - See {@link IQueryBuilderUnitProps} for available props.
 * @returns A MUI TextField select dropdown populated with the field's available units.
 */
export function QueryBuilderUnit({
	config,
	value,
	onChange,
}: IQueryBuilderUnitProps): ReactElement {
	// Unwrap the select event to pass just the selected value string upstream
	const _onChange = ({ target: { value } }: ChangeEvent<{ value: string }>) => {
		onChange(value);
	};

	// Build dropdown options from the field config's unit definitions
	const menuItems = (config.unit ?? []).map((o) => (
		<MenuItem key={o.value} value={o.value}>
			{o.label}
		</MenuItem>
	));

	return (
		<TextField select label="Unit" size="small" value={value} onChange={_onChange}>
			{menuItems}
		</TextField>
	);
}
