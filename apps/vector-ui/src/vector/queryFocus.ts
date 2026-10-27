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
// VECTOR - THE QUERY TAB'S FOCUS AND KEYS (pure)
// =============================================================================
//
// Where the keyboard focus goes when something in the Query tab hides or
// goes away, which key moves between its Search, Compare and Ask tabs, and
// which Escape handler acts. The components hold only the call sites; the
// decisions are here, where they can be tested without a page:
//
//   - focus never falls to <body>: a sub-tab that hides the focused control
//     (a result's "ask about this", "Open in Search", "Use Search", a
//     history entry's Load) moves it to the shown tab's first control;
//   - the History aside: removing an entry moves to the next one (else the
//     previous, else the heading); closing it returns to its button;
//   - Escape: the innermost handler that acts calls preventDefault, and the
//     ones around it skip an event already handled (no stopPropagation).
// =============================================================================

import type { QueryMode } from './workbench';

/** The Query tab's modes, in the order its tab row shows them. */
export const QUERY_MODES: readonly QueryMode[] = ['search', 'compare', 'ask'];

/** The words of each mode's tab. */
export const QUERY_MODE_LABELS: Readonly<Record<QueryMode, string>> = { search: 'Search', compare: 'Compare', ask: 'Ask' };

/**
 * The tab a key moves to in the Query tab's tab row (the tabs follow focus).
 *
 * @param current - The tab shown.
 * @param key - KeyboardEvent.key.
 * @returns The tab to show, or null for a key the row does not take.
 */
export function nextQueryTab(current: QueryMode, key: string): QueryMode | null {
	const at = QUERY_MODES.indexOf(current);
	if (key === 'ArrowRight') return QUERY_MODES[(at + 1) % QUERY_MODES.length];
	if (key === 'ArrowLeft') return QUERY_MODES[(at - 1 + QUERY_MODES.length) % QUERY_MODES.length];
	if (key === 'Home') return QUERY_MODES[0];
	if (key === 'End') return QUERY_MODES[QUERY_MODES.length - 1];
	return null;
}

/** Where the focused element is: nowhere (<body>), inside something hidden (no layout box), or on screen. */
export type ActiveFocus = 'body' | 'hidden' | 'shown';

/**
 * Whether the focus must be moved: it fell to <body>, or it sits on a control a hidden tab took off the screen.
 *
 * @param active - Where the focus is.
 * @returns True when the tab's first control should take it.
 */
export function needsFocusRescue(active: ActiveFocus): boolean {
	return active !== 'shown';
}

/** The controls the Query tab moves the focus to (each marked `data-query-focus`). */
export type QueryFocusTarget = 'question' | 'composer' | 'use-search' | 'tab' | 'history-toggle' | 'history-heading' | 'history-clear';

/**
 * The first control of a shown sub-tab.
 *
 * @param mode - The sub-tab.
 * @param ask - Whether the chat can ask, and whether Search can run (Ask then offers "Use Search").
 * @returns The control.
 */
export function primaryTarget(mode: QueryMode, ask: { chatAvailable: boolean; searchable: boolean }): QueryFocusTarget {
	if (mode !== 'ask') return 'question';
	if (ask.chatAvailable) return 'composer';
	return ask.searchable ? 'use-search' : 'tab';
}

/**
 * Where the focus goes when a history entry is removed: the next entry, else the previous one, else the heading.
 *
 * @param ids - The entries shown, in order.
 * @param removed - The entry removed.
 * @returns The entry to focus, or the heading.
 */
export function focusAfterRemove(ids: readonly string[], removed: string): { entry: string } | 'history-heading' {
	const at = ids.indexOf(removed);
	if (at >= 0 && at + 1 < ids.length) return { entry: ids[at + 1] };
	if (at > 0) return { entry: ids[at - 1] };
	return 'history-heading';
}

/**
 * Where the focus goes after Pin: it stays on the Pin button, unless the list
 * shows pinned entries only and the entry was just unpinned (it leaves the
 * list), when it goes where a removed entry's would.
 *
 * @param pinnedOnly - The list shows pinned entries only.
 * @param ids - The entries shown, in order.
 * @param id - The entry pinned or unpinned.
 * @param wasPinned - It was pinned before the click.
 * @returns The control of an entry, or the heading.
 */
export function focusAfterPin(pinnedOnly: boolean, ids: readonly string[], id: string, wasPinned: boolean): { entry: string; control: 'pin' | 'load' } | 'history-heading' {
	if (!pinnedOnly || !wasPinned) return { entry: id, control: 'pin' };
	const next = focusAfterRemove(ids, id);
	return typeof next === 'string' ? next : { entry: next.entry, control: 'load' };
}

/**
 * Where the focus goes when the "Clear…" confirmation closes: the heading after clearing, its opener after Cancel.
 *
 * @param confirmed - The history was cleared.
 * @returns The control.
 */
export function focusAfterClear(confirmed: boolean): QueryFocusTarget {
	return confirmed ? 'history-heading' : 'history-clear';
}

/**
 * Escape in a layer of the History aside (its note box, its "Clear…" confirmation, the aside itself): the
 * innermost layer acts; an outer one skips a key an inner one already handled.
 *
 * @param defaultPrevented - An inner handler acted.
 * @returns 'act' or 'pass'.
 */
export function escapeLayer(defaultPrevented: boolean): 'act' | 'pass' {
	return defaultPrevented ? 'pass' : 'act';
}
