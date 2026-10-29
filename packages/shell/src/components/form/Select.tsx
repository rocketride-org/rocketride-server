// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Select — one value from a list too long for a RadioGroup: models,
 * regions, providers. Styled consistently across browsers and themes
 * (unlike a native `<select>` popup), with option descriptions and icons.
 *
 * Implements the WAI-ARIA "select-only combobox": focus stays on the trigger
 * button; the open list is announced through `aria-activedescendant`.
 *
 *   Closed:  Enter / Space / Arrow Down / Arrow Up open the list. Typing
 *            selects the next option starting with the typed text, like a
 *            native select.
 *   Open:    Arrow Up / Down move, Home / End jump, typing jumps,
 *            Enter / Space choose, Escape and Tab close without changing.
 *
 * Field-aware: inside a Field the trigger takes the label, description and
 * invalid state. Pass `name` to submit the value with a native form.
 *
 * Built on `.rr-select`, `.rr-listbox` and `.rr-option` from components.css.
 */

import React, { useId, useRef, useState } from 'react';
import { Popover } from '../overlay/Popover';
import { findTypeaheadIndex, getFirstIndex, getLastIndex, getNextIndex } from '../overlay/listNavigation';
import { isTypeaheadKey, useTypeahead } from '../overlay/overlayHooks';
import { useField, useFieldControl } from '../field/Field';
import { ISelectOption, OptionList, optionId } from './OptionList';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Select} component. */
export interface ISelectProps<T extends string = string> {
	/** The options, in display order. */
	options: ISelectOption<T>[];
	/** The selected value, or null for none. */
	value: T | null;
	/** Fired with the newly chosen value. */
	onChange: (value: T) => void;
	/** Trigger text while nothing is selected. Defaults to `'Select…'`. */
	placeholder?: string;
	/** Disable the control. */
	disabled?: boolean;
	/** Mark invalid (a Field with an `error` does this for you). */
	invalid?: boolean;
	/** Compact 26px trigger. */
	small?: boolean;
	/** Accessible name when not inside a Field. */
	ariaLabel?: string;
	/** Trigger id; a Field supplies one. */
	id?: string;
	/** Form field name; renders a hidden input carrying the value. */
	name?: string;
	/** Extra class names on the trigger. */
	className?: string;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a themed single-select dropdown.
 *
 * @param props - {@link ISelectProps}.
 * @returns The trigger, its listbox, and (with `name`) a hidden form input.
 */
export function Select<T extends string = string>({ options, value, onChange, placeholder = 'Select…', disabled, invalid, small = false, ariaLabel, id, name, className }: ISelectProps<T>): React.ReactElement {
	const [isOpen, setIsOpen] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const typeahead = useTypeahead();
	const listId = useId();

	let ariaInvalid: boolean | undefined;
	if (invalid) ariaInvalid = true;
	const field = useField();
	const fieldProps = useFieldControl({ id, disabled, 'aria-invalid': ariaInvalid });

	const selectedIndex = options.findIndex((option) => option.value === value);
	const labels = options.map((option) => option.label);

	/** Opens the list on the selected row, or on an end of the list. */
	function open(fallback: 'first' | 'last'): void {
		if (fieldProps.disabled) return;
		let start = selectedIndex;
		if (start < 0 || options[start].disabled) {
			start = getFirstIndex(options);
			if (fallback === 'last') start = getLastIndex(options);
		}
		setActiveIndex(start);
		setIsOpen(true);
	}

	/** Closes the list. */
	function close(): void {
		setIsOpen(false);
		setActiveIndex(-1);
	}

	/** Commits a row and closes. */
	function choose(index: number): void {
		const option = options[index];
		if (!option || option.disabled) return;
		if (option.value !== value) onChange(option.value);
		close();
	}

	/** Keyboard handling for both the closed and the open state. */
	function handleKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
		if (!isOpen) {
			if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				open('first');
				return;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				open('last');
				return;
			}
			if (isTypeaheadKey(event)) {
				// Native-select behavior: typing while closed changes the value.
				const match = findTypeaheadIndex(labels, options, typeahead(event.key), selectedIndex);
				if (match >= 0 && options[match].value !== value) onChange(options[match].value);
			}
			return;
		}

		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setActiveIndex(getNextIndex(options, activeIndex, 1));
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			setActiveIndex(getNextIndex(options, activeIndex, -1));
			return;
		}
		if (event.key === 'Home') {
			event.preventDefault();
			setActiveIndex(getFirstIndex(options));
			return;
		}
		if (event.key === 'End') {
			event.preventDefault();
			setActiveIndex(getLastIndex(options));
			return;
		}
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			choose(activeIndex);
			return;
		}
		if (event.key === 'Tab') {
			close();
			return;
		}
		if (isTypeaheadKey(event)) {
			const match = findTypeaheadIndex(labels, options, typeahead(event.key), activeIndex);
			if (match >= 0) setActiveIndex(match);
		}
	}

	let triggerClassName = 'rr-input rr-select';
	if (small) triggerClassName += ' rr-input--sm';
	if (className) triggerClassName += ` ${className}`;

	let activeDescendant: string | undefined;
	if (isOpen && activeIndex >= 0) activeDescendant = optionId(listId, activeIndex);

	const selected = options[selectedIndex];

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				role="combobox"
				id={fieldProps.id}
				className={triggerClassName}
				aria-haspopup="listbox"
				aria-expanded={isOpen}
				aria-controls={listId}
				aria-activedescendant={activeDescendant}
				aria-label={ariaLabel}
				aria-describedby={fieldProps['aria-describedby']}
				aria-invalid={fieldProps['aria-invalid']}
				aria-required={fieldProps.required}
				disabled={fieldProps.disabled}
				onClick={() => {
					if (isOpen) {
						close();
						return;
					}
					open('first');
				}}
				onKeyDown={handleKeyDown}
			>
				{selected && (
					<span className="rr-select__value">
						{selected.icon}
						<span className="rr-truncate">{selected.label}</span>
					</span>
				)}
				{!selected && <span className="rr-select__value rr-select__placeholder rr-truncate">{placeholder}</span>}
			</button>
			{name && <input type="hidden" name={name} value={value ?? ''} />}
			<Popover open={isOpen} anchorRef={triggerRef} onClose={close} role="listbox" id={listId} ariaLabel={ariaLabel} ariaLabelledBy={field?.labelId} matchWidth autoFocus={false} className="rr-listbox">
				<OptionList id={listId} options={options} activeIndex={activeIndex} selectedValue={value} onChoose={choose} onActivate={setActiveIndex} />
			</Popover>
		</>
	);
}
