// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Checkbox and Switch — native inputs with a clickable label and optional
 * description.
 *
 * Use a Checkbox for a choice that takes effect when a form is submitted or
 * for one item of a set; use a Switch for a setting that applies at once.
 * Both are controlled: pass `checked` and handle `onChange(checked)`.
 * Checkbox also supports the `indeterminate` (mixed) state for "select all".
 *
 * Built on `.rr-choice`, `.rr-checkbox` and `.rr-switch` from components.css.
 */

import React, { forwardRef, ForwardRefExoticComponent, ReactNode, RefAttributes, useCallback, useEffect, useId, useRef } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** Props shared by {@link Checkbox} and {@link Switch}. */
export interface IChoiceProps {
	/** Whether it is on. */
	checked: boolean;
	/** Fired with the new state. */
	onChange: (checked: boolean, event: React.ChangeEvent<HTMLInputElement>) => void;
	/** Visible label. Omit only when `ariaLabel` is set. */
	label?: ReactNode;
	/** Secondary line under the label. */
	description?: ReactNode;
	/** Accessible name when there is no visible label. */
	ariaLabel?: string;
	/** Disable the control. */
	disabled?: boolean;
	/** Form field name. */
	name?: string;
	/** Form value submitted when checked. */
	value?: string;
	/** Element id; generated when omitted. */
	id?: string;
	/** Extra class names on the label wrapper. */
	className?: string;
}

/** Props for the {@link Checkbox} component. */
export interface ICheckboxProps extends IChoiceProps {
	/** Show the mixed state (e.g. some, not all, rows selected). */
	indeterminate?: boolean;
}

/** Props for the {@link Switch} component. */
export type ISwitchProps = IChoiceProps;

// =============================================================================
// SHARED RENDER
// =============================================================================

/**
 * Renders the label wrapper around a native input.
 *
 * @param props - The choice props plus the input's class and role.
 * @returns The labelled input.
 */
function ChoiceControl({ inputRef, inputClassName, role, checked, onChange, label, description, ariaLabel, disabled, name, value, id, className }: IChoiceProps & { inputRef: React.Ref<HTMLInputElement>; inputClassName: string; role?: string }): React.ReactElement {
	const generatedId = useId();
	const inputId = id ?? generatedId;
	const descriptionId = `${inputId}-description`;

	let wrapperClassName = 'rr-choice';
	if (description) wrapperClassName = 'rr-choice rr-choice--described';
	if (className) wrapperClassName += ` ${className}`;

	let describedBy: string | undefined;
	if (description) describedBy = descriptionId;

	return (
		<label className={wrapperClassName} htmlFor={inputId}>
			<input ref={inputRef} id={inputId} type="checkbox" role={role} className={inputClassName} checked={checked} onChange={(event) => onChange(event.target.checked, event)} disabled={disabled} name={name} value={value} aria-label={ariaLabel} aria-describedby={describedBy} />
			{(label || description) && (
				<span className="rr-choice__text">
					{label}
					{description && (
						<span id={descriptionId} className="rr-choice__description">
							{description}
						</span>
					)}
				</span>
			)}
		</label>
	);
}

// =============================================================================
// COMPONENTS
// =============================================================================

/**
 * Renders a labelled checkbox.
 *
 * @param props - {@link ICheckboxProps}.
 * @returns The checkbox and its label.
 */
export const Checkbox: ForwardRefExoticComponent<ICheckboxProps & RefAttributes<HTMLInputElement>> = forwardRef<HTMLInputElement, ICheckboxProps>(function Checkbox({ indeterminate = false, ...props }, forwardedRef) {
	const innerRef = useRef<HTMLInputElement | null>(null);

	/** Keeps both the internal and the caller's ref. */
	const setRef = useCallback(
		(element: HTMLInputElement | null) => {
			innerRef.current = element;
			if (typeof forwardedRef === 'function') {
				forwardedRef(element);
			} else if (forwardedRef) {
				forwardedRef.current = element;
			}
		},
		[forwardedRef]
	);

	// `indeterminate` is a DOM property only; there is no attribute for it.
	useEffect(() => {
		if (innerRef.current) innerRef.current.indeterminate = indeterminate;
	}, [indeterminate]);

	return <ChoiceControl {...props} inputRef={setRef} inputClassName="rr-checkbox" />;
});

/**
 * Renders a labelled on/off switch (`role="switch"`).
 *
 * @param props - {@link ISwitchProps}.
 * @returns The switch and its label.
 */
export const Switch: ForwardRefExoticComponent<ISwitchProps & RefAttributes<HTMLInputElement>> = forwardRef<HTMLInputElement, ISwitchProps>(function Switch(props, forwardedRef) {
	return <ChoiceControl {...props} inputRef={forwardedRef} inputClassName="rr-switch" role="switch" />;
});
