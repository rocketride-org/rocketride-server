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
// GRAPH - QUERY TABS (the workbench's tabs, inside its one document)
// =============================================================================
//
// A workbench document holds an Overview tab and up to MAX_QUERY_TABS query
// tabs, each with its own editor, runs, results and graph. The tabs live INSIDE
// the document: a dev-tool frame gets only its docKey, never a payload, so a
// document per query would need a new docKey family, a seed channel and, in
// VS Code, one webview per query.
//
// The rule this model enforces: text that arrives from elsewhere (a sidebar
// preview, an Ask answer, History's Run again or Open in new tab, a saved query
// or a template, the graph's "New query from here") opens its OWN tab, so no
// draft is ever replaced. Only "Load into editor" and "Insert" go into an
// existing tab, the query tab shown last, as an explicit replace or insert the
// editor can undo.
//
// Pure: no React, no ids from a clock. The workbench keeps one load slot per
// tab (graph/loadSlot.ts) and puts `put` into the target tab's slot.
// =============================================================================

/** The most query tabs one workbench holds (Overview is not counted). */
export const MAX_QUERY_TABS = 8;

/** The Overview tab's id. It is always first and cannot be closed. */
export const OVERVIEW_TAB = 'overview';

/** Query 1's id: the tab whose draft is persisted (as the workbench's one editor was before tabs). */
export const FIRST_QUERY_TAB = 'q1';

/** Where a tab's text came from. */
export type QueryTabOrigin = 'query' | 'preview' | 'ask' | 'explore' | 'history' | 'saved' | 'template' | 'graph';

/** One query tab. */
export interface IQueryTab {
	id: string;
	title: string;
	origin: QueryTabOrigin;
	/** For a tab Ask opened: the question, and the tab it was asked from. */
	ask?: { question: string; from: string };
}

/** The tabs of one workbench. */
export interface IQueryTabsState {
	/** The query tabs, in strip order (Overview is implicit and always first). */
	tabs: readonly IQueryTab[];
	/** The tab shown: OVERVIEW_TAB or a query tab's id. */
	active: string;
	/** The query tab shown last, where "Load into editor" and "Insert" go; null when there is none. */
	lastQuery: string | null;
	/** The next id number (ids are never reused). */
	nextId: number;
	/** The next "Query N" number. */
	nextQuery: number;
}

/** What a request asks for. */
export type TabRequest =
	| { kind: 'new'; origin: QueryTabOrigin; title?: string; text: string; run: boolean; ask?: { question: string; from: string }; activate?: boolean }
	| { kind: 'replace'; text: string }
	| { kind: 'insert'; text: string };

/** What goes into the target tab's load slot. */
export interface ITabPut {
	text: string;
	run: boolean;
	/** Insert at the caret (replacing a selection) instead of replacing the text. */
	insert: boolean;
}

// =============================================================================
// TITLES
// =============================================================================

/** The most characters a title takes from text it quotes. */
const TITLE_CHARS = 30;

/**
 * Text for a tab title: one line, at most 30 characters.
 *
 * @param text - Any text.
 * @returns The text with its whitespace collapsed, cut with an ellipsis past 30 characters.
 */
export function clipTitle(text: string): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length <= TITLE_CHARS ? line : `${line.slice(0, TITLE_CHARS - 1).trimEnd()}…`;
}

/**
 * @param name - A label or relationship type.
 * @returns The title of its preview tab.
 */
export function previewTitle(name: string): string {
	return `${clipTitle(name)} (preview)`;
}

/**
 * @param question - The question asked.
 * @returns The title of the tab its answer opens.
 */
export function askTitle(question: string): string {
	return `Ask: ${clipTitle(question)}`;
}

/**
 * @param cypher - A statement from History.
 * @returns The title of the tab it opens: its first line.
 */
export function historyTitle(cypher: string): string {
	const first = cypher.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
	return `History: ${clipTitle(first)}`;
}

/**
 * The sentence a refused tab says. Nothing is dropped to make room: the person chooses what to close.
 *
 * @param title - The tab that was not opened.
 * @returns The sentence.
 */
export function tabsFullText(title: string): string {
	return `“${title}” was not opened: ${MAX_QUERY_TABS} query tabs are open, the most a workbench holds. Close one, then try again.`;
}

// =============================================================================
// STATE
// =============================================================================

/**
 * A workbench's tabs when it opens: Overview shown, Query 1 beside it.
 *
 * @returns The state.
 */
export function initialTabs(): IQueryTabsState {
	return { tabs: [{ id: FIRST_QUERY_TAB, title: 'Query 1', origin: 'query' }], active: OVERVIEW_TAB, lastQuery: FIRST_QUERY_TAB, nextId: 2, nextQuery: 2 };
}

/**
 * Every tab id in strip order, Overview first.
 *
 * @param state - The tabs.
 * @returns The ids.
 */
export function tabOrder(state: IQueryTabsState): string[] {
	return [OVERVIEW_TAB, ...state.tabs.map((tab) => tab.id)];
}

/**
 * Open a query tab and show it (or, with `activate: false`, open it behind the tab shown).
 *
 * @param state - The tabs.
 * @param input - Where its text came from, its title (default "Query N"), for Ask the question, and whether to show it.
 * @returns The new state and the tab's id, or the same state and the sentence saying why it was not opened.
 */
export function openTab(state: IQueryTabsState, input: { origin: QueryTabOrigin; title?: string; ask?: { question: string; from: string }; activate?: boolean }): { state: IQueryTabsState; id: string } | { state: IQueryTabsState; refused: string } {
	const numbered = input.title === undefined;
	const title = input.title ?? `Query ${state.nextQuery}`;
	if (state.tabs.length >= MAX_QUERY_TABS) return { state, refused: tabsFullText(title) };
	const id = `q${state.nextId}`;
	const tab: IQueryTab = { id, title, origin: input.origin, ...(input.ask ? { ask: { ...input.ask } } : {}) };
	const show = input.activate !== false;
	return {
		id,
		state: { tabs: [...state.tabs, tab], active: show ? id : state.active, lastQuery: show ? id : state.lastQuery ?? id, nextId: state.nextId + 1, nextQuery: numbered ? state.nextQuery + 1 : state.nextQuery },
	};
}

/**
 * Show a tab.
 *
 * @param state - The tabs.
 * @param id - OVERVIEW_TAB or a query tab's id.
 * @returns The new state (the same one when there is no such tab).
 */
export function activateTab(state: IQueryTabsState, id: string): IQueryTabsState {
	if (id === OVERVIEW_TAB) return state.active === id ? state : { ...state, active: id };
	if (!state.tabs.some((tab) => tab.id === id)) return state;
	return state.active === id && state.lastQuery === id ? state : { ...state, active: id, lastQuery: id };
}

/**
 * Close a query tab. The tab shown next is its right neighbour, else its left one, else Overview.
 *
 * @param state - The tabs.
 * @param id - The tab to close (Overview cannot be closed).
 * @returns The new state (the same one for Overview or an unknown id).
 */
export function closeTab(state: IQueryTabsState, id: string): IQueryTabsState {
	const index = state.tabs.findIndex((tab) => tab.id === id);
	if (index < 0) return state;
	const tabs = state.tabs.filter((tab) => tab.id !== id);
	const neighbour = tabs[index]?.id ?? tabs[index - 1]?.id ?? null;
	const active = state.active === id ? neighbour ?? OVERVIEW_TAB : state.active;
	const lastQuery = state.lastQuery === id ? (active !== OVERVIEW_TAB ? active : neighbour) : state.lastQuery;
	return { ...state, tabs, active, lastQuery };
}

/**
 * The tab a key moves to in the strip (automatic activation, wrapping at the ends).
 *
 * @param order - Every tab id in strip order.
 * @param current - The focused tab.
 * @param key - The key pressed.
 * @returns The tab to move to, or null when the key does not move.
 */
export function stepTab(order: readonly string[], current: string, key: string): string | null {
	if (order.length === 0) return null;
	const at = Math.max(0, order.indexOf(current));
	switch (key) {
		case 'ArrowRight':
			return order[(at + 1) % order.length];
		case 'ArrowLeft':
			return order[(at - 1 + order.length) % order.length];
		case 'Home':
			return order[0];
		case 'End':
			return order[order.length - 1];
		default:
			return null;
	}
}

/**
 * Where a request's text goes. A `new` request always opens a tab; `replace` and `insert` go into the query tab shown
 * last, and open a tab when there is none (an empty one, so there is nothing to insert into).
 *
 * @param state - The tabs.
 * @param request - The request.
 * @returns The new state, the tab to put the text in and what to put; or the same state and why no tab was opened.
 */
export function placeRequest(state: IQueryTabsState, request: TabRequest): { state: IQueryTabsState; target: string; put: ITabPut } | { state: IQueryTabsState; refused: string } {
	if (request.kind !== 'new' && state.lastQuery !== null) {
		return { state: activateTab(state, state.lastQuery), target: state.lastQuery, put: { text: request.text, run: false, insert: request.kind === 'insert' } };
	}
	const opened = request.kind === 'new' ? openTab(state, { origin: request.origin, ...(request.title !== undefined ? { title: request.title } : {}), ...(request.ask ? { ask: request.ask } : {}), ...(request.activate === false ? { activate: false } : {}) }) : openTab(state, { origin: 'query' });
	if ('refused' in opened) return opened;
	return { state: opened.state, target: opened.id, put: { text: request.text, run: request.kind === 'new' && request.run, insert: false } };
}

/**
 * Where to scroll the tab list so a tab is in view: not at all when it already is, else just enough. A tab wider than
 * the list shows its start. Only the list scrolls (scrollIntoView would also scroll its ancestors, a frame's document).
 *
 * @param view - The list's visible edges on screen.
 * @param item - The tab's edges on screen.
 * @param scrollLeft - The list's scroll position now.
 * @returns The scroll position to set (never below 0).
 */
export function scrollLeftToShow(view: { left: number; right: number }, item: { left: number; right: number }, scrollLeft: number): number {
	const tooWide = item.right - item.left > view.right - view.left;
	if (item.left >= view.left && (item.right <= view.right || tooWide)) return scrollLeft;
	if (item.left < view.left || tooWide) return Math.max(0, scrollLeft - (view.left - item.left));
	return scrollLeft + (item.right - view.right);
}
