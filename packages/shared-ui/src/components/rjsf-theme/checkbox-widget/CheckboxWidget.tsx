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

import { FocusEvent } from 'react';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import InfoIcon from '@mui/icons-material/Info';
import Tooltip from '@mui/material/Tooltip';
import {
	ariaDescribedByIds,
	descriptionId,
	labelValue,
	schemaRequiresTrueValue,
	FormContextType,
	RJSFSchema,
	StrictRJSFSchema,
	WidgetProps,
} from '@rjsf/utils';

/**
 * Custom RJSF checkbox widget that renders a MUI Checkbox with an optional
 * info tooltip for the field description. Handles required validation based
 * on JSON Schema "const"/"enum" constraints, and displays the label alongside
 * the checkbox using MUI FormControlLabel.
 */
export default function CheckboxWidget<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({
	schema,
	id,
	value,
	disabled,
	readonly,
	label = '',
	hideLabel,
	autofocus,
	onChange,
	onBlur,
	onFocus,
	options,
}: WidgetProps<T, S, F>) {
	// Because an unchecked checkbox will cause html5 validation to fail, only add
	// the "required" attribute if the field value must be "true", due to the
	// "const" or "enum" keywords
	const required = schemaRequiresTrueValue<S>(schema);

	// Forward the boolean checked state directly to the RJSF onChange handler
	const _onChange = (_: unknown, checked: boolean) => onChange(checked);
	const _onBlur = ({ target }: FocusEvent<HTMLButtonElement>) =>
		onBlur(id, target && target.value);
	const _onFocus = ({ target }: FocusEvent<HTMLButtonElement>) =>
		onFocus(id, target && target.value);
	// Prefer description from uiSchema options, falling back to the JSON Schema description
	const description = options.description ?? schema.description;

	// Render the label with an inline info tooltip icon when a description is available
	const renderLabel = () => (
		<Box sx={{ display: 'flex', alignItems: 'center' }} id={descriptionId<T>(id)}>
			{labelValue(label, hideLabel, false)}
			{description && (
				<Tooltip title={description} placement="right">
					<InfoIcon sx={{ ml: 0.5, color: 'rgba(0, 0, 0, 0.54)', fontSize: 16 }} />
				</Tooltip>
			)}
		</Box>
	);

	return (
		<FormControlLabel
			control={
				<Checkbox
					size="small"
					id={id}
					name={id}
					checked={typeof value === 'undefined' ? false : Boolean(value)}
					required={required}
					disabled={disabled || readonly}
					autoFocus={autofocus}
					onChange={_onChange}
					onBlur={_onBlur}
					onFocus={_onFocus}
					aria-describedby={ariaDescribedByIds<T>(id)}
				/>
			}
			label={renderLabel()}
			sx={{ mr: 0 }}
		/>
	);
}
