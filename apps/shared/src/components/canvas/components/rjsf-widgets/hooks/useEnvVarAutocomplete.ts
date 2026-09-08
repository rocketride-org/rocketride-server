/**
 * MIT License
 * Copyright (c) 2026 Aparavi Software AG
 * See LICENSE file for details.
 */

import { useCallback, useRef, useState } from 'react';

// =============================================================================
// Types
// =============================================================================

export interface UseEnvVarAutocompleteResult {
	/** Whether the suggestions popover is open. */
	isOpen: boolean;
	/** Filtered list of matching env key names. */
	suggestions: string[];
	/** The element to anchor the popover to. */
	anchorEl: HTMLElement | null;
	/** Called on every input change to detect the `${` trigger. Pass the value and cursor position directly from the event target. */
	handleInputChange: (value: string, cursorPos: number, anchorElement: HTMLElement | null) => void;
	/** Called when the user selects a suggestion. Returns the new field value. */
	handleSelect: (key: string, currentValue: string, inputEl: HTMLInputElement | HTMLTextAreaElement | null) => string;
	/** Dismisses the popover. */
	handleDismiss: () => void;
	/** Index of the currently highlighted suggestion (for keyboard nav). */
	highlightedIndex: number;
	/** Move highlight up/down. */
	moveHighlight: (direction: 'up' | 'down') => void;
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
 * Provides env-var autocomplete logic for text input widgets.
 *
 * Detects when the user types `${` and shows filtered suggestions from the
 * available ROCKETRIDE_* environment keys. On selection, inserts the full
 * `${ROCKETRIDE_KEY}` reference into the field value.
 */
export function useEnvVarAutocomplete(envKeys: string[]): UseEnvVarAutocompleteResult {
	const [isOpen, setIsOpen] = useState(false);
	const [suggestions, setSuggestions] = useState<string[]>([]);
	const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
	const [highlightedIndex, setHighlightedIndex] = useState(0);

	// Track the position of the `${` trigger in the input value
	const triggerStartRef = useRef<number>(0);

	const handleInputChange = useCallback(
		(value: string, cursorPos: number, anchorElement: HTMLElement | null) => {
			if (!anchorElement || !envKeys.length) {
				setIsOpen(false);
				return;
			}

			const textBeforeCursor = value.substring(0, cursorPos);
			const match = TRIGGER_REGEX.exec(textBeforeCursor);

			if (match) {
				const partial = (match[1] ?? '').toUpperCase();
				const filtered = envKeys.filter((k) => k.toUpperCase().startsWith(partial || 'ROCKETRIDE_'));

				if (filtered.length > 0) {
					// Position of the `$` character
					triggerStartRef.current = match.index;
					setSuggestions(filtered);
					setAnchorEl(anchorElement);
					setHighlightedIndex(0);
					setIsOpen(true);
					return;
				}
			}

			setIsOpen(false);
		},
		[envKeys],
	);

	const handleSelect = useCallback(
		(key: string, currentValue: string, inputEl: HTMLInputElement | HTMLTextAreaElement | null): string => {
			const triggerStart = triggerStartRef.current;
			const cursorPos = inputEl?.selectionStart ?? currentValue.length;

			// Replace from the `${` trigger to the cursor with the full variable reference
			const before = currentValue.substring(0, triggerStart);
			const after = currentValue.substring(cursorPos);
			const newValue = `${before}\${${key}}${after}`;

			setIsOpen(false);

			// Restore cursor position after the inserted reference
			const newCursorPos = triggerStart + key.length + 3; // 3 = ${ + }
			setTimeout(() => {
				inputEl?.setSelectionRange(newCursorPos, newCursorPos);
				inputEl?.focus();
			}, 0);

			return newValue;
		},
		[],
	);

	const handleDismiss = useCallback(() => {
		setIsOpen(false);
	}, []);

	const moveHighlight = useCallback(
		(direction: 'up' | 'down') => {
			setHighlightedIndex((prev) => {
				if (direction === 'up') return prev <= 0 ? suggestions.length - 1 : prev - 1;
				return prev >= suggestions.length - 1 ? 0 : prev + 1;
			});
		},
		[suggestions.length],
	);

	return { isOpen, suggestions, anchorEl, handleInputChange, handleSelect, handleDismiss, highlightedIndex, moveHighlight };
}
