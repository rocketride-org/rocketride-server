// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Field — the label / control / help-or-error stack every form row uses.
 *
 * Field shares an id, the help/error description ids, and the invalid,
 * required and disabled state with the control inside it through context,
 * so any stock control (InputField, TextArea, Select, Combobox, Slider) is
 * labelled, described and marked invalid with no extra wiring:
 *
 *   <Field label="Endpoint" error={endpointError} required>
 *     <InputField value={endpoint} onChange={...} />
 *   </Field>
 *
 * Passing `error` marks the control invalid and replaces the help text with
 * the error. Group controls (RadioGroup, a set of Checkboxes) take their
 * label from Field through `aria-labelledby` instead of `<label for>`.
 *
 * Built on `.rr-field` from components.css.
 */

import React, { createContext, ReactNode, useContext, useId } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** What a Field shares with the control inside it. */
export interface IFieldContext {
	/** Id the control should use (the label's `htmlFor`). */
	controlId: string;
	/** Id of the label element, for group controls (`aria-labelledby`). */
	labelId: string;
	/** Ids of the help/error text, for `aria-describedby` (may be undefined). */
	describedBy?: string;
	/** Whether the field currently shows an error. */
	isInvalid: boolean;
	/** Whether the field is required. */
	isRequired: boolean;
	/** Whether the field is disabled. */
	isDisabled: boolean;
}

/** Props for the {@link Field} component. */
export interface IFieldProps {
	/** Visible label. */
	label: ReactNode;
	/** The control (InputField, TextArea, Select, ...). */
	children: ReactNode;
	/** Hint under the control. Hidden while an error shows. */
	help?: ReactNode;
	/** Error message. Present = the control is marked invalid. */
	error?: ReactNode;
	/** Mark required: adds the asterisk and `aria-required` / `required`. */
	required?: boolean;
	/** Disable the control. */
	disabled?: boolean;
	/** Id for the control; generated when omitted. */
	id?: string;
	/** Extra class names on the wrapper. */
	className?: string;
}

/** The ARIA / form props a control may already carry. */
export interface IFieldControlProps {
	id?: string;
	'aria-describedby'?: string;
	'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
	required?: boolean;
	disabled?: boolean;
}

// =============================================================================
// CONTEXT
// =============================================================================

const FieldContext = createContext<IFieldContext | null>(null);

/**
 * Reads the enclosing Field, if any.
 *
 * @returns The field context, or null outside a Field.
 */
export function useField(): IFieldContext | null {
	return useContext(FieldContext);
}

/**
 * Merges a control's own props with the enclosing Field's wiring. Props the
 * control sets explicitly win; the Field fills in what is missing. Outside a
 * Field the props come back unchanged.
 *
 * @param props - The control's own id / ARIA / required / disabled props.
 * @returns Props to spread on the control element.
 */
export function useFieldControl<T extends IFieldControlProps>(props: T): T & IFieldControlProps {
	const field = useContext(FieldContext);
	if (!field) return props;

	let describedBy = props['aria-describedby'];
	if (describedBy && field.describedBy) {
		describedBy = `${describedBy} ${field.describedBy}`;
	} else if (field.describedBy) {
		describedBy = field.describedBy;
	}

	let ariaInvalid = props['aria-invalid'];
	if (ariaInvalid === undefined && field.isInvalid) ariaInvalid = true;

	return {
		...props,
		id: props.id ?? field.controlId,
		'aria-describedby': describedBy,
		'aria-invalid': ariaInvalid,
		required: props.required ?? (field.isRequired || undefined),
		disabled: props.disabled ?? (field.isDisabled || undefined),
	};
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a labelled form row and wires the control inside it.
 *
 * @param props - {@link IFieldProps}.
 * @returns The field wrapper.
 */
export function Field({ label, children, help, error, required = false, disabled = false, id, className }: IFieldProps): React.ReactElement {
	const generatedId = useId();
	const controlId = id ?? `${generatedId}-control`;
	const labelId = `${generatedId}-label`;
	const messageId = `${generatedId}-message`;

	const hasError = error !== undefined && error !== null && error !== false && error !== '';
	const hasHelp = help !== undefined && help !== null && help !== '';

	let describedBy: string | undefined;
	if (hasError || hasHelp) describedBy = messageId;

	let wrapperClassName = 'rr-field';
	if (className) wrapperClassName = `rr-field ${className}`;
	let labelClassName = 'rr-field__label';
	if (required) labelClassName = 'rr-field__label rr-field__label--required';

	const context: IFieldContext = { controlId, labelId, describedBy, isInvalid: hasError, isRequired: required, isDisabled: disabled };

	return (
		<FieldContext.Provider value={context}>
			<div className={wrapperClassName}>
				<label id={labelId} htmlFor={controlId} className={labelClassName}>
					{label}
				</label>
				{children}
				{hasError && (
					<span id={messageId} className="rr-field__error">
						{error}
					</span>
				)}
				{!hasError && hasHelp && (
					<span id={messageId} className="rr-field__help">
						{help}
					</span>
				)}
			</div>
		</FieldContext.Provider>
	);
}
