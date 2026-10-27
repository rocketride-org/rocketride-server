// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// TOOLBAR FIT: which actions stay on the row and which go to "More", in a fixed order
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitToolbar } from '../src/graph/toolbarFit';
import type { IToolbarSlot } from '../src/graph/toolbarFit';

const slots = (...rows: Array<[string, number, number]>): IToolbarSlot[] => rows.map(([id, width, keep]) => ({ id, width, keep }));
const ids = (list: readonly IToolbarSlot[]): string => list.map((s) => s.id).join(',');

test('everything stays when it fits, and nothing goes to More', () => {
	const out = fitToolbar(slots(['a', 100, 1], ['b', 100, 2]), { available: 400, fixed: 100, gap: 6, moreWidth: 60 });
	assert.deepEqual(out.hidden, []);
	assert.equal(out.showMore, false);
});

test('the lowest keep-priority goes first, one at a time, until the rest fit with the More button', () => {
	const list = slots(['label', 150, 0], ['expand', 80, 9], ['collapse', 80, 5], ['dismiss', 80, 4]);
	// 410 of actions + 24 of gaps + 200 fixed = 634 against 450: the label (keep 0) and then dismiss (keep 4) leave, with More shown.
	const out = fitToolbar(list, { available: 450, fixed: 200, gap: 6, moreWidth: 60 });
	assert.deepEqual(out.hidden, ['label', 'dismiss']);
	assert.equal(out.showMore, true);
});

test('the order is by priority, not by position, and equal priorities hide the later one first', () => {
	const list = slots(['a', 100, 3], ['b', 100, 3], ['c', 100, 3]);
	const out = fitToolbar(list, { available: 280, fixed: 0, gap: 0, moreWidth: 40 });
	assert.deepEqual(out.hidden, ['c']);
});

test('when even the fixed part does not fit, every slot is hidden and More is shown (the row still does not wrap)', () => {
	const out = fitToolbar(slots(['a', 100, 1], ['b', 100, 2]), { available: 50, fixed: 300, gap: 6, moreWidth: 60 });
	assert.equal(out.hidden.length, 2);
	assert.equal(out.showMore, true);
});

test('the result does not depend on how often it is asked, and does not change its input', () => {
	const list = slots(['a', 100, 1], ['b', 100, 2], ['c', 100, 3]);
	const copy = JSON.stringify(list);
	const first = fitToolbar(list, { available: 260, fixed: 0, gap: 6, moreWidth: 50 });
	assert.deepEqual(fitToolbar(list, { available: 260, fixed: 0, gap: 6, moreWidth: 50 }), first);
	assert.equal(JSON.stringify(list), copy);
	assert.equal(ids(list), 'a,b,c');
});
