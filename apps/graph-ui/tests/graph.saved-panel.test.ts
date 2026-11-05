// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SAVED PANEL: "Save current query" takes the tab's text when it is pressed
// =============================================================================
//
// A tab's text lives with its editor and is told to the workbench as it changes,
// which re-renders nothing above the editor. So the panel must read it when the
// button is pressed, never from its own last render: with the panel open, typing
// into the tab and then pressing Save keeps what the editor holds then.
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { NO_QUERY_TAB_TEXT, EMPTY_QUERY_TAB_TEXT, saveStart, suggestedName } from '../src/components/SavedQueriesPanel';

test('Save current query takes the text the tab holds when it is pressed, not when the panel last rendered', () => {
	let text = '';
	const current = (): { title: string; text: string } => ({ title: 'Query 2', text });
	// The panel rendered while the tab was empty; then the user typed.
	text = 'MATCH (p:Person) RETURN p';
	assert.deepEqual(saveStart(current), { name: 'MATCH (p:Person) RETURN p', text: 'MATCH (p:Person) RETURN p' });
	text = 'MATCH (c:Company) RETURN c';
	assert.deepEqual(saveStart(current), { name: 'MATCH (c:Company) RETURN c', text: 'MATCH (c:Company) RETURN c' });
});

test('an empty tab, or no query tab at all, is refused with a sentence instead of a disabled button', () => {
	assert.deepEqual(saveStart(() => ({ title: 'Query 3', text: '  \n ' })), { refusal: EMPTY_QUERY_TAB_TEXT });
	assert.deepEqual(saveStart(() => null), { refusal: NO_QUERY_TAB_TEXT });
	assert.match(EMPTY_QUERY_TAB_TEXT, /^Nothing was saved: /);
});

test('the name starts from the tab title unless it is a plain "Query N", then from the first line', () => {
	assert.equal(suggestedName({ title: 'Person (preview)', text: 'MATCH (n:Person) RETURN n LIMIT 25' }), 'Person');
	assert.equal(suggestedName({ title: 'Query 4', text: '\n  MATCH (n) RETURN n\nLIMIT 5' }), 'MATCH (n) RETURN n');
});

test('the panel reads the tab only when the button is pressed', () => {
	const source = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'SavedQueriesPanel.tsx'), 'utf8');
	assert.doesNotMatch(source, /const tab = current\(\);/, 'no read of the tab text during render');
	assert.match(source, /onClick=\{\(\) => \{\s*const start = saveStart\(current\);/, 'the click reads it');
});
