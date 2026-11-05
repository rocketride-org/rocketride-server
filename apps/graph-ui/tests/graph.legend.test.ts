// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// LEGEND: labels and relationship types with counts, label selection, distinct
// colours for a connection's labels, and the colours offered for types
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHART_COLOR_VARS, colorFor, TYPE_COLOR_SLOTS, labelColors, neutralColors, nextAssignments, typeColorsOf } from '../src/graph/colors';
import { labelStyleEdit, legendOf, nodeIdsOfLabel, resetLabelEdit, typeLegendOf, typeStyleEdit } from '../src/graph/legend';
import { modelFromResult } from '../src/graph/model';
import { EMPTY_STYLE } from '../src/graph/userData';
import { entitiesOf, node, rel } from './support/builders';

const model = modelFromResult(
	entitiesOf(
		[node('1', ['Person']), node('2', ['Person']), node('3', ['Company']), node('4', [])],
		[rel('r1', 'WORKS_AT', '1', '3'), rel('r2', 'WORKS_AT', '2', '3'), rel('r3', 'KNOWS', '1', '2')]
	)
);

test('the legend counts drawn nodes under their first label, most first', () => {
	const colors = labelColors(EMPTY_STYLE, ['Person', 'Company']);
	assert.deepEqual(legendOf(model, colors).map((e) => [e.name, e.count]), [['Person', 2], ['(no label)', 1], ['Company', 1]].sort((a, b) => (b[1] as number) - (a[1] as number) || (a[0] < b[0] ? -1 : 1)));
});

test('the type legend counts drawn relationships per type and carries the colour a style gave the type', () => {
	const colors = typeColorsOf({ ...EMPTY_STYLE, types: { KNOWS: { slot: 4 } } });
	assert.deepEqual(typeLegendOf(model, colors), [
		{ type: 'WORKS_AT', count: 2, fill: null },
		{ type: 'KNOWS', count: 1, fill: `var(${CHART_COLOR_VARS[4]})` },
	]);
});

test('clicking a label selects the drawn nodes whose first label it is', () => {
	assert.deepEqual(nodeIdsOfLabel(model, 'Person'), ['1', '2']);
	assert.deepEqual(nodeIdsOfLabel(model, ''), ['4']);
	assert.deepEqual(nodeIdsOfLabel(model, 'Nope'), []);
});

test('with six labels or fewer, every label has its own chart colour (Product and Order never share one)', () => {
	for (const labels of [['Person', 'Product', 'Order'], ['Person', 'Product', 'Order', 'Company', 'Topic', 'Document'], ['Order', 'Product']]) {
		// The realm that owns the schema gives each label its slot once (nextAssignments); every screen then reads it.
		const colors = labelColors({ ...EMPTY_STYLE, assigned: nextAssignments({}, labels) }, labels);
		const slots = [...colors.values()].map((c) => c.slot);
		assert.ok(slots.every((s) => s !== null), labels.join());
		assert.equal(new Set(slots).size, labels.length, labels.join());
	}
});

test('a label added later never changes the colour of one already assigned', () => {
	const first = labelColors({ ...EMPTY_STYLE, assigned: { Person: 1, Product: 2 } }, ['Person', 'Product']);
	const later = labelColors({ ...EMPTY_STYLE, assigned: { Person: 1, Product: 2 } }, ['Aardvark', 'Person', 'Product']);
	assert.equal(later.get('Person')?.fill, first.get('Person')?.fill);
	assert.equal(later.get('Product')?.fill, first.get('Product')?.fill);
	assert.notEqual(later.get('Aardvark')?.fill, later.get('Person')?.fill);
});

test('type colours: only the offered slots count, and an unstyled or invalid type keeps the ordinary line', () => {
	assert.deepEqual(TYPE_COLOR_SLOTS.slice().sort(), [0, 1, 2, 4]);
	const colors = typeColorsOf({ ...EMPTY_STYLE, types: { A: { slot: 0 }, B: { slot: 3 }, C: { slot: 5 }, D: {} } });
	assert.deepEqual([...colors.keys()], ['A']);
});

test('until the style is read, every label is the same neutral grey with no slot', () => {
	const colors = neutralColors(['Person', 'Company', '', 'Person']);
	assert.equal(colors.size, 2);
	for (const c of colors.values()) assert.deepEqual([c.fill, c.slot], ['var(--rr-grey-200)', null]);
	assert.notEqual(neutralColors(['A']).get('A')?.fill, colorFor(new Map(), '').fill, 'told apart from an unlabelled node');
});

test('a style edit sends only what changed, and clears a field that went back to its default', () => {
	assert.deepEqual(labelStyleEdit('Person', {}, { slot: 4 }), { kind: 'label', label: 'Person', patch: { slot: 4 } });
	assert.deepEqual(labelStyleEdit('Person', { slot: 4, size: 'L' }, { slot: 4, size: 'M' }), { kind: 'label', label: 'Person', clear: ['size'] });
	assert.deepEqual(labelStyleEdit('Person', { slot: 4 }, { slot: undefined }), { kind: 'label', label: 'Person', clear: ['slot'] });
	assert.deepEqual(labelStyleEdit('Person', { badge: 'dot' }, { badge: 'initials' }), { kind: 'label', label: 'Person', clear: ['badge'] });
	assert.deepEqual(labelStyleEdit('Person', { caption: 'name' }, { caption: 'title' }), { kind: 'label', label: 'Person', patch: { caption: 'title' } });
	assert.deepEqual(labelStyleEdit('Person', { slot: 1 }, { slot: 1 }), { kind: 'label', label: 'Person' });
});

test('reset clears every field of the label; a type edit patches or clears its slot', () => {
	assert.deepEqual(resetLabelEdit('Person'), { kind: 'label', label: 'Person', clear: ['slot', 'size', 'badge', 'caption'] });
	assert.deepEqual(typeStyleEdit('KNOWS', 4), { kind: 'type', type: 'KNOWS', patch: { slot: 4 } });
	assert.deepEqual(typeStyleEdit('KNOWS', undefined), { kind: 'type', type: 'KNOWS', clear: ['slot'] });
});
