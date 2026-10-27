// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// QUERY TABS: the workbench's tabs inside one document, and where text goes
// =============================================================================
//
// A preview, an Ask answer, a History "Run again" or a saved query opens its own
// tab, so the text in another tab (Query 1's persisted draft above all) is never
// replaced. Only "Load into editor" and "Insert" go into an existing tab, and
// only into the query tab shown last.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIRST_QUERY_TAB, MAX_QUERY_TABS, OVERVIEW_TAB, activateTab, askTitle, clipTitle, closeTab, historyTitle, initialTabs, openTab, placeRequest, previewTitle, scrollLeftToShow, stepTab, tabOrder, tabsFullText } from '../src/graph/queryTabs';
import type { IQueryTabsState } from '../src/graph/queryTabs';

/** Open `n` more query tabs. */
function withTabs(n: number, state: IQueryTabsState = initialTabs()): IQueryTabsState {
	let next = state;
	for (let i = 0; i < n; i++) {
		const out = openTab(next, { origin: 'query' });
		assert.ok('id' in out, 'opened');
		next = out.state;
	}
	return next;
}

test('a workbench opens on Overview, with Query 1 beside it', () => {
	const state = initialTabs();
	assert.equal(state.active, OVERVIEW_TAB);
	assert.deepEqual(state.tabs.map((t) => [t.id, t.title, t.origin]), [[FIRST_QUERY_TAB, 'Query 1', 'query']]);
	assert.equal(state.lastQuery, FIRST_QUERY_TAB);
	assert.deepEqual(tabOrder(state), [OVERVIEW_TAB, FIRST_QUERY_TAB]);
});

test('opening a tab activates it, and a new query is numbered after the ones already given', () => {
	const one = openTab(initialTabs(), { origin: 'query' });
	assert.ok('id' in one);
	assert.equal(one.state.active, one.id);
	assert.equal(one.state.lastQuery, one.id);
	assert.equal(one.state.tabs[1].title, 'Query 2');
	const preview = openTab(one.state, { origin: 'preview', title: previewTitle('Person') });
	assert.ok('id' in preview);
	assert.equal(preview.state.tabs[2].title, 'Person (preview)');
	const three = openTab(preview.state, { origin: 'query' });
	assert.ok('id' in three);
	assert.equal(three.state.tabs[3].title, 'Query 3', 'a titled tab does not take a query number');
});

test('tab ids are unique and never reused after a close', () => {
	let state = withTabs(3);
	const seen = new Set(state.tabs.map((t) => t.id));
	assert.equal(seen.size, state.tabs.length);
	state = closeTab(state, state.tabs[2].id);
	const again = openTab(state, { origin: 'query' });
	assert.ok('id' in again);
	assert.ok(!seen.has(again.id), 'a fresh id');
	assert.ok(!again.id.includes(OVERVIEW_TAB));
});

test(`at most ${MAX_QUERY_TABS} query tabs: the next is refused with a sentence and nothing is dropped`, () => {
	const full = withTabs(MAX_QUERY_TABS - 1);
	assert.equal(full.tabs.length, MAX_QUERY_TABS);
	const out = openTab(full, { origin: 'preview', title: 'Person (preview)' });
	assert.ok('refused' in out);
	assert.equal(out.state, full, 'the state is untouched');
	assert.equal(out.refused, tabsFullText('Person (preview)'));
	assert.match(out.refused, /^“Person \(preview\)” was not opened: 8 query tabs are open, the most a workbench holds\. Close one, then try again\.$/);
});

test('Overview cannot be closed; closing the active tab activates its neighbour', () => {
	const state = withTabs(2);
	const [a, b, c] = state.tabs.map((t) => t.id);
	assert.equal(closeTab(state, OVERVIEW_TAB), state);
	const middle = closeTab(activateTab(state, b), b);
	assert.equal(middle.active, c, 'the tab to the right');
	const last = closeTab(activateTab(state, c), c);
	assert.equal(last.active, b, 'the tab to the left when there is none to the right');
	const other = closeTab(activateTab(state, a), c);
	assert.equal(other.active, a, 'closing a background tab leaves the active one');
	let empty = state;
	for (const id of [a, b, c]) empty = closeTab(empty, id);
	assert.equal(empty.tabs.length, 0);
	assert.equal(empty.active, OVERVIEW_TAB, 'with no query tab left, Overview');
	assert.equal(empty.lastQuery, null);
});

test('activating follows only tabs that exist, and remembers the query tab shown last', () => {
	const state = withTabs(1);
	const [a, b] = state.tabs.map((t) => t.id);
	assert.equal(activateTab(state, 'nope'), state);
	const onA = activateTab(state, a);
	assert.equal(onA.lastQuery, a);
	const onOverview = activateTab(onA, OVERVIEW_TAB);
	assert.equal(onOverview.active, OVERVIEW_TAB);
	assert.equal(onOverview.lastQuery, a, 'Overview is not a query tab');
	assert.equal(closeTab(onOverview, a).lastQuery, b);
});

test('arrow keys, Home and End move along the strip, wrapping at the ends', () => {
	const order = [OVERVIEW_TAB, 'q1', 'q2'];
	assert.equal(stepTab(order, 'q1', 'ArrowRight'), 'q2');
	assert.equal(stepTab(order, 'q2', 'ArrowRight'), OVERVIEW_TAB);
	assert.equal(stepTab(order, OVERVIEW_TAB, 'ArrowLeft'), 'q2');
	assert.equal(stepTab(order, 'q2', 'Home'), OVERVIEW_TAB);
	assert.equal(stepTab(order, OVERVIEW_TAB, 'End'), 'q2');
	assert.equal(stepTab(order, 'q1', 'Enter'), null);
});

test('titles are clipped to 30 characters on one line', () => {
	assert.equal(clipTitle('  MATCH (n)\n  RETURN n  '), 'MATCH (n) RETURN n');
	const long = clipTitle('which people work at Acme and also know someone at Initech?');
	assert.equal(long.length, 30);
	assert.ok(long.endsWith('…'));
	assert.equal(askTitle('who works where?'), 'Ask: who works where?');
	assert.equal(historyTitle('// first\nMATCH (n) RETURN n'), 'History: // first');
});

// -----------------------------------------------------------------------------
// Where a request's text goes (the M5 rule: a draft is never overwritten)
// -----------------------------------------------------------------------------

test('a sidebar preview with a draft in Query 1 opens a new tab and runs there; Query 1 is not touched', () => {
	const state = initialTabs();
	const placed = placeRequest(state, { kind: 'new', origin: 'preview', title: previewTitle('Person'), text: 'MATCH (n:Person) RETURN n LIMIT 25', run: true });
	assert.ok('target' in placed);
	assert.notEqual(placed.target, FIRST_QUERY_TAB);
	assert.equal(placed.state.active, placed.target);
	assert.deepEqual(placed.put, { text: 'MATCH (n:Person) RETURN n LIMIT 25', run: true, insert: false });
	assert.equal(placed.state.tabs.find((t) => t.id === FIRST_QUERY_TAB)?.title, 'Query 1', 'Query 1 is still there');
});

test('an Ask answer opens a new tab, not run, that remembers the question and the tab it was asked from', () => {
	const state = activateTab(withTabs(1), FIRST_QUERY_TAB);
	const placed = placeRequest(state, { kind: 'new', origin: 'ask', title: askTitle('who works where?'), text: 'MATCH (p)-[r]->(c) RETURN p, r, c', run: false, ask: { question: 'who works where?', from: FIRST_QUERY_TAB } });
	assert.ok('target' in placed);
	assert.equal(placed.put.run, false);
	const tab = placed.state.tabs.find((t) => t.id === placed.target);
	assert.deepEqual(tab?.ask, { question: 'who works where?', from: FIRST_QUERY_TAB });
});

test('Load into editor and Insert go into the query tab shown last, and open one when there is none', () => {
	const state = withTabs(1);
	const [a] = state.tabs.map((t) => t.id);
	const onA = activateTab(activateTab(state, a), OVERVIEW_TAB);
	const loaded = placeRequest(onA, { kind: 'replace', text: 'RETURN 1' });
	assert.ok('target' in loaded);
	assert.equal(loaded.target, a);
	assert.equal(loaded.state.active, a, 'the tab is shown');
	assert.deepEqual(loaded.put, { text: 'RETURN 1', run: false, insert: false });
	const inserted = placeRequest(onA, { kind: 'insert', text: 'RETURN 2' });
	assert.ok('target' in inserted);
	assert.deepEqual(inserted.put, { text: 'RETURN 2', run: false, insert: true });

	let none = state;
	for (const tab of state.tabs) none = closeTab(none, tab.id);
	const opened = placeRequest(none, { kind: 'replace', text: 'RETURN 3' });
	assert.ok('target' in opened);
	assert.equal(opened.state.tabs.length, 1);
	assert.equal(opened.put.insert, false, 'into a new, empty tab: nothing to insert into');
});

test('a request that would need a ninth tab is refused, and the state is untouched', () => {
	const full = withTabs(MAX_QUERY_TABS - 1);
	const placed = placeRequest(full, { kind: 'new', origin: 'history', title: historyTitle('MATCH (n) RETURN n'), text: 'MATCH (n) RETURN n', run: true });
	assert.ok('refused' in placed);
	assert.equal(placed.state, full);
});

// M14: a visible sentence longer than 160 characters goes behind a Details disclosure; these are shown whole.
test('the sentences the tabs show stay under 160 characters, whatever the titles quote', () => {
	const long = 'x'.repeat(500);
	for (const text of [tabsFullText(previewTitle(long)), tabsFullText(askTitle(long)), tabsFullText(historyTitle(long))]) assert.ok(text.length <= 160, text);
});

// An Ask answer can arrive long after the question: it opens its tab without taking the screen from the tab now shown.
test('a tab can open in the background: the shown tab and the query tab shown last stay as they were', () => {
	const state = activateTab(withTabs(1), FIRST_QUERY_TAB);
	const placed = placeRequest(state, { kind: 'new', origin: 'ask', title: askTitle('late'), text: 'MATCH (n) RETURN n', run: false, activate: false });
	assert.ok('target' in placed);
	assert.equal(placed.state.active, FIRST_QUERY_TAB);
	assert.equal(placed.state.lastQuery, FIRST_QUERY_TAB);
	assert.ok(placed.state.tabs.some((t) => t.id === placed.target));
	const opened = openTab(state, { origin: 'query', activate: false });
	assert.ok('id' in opened);
	assert.equal(opened.state.active, FIRST_QUERY_TAB);
});

// The shown tab is brought into view by scrolling the tab list itself (never an ancestor, such as a frame's document).
test('the tab list scrolls just enough to show the shown tab, and not at all when it is in view', () => {
	// The list shows 100..400 on screen and is scrolled 50 px.
	assert.equal(scrollLeftToShow({ left: 100, right: 400 }, { left: 150, right: 250 }, 50), 50, 'in view: no change');
	assert.equal(scrollLeftToShow({ left: 100, right: 400 }, { left: 380, right: 460 }, 50), 110, 'past the right edge: scroll right by 60');
	assert.equal(scrollLeftToShow({ left: 100, right: 400 }, { left: 60, right: 140 }, 50), 10, 'past the left edge: scroll left by 40');
	assert.equal(scrollLeftToShow({ left: 100, right: 400 }, { left: 20, right: 90 }, 30), 0, 'never below 0');
	assert.equal(scrollLeftToShow({ left: 100, right: 200 }, { left: 120, right: 260 }, 0), 0, 'a tab wider than the list whose start is in view: no change');
	assert.equal(scrollLeftToShow({ left: 100, right: 200 }, { left: 60, right: 260 }, 50), 10, 'a tab wider than the list that starts before it: its start is brought in');
});
