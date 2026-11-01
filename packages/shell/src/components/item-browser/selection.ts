// =============================================================================
// ITEM BROWSER — selection rules
// =============================================================================
// The selection rules every desktop file browser shares: a plain click picks
// one item, Ctrl/Cmd+click toggles one, Shift+click selects the run from the
// anchor (the last plainly clicked or toggled item). Plain data in and out,
// so the rules are tested without React.
// =============================================================================

/** The modifier keys held during a click or key press. */
export interface ISelectionModifiers {
	/** Ctrl (or Cmd on macOS): toggle one item, keep the rest. */
	isToggle: boolean;
	/** Shift: select the run from the anchor to the item. */
	isRange: boolean;
}

/** A selection and the anchor a later Shift+click extends from. */
export interface ISelectionState {
	/** Selected item ids, in display order. */
	selectedIds: string[];
	/** The item a Shift+click range starts from, or null. */
	anchorId: string | null;
}

/**
 * The selection after clicking an item.
 *
 * @param orderedIds - Every item id, in display order.
 * @param current - The selection before the click.
 * @param id - The clicked item.
 * @param modifiers - The keys held.
 * @returns The selection after the click.
 */
export function selectionAfterClick(orderedIds: readonly string[], current: ISelectionState, id: string, modifiers: ISelectionModifiers): ISelectionState {
	if (modifiers.isRange && current.anchorId !== null) {
		const from = orderedIds.indexOf(current.anchorId);
		const to = orderedIds.indexOf(id);
		if (from >= 0 && to >= 0) {
			const start = Math.min(from, to);
			const end = Math.max(from, to);
			return { selectedIds: orderedIds.slice(start, end + 1), anchorId: current.anchorId };
		}
	}
	if (modifiers.isToggle) {
		const isSelected = current.selectedIds.includes(id);
		const kept: string[] = [];
		for (const candidate of orderedIds) {
			const isClicked = candidate === id;
			if (isClicked && !isSelected) kept.push(candidate);
			if (!isClicked && current.selectedIds.includes(candidate)) kept.push(candidate);
		}
		return { selectedIds: kept, anchorId: id };
	}
	return { selectedIds: [id], anchorId: id };
}

/**
 * The index focus moves to for a navigation key, or null for any other key.
 * In the grid, Up and Down move by a whole row.
 *
 * @param key - The `KeyboardEvent.key`.
 * @param index - The focused index, or -1 when nothing is focused.
 * @param count - How many items there are.
 * @param columns - Items per row (1 in the list).
 * @returns The new index, or null when the key does not navigate.
 */
export function indexAfterKey(key: string, index: number, count: number, columns: number): number | null {
	if (count === 0) return null;
	let next: number | null = null;
	if (key === 'ArrowRight' && columns > 1) next = index + 1;
	if (key === 'ArrowLeft' && columns > 1) next = index - 1;
	if (key === 'ArrowDown') next = index + columns;
	if (key === 'ArrowUp') next = index - columns;
	if (key === 'Home') next = 0;
	if (key === 'End') next = count - 1;
	if (next === null) return null;
	if (index < 0) return 0;
	return Math.max(0, Math.min(count - 1, next));
}

/** A screen rectangle. */
export interface IBrowserRect {
	left: number;
	top: number;
	width: number;
	height: number;
}

/**
 * Whether two rectangles overlap at all.
 *
 * @param a - One rectangle.
 * @param b - The other.
 * @returns True when they share any area.
 */
export function rectsIntersect(a: IBrowserRect, b: IBrowserRect): boolean {
	return a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;
}

/**
 * Adds a selection box's items to a starting selection, in display order.
 *
 * @param orderedIds - Every item id, in display order.
 * @param base - The selection the box adds to (empty unless Ctrl/Cmd or Shift was held).
 * @param boxed - The ids the box touches.
 * @returns The selection.
 */
export function mergeSelection(orderedIds: readonly string[], base: readonly string[], boxed: readonly string[]): string[] {
	const merged: string[] = [];
	for (const id of orderedIds) {
		if (base.includes(id) || boxed.includes(id)) merged.push(id);
	}
	return merged;
}
