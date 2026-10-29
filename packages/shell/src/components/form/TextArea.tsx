// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * TextArea — the multi-line counterpart of InputField: prompts, JSON
 * snippets, descriptions. Optionally grows with its content between
 * `minRows` and `maxRows`, then scrolls. Field-aware like every stock control.
 *
 * Built on `textarea.rr-input` from components.css.
 */

import React, { forwardRef, ForwardRefExoticComponent, RefAttributes, TextareaHTMLAttributes, useCallback, useLayoutEffect, useRef } from 'react';
import { useFieldControl } from '../field/Field';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Props for the {@link TextArea} component — all `<textarea>` props plus
 * sizing. A type alias (not `interface extends`), like IInputFieldProps, so
 * the contract bundler can inline React's attribute type.
 */
export type ITextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
	/** Grow with the content instead of showing a fixed box. */
	autoResize?: boolean;
	/** Minimum visible rows. Defaults to 3. */
	minRows?: number;
	/** Maximum rows before scrolling (autoResize only). Defaults to 12. */
	maxRows?: number;
	/** Monospace text, for code and JSON. */
	mono?: boolean;
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Sizes a textarea to its content, clamped to a row range.
 *
 * @param element - The textarea.
 * @param minRows - Minimum rows.
 * @param maxRows - Maximum rows.
 */
function fitToContent(element: HTMLTextAreaElement, minRows: number, maxRows: number): void {
	const computed = window.getComputedStyle(element);
	const lineHeight = parseFloat(computed.lineHeight) || 20;
	const chrome = parseFloat(computed.paddingTop) + parseFloat(computed.paddingBottom) + parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth);

	element.style.height = 'auto';
	const minHeight = minRows * lineHeight + chrome;
	const maxHeight = maxRows * lineHeight + chrome;
	const next = Math.min(Math.max(element.scrollHeight + parseFloat(computed.borderTopWidth) + parseFloat(computed.borderBottomWidth), minHeight), maxHeight);
	element.style.height = `${next}px`;

	let overflow = 'hidden';
	if (element.scrollHeight > maxHeight) overflow = 'auto';
	element.style.overflowY = overflow;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a themed multi-line text input.
 *
 * @param props - {@link ITextAreaProps}; other props pass through to `<textarea>`.
 * @returns The textarea element.
 */
export const TextArea: ForwardRefExoticComponent<ITextAreaProps & RefAttributes<HTMLTextAreaElement>> = forwardRef<HTMLTextAreaElement, ITextAreaProps>(function TextArea({ autoResize = false, minRows = 3, maxRows = 12, mono = false, className, style, rows, onInput, ...rest }, forwardedRef) {
	const fieldProps = useFieldControl(rest);
	const innerRef = useRef<HTMLTextAreaElement | null>(null);

	/** Keeps both the internal and the caller's ref. */
	const setRef = useCallback(
		(element: HTMLTextAreaElement | null) => {
			innerRef.current = element;
			if (typeof forwardedRef === 'function') {
				forwardedRef(element);
			} else if (forwardedRef) {
				forwardedRef.current = element;
			}
		},
		[forwardedRef]
	);

	// Re-fit whenever a controlled value changes.
	useLayoutEffect(() => {
		if (!autoResize || !innerRef.current) return;
		fitToContent(innerRef.current, minRows, maxRows);
	}, [autoResize, minRows, maxRows, fieldProps.value]);

	let classes = 'rr-input';
	if (mono) classes += ' rr-text-mono';
	if (className) classes += ` ${className}`;

	let resizeStyle: React.CSSProperties | undefined;
	if (autoResize) resizeStyle = { resize: 'none', minHeight: 0 };

	return (
		<textarea
			{...fieldProps}
			ref={setRef}
			rows={rows ?? minRows}
			className={classes}
			style={{ ...resizeStyle, ...style }}
			onInput={(event) => {
				if (autoResize) fitToContent(event.currentTarget, minRows, maxRows);
				onInput?.(event);
			}}
		/>
	);
});
