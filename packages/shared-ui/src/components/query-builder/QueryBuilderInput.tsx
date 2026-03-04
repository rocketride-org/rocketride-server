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
import moment from 'moment';
import { TextField, ToggleButton, ToggleButtonGroup, MenuItem, Autocomplete } from '@mui/material';
import { DatePicker } from '@mui/x-date-pickers/DatePicker';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import { IQueryBuilderConfig, IQueryBuilderOperator } from './types';
import { DateRangePicker } from '../inputs/date-range-picker/DateRangePicker';
import { NumberRange } from '../inputs/number-range/NumberRange';

/**
 * Props for the {@link QueryBuilderInput} component.
 */
interface IQueryBuilderInputProps {
	/** Configuration for the selected field, providing type info, enum values, operators, and label. */
	config: IQueryBuilderConfig;
	/** The currently selected operator value, which may override the config's default input type. */
	operator?: string;
	/** The current filter value entered by the user. */
	value: unknown;
	/** Callback invoked when the user changes the filter value. */
	onChange: (value: unknown) => void;
}

/**
 * Renders the appropriate input control for a query builder row based on the field's type
 * and the currently selected operator. Supports a wide variety of input types including
 * text fields, number inputs, single/multi select dropdowns, autocomplete, boolean toggles,
 * date pickers, date range pickers, and number range inputs.
 *
 * The operator's `type` takes precedence over the config's `type` when determining which
 * input to render, allowing operators like "Between" to switch from a single date picker
 * to a date range picker.
 *
 * @param props - See {@link IQueryBuilderInputProps} for available props.
 * @returns The rendered input element, or null if no matching input type is found.
 */
export function QueryBuilderInput({
	config,
	operator,
	value,
	onChange,
}: IQueryBuilderInputProps): ReactElement | null {
	// Look up the operator config to determine if it overrides the field's default input type
	const operatorConfig = (config.operator ?? []).find(
		(o: IQueryBuilderOperator) => o.value === operator
	);

	// Operator type takes precedence over field type, allowing operators like
	// "Between" to switch from e.g. a single date picker to a date range picker
	switch (operatorConfig?.type ?? config.type) {
		case 'select': {
			// Normalize value to an array since MUI TextField in select mode expects array-like values
			const _value = Array.isArray(value) ? value : [value];
			// Build menu options from config enum, filtering out empty strings
			const selectItems = (config.enum ?? [])
				.filter((item) => item !== '')
				.map((item) => {
					return (
						<MenuItem key={item} value={item}>
							{item}
						</MenuItem>
					);
				});
			return (
				<TextField
					required
					select
					variant="outlined"
					size="small"
					fullWidth={true}
					label={config.label}
					value={_value}
					sx={{ minWidth: 100 }}
					onChange={(e) => onChange(e.target.value)}
				>
					{selectItems}
				</TextField>
			);
		}
		case 'selectMultiple': {
			// Normalize to array for multi-select compatibility
			const _value = Array.isArray(value) ? value : [value];
			const selectItems = (config.enum ?? [])
				.filter((item) => item !== '')
				.map((item) => {
					return (
						<MenuItem key={item} value={item}>
							{item}
						</MenuItem>
					);
				});
			return (
				<TextField
					required
					select
					variant="outlined"
					size="small"
					fullWidth={true}
					label={config.label}
					value={_value}
					sx={{ minWidth: 100 }}
					// Filter out empty strings from the selection to prevent blank entries
					onChange={(e) => onChange((e.target.value as unknown as string[])?.filter((v: string) => v !== ''))}
					SelectProps={{
						multiple: true,
					}}
				>
					{selectItems}
				</TextField>
			);
		}
		case 'stringAutocomplete': {
			// Extract a single string value; if array, take the first element
			const _value = Array.isArray(value) ? (value?.[0] ?? '') : (value as string);
			// Build suggestion options from enum, excluding empty strings
			const options = (config.enum ?? []).filter((label) => label !== '');
			return (
				<Autocomplete
					disablePortal
					freeSolo
					options={options}
					inputValue={_value}
					onInputChange={(e, v) => onChange(v)}
					renderInput={(params) => (
						<TextField
							{...params}
							required
							variant="outlined"
							size="small"
							fullWidth={true}
							label={config.label}
							sx={{ minWidth: 100 }}
						/>
					)}
				/>
			);
		}
		case 'string': {
			// Unwrap array values to a single string for the text input
			const _value = Array.isArray(value) ? (value?.[0] ?? '') : value;
			return (
				<TextField
					required
					variant="outlined"
					size="small"
					fullWidth={true}
					label={config.label}
					value={_value}
					onChange={(e) => onChange(e.currentTarget.value)}
				/>
			);
		}
		case 'number': {
			// Unwrap array values to a single number for the numeric input
			const _value = Array.isArray(value) ? (value?.[0] ?? '') : value;
			return (
				<TextField
					required
					variant="outlined"
					type="number"
					fullWidth={true}
					size="small"
					label={config.label}
					value={_value}
					onChange={(e) => onChange(e.currentTarget.value)}
				/>
			);
		}
		case 'numberRange': {
			// Ensure value is an array of two elements [from, to] for the range component
			const _value = Array.isArray(value) ? value : [value];
			return (
				<NumberRange
					labelFrom={`${config.label} From`}
					labelTo={`${config.label} To`}
					value={_value}
					onChange={(v) => onChange(v)}
				/>
			);
		}
		case 'boolean': {
			const _value = Array.isArray(value) ? (value?.[0] ?? '') : value;
			return (
				<ToggleButtonGroup
					// Compare as string because query values are stored as strings
					value={_value === 'true'}
					exclusive
					size="small"
					// Convert the boolean toggle result back to a string for uniform storage
					onChange={(_e, val) => onChange(String(val))}
				>
					<ToggleButton value={true}>
						<CheckIcon />
					</ToggleButton>
					<ToggleButton value={false}>
						<CloseIcon />
					</ToggleButton>
				</ToggleButtonGroup>
			);
		}
		case 'date': {
			const _value = Array.isArray(value) ? (value?.[0] ?? '') : (value as string);
			// Parse the stored ISO string into a moment object for the DatePicker;
			// null is used when no date has been selected yet
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const dateValue = (_value ? moment(_value) : null) as any;
			// Convert the selected moment back to an ISO string for storage,
			// defaulting to empty string if the user clears the date
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const handleDateChange = (v: any) => onChange((v as moment.Moment | null)?.toISOString() ?? '');
			return (
				<DatePicker
					value={dateValue}
					onChange={handleDateChange}
					label={config.label}
					slotProps={{
						textField: { fullWidth: true, size: 'small' },
					}}
				/>
			);
		}
		case 'dateRange': {
			// Ensure value is a string array [fromDate, toDate] for the range picker
			const _value = Array.isArray(value) ? value as string[] : (value as string[]);
			return (
				<DateRangePicker
					value={_value}
					labelFrom={`${config.label} From`}
					labelTo={`${config.label} To`}
					onChange={(v) => onChange(v)}
				/>
			);
		}
		default:
			return null;
	}
}
