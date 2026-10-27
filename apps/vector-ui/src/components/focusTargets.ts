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
// VECTOR-UI - WHERE THE FOCUS GOES WHEN ITS CONTROL LEAVES (the workbench's fallbacks)
// =============================================================================
//
// When the pending bar goes (Discard, or its last staged document moved)
// with the focus in it, the focus moves inside the same workbench, in this
// order, never to the page:
//
//   1. the row the shown grid marks for it (`data-return-focus`);
//   2. the grid shown on the current tab: its row in the tab order, else the grid;
//   3. the current tab in the tab row;
//   4. the first button of the workbench's header.
//
// The first three are the order views/ConsoleView.tsx returnFocus uses when an
// inline confirmation closes.
//
// Each step is a selector over the workbench (FOCUS_FALLBACK), tried while
// visible (a hidden tab's grid is skipped).
// =============================================================================

import { focusLost } from '../vector/focus';

/** The workbench element (views/ConsoleView.tsx renders it with data-console). */
export const WORKBENCH_SELECTOR = '[data-console]';

/** The fallbacks, in order. */
export const FOCUS_FALLBACK: readonly string[] = [
	'[data-grid-focus] [data-return-focus]',
	'[data-grid-focus] [data-grid-row][tabindex="0"]',
	'[data-grid-focus]',
	'[data-workbench-tabs] [aria-selected="true"], [data-workbench-tabs] [aria-pressed="true"]',
	'header button',
];

/**
 * The workbench an element is in (read it while the element is still on the page).
 *
 * @param el - An element of the workbench.
 * @returns The workbench element, or null.
 */
export function workbenchOf(el: Element | null): HTMLElement | null {
	return el?.closest<HTMLElement>(WORKBENCH_SELECTOR) ?? null;
}

/** Whether an element is laid out (not inside a hidden tab or document). */
function shown(el: Element): boolean {
	return el.getClientRects().length > 0;
}

/**
 * Focus the first fallback that is there and shown.
 *
 * @param workbench - The workbench (from {@link workbenchOf}, read before the control left).
 * @returns True when something took the focus.
 */
export function focusWorkbench(workbench: HTMLElement | null): boolean {
	if (workbench === null || !workbench.isConnected) return false;
	for (const selector of FOCUS_FALLBACK) {
		for (const el of workbench.querySelectorAll<HTMLElement>(selector)) {
			if (!shown(el)) continue;
			el.focus({ preventScroll: true });
			if (document.activeElement === el) return true;
		}
	}
	return false;
}

/**
 * Whether the focus fell to the page (its element left, or nothing has it).
 *
 * @returns True when nothing in particular has the focus.
 */
export function focusFell(): boolean {
	return typeof document !== 'undefined' && focusLost(document.activeElement, document.body, null);
}
