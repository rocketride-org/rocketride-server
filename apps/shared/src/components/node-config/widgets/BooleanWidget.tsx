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
 * BooleanWidget — a checkbox showing the effective value (stored ?? default).
 * Toggling stores the new value; the field frame's reset deletes the key.
 */

import { CSSProperties, ReactElement } from 'react';

import { fieldStyles } from './PropertyField';

// =============================================================================
// Styles
// =============================================================================

const styles = {
	row: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		cursor: 'pointer',
	} as CSSProperties,

	box: {
		width: 16,
		height: 16,
		margin: 0,
		accentColor: 'var(--rr-color-primary)',
		cursor: 'pointer',
	} as CSSProperties,
};

// =============================================================================
// Props
// =============================================================================

/** Props for {@link BooleanWidget}. */
export interface IBooleanWidgetProps {
	/** The control's element id. */
	id: string;
	/** The effective value. */
	value: boolean;
	/** Whether the value is the ghost default. */
	ghost?: boolean;
	/** Text beside the box (the enabled/disabled meaning). */
	caption?: string;
	/** Stores the toggled value. */
	onChange: (value: boolean) => void;
	/** Disabled state. */
	disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the checkbox.
 *
 * @param props - {@link IBooleanWidgetProps}.
 * @returns The control.
 */
export default function BooleanWidget({ id, value, ghost, caption, onChange, disabled }: IBooleanWidgetProps): ReactElement {
	return (
		<label style={{ ...styles.row, ...(ghost ? fieldStyles.ghostControl : {}), ...(disabled ? { cursor: 'default', opacity: 0.6 } : {}) }}>
			<input id={id} type="checkbox" style={styles.box} checked={value} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
			<span>{caption ?? (value ? 'Enabled' : 'Disabled')}</span>
		</label>
	);
}
