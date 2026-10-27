// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// BADGES: distinct initials per label, and the look of each label's nodes
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distinctBadges, nodeLooks } from '../src/graph/badges';
import { EMPTY_STYLE } from '../src/graph/userData';

test('labels with different first letters keep one letter; colliding ones are extended until they differ', () => {
	const badges = distinctBadges(['Person', 'Product', 'Topic']);
	assert.equal(badges.get('Person'), 'Pe');
	assert.equal(badges.get('Product'), 'Pr');
	assert.equal(badges.get('Topic'), 'T');
});

test('no two labels share a badge, however many collide, and the result does not depend on input order or duplicates', () => {
	const labels = ['Person', 'Place', 'Product', 'Project', 'Pet', 'Order', 'Organisation', 'Person'];
	const a = distinctBadges(labels);
	const b = distinctBadges([...labels].reverse());
	assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
	assert.equal(new Set(a.values()).size, a.size, [...a.values()].join(','));
	assert.equal(a.size, 7);
});

test('labels that differ only by case still get different badges', () => {
	const badges = distinctBadges(['person', 'Person']);
	assert.notEqual(badges.get('person'), badges.get('Person'));
});

test('a long run of collisions is cut at three characters and numbered, still unique', () => {
	const labels = ['Customer', 'CustomerGroup', 'CustomerSegment', 'Cust'];
	const badges = distinctBadges(labels);
	assert.equal(new Set(badges.values()).size, 4);
	for (const badge of badges.values()) assert.ok(Array.from(badge).length <= 4, badge);
});

test('an empty label has no badge, and a label whose first letter is astral is not split in half', () => {
	assert.equal(distinctBadges(['', 'A']).has(''), false);
	const badges = distinctBadges(['\u{1d4d0}lpha']);
	assert.equal(Array.from(badges.get('\u{1d4d0}lpha') as string).length, 1);
});

test('looks: the default is initials at size M, and a style overrides size and badge mode per label', () => {
	const looks = nodeLooks(['Person', 'Product'], { ...EMPTY_STYLE, labels: { Person: { size: 'L', badge: 'dot' } } });
	assert.deepEqual(looks.get('Person'), { badge: 'Pe', size: 'L', badgeMode: 'dot' });
	assert.deepEqual(looks.get('Product'), { badge: 'Pr', size: 'M', badgeMode: 'initials' });
});
