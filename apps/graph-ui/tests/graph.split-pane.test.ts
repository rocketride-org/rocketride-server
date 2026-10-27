// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// EDITOR SPLIT: the divider between the editor and the results
// =============================================================================
//
// The editor's height is clamped between one line and what leaves the results
// RESULTS_MIN pixels; the keys step it by EDITOR_STEP; Home hides the editor and
// End brings it back at the height it had.
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SPLIT, EDITOR_DEFAULT, EDITOR_MIN, EDITOR_STEP, RESULTS_MIN, clampEditorHeight, editorMax, restoredHeight, splitAfterDrag, splitAfterKey, splitAria, splitToggled, storedEditorHeight } from '../src/graph/splitPane';

test('the editor is clamped between one line and the space that leaves the results their minimum', () => {
	assert.equal(editorMax(800), 800 - RESULTS_MIN);
	assert.equal(editorMax(100), EDITOR_MIN, 'never below one line, even in a tiny document');
	assert.equal(editorMax(null), Number.POSITIVE_INFINITY, 'unmeasured: no upper bound yet');
	assert.equal(clampEditorHeight(5, 800), EDITOR_MIN);
	assert.equal(clampEditorHeight(10_000, 800), 600);
	assert.equal(clampEditorHeight(301.6, 800), 302, 'whole pixels');
	assert.equal(clampEditorHeight(10_000, null), 10_000);
});

test('the arrow keys step by 24 pixels, within the bounds', () => {
	assert.equal(EDITOR_STEP, 24);
	const split = { height: 200, collapsed: false };
	assert.deepEqual(splitAfterKey(split, 'ArrowDown', 800), { height: 224, collapsed: false });
	assert.deepEqual(splitAfterKey(split, 'ArrowUp', 800), { height: 176, collapsed: false });
	assert.deepEqual(splitAfterKey({ height: EDITOR_MIN, collapsed: false }, 'ArrowUp', 800), { height: EDITOR_MIN, collapsed: false });
	assert.deepEqual(splitAfterKey({ height: 590, collapsed: false }, 'ArrowDown', 800), { height: 600, collapsed: false });
	assert.equal(splitAfterKey(split, 'Enter', 800), null, 'other keys are not the divider\'s');
});

test('Home hides the editor and End brings it back at the height it had; a hidden editor grows from where it was', () => {
	const split = { height: 260, collapsed: false };
	const hidden = splitAfterKey(split, 'Home', 800);
	assert.deepEqual(hidden, { height: 260, collapsed: true });
	assert.deepEqual(splitAfterKey(hidden!, 'End', 800), { height: 260, collapsed: false });
	assert.deepEqual(splitAfterKey(hidden!, 'ArrowDown', 800), { height: 260, collapsed: false }, 'ArrowDown shows it again first');
	assert.deepEqual(splitAfterKey(hidden!, 'ArrowUp', 800), hidden, 'ArrowUp on a hidden editor does nothing');
});

test('a double click hides the editor, and shows it again', () => {
	const split = { height: 200, collapsed: false };
	assert.deepEqual(splitToggled(split), { height: 200, collapsed: true });
	assert.deepEqual(splitToggled(splitToggled(split)), split);
});

test('a drag moves the divider by the pointer\'s travel, clamped, and shows a hidden editor', () => {
	assert.deepEqual(splitAfterDrag({ height: 200, collapsed: false }, 40, 800), { height: 240, collapsed: false });
	assert.deepEqual(splitAfterDrag({ height: 200, collapsed: false }, -1000, 800), { height: EDITOR_MIN, collapsed: false });
	assert.deepEqual(splitAfterDrag({ height: 200, collapsed: true }, 30, 800), { height: EDITOR_MIN + 30, collapsed: false }, 'a hidden editor grows from one line');
	assert.deepEqual(splitAfterDrag({ height: 200, collapsed: false }, 2, 800), { height: 202, collapsed: false });
});

test('the separator reports its value in pixels, 0 while the editor is hidden', () => {
	assert.deepEqual(splitAria({ height: 200, collapsed: false }, 800), { now: 200, min: 0, max: 600, text: 'Editor 200 pixels high' });
	assert.deepEqual(splitAria({ height: 200, collapsed: true }, 800), { now: 0, min: 0, max: 600, text: 'Editor hidden' });
	assert.equal(splitAria({ height: 200, collapsed: false }, null).max, 200, 'unmeasured: the current height is the maximum known');
});

test('a stored height is used only when it is a sensible number', () => {
	assert.deepEqual(DEFAULT_SPLIT, { height: EDITOR_DEFAULT, collapsed: false });
	assert.equal(storedEditorHeight(240), 240);
	assert.equal(storedEditorHeight('240'), EDITOR_DEFAULT);
	assert.equal(storedEditorHeight(Number.NaN), EDITOR_DEFAULT);
	assert.equal(storedEditorHeight(-4), EDITOR_DEFAULT);
	assert.equal(storedEditorHeight(5), EDITOR_MIN);
	assert.equal(storedEditorHeight(undefined), EDITOR_DEFAULT);
});

// Live bug 3: hiding an editor kept at one line and showing it again gave back one line (40 px), not a usable editor.
test('a hidden editor whose height was one line comes back at the default; any other height comes back as it was', () => {
	const fromMin = { height: EDITOR_MIN, collapsed: true };
	assert.deepEqual(splitToggled(fromMin), { height: EDITOR_DEFAULT, collapsed: false }, 'Show editor, or a double click');
	assert.deepEqual(splitAfterKey(fromMin, 'End', 800), { height: EDITOR_DEFAULT, collapsed: false }, 'End');
	assert.deepEqual(splitAfterKey(fromMin, 'ArrowDown', 800), { height: EDITOR_DEFAULT, collapsed: false }, 'ArrowDown');
	assert.deepEqual(splitToggled({ height: 260, collapsed: true }), { height: 260, collapsed: false });
	assert.deepEqual(splitToggled({ height: EDITOR_MIN, collapsed: false }), { height: EDITOR_MIN, collapsed: true }, 'hiding keeps the height it had');
	assert.equal(restoredHeight(EDITOR_MIN), EDITOR_DEFAULT);
	assert.equal(restoredHeight(EDITOR_MIN + 1), EDITOR_MIN + 1);
});
