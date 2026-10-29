// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * RadioGroup — one choice from a short, always-visible set (2 to 5 options).
 * For longer lists use Select. Native radios, so Arrow keys move the
 * selection and Tab enters/leaves the group as one stop.
 *
 * Inside a Field the group is labelled by the Field's label
 * (`aria-labelledby`); outside one, pass `ariaLabel`.
 *
 * Built on `.rr-radio-group`, `.rr-choice` and `.rr-radio` from components.css.
 */

import React, { ReactNode, useId } from 'react';
import { useField } from '../field/Field';

// =============================================================================
// TYPES
// =============================================================================

/** One option of a {@link RadioGroup}. */
export interface IRadioOption<T extends string = string> {
	/** Value reported to `onChange`. */
	value: T;
	/** Visible label. */
	label: ReactNode;
	/** Secondary line under the label. */
	description?: ReactNode;
	/** Render dimmed and unselectable. */
	disabled?: boolean;
}

/** Props for the {@link RadioGroup} component. */
export interface IRadioGroupProps<T extends string = string> {
	/** The options, in display order. */
	options: IRadioOption<T>[];
	/** The selected value, or null for none. */
	value: T | null;
	/** Fired with the newly selected value. */
	onChange: (value: T) => void;
	/** Form field name; generated when omitted. */
	name?: string;
	/** Lay options out in a row instead of a column. */
	horizontal?: boolean;
	/** Disable every option. */
	disabled?: boolean;
	/** Accessible name when not inside a Field. */
	ariaLabel?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a group of native radio buttons.
 *
 * @param props - {@link IRadioGroupProps}.
 * @returns The radio group.
 */
export function RadioGroup<T extends string = string>({ options, value, onChange, name, horizontal = false, disabled, ariaLabel }: IRadioGroupProps<T>): React.ReactElement {
	const field = useField();
	const generatedName = useId();
	const groupName = name ?? generatedName;
	const isDisabled = disabled ?? field?.isDisabled ?? false;

	let groupClassName = 'rr-radio-group';
	if (horizontal) groupClassName = 'rr-radio-group rr-radio-group--horizontal';

	return (
		<div role="radiogroup" className={groupClassName} aria-labelledby={field?.labelId} aria-label={ariaLabel} aria-describedby={field?.describedBy} aria-required={field?.isRequired || undefined} aria-invalid={field?.isInvalid || undefined}>
			{options.map((option) => {
				const optionId = `${groupName}-${option.value}`;
				const descriptionId = `${optionId}-description`;
				let describedBy: string | undefined;
				if (option.description) describedBy = descriptionId;

				return (
					<label key={option.value} className="rr-choice" htmlFor={optionId}>
						<input type="radio" id={optionId} className="rr-radio" name={groupName} value={option.value} checked={value === option.value} disabled={isDisabled || option.disabled} onChange={() => onChange(option.value)} aria-describedby={describedBy} />
						<span className="rr-choice__text">
							{option.label}
							{option.description && (
								<span id={descriptionId} className="rr-choice__description">
									{option.description}
								</span>
							)}
						</span>
					</label>
				);
			})}
		</div>
	);
}
