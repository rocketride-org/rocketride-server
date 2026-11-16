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
 * Env-var autocomplete for the text widgets: typing `${` offers the
 * `ROCKETRIDE_*` keys the host supplied; picking one inserts the full
 * `${ROCKETRIDE_KEY}` reference at the trigger.
 */

import { KeyboardEvent, useCallback, useRef, useState } from 'react';

// =============================================================================
// Types
// =============================================================================

/** The state and handlers the hook hands a text widget. */
export interface IEnvVarAutocomplete {
	/** Whether the suggestion list is open. */
	isOpen: boolean;
	/** The filtered key names. */
	suggestions: string[];
	/** Index of the highlighted suggestion. */
	highlightedIndex: number;
	/** Call on every input change with the new value and cursor position. */
	handleInputChange: (value: string, cursorPos: number) => void;
	/** Inserts `key` at the trigger; returns the new field value and refocuses the input. */
	handleSelect: (key: string, currentValue: string, inputEl: HTMLInputElement | HTMLTextAreaElement | null) => string;
	/** Routes arrow/enter/escape keys while open; returns true when consumed. */
	handleKeyDown: (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, onPick: (key: string) => void) => boolean;
	/** Closes the list. */
	handleDismiss: () => void;
}

// =============================================================================
// Constants
// =============================================================================

/** Matches `${` followed by an optional partial ROCKETRIDE_* key name at the end of a string. */
const TRIGGER_REGEX = /\$\{(ROCKETRIDE_\w*)?$/;

// =============================================================================
// Hook
// =============================================================================

/**
 * Provides env-var autocomplete logic for a text input.
 *
 * @param envKeys - The available `ROCKETRIDE_*` key names.
 * @returns The autocomplete state and handlers.
 */
export function useEnvVarAutocomplete(envKeys: string[]): IEnvVarAutocomplete {
	const [isOpen, setIsOpen] = useState(false);
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [highlightedIndex, setHighlightedIndex] = useState(0);

	// Position of the `$` that opened the list, inside the field value.
	const triggerStartRef = useRef<number>(0);

	const handleInputChange = useCallback(
		(value: string, cursorPos: number) => {
			if (!envKeys.length) {
				setIsOpen(false);
				return;
			}
			const match = TRIGGER_REGEX.exec(value.substring(0, cursorPos));
			if (match) {
				const partial = (match[1] ?? '').toUpperCase();
				const filtered = envKeys.filter((key) => key.toUpperCase().startsWith(partial || 'ROCKETRIDE_'));
				if (filtered.length > 0) {
					triggerStartRef.current = match.index;
					setSuggestions(filtered);
					setHighlightedIndex(0);
					setIsOpen(true);
					return;
				}
			}
			setIsOpen(false);
		},
		[envKeys]
	);

	const handleSelect = useCallback((key: string, currentValue: string, inputEl: HTMLInputElement | HTMLTextAreaElement | null): string => {
		const triggerStart = triggerStartRef.current;
		const cursorPos = inputEl?.selectionStart ?? currentValue.length;
		// The caret must still end the trigger the list opened for; moved away
		// (Home, a click elsewhere) the pick is dropped and the text kept
		const trigger = TRIGGER_REGEX.exec(currentValue.substring(0, cursorPos));
		if (!trigger || trigger.index !== triggerStart) {
			setIsOpen(false);
			return currentValue;
		}
		// Replace from the `${` trigger to the cursor with the full reference,
		// consuming a closing brace already sitting after the caret
		const end = currentValue.charAt(cursorPos) === '}' ? cursorPos + 1 : cursorPos;
		const newValue = `${currentValue.substring(0, triggerStart)}\${${key}}${currentValue.substring(end)}`;
		setIsOpen(false);
		// Restore the caret after the inserted reference (3 = "${" + "}")
		const newCursorPos = triggerStart + key.length + 3;
		setTimeout(() => {
			inputEl?.setSelectionRange(newCursorPos, newCursorPos);
			inputEl?.focus();
		}, 0);
		return newValue;
	}, []);

	const handleDismiss = useCallback(() => setIsOpen(false), []);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>, onPick: (key: string) => void): boolean => {
			if (!isOpen) return false;
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				setHighlightedIndex((prev) => (prev >= suggestions.length - 1 ? 0 : prev + 1));
				return true;
			}
			if (event.key === 'ArrowUp') {
				event.preventDefault();
				setHighlightedIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
				return true;
			}
			if (event.key === 'Enter') {
				event.preventDefault();
				if (suggestions[highlightedIndex]) onPick(suggestions[highlightedIndex]);
				return true;
			}
			if (event.key === 'Escape') {
				setIsOpen(false);
				return true;
			}
			return false;
		},
		[isOpen, suggestions, highlightedIndex]
	);

	return { isOpen, suggestions, highlightedIndex, handleInputChange, handleSelect, handleKeyDown, handleDismiss };
}
