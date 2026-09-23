// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * InputField — the platform's stock single-line text input.
 *
 * A thin wrapper over `commonStyles.inputField` that applies the style-guide
 * sizing (34px tall, 7px radius, 0 12px padding) and forwards every standard
 * `<input>` prop (value, onChange, placeholder, disabled, type, ...). Because
 * inline styles cannot target the `::placeholder` pseudo-element, the component
 * injects a single scoped rule once so the placeholder uses
 * `--rr-text-disabled`.
 */

import React, { CSSProperties, InputHTMLAttributes } from 'react';
import { commonStyles } from '../../themes/styles';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link InputField} component — all standard `<input>` props. */
export type IInputFieldProps = InputHTMLAttributes<HTMLInputElement>;

// =============================================================================
// CONSTANTS
// =============================================================================

/** Class applied to every InputField so the injected placeholder rule matches. */
const INPUT_CLASS = 'rr-input-field';
/** Id of the injected <style> element (guarantees a single insertion). */
const PLACEHOLDER_STYLE_ID = 'rr-input-field-placeholder-style';

/**
 * Injects the placeholder-colour rule exactly once.
 *
 * Inline styles have no `::placeholder` selector, so the colour is applied via a
 * single document-level rule scoped to the {@link INPUT_CLASS} class. Guarded
 * against non-DOM environments and repeated insertion.
 */
function ensurePlaceholderStyle(): void {
	// Skip when there is no document (non-browser environments).
	if (typeof document === 'undefined') return;
	// Already injected — nothing to do.
	if (document.getElementById(PLACEHOLDER_STYLE_ID)) return;
	// Insert the scoped placeholder rule into <head>.
	const el = document.createElement('style');
	el.id = PLACEHOLDER_STYLE_ID;
	el.textContent = `.${INPUT_CLASS}::placeholder { color: var(--rr-text-disabled); }`;
	document.head.appendChild(el);
}

// Inject once at module load (safe no-op outside the DOM) so even the very
// first paint of the first InputField has the placeholder colour — a mount
// effect would run one frame too late and flash the browser default.
ensurePlaceholderStyle();

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	input: {
		...commonStyles.inputField,
		height: 34,
		padding: '0 12px',
		borderRadius: 7,
		background: 'var(--rr-bg-default)',
	} as CSSProperties,
};

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a themed single-line text input.
 *
 * @param props - {@link IInputFieldProps}; `className` and `style` are merged
 *   with the component's own class and base style, all other props pass through.
 * @returns The input element.
 */
export function InputField({ className, style, ...rest }: IInputFieldProps): React.ReactElement {
	// Merge our scoped class with any caller-supplied class.
	const mergedClassName = className ? `${INPUT_CLASS} ${className}` : INPUT_CLASS;

	return <input {...rest} className={mergedClassName} style={{ ...styles.input, ...style }} />;
}
