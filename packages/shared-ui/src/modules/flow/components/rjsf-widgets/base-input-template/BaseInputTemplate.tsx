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

import { ChangeEvent, FocusEvent, useState, useEffect } from 'react';
import TextField, { TextFieldProps } from '@mui/material/TextField';
import { ariaDescribedByIds, BaseInputTemplateProps, examplesId, getInputProps, labelValue, FormContextType, RJSFSchema, StrictRJSFSchema } from '@rjsf/utils';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Input types whose labels should always be shrunk (floated above the input),
 * because these types have built-in browser UI that would overlap a non-shrunk label.
 */
const TYPES_THAT_SHRINK_LABEL = ['date', 'datetime-local', 'file', 'time'];

// =============================================================================
// Component
// =============================================================================

/**
 * Custom RJSF base input template that renders a MUI TextField for all primitive
 * schema types (string, number, integer). Handles controlled value state,
 * encrypted/secure field placeholders, number spinner removal, label shrinking
 * for date/time/file inputs, and optional datalist examples. Serves as the
 * foundational text input across all JSON Schema forms in the application.
 */
export default function BaseInputTemplate<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({
	/* eslint-disable @typescript-eslint/no-unused-vars */
	id,
	name, // remove this from textFieldProps
	placeholder,
	required,
	readonly,
	disabled,
	type,
	label,
	hideLabel,
	hideError,
	value,
	onChange,
	onChangeOverride,
	onBlur,
	onFocus,
	autofocus,
	options,
	schema,
	uiSchema,
	rawErrors = [],
	errorSchema,
	formContext,
	registry,
	InputLabelProps,
	sx,
	...textFieldProps
	/* eslint-enable */
}: BaseInputTemplateProps<T, S, F>) {
	// Maintain a local controlled value to allow optimistic updates before RJSF processes the change
	const [controlledValue, setControlledValue] = useState(value);
	// Ensure `0` is treated as a valid value but `undefined`/`null`/empty are normalized to empty string
	const validatedPropValue = value || value === 0 ? value : '';

	// Sync controlled value when the form re-renders with a new prop value (e.g., reset or external update)
	useEffect(() => {
		if (value !== undefined && value !== null) {
			setControlledValue(value);
		}
	}, [value]);

	const inputProps = getInputProps<T, S, F>(schema, type, options);

	// Separate numeric constraints (step/min/max) into MUI's nested inputProps; keep the rest at the top level
	const { step, min, max, ...rest } = inputProps;
	const otherProps = {
		inputProps: {
			step,
			min,
			max,
			// Link to a <datalist> element if the schema provides example values for autocompletion
			...(schema.examples ? { list: examplesId<T>(id) } : undefined),
		},
		...rest,
	};

	// If the field holds an encrypted/secure value, show a masked placeholder and drop the required constraint
	if (uiSchema?.['ui:encrypted']) {
		placeholder = '••••••••';
		required = false;
	}

	const _onChange = ({ target: { value } }: ChangeEvent<HTMLInputElement>) => {
		setControlledValue(value);
		// Map empty string back to the schema's configured emptyValue (e.g., undefined for optional fields)
		onChange(value === '' ? options.emptyValue : value);
	};
	const _onBlur = ({ target }: FocusEvent<HTMLInputElement>) => onBlur(id, target && target.value);
	const _onFocus = ({ target }: FocusEvent<HTMLInputElement>) => onFocus(id, target && target.value);
	// Force label to shrink for date/time/file inputs (browser native UI overlaps) and when a placeholder is present
	const DisplayInputLabelProps =
		TYPES_THAT_SHRINK_LABEL.includes(type) || (placeholder != undefined && placeholder != '')
			? {
					...InputLabelProps,
					shrink: true,
				}
			: InputLabelProps;

	return (
		<>
			<TextField
				id={id}
				name={id}
				fullWidth={true}
				size="small"
				placeholder={placeholder}
				label={labelValue(label || undefined, hideLabel, undefined)}
				autoFocus={autofocus}
				required={required}
				disabled={disabled || readonly}
				{...otherProps}
				value={controlledValue ?? validatedPropValue}
				error={rawErrors.length > 0}
				onChange={onChangeOverride || _onChange}
				onBlur={_onBlur}
				onFocus={_onFocus}
				InputLabelProps={DisplayInputLabelProps}
				{...(textFieldProps as TextFieldProps)}
				sx={{
					...sx,
					'& input[type="number"]::-webkit-outer-spin-button, & input[type="number"]::-webkit-inner-spin-button': {
						WebkitAppearance: 'none',
						margin: 0,
					},
					'& input[type="number"]': {
						'-moz-appearance': 'textfield',
					},
				}}
				aria-describedby={ariaDescribedByIds<T>(id, !!schema.examples)}
			/>
			{/* Render a datalist with schema examples for browser autocompletion; include the default if not already listed */}
			{Array.isArray(schema.examples) && (
				<datalist id={examplesId<T>(id)}>
					{(schema.examples as string[]).concat(schema.default && !schema.examples.includes(schema.default) ? ([schema.default] as string[]) : []).map((example: string) => {
						return <option key={example} value={example} />;
					})}
				</datalist>
			)}
		</>
	);
}
