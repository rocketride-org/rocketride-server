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

import { ChangeEvent, FocusEvent } from 'react';
import MenuItem from '@mui/material/MenuItem';
import TextField, { TextFieldProps } from '@mui/material/TextField';
import { ariaDescribedByIds, enumOptionsIndexForValue, enumOptionsValueForIndex, labelValue, FormContextType, RJSFSchema, StrictRJSFSchema, WidgetProps } from '@rjsf/utils';

/**
 * Custom RJSF select widget that renders enum schema options as a MUI TextField
 * with select mode. Supports single and multiple selection, disabled options,
 * text overflow ellipsis, and proper label shrinking when a value is selected.
 * Each option is rendered as a MUI MenuItem within the dropdown.
 */
export default function SelectWidget<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({
	/* eslint-disable @typescript-eslint/no-unused-vars */
	schema,
	id,
	name, // remove this from textFieldProps
	options,
	label,
	hideLabel,
	required,
	disabled,
	placeholder,
	readonly,
	value,
	multiple,
	autofocus,
	onChange,
	onBlur,
	onFocus,
	errorSchema,
	rawErrors = [],
	registry,
	uiSchema,
	hideError,
	formContext,
	...textFieldProps
	/* eslint-enable */
}: WidgetProps<T, S, F>) {
	const { enumOptions, enumDisabled, emptyValue: optEmptyVal } = options;

	// Default to single-select if multiple is not explicitly set
	multiple = typeof multiple === 'undefined' ? false : !!multiple;

	// Check if empty string is a valid enum value (e.g., "None" option) to avoid treating it as "no selection"
	const hasEmptyAsValue = enumOptions?.find((o) => o.value === '');

	// Determine the appropriate empty/default value based on selection mode
	const emptyValue = multiple ? [] : '';
	// A field is "empty" if undefined, has no multi-selections, or equals the empty value (excluding valid empty options)
	const isEmpty = typeof value === 'undefined' || (multiple && value.length < 1) || (!hasEmptyAsValue && !multiple && value === emptyValue);

	// Convert the DOM string value (option index) back to the actual enum value before notifying RJSF
	const _onChange = ({ target: { value } }: ChangeEvent<{ value: string }>) => onChange(enumOptionsValueForIndex<S>(value, enumOptions, optEmptyVal));
	const _onBlur = ({ target }: FocusEvent<HTMLInputElement>) => onBlur(id, enumOptionsValueForIndex<S>(target && target.value, enumOptions, optEmptyVal));
	const _onFocus = ({ target }: FocusEvent<HTMLInputElement>) => onFocus(id, enumOptionsValueForIndex<S>(target && target.value, enumOptions, optEmptyVal));
	// Map the current form value back to the index(es) used by the MUI Select component
	const selectedIndexes = enumOptionsIndexForValue<S>(value, enumOptions, multiple);
	const { InputLabelProps, SelectProps, autocomplete, ...textFieldRemainingProps } = textFieldProps;

	// Resolve the label of the selected option to use as a tooltip on the input (for overflow cases)
	const selectedOptionLabel = !isEmpty && Array.isArray(enumOptions) && typeof selectedIndexes !== 'undefined' ? enumOptions[Number(selectedIndexes)]?.label : undefined;

	return (
		<TextField
			id={id}
			name={id}
			fullWidth={true}
			size="small"
			sx={{
				textAlign: 'left',
				'& .MuiSelect-select': {
					whiteSpace: 'normal !important',
					wordBreak: 'break-word',
					overflow: 'visible !important',
					height: 'auto !important',
					minHeight: '1.4375em',
				},
			}}
			label={labelValue(label || undefined, hideLabel, undefined)}
			value={!isEmpty && typeof selectedIndexes !== 'undefined' ? selectedIndexes : emptyValue}
			required={required}
			disabled={disabled || readonly}
			autoFocus={autofocus}
			autoComplete={autocomplete}
			placeholder={placeholder}
			error={rawErrors.length > 0}
			onChange={_onChange}
			onBlur={_onBlur}
			onFocus={_onFocus}
			{...(textFieldRemainingProps as TextFieldProps)}
			select
			InputLabelProps={{
				...InputLabelProps,
				shrink: !isEmpty,
			}}
			slotProps={{
				input: {
					...(textFieldProps as TextFieldProps).slotProps?.input,
					title: selectedOptionLabel ?? undefined,
				},
			}}
			SelectProps={{
				...SelectProps,
				multiple,
			}}
			aria-describedby={ariaDescribedByIds<T>(id)}
		>
			{Array.isArray(enumOptions) &&
				enumOptions.map(({ value, label }, i: number) => {
					const disabled: boolean = Array.isArray(enumDisabled) && enumDisabled.indexOf(value) !== -1;
					return (
						<MenuItem key={i} value={String(i)} disabled={disabled}>
							{label}
						</MenuItem>
					);
				})}
		</TextField>
	);
}
