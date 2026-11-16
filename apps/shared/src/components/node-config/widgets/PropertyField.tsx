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
 * PropertyField — the one field frame every widget renders inside: the
 * uppercase label (required marker, "default" ghost marker, reset affordance),
 * the expose chip flush-right on `param` properties (mockup M-1.1), the
 * control, the inline validation message, and the description.
 */

import { CSSProperties, ReactElement, ReactNode } from 'react';
import { Chip, ChipAdd, commonStyles } from 'shell';

import { sanitizeAndParseHtmlToReact } from '../../../utils/sanitizeHtml';

// =============================================================================
// Styles
// =============================================================================

export const fieldStyles = {
	// One labelled field block.
	field: {
		marginBottom: 14,
	} as CSSProperties,

	// Label row: label left, chip flush-right.
	labelRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 8,
		marginBottom: 5,
		minHeight: 20,
	} as CSSProperties,

	label: {
		...commonStyles.labelUppercase,
		display: 'inline-flex',
		alignItems: 'center',
		gap: 4,
		flex: 1,
		minWidth: 0,
	} as CSSProperties,

	required: {
		color: 'var(--rr-color-error)',
	} as CSSProperties,

	// "default" marker beside the label while the value is a ghost.
	ghostMark: {
		...commonStyles.textMuted,
		fontSize: 10,
		textTransform: 'none',
		letterSpacing: 0,
		fontWeight: 400,
	} as CSSProperties,

	// Reset-to-default link shown while a stored value overrides the default.
	reset: {
		...commonStyles.textMuted,
		fontSize: 11,
		textTransform: 'none',
		letterSpacing: 0,
		fontWeight: 400,
		cursor: 'pointer',
		textDecoration: 'underline',
		background: 'none',
		border: 'none',
		padding: 0,
	} as CSSProperties,

	// Description under the control.
	help: {
		...commonStyles.textMuted,
		marginTop: 4,
		lineHeight: 1.4,
	} as CSSProperties,

	// Inline validation message (same slot, error colour).
	error: {
		fontSize: 12,
		marginTop: 4,
		color: 'var(--rr-color-error)',
	} as CSSProperties,

	// Ghost treatment for a control showing its default.
	ghostControl: {
		color: 'var(--rr-text-secondary)',
		fontStyle: 'italic',
	} as CSSProperties,

	// Base input (text, number, select, textarea).
	input: {
		...commonStyles.inputField,
	} as CSSProperties,

	// Error border on an invalid control.
	inputError: {
		borderColor: 'var(--rr-color-error)',
	} as CSSProperties,

	// Secondary row under a control (replace / clear / add actions).
	actionRow: {
		display: 'flex',
		gap: 8,
		alignItems: 'center',
		marginTop: 6,
	} as CSSProperties,
};

// =============================================================================
// Props
// =============================================================================

/** The expose-chip state the label renders for a `param` property. */
export interface IExposeState {
	/** The public name the property is exposed under, or undefined when not exposed. */
	publicName?: string;
	/** Opens the naming popup. */
	onClick: () => void;
}

/** Props for {@link PropertyField}. */
export interface IPropertyFieldProps {
	/** The control's element id (label `htmlFor`). */
	id: string;
	/** Display title. */
	title: string;
	/** Description (HTML allowed; sanitized). */
	description?: string;
	/** Required marker. */
	required?: boolean;
	/** Whether the shown value is the node's default (nothing stored). */
	ghost?: boolean;
	/** Reset-to-default handler; shown only while a value is stored and a default exists. */
	onReset?: () => void;
	/** Inline validation message. */
	error?: string | null;
	/** Expose chip (only for `param` properties). */
	expose?: IExposeState;
	/** The control. */
	children: ReactNode;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Renders the field frame around a widget.
 *
 * @param props - {@link IPropertyFieldProps}.
 * @returns The field element.
 */
export default function PropertyField({ id, title, description, required, ghost, onReset, error, expose, children }: IPropertyFieldProps): ReactElement {
	return (
		<div style={fieldStyles.field}>
			<div style={fieldStyles.labelRow}>
				<label id={`${id}-label`} style={fieldStyles.label} htmlFor={id}>
					<span>{title}</span>
					{required && <span style={fieldStyles.required}>*</span>}
					{ghost && <span style={fieldStyles.ghostMark}>default</span>}
					{!ghost && onReset && (
						<button type="button" style={fieldStyles.reset} onClick={onReset} title="Use the node's default">
							reset
						</button>
					)}
				</label>
				{/* Expose chip, flush-right (mockup M-1.1): exposed → the public
				    name; param-capable but unexposed → the add affordance. */}
				{expose && (expose.publicName ? <span role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={expose.onClick} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); expose.onClick(); } }}><Chip label={`⤴ ${expose.publicName}`} /></span> : <ChipAdd label="Expose" onClick={expose.onClick} />)}
			</div>
			{children}
			{/* Both carry ids so the control can name them in aria-describedby. */}
			{error && (
				<div id={`${id}-error`} style={fieldStyles.error}>
					{error}
				</div>
			)}
			{description && (
				<div id={`${id}-help`} style={fieldStyles.help}>
					{sanitizeAndParseHtmlToReact(description)}
				</div>
			)}
		</div>
	);
}
