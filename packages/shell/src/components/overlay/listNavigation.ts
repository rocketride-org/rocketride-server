// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Keyboard navigation over option lists (Menu, Select, Combobox). Pure
 * functions over an items array so the arrow / Home / End / typeahead rules
 * are unit-testable without a DOM. Disabled items are skipped everywhere.
 */

// =============================================================================
// TYPES
// =============================================================================

/** The minimum an item needs for navigation: whether it can be focused. */
export interface INavigableItem {
	disabled?: boolean;
}

// =============================================================================
// API
// =============================================================================

/**
 * Index of the first enabled item.
 *
 * @param items - The list.
 * @returns The index, or -1 when every item is disabled.
 */
export function getFirstIndex(items: readonly INavigableItem[]): number {
	for (let index = 0; index < items.length; index++) {
		if (!items[index].disabled) return index;
	}
	return -1;
}

/**
 * Index of the last enabled item.
 *
 * @param items - The list.
 * @returns The index, or -1 when every item is disabled.
 */
export function getLastIndex(items: readonly INavigableItem[]): number {
	for (let index = items.length - 1; index >= 0; index--) {
		if (!items[index].disabled) return index;
	}
	return -1;
}

/**
 * Index of the next enabled item in a direction, wrapping at the ends.
 * From "nothing active" (-1), moving down lands on the first item and moving
 * up lands on the last.
 *
 * @param items - The list.
 * @param current - The active index, or -1.
 * @param direction - 1 for down, -1 for up.
 * @returns The next index, or -1 when every item is disabled.
 */
export function getNextIndex(items: readonly INavigableItem[], current: number, direction: 1 | -1): number {
	if (items.length === 0) return -1;
	if (current < 0) {
		if (direction === 1) return getFirstIndex(items);
		return getLastIndex(items);
	}

	for (let step = 1; step <= items.length; step++) {
		const index = (current + direction * step + items.length) % items.length;
		if (!items[index].disabled) return index;
	}
	return -1;
}

/**
 * Typeahead: the next enabled item whose label starts with the query,
 * searching after the active item and wrapping. Typing the same character
 * repeatedly cycles through the items that start with it.
 *
 * @param labels - Item labels in list order.
 * @param items - The list (for disabled state); same length as `labels`.
 * @param query - Characters typed so far (case-insensitive).
 * @param current - The active index, or -1.
 * @returns The matching index, or -1 when nothing matches.
 */
export function findTypeaheadIndex(labels: readonly string[], items: readonly INavigableItem[], query: string, current: number): number {
	if (!query) return -1;
	const needle = query.toLowerCase();
	const isRepeatedChar = needle.split('').every((char) => char === needle[0]);

	// A fresh multi-character query should match the active item itself
	// (refining it); a repeated single character should move past it.
	let start = current + 1;
	if (needle.length > 1 && !isRepeatedChar) start = Math.max(current, 0);
	const search = isRepeatedChar ? needle[0] : needle;

	for (let step = 0; step < labels.length; step++) {
		const index = (start + step) % labels.length;
		if (items[index].disabled) continue;
		if (labels[index].toLowerCase().startsWith(search)) return index;
	}
	return -1;
}

/**
 * Filters options by a query for Combobox: case-insensitive substring match,
 * with labels that START with the query ranked first. Order is otherwise
 * preserved.
 *
 * @param options - Options to filter.
 * @param query - The input text.
 * @param getLabel - Reads an option's label.
 * @returns The matching options, best matches first.
 */
export function filterOptions<T>(options: readonly T[], query: string, getLabel: (option: T) => string): T[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...options];

	const prefixMatches: T[] = [];
	const innerMatches: T[] = [];
	for (const option of options) {
		const label = getLabel(option).toLowerCase();
		if (label.startsWith(needle)) {
			prefixMatches.push(option);
		} else if (label.includes(needle)) {
			innerMatches.push(option);
		}
	}
	return [...prefixMatches, ...innerMatches];
}
