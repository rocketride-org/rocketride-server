// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Combobox — a text input with a filtered list of suggestions: searchable
 * pickers for long lists, and suggest-as-you-type fields such as env-var
 * names.
 *
 * Two modes:
 *   - Pick (default): the value must be one of the options. Leaving the
 *     input reverts unmatched text to the current selection.
 *   - Free text (`allowCustomValue`): the options are suggestions; whatever
 *     is typed is committed on Enter or when the input loses focus.
 *
 * Implements the WAI-ARIA "editable combobox with list autocomplete": focus
 * stays in the input; Arrow Down / Up open and move through the list
 * (announced through `aria-activedescendant`), Enter chooses, Escape closes
 * the list (or, when already closed, restores the committed text). Field-aware.
 *
 * Built on `.rr-input`, `.rr-listbox` and `.rr-option` from components.css.
 */

import React, { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Popover } from '../overlay/Popover';
import { filterOptions, getFirstIndex, getLastIndex, getNextIndex } from '../overlay/listNavigation';
import { useField, useFieldControl } from '../field/Field';
import { CLOSE_GLYPH } from '../modal/Modal';
import { ISelectOption, OptionList, optionId } from './OptionList';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link Combobox} component. */
export interface IComboboxProps {
	/** Options (pick mode) or suggestions (free-text mode). */
	options: ISelectOption[];
	/** The committed value, or null for none. */
	value: string | null;
	/** Fired with the committed value; null when cleared. */
	onChange: (value: string | null) => void;
	/** Accept text that matches no option. */
	allowCustomValue?: boolean;
	/** Fired on every keystroke, e.g. to fetch suggestions from a server. */
	onInputChange?: (text: string) => void;
	/** Input placeholder. */
	placeholder?: string;
	/** Text shown when nothing matches. Defaults to `'No matches'`. */
	emptyText?: string;
	/** Show a clear button while there is a value. */
	clearable?: boolean;
	/** Disable the control. */
	disabled?: boolean;
	/** Mark invalid (a Field with an `error` does this for you). */
	invalid?: boolean;
	/** Compact 26px input. */
	small?: boolean;
	/** Monospace input text, e.g. for identifiers. */
	mono?: boolean;
	/** Accessible name when not inside a Field. */
	ariaLabel?: string;
	/** Input id; a Field supplies one. */
	id?: string;
	/** Form field name. */
	name?: string;
	/** Decorative icon drawn inside the input's start edge, e.g. a search glyph. */
	leadingIcon?: ReactNode;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The text an input should show for a committed value: the matching
 * option's label, or the raw value for a custom entry.
 *
 * @param options - All options.
 * @param value - The committed value.
 * @returns The display text.
 */
export function displayTextFor(options: readonly ISelectOption[], value: string | null): string {
	if (value === null) return '';
	const match = options.find((option) => option.value === value);
	if (match) return match.label;
	return value;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders a filterable text input with a suggestion list.
 *
 * @param props - {@link IComboboxProps}.
 * @returns The input, its clear button, and the suggestion list.
 */
export function Combobox({ options, value, onChange, allowCustomValue = false, onInputChange, placeholder, emptyText = 'No matches', clearable = false, disabled, invalid, small = false, mono = false, ariaLabel, id, name, leadingIcon }: IComboboxProps): React.ReactElement {
	const [text, setText] = useState(() => displayTextFor(options, value));
	const [isOpen, setIsOpen] = useState(false);
	const [isFiltering, setIsFiltering] = useState(false);
	const [activeIndex, setActiveIndex] = useState(-1);
	const anchorRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listId = useId();
	const field = useField();

	let ariaInvalid: boolean | undefined;
	if (invalid) ariaInvalid = true;
	const fieldProps = useFieldControl({ id, disabled, 'aria-invalid': ariaInvalid });

	// Follow external value changes while the user is not editing.
	useEffect(() => {
		if (document.activeElement === inputRef.current) return;
		setText(displayTextFor(options, value));
	}, [options, value]);

	let visible = options;
	if (isFiltering) visible = filterOptions(options, text, (option) => option.label);

	/** Opens the list without filtering, on the selection or an end. */
	function open(fallback: 'first' | 'last'): void {
		if (fieldProps.disabled) return;
		setIsFiltering(false);
		let start = options.findIndex((option) => option.value === value);
		if (start < 0 && fallback === 'first') start = getFirstIndex(options);
		if (start < 0 && fallback === 'last') start = getLastIndex(options);
		setActiveIndex(start);
		setIsOpen(true);
	}

	/** Closes the list. */
	function close(): void {
		setIsOpen(false);
		setIsFiltering(false);
		setActiveIndex(-1);
	}

	/** Commits a row. */
	function choose(index: number): void {
		const option = visible[index];
		if (!option || option.disabled) return;
		setText(option.label);
		if (option.value !== value) onChange(option.value);
		close();
	}

	/** Commits whatever is typed (free-text mode) or reverts it (pick mode). */
	function commitText(): void {
		if (!allowCustomValue) {
			setText(displayTextFor(options, value));
			return;
		}
		const trimmed = text.trim();
		let next: string | null = trimmed;
		if (trimmed === '') next = null;
		const exact = options.find((option) => option.label.toLowerCase() === trimmed.toLowerCase());
		if (exact) next = exact.value;
		if (next !== value) onChange(next);
		setText(displayTextFor(options, next));
	}

	/** Keyboard handling on the input. */
	function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			if (!isOpen) {
				open('first');
				return;
			}
			setActiveIndex(getNextIndex(visible, activeIndex, 1));
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			if (!isOpen) {
				open('last');
				return;
			}
			setActiveIndex(getNextIndex(visible, activeIndex, -1));
			return;
		}
		if (event.key === 'Enter') {
			if (isOpen && activeIndex >= 0) {
				event.preventDefault();
				choose(activeIndex);
				return;
			}
			if (allowCustomValue) {
				event.preventDefault();
				commitText();
				close();
			}
			return;
		}
		if (event.key === 'Escape' && !isOpen) {
			// List already closed: Escape restores the committed text.
			setText(displayTextFor(options, value));
		}
	}

	/** Typing filters and opens the list. */
	function handleChange(event: React.ChangeEvent<HTMLInputElement>): void {
		const next = event.target.value;
		setText(next);
		setIsFiltering(true);
		setIsOpen(true);
		onInputChange?.(next);

		// Pick mode pre-selects the best match so Enter takes it; free-text
		// mode leaves nothing active so Enter keeps exactly what was typed.
		if (allowCustomValue) {
			setActiveIndex(-1);
			return;
		}
		setActiveIndex(getFirstIndex(filterOptions(options, next, (option) => option.label)));
	}

	let inputClassName = 'rr-input';
	if (small) inputClassName += ' rr-input--sm';
	if (mono) inputClassName += ' rr-text-mono';

	let groupClassName = 'rr-input-group';
	if (leadingIcon) groupClassName += ' rr-input-group--start';
	const showClear = clearable && value !== null && !fieldProps.disabled;
	if (showClear) groupClassName += ' rr-input-group--end';

	// In free-text mode an empty suggestion list is noise, not an error.
	let isListShown = isOpen;
	if (allowCustomValue && visible.length === 0) isListShown = false;

	let activeDescendant: string | undefined;
	if (isListShown && activeIndex >= 0) activeDescendant = optionId(listId, activeIndex);

	return (
		<>
			<div ref={anchorRef} className={groupClassName}>
				{leadingIcon && (
					<span className="rr-input-group__start" aria-hidden="true">
						{leadingIcon}
					</span>
				)}
				<input
					ref={inputRef}
					type="text"
					role="combobox"
					id={fieldProps.id}
					name={name}
					className={inputClassName}
					value={text}
					placeholder={placeholder}
					autoComplete="off"
					spellCheck={false}
					aria-autocomplete="list"
					aria-expanded={isListShown}
					aria-controls={listId}
					aria-activedescendant={activeDescendant}
					aria-label={ariaLabel}
					aria-describedby={fieldProps['aria-describedby']}
					aria-invalid={fieldProps['aria-invalid']}
					aria-required={fieldProps.required}
					disabled={fieldProps.disabled}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					onClick={() => {
						if (!isOpen) open('first');
					}}
					onBlur={() => {
						commitText();
						close();
					}}
				/>
				{showClear && (
					<button
						type="button"
						className="rr-icon-btn rr-icon-btn--sm rr-input-group__action"
						aria-label="Clear"
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => {
							setText('');
							onChange(null);
							inputRef.current?.focus();
						}}
					>
						{CLOSE_GLYPH}
					</button>
				)}
			</div>
			<Popover open={isListShown} anchorRef={anchorRef} onClose={close} role="listbox" id={listId} ariaLabel={ariaLabel} ariaLabelledBy={field?.labelId} matchWidth autoFocus={false} restoreFocus={false} className="rr-listbox">
				<OptionList id={listId} options={visible} activeIndex={activeIndex} selectedValue={value} onChoose={choose} onActivate={setActiveIndex} emptyText={emptyText} />
			</Popover>
		</>
	);
}
