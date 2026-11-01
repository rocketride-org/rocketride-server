// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pure-logic tests for the item browser's selection rules and file icon.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { indexAfterKey, mergeSelection, rectsIntersect, selectionAfterClick } from './selection';
import { extensionBadge } from './FileIcon';

const IDS = ['a', 'b', 'c', 'd', 'e'];
const PLAIN = { isToggle: false, isRange: false };

test('a plain click selects only the clicked item and anchors there', () => {
	const next = selectionAfterClick(IDS, { selectedIds: ['a', 'b'], anchorId: 'a' }, 'c', PLAIN);
	assert.deepEqual(next, { selectedIds: ['c'], anchorId: 'c' });
});

test('a toggle click adds or removes one item and keeps display order', () => {
	const added = selectionAfterClick(IDS, { selectedIds: ['d'], anchorId: 'd' }, 'b', { isToggle: true, isRange: false });
	assert.deepEqual(added.selectedIds, ['b', 'd']);
	const removed = selectionAfterClick(IDS, { selectedIds: ['b', 'd'], anchorId: 'b' }, 'd', { isToggle: true, isRange: false });
	assert.deepEqual(removed.selectedIds, ['b']);
});

test('a range click selects the run from the anchor, either direction', () => {
	const down = selectionAfterClick(IDS, { selectedIds: ['b'], anchorId: 'b' }, 'd', { isToggle: false, isRange: true });
	assert.deepEqual(down, { selectedIds: ['b', 'c', 'd'], anchorId: 'b' });
	const up = selectionAfterClick(IDS, { selectedIds: ['d'], anchorId: 'd' }, 'a', { isToggle: false, isRange: true });
	assert.deepEqual(up.selectedIds, ['a', 'b', 'c', 'd']);
});

test('a range click with no anchor acts like a plain click', () => {
	const next = selectionAfterClick(IDS, { selectedIds: [], anchorId: null }, 'c', { isToggle: false, isRange: true });
	assert.deepEqual(next, { selectedIds: ['c'], anchorId: 'c' });
});

test('arrow keys move by one in the grid row and by a row up and down', () => {
	assert.equal(indexAfterKey('ArrowRight', 1, 10, 4), 2);
	assert.equal(indexAfterKey('ArrowDown', 1, 10, 4), 5);
	assert.equal(indexAfterKey('ArrowUp', 1, 10, 4), 0);
	assert.equal(indexAfterKey('End', 1, 10, 4), 9);
	assert.equal(indexAfterKey('ArrowDown', 8, 10, 4), 9);
});

test('left and right do nothing in the list, and other keys never navigate', () => {
	assert.equal(indexAfterKey('ArrowRight', 1, 10, 1), null);
	assert.equal(indexAfterKey('x', 1, 10, 4), null);
	assert.equal(indexAfterKey('ArrowDown', -1, 10, 1), 0);
	assert.equal(indexAfterKey('ArrowDown', 0, 0, 1), null);
});

test('the badge is the short upper-case extension, or empty without one', () => {
	assert.equal(extensionBadge('Contract.pdf'), 'PDF');
	assert.equal(extensionBadge('budget.final.xlsx'), 'XLSX');
	assert.equal(extensionBadge('archive.parquet'), 'PARQ');
	assert.equal(extensionBadge('README'), '');
	assert.equal(extensionBadge('.env'), '');
});

test('a selection box touches items it overlaps and not ones beside it', () => {
	const box = { left: 10, top: 10, width: 100, height: 50 };
	assert.equal(rectsIntersect(box, { left: 100, top: 50, width: 40, height: 40 }), true);
	assert.equal(rectsIntersect(box, { left: 110, top: 10, width: 40, height: 40 }), false);
	assert.equal(rectsIntersect(box, { left: 20, top: 70, width: 40, height: 40 }), false);
});

test('a selection box adds to the held selection in display order', () => {
	assert.deepEqual(mergeSelection(IDS, ['e'], ['c', 'b']), ['b', 'c', 'e']);
	assert.deepEqual(mergeSelection(IDS, [], ['d']), ['d']);
});
