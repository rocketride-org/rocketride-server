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

import FormControl from '@mui/material/FormControl';
import { FieldTemplateProps, FormContextType, RJSFSchema, StrictRJSFSchema, getTemplate, getUiOptions } from '@rjsf/utils';

// =============================================================================
// Component
// =============================================================================

/**
 * Custom RJSF field template that wraps each form field in a MUI FormControl
 * with error state handling and conditional visibility. Supports a custom
 * "hideFor" UI option that hides fields based on the form context, and uses
 * the WrapIfAdditionalTemplate for additional property support. This template
 * controls the overall layout of every individual field in the form.
 */
export default function FieldTemplate<
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	T = any,
	S extends StrictRJSFSchema = RJSFSchema,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	F extends FormContextType = any,
>({ id, children, classNames, style, disabled, hidden, label, onDropPropertyClick, onKeyChange, readonly, required, rawErrors = [], errors, help, schema, uiSchema, registry, formContext }: FieldTemplateProps<T, S, F>) {
	const uiOptions = getUiOptions<T, S, F>(uiSchema);
	// Resolve the wrapper template for additional (user-defined) properties on objects
	const WrapIfAdditionalTemplate = getTemplate<'WrapIfAdditionalTemplate', T, S, F>('WrapIfAdditionalTemplate', registry, uiOptions);

	// Support a custom "hideFor" UI option that conditionally hides fields based on the form context.
	// This allows different host environments (e.g., VSCode vs web) to show/hide specific fields.
	const hideFor = uiSchema?.['ui:options']?.hideFor;
	const shouldHide = hidden || (hideFor && formContext?.hideFor === hideFor);

	// Render hidden fields in the DOM (for form data) but visually hide them
	if (shouldHide) {
		return <div style={{ display: 'none' }}>{children}</div>;
	}

	return (
		<WrapIfAdditionalTemplate classNames={classNames} style={style} disabled={disabled} id={id} label={label} onDropPropertyClick={onDropPropertyClick} onKeyChange={onKeyChange} readonly={readonly} required={required} schema={schema} uiSchema={uiSchema} registry={registry}>
			<FormControl fullWidth={true} error={rawErrors.length ? true : false} required={required}>
				{children ?? null}
				{errors}
				{help}
			</FormControl>
		</WrapIfAdditionalTemplate>
	);
}
