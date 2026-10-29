// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pure-logic tests for the phase 3 display and navigation components.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { AVATAR_TONES, getAvatarTone, getInitials } from './avatar/Avatar';
import { formatBadgeCount } from './badge/Badge';
import { toPercent } from './progress/Progress';
import { paragraphWidths } from './skeleton/Skeleton';
import { toggleExpanded } from './accordion/Accordion';
import { compareValues, nextSort, sortRows } from './table/Table';
import { expandableSiblingIds, flattenVisible, ITreeNode } from './tree/Tree';
import { collapseBreadcrumbs } from './breadcrumbs/Breadcrumbs';
import { formatPageRange, getPageSlots, PageSlot } from './pagination/Pagination';
import { getStepState } from './stepper/Stepper';

test('getInitials handles names, single words, emails and junk', () => {
	assert.equal(getInitials('Avery Chen'), 'AC');
	assert.equal(getInitials('Ada Byron Lovelace'), 'AL');
	assert.equal(getInitials('rocketride'), 'RO');
	assert.equal(getInitials('jane.doe@example.com'), 'JD');
	assert.equal(getInitials('   '), '?');
});

test('getAvatarTone is stable, case-insensitive and in the palette', () => {
	assert.equal(getAvatarTone('Rod'), getAvatarTone('rod'));
	assert.ok(AVATAR_TONES.includes(getAvatarTone('Joe')));
	const tones = new Set(['Ann', 'Ben', 'Cal', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'].map(getAvatarTone));
	assert.ok(tones.size > 1, 'different names should spread across tones');
});

test('formatBadgeCount caps at max', () => {
	assert.equal(formatBadgeCount(7, 99), '7');
	assert.equal(formatBadgeCount(99, 99), '99');
	assert.equal(formatBadgeCount(100, 99), '99+');
	assert.equal(formatBadgeCount(12, 9), '9+');
});

test('toPercent clamps and handles an empty range', () => {
	assert.equal(toPercent(25, 0, 100), 25);
	assert.equal(toPercent(3, 0, 4), 75);
	assert.equal(toPercent(-5, 0, 10), 0);
	assert.equal(toPercent(50, 0, 10), 100);
	assert.equal(toPercent(1, 5, 5), 0);
});

test('paragraphWidths shortens only the last of several lines', () => {
	assert.deepEqual(paragraphWidths(1), ['100%']);
	assert.deepEqual(paragraphWidths(3), ['100%', '100%', '60%']);
});

test('toggleExpanded: single mode replaces, multiple mode adds, both close', () => {
	assert.deepEqual(toggleExpanded(['a'], 'b', false), ['b']);
	assert.deepEqual(toggleExpanded(['a'], 'b', true), ['a', 'b']);
	assert.deepEqual(toggleExpanded(['a', 'b'], 'a', true), ['b']);
	assert.deepEqual(toggleExpanded(['a'], 'a', false), []);
});

test('compareValues: numbers, natural strings, dates, booleans', () => {
	assert.ok(compareValues(2, 10) < 0);
	assert.ok(compareValues('run 2', 'run 10') < 0);
	assert.equal(compareValues('Alpha', 'alpha'), 0);
	assert.ok(compareValues(new Date('2026-01-01'), new Date('2026-06-01')) < 0);
	assert.ok(compareValues(false, true) < 0);
});

test('sortRows is stable and keeps empty values last in both directions', () => {
	const rows = [
		{ id: 'a', cost: 3 },
		{ id: 'b', cost: null },
		{ id: 'c', cost: 1 },
		{ id: 'd', cost: 3 },
		{ id: 'e', cost: undefined },
	];
	const value = (row: { cost: number | null | undefined }) => row.cost;
	assert.deepEqual(
		sortRows(rows, value, 'asc').map((row) => row.id),
		['c', 'a', 'd', 'b', 'e']
	);
	assert.deepEqual(
		sortRows(rows, value, 'desc').map((row) => row.id),
		['a', 'd', 'c', 'b', 'e']
	);
	assert.deepEqual(
		rows.map((row) => row.id),
		['a', 'b', 'c', 'd', 'e'],
		'input is not mutated'
	);
});

test('nextSort starts ascending on a new column and flips the active one', () => {
	assert.deepEqual(nextSort(null, 'name'), { columnId: 'name', direction: 'asc' });
	assert.deepEqual(nextSort({ columnId: 'name', direction: 'asc' }, 'name'), { columnId: 'name', direction: 'desc' });
	assert.deepEqual(nextSort({ columnId: 'name', direction: 'desc' }, 'name'), { columnId: 'name', direction: 'asc' });
	assert.deepEqual(nextSort({ columnId: 'name', direction: 'desc' }, 'cost'), { columnId: 'cost', direction: 'asc' });
});

const tree: ITreeNode[] = [
	{
		id: 'src',
		label: 'Sources',
		children: [
			{ id: 's3', label: 'S3' },
			{ id: 'gdrive', label: 'Google Drive', children: [{ id: 'docs', label: 'Docs' }] },
		],
	},
	{ id: 'llm', label: 'LLMs', children: [] },
	{ id: 'out', label: 'Output' },
];

test('flattenVisible shows roots and the children of expanded nodes only', () => {
	const collapsed = flattenVisible(tree, new Set());
	assert.deepEqual(
		collapsed.map((entry) => entry.node.id),
		['src', 'llm', 'out']
	);

	const flat = flattenVisible(tree, new Set(['src', 'gdrive']));
	assert.deepEqual(
		flat.map((entry) => entry.node.id),
		['src', 's3', 'gdrive', 'docs', 'llm', 'out']
	);
	assert.deepEqual(
		flat.map((entry) => entry.level),
		[1, 2, 2, 3, 1, 1]
	);
	assert.deepEqual(
		flat.map((entry) => entry.parentId),
		[null, 'src', 'src', 'gdrive', null, null]
	);
	assert.deepEqual(
		flat.map((entry) => [entry.posInSet, entry.setSize]),
		[
			[1, 3],
			[1, 2],
			[2, 2],
			[1, 1],
			[2, 3],
			[3, 3],
		]
	);
	assert.equal(flat[4].hasChildren, true, 'an empty children array is still expandable');
	assert.equal(flat[5].hasChildren, false);
});

test('expandableSiblingIds lists expandable nodes sharing the parent', () => {
	const flat = flattenVisible(tree, new Set());
	assert.deepEqual(expandableSiblingIds(flat, 2), ['src', 'llm']);
});

test('collapseBreadcrumbs keeps first + tail and hides the middle', () => {
	const crumbs = ['org', 'team', 'project', 'pipeline', 'run'].map((id) => ({ id, label: id }));
	assert.equal(collapseBreadcrumbs(crumbs, 5).length, 5);
	const slots = collapseBreadcrumbs(crumbs, 4);
	const ids = slots.map((slot) => {
		if (slot.kind === 'collapsed') return `…${slot.hidden.map((item) => item.id).join('+')}`;
		return slot.item.id;
	});
	assert.deepEqual(ids, ['org', '…team+project', 'pipeline', 'run']);
});

/** Renders slots as a compact string, e.g. "1 2 3 4 5 … 10". */
function showSlots(slots: PageSlot[]): string {
	return slots
		.map((slot) => {
			if (slot.kind === 'gap') return '…';
			return String(slot.page);
		})
		.join(' ');
}

test('getPageSlots: short ranges show every page', () => {
	assert.equal(showSlots(getPageSlots(1, 1)), '1');
	assert.equal(showSlots(getPageSlots(3, 7)), '1 2 3 4 5 6 7');
	assert.deepEqual(getPageSlots(1, 0), []);
});

test('getPageSlots: long ranges keep a constant width with gaps', () => {
	assert.equal(showSlots(getPageSlots(1, 10)), '1 2 3 4 5 … 10');
	assert.equal(showSlots(getPageSlots(4, 10)), '1 2 3 4 5 … 10');
	assert.equal(showSlots(getPageSlots(5, 10)), '1 … 4 5 6 … 10');
	assert.equal(showSlots(getPageSlots(7, 10)), '1 … 6 7 8 9 10');
	assert.equal(showSlots(getPageSlots(10, 10)), '1 … 6 7 8 9 10');
	assert.equal(showSlots(getPageSlots(50, 100, 2)), '1 … 48 49 50 51 52 … 100');
	for (let page = 1; page <= 30; page++) {
		assert.equal(getPageSlots(page, 30).length, 7, `page ${page} keeps 7 slots`);
	}
});

test('getPageSlots clamps an out-of-range current page', () => {
	assert.equal(showSlots(getPageSlots(99, 10)), '1 … 6 7 8 9 10');
});

test('formatPageRange covers first, middle, last and empty pages', () => {
	assert.equal(formatPageRange(1, 20, 134), '1–20 of 134');
	assert.equal(formatPageRange(2, 20, 134), '21–40 of 134');
	assert.equal(formatPageRange(7, 20, 134), '121–134 of 134');
	assert.equal(formatPageRange(1, 20, 0), '0 of 0');
});

test('getStepState orders complete, current, upcoming; error wins', () => {
	assert.equal(getStepState(0, 2), 'complete');
	assert.equal(getStepState(2, 2), 'current');
	assert.equal(getStepState(3, 2), 'upcoming');
	assert.equal(getStepState(0, 2, true), 'error');
});
