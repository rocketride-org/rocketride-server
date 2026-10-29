// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * OptionList — the `role="option"` rows shared by Select and Combobox.
 * Internal: focus stays on the Select trigger / Combobox input, and the
 * active row is announced through `aria-activedescendant`, so the rows are
 * never focused themselves. Keeps the active row scrolled into view.
 */

import React, { ReactNode, useEffect } from 'react';

// =============================================================================
// TYPES
// =============================================================================

/** One option of a Select or Combobox. */
export interface ISelectOption<T extends string = string> {
	/** Value reported to `onChange`. */
	value: T;
	/** Visible text. Also used for typeahead and filtering. */
	label: string;
	/** Secondary line under the label. */
	description?: string;
	/** Optional leading icon. */
	icon?: ReactNode;
	/** Render dimmed and skip during navigation. */
	disabled?: boolean;
}

/** Props for the internal {@link OptionList}. */
export interface IOptionListProps<T extends string> {
	/** Base id; rows get `${id}-option-${index}`. */
	id: string;
	/** Rows to render. */
	options: ISelectOption<T>[];
	/** Index of the keyboard-active row, or -1. */
	activeIndex: number;
	/** Currently selected value, for `aria-selected`. */
	selectedValue: T | null;
	/** A row was clicked. */
	onChoose: (index: number) => void;
	/** The pointer moved onto a row. */
	onActivate: (index: number) => void;
	/** Text shown when there are no rows. */
	emptyText?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * The DOM id of a row, for `aria-activedescendant`.
 *
 * @param listId - The list's base id.
 * @param index - The row index.
 * @returns The row id.
 */
export function optionId(listId: string, index: number): string {
	return `${listId}-option-${index}`;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders listbox rows.
 *
 * @param props - {@link IOptionListProps}.
 * @returns The rows, or the empty text.
 */
export function OptionList<T extends string>({ id, options, activeIndex, selectedValue, onChoose, onActivate, emptyText = 'No options' }: IOptionListProps<T>): React.ReactElement {
	// Keep the active row visible while arrowing through a long list.
	useEffect(() => {
		if (activeIndex < 0) return;
		const row = document.getElementById(optionId(id, activeIndex));
		if (row) row.scrollIntoView({ block: 'nearest' });
	}, [id, activeIndex]);

	if (options.length === 0) {
		return <div className="rr-listbox__empty">{emptyText}</div>;
	}

	return (
		<>
			{options.map((option, index) => (
				<div
					key={option.value}
					id={optionId(id, index)}
					role="option"
					className="rr-option"
					aria-selected={option.value === selectedValue}
					aria-disabled={option.disabled || undefined}
					data-active={index === activeIndex || undefined}
					// Keep focus on the trigger/input: never let a row take it.
					onMouseDown={(event) => event.preventDefault()}
					onMouseMove={() => {
						if (!option.disabled && index !== activeIndex) onActivate(index);
					}}
					onClick={() => {
						if (!option.disabled) onChoose(index);
					}}
				>
					{option.icon}
					<span className="rr-option__text">
						<span className="rr-truncate">{option.label}</span>
						{option.description && <span className="rr-option__description">{option.description}</span>}
					</span>
				</div>
			))}
		</>
	);
}
