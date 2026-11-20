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
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// GRAPH - EDITOR SPLIT (how tall the editor is above the results)
// =============================================================================
//
// The run surface's divider is a WAI-ARIA window splitter. This is its model:
//
//   height     clamped between one editor line and what leaves the results
//              RESULTS_MIN pixels of the space the two share;
//   keys       ArrowUp/ArrowDown step by EDITOR_STEP; Home hides the editor
//              (the run bar stays, with the statement's first line); End shows
//              it again at the height it had, or at the default when that was
//              one line (a one-line editor shown again is not usable);
//   drag       moves the divider by the pointer's travel, applied once on
//              release, so the canvas below resizes (and refits) once;
//   stored     the height is kept in the prefs (graph.editorHeight); a value
//              that is not a sensible number is ignored.
//
// Pure: the surface measures the space and renders the separator.
// =============================================================================

/** One line of the editor (20 px lines, 10 px padding above and below). */
export const EDITOR_MIN = 40;

/** Four lines: the height a new editor opens at (small, so the results get the room). */
export const EDITOR_DEFAULT = 100;

/** What one arrow key moves the divider. */
export const EDITOR_STEP = 24;

/** The space the results keep, whatever the editor's height. */
export const RESULTS_MIN = 200;

/** The prefs key the height is kept under. */
export const EDITOR_HEIGHT_PREF_KEY = 'graph.editorHeight';

/** Where the divider is. */
export interface IEditorSplit {
	/** The editor's height in pixels while it is shown (kept while it is hidden, so End restores it). */
	height: number;
	/** True while the editor is hidden. */
	collapsed: boolean;
}

/** A new editor: four lines, shown. */
export const DEFAULT_SPLIT: IEditorSplit = Object.freeze({ height: EDITOR_DEFAULT, collapsed: false });

/**
 * The tallest the editor may be.
 *
 * @param available - The space the editor and the results share, in pixels; null before it is measured.
 * @returns The bound (never below one line; unbounded before a measurement).
 */
export function editorMax(available: number | null): number {
	if (available === null) return Number.POSITIVE_INFINITY;
	return Math.max(EDITOR_MIN, Math.floor(available) - RESULTS_MIN);
}

/**
 * Clamp a height to the bounds.
 *
 * @param height - Pixels.
 * @param available - See {@link editorMax}.
 * @returns Whole pixels within the bounds.
 */
export function clampEditorHeight(height: number, available: number | null): number {
	return Math.round(Math.min(editorMax(available), Math.max(EDITOR_MIN, height)));
}

/**
 * The height a hidden editor comes back at: the one it had, unless that was one line, then the default.
 *
 * @param height - The height it had.
 * @returns The height to show it at.
 */
export function restoredHeight(height: number): number {
	return height <= EDITOR_MIN ? EDITOR_DEFAULT : height;
}

/**
 * What a key does to the divider.
 *
 * @param split - Where it is.
 * @param key - The key pressed on the focused separator.
 * @param available - See {@link editorMax}.
 * @returns Where it moves to, or null when the key is not the divider's.
 */
export function splitAfterKey(split: IEditorSplit, key: string, available: number | null): IEditorSplit | null {
	switch (key) {
		case 'ArrowUp':
			return split.collapsed ? split : { height: clampEditorHeight(split.height - EDITOR_STEP, available), collapsed: false };
		case 'ArrowDown':
			return split.collapsed ? { height: clampEditorHeight(restoredHeight(split.height), available), collapsed: false } : { height: clampEditorHeight(split.height + EDITOR_STEP, available), collapsed: false };
		case 'Home':
			return { height: split.height, collapsed: true };
		case 'End':
			return { height: clampEditorHeight(split.collapsed ? restoredHeight(split.height) : split.height, available), collapsed: false };
		default:
			return null;
	}
}

/**
 * Hide a shown editor, or show a hidden one (a double click on the divider, or Hide/Show editor).
 *
 * @param split - Where the divider is.
 * @returns The other state, at the same height.
 */
export function splitToggled(split: IEditorSplit): IEditorSplit {
	return split.collapsed ? { height: restoredHeight(split.height), collapsed: false } : { height: split.height, collapsed: true };
}

/**
 * Where a drag leaves the divider. A hidden editor grows from one line.
 *
 * @param split - Where the divider was when the drag started.
 * @param deltaY - The pointer's vertical travel (down is positive).
 * @param available - See {@link editorMax}.
 * @returns The new split, shown.
 */
export function splitAfterDrag(split: IEditorSplit, deltaY: number, available: number | null): IEditorSplit {
	const from = split.collapsed ? EDITOR_MIN : split.height;
	return { height: clampEditorHeight(from + deltaY, available), collapsed: false };
}

/**
 * The separator's ARIA values: the editor's height in pixels, 0 while hidden.
 *
 * @param split - Where the divider is.
 * @param available - See {@link editorMax}.
 * @returns aria-valuenow, -min, -max and -text.
 */
export function splitAria(split: IEditorSplit, available: number | null): { now: number; min: number; max: number; text: string } {
	const max = available === null ? split.height : editorMax(available);
	return split.collapsed ? { now: 0, min: 0, max, text: 'Editor hidden' } : { now: split.height, min: 0, max, text: `Editor ${split.height} pixels high` };
}

/**
 * The height kept in the prefs, when it is a sensible number.
 *
 * @param value - What the prefs hold.
 * @returns The height to open at (at least one line), or the default.
 */
export function storedEditorHeight(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return EDITOR_DEFAULT;
	return Math.round(Math.max(EDITOR_MIN, value));
}
