// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
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

/**
 * EnumWidget — a select over a plain enum or a selector's branches. The value
 * shown is the effective one (stored ?? default). A stored value that is not
 * one of the options (a branch renamed in a later node version) is shown as a
 * disabled "stale" option so the user sees exactly what the file holds; the
 * renderer puts the field in its error state with the reset affordance.
 */

import { CSSProperties, ReactElement } from 'react';

import { fieldStyles } from './PropertyField';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	select: {
		...fieldStyles.input,
		appearance: 'auto',
		cursor: 'pointer',
	} as CSSProperties,
};

// =============================================================================
// Props
// =============================================================================

/** Props for {@link EnumWidget}. */
export interface IEnumWidgetProps {
	/** The control's element id. */
	id: string;
	/** `[value, label]` options in declaration order. */
	options: Array<[unknown, string]>;
	/** The effective value. */
	value: unknown;
	/** Whether the value is the ghost default. */
	ghost?: boolean;
	/** Stores the chosen value. */
	onChange: (value: unknown) => void;
	/** Disabled state. */
	disabled?: boolean;
	/** Invalid state (error border). */
	invalid?: boolean;
	/** Ids of the message / help elements the control is described by. */
	describedBy?: string;
	/** Required state, announced on the control. */
	required?: boolean;
	/** Accessible name when no visible label targets the control (array items). */
	label?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the select.
 *
 * @param props - {@link IEnumWidgetProps}.
 * @returns The control.
 */
export default function EnumWidget({ id, options, value, ghost, onChange, disabled, invalid, describedBy, required, label }: IEnumWidgetProps): ReactElement {
	const keys = options.map(([optionValue]) => JSON.stringify(optionValue));
	const current = value === undefined ? '' : JSON.stringify(value);
	const stale = current !== '' && !keys.includes(current);

	return (
		<select
			id={id}
			style={{ ...styles.select, ...(ghost ? fieldStyles.ghostControl : {}), ...(invalid ? fieldStyles.inputError : {}) }}
			value={current}
			disabled={disabled}
			aria-invalid={invalid || undefined}
			aria-describedby={describedBy}
			aria-required={required || undefined}
			aria-label={label}
			onChange={(event) => {
				const index = keys.indexOf(event.target.value);
				if (index >= 0) onChange(options[index][0]);
			}}
		>
			{/* No default and nothing stored: an explicit empty choice. */}
			{current === '' && <option value="">— choose —</option>}
			{/* The file holds a value no option matches: show it, unselectable. */}
			{stale && (
				<option value={current} disabled>
					{String(value)} (no longer available)
				</option>
			)}
			{options.map(([, label], index) => (
				<option key={keys[index]} value={keys[index]}>
					{label}
				</option>
			))}
		</select>
	);
}
