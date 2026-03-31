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
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import FormLabel from '@mui/material/FormLabel';
import { ariaDescribedByIds, enumOptionsDeselectValue, enumOptionsIsSelected, enumOptionsSelectValue, enumOptionsValueForIndex, labelValue, optionId, FormContextType, WidgetProps, RJSFSchema, StrictRJSFSchema } from '@rjsf/utils';

/**
 * Custom RJSF widget for rendering a group of checkboxes from an enum schema.
 * Displays multiple checkbox options that allow multi-select behavior, where
 * each checked option adds its value to the form's array value and unchecking
 * removes it. Used when a JSON Schema field has enum options with uniqueItems.
 */
export default function CheckboxesWidget<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({ label, hideLabel, id, disabled, options, value, autofocus, readonly, required, onChange, onBlur, onFocus }: WidgetProps<T, S, F>) {
	const { enumOptions, enumDisabled, inline, emptyValue } = options;
	// Normalize value to an array so single-value and multi-value cases are handled uniformly
	const checkboxesValues = Array.isArray(value) ? value : [value];

	// Curried change handler: checking adds the enum value to the selection, unchecking removes it
	const _onChange =
		(index: number) =>
		({ target: { checked } }: ChangeEvent<HTMLInputElement>) => {
			if (checked) {
				onChange(enumOptionsSelectValue(index, checkboxesValues, enumOptions));
			} else {
				onChange(enumOptionsDeselectValue(index, checkboxesValues, enumOptions));
			}
		};

	// Resolve the actual enum value from the DOM target's string value for blur/focus callbacks
	const _onBlur = ({ target }: FocusEvent<HTMLButtonElement>) => onBlur(id, enumOptionsValueForIndex<S>(target && target.value, enumOptions, emptyValue));
	const _onFocus = ({ target }: FocusEvent<HTMLButtonElement>) => onFocus(id, enumOptionsValueForIndex<S>(target && target.value, enumOptions, emptyValue));

	return (
		<>
			{labelValue(
				<FormLabel required={required} htmlFor={id}>
					{label || undefined}
				</FormLabel>,
				hideLabel
			)}
			<FormGroup
				id={id}
				row={!!inline}
				sx={{
					gap: 0,
					'& .MuiFormControlLabel-root': {
						marginBottom: 0,
						marginTop: 0,
						marginLeft: 0,
						marginRight: 0,
						paddingTop: 0,
						paddingBottom: 0,
						minHeight: 'unset',
					},
				}}
			>
				{Array.isArray(enumOptions) &&
					enumOptions.map((option, index: number) => {
						// Determine if this particular option is currently selected in the value array
						const checked = enumOptionsIsSelected<S>(option.value, checkboxesValues);
						// Check if this specific option has been individually disabled via enumDisabled
						const itemDisabled = Array.isArray(enumDisabled) && enumDisabled.indexOf(option.value) !== -1;
						const checkbox = <Checkbox size="small" id={optionId(id, index)} name={id} checked={checked} disabled={disabled || itemDisabled || readonly} autoFocus={autofocus && index === 0} onChange={_onChange(index)} onBlur={_onBlur} onFocus={_onFocus} aria-describedby={ariaDescribedByIds<T>(id)} sx={{ py: 0 }} />;
						return <FormControlLabel control={checkbox} key={index} label={option.label} sx={{ mr: 0, '& .MuiFormControlLabel-label': { fontSize: '0.875rem' } }} />;
					})}
			</FormGroup>
		</>
	);
}
