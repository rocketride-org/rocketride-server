// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// GRAPH CANVAS MODEL AND BUDGETS
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INITIAL_NODES, MAX_NEW_NEIGHBORS, MAX_NODES, MAX_RELATIONSHIPS } from '../src/graph/budgets';
import { EMPTY_MODEL, collapseNode, connectNodes, dismissNodes, expandNode, isExpanded, modelFromResult, neighborIds, relationshipsOf, revealMore } from '../src/graph/model';
import { collectEntities } from '../src/graph/results';
import { deepFreeze, entitiesOf, generateGraph, node, rel } from './support/builders';

/** A star: center `c` with `count` leaves, relationships stored c -> leaf. */
function star(count: number, prefix = 'leaf') {
	const nodes = [node('c')];
	const rels = [];
	for (let i = 0; i < count; i++) {
		nodes.push(node(`${prefix}${i}`));
		rels.push(rel(`${prefix}-r${i}`, 'T', 'c', `${prefix}${i}`));
	}
	return entitiesOf(nodes, rels);
}

test('the budgets are the designed constants', () => {
	assert.deepEqual([INITIAL_NODES, MAX_NODES, MAX_RELATIONSHIPS, MAX_NEW_NEIGHBORS], [300, 1000, 2000, 100]);
});

test('a fresh result draws the first 300 nodes and only relationships with both ends drawn', () => {
	const { nodes, relationships } = generateGraph({ nodes: 1000, relationships: 1500, seed: 7 });
	const entities = entitiesOf(nodes, relationships);
	const model = modelFromResult(entities);
	assert.equal(model.nodes.size, 300);
	assert.deepEqual([...model.nodes.keys()], nodes.slice(0, 300).map((n) => n.id), 'result order, not random');
	assert.equal(model.resultNodes, 1000);
	assert.equal(model.hiddenNodes, 700);
	for (const r of model.relationships.values()) assert.ok(model.nodes.has(r.start) && model.nodes.has(r.end));
	assert.equal(model.hiddenRelationships, 1500 - model.relationships.size);
	assert.equal(model.roots.size, 300);
});

test('the canvas never holds more than 1,000 nodes or 2,000 relationships, whatever is asked', () => {
	const { nodes, relationships } = generateGraph({ nodes: 1500, relationships: 5000, seed: 11, parallel: 0.1, selfLoops: 0.02 });
	const model = modelFromResult(entitiesOf(nodes, relationships), 5000);
	assert.equal(model.nodes.size, MAX_NODES);
	assert.ok(model.relationships.size <= MAX_RELATIONSHIPS);
	assert.equal(model.relationships.size, MAX_RELATIONSHIPS, 'a dense graph fills the relationship budget exactly');
	assert.equal(model.hiddenNodes, 500);
});

test('a small result is drawn completely', () => {
	const model = modelFromResult(star(3));
	assert.equal(model.nodes.size, 4);
	assert.equal(model.relationships.size, 3);
	assert.equal(model.hiddenNodes, 0);
	assert.equal(model.hiddenRelationships, 0);
});

test('relationships with a missing endpoint are counted as hidden, not drawn', () => {
	const model = modelFromResult(entitiesOf([node('a')], [rel('r1', 'T', 'a', 'ghost')]));
	assert.equal(model.relationships.size, 0);
	assert.equal(model.hiddenRelationships, 1);
});

test('revealMore draws more of the same result and keeps expansions', () => {
	const entities = entitiesOf(generateGraph({ nodes: 600, relationships: 600, seed: 3 }).nodes, []);
	let model = modelFromResult(entities);
	model = { ...model, expansions: new Map([['x', new Set(['y'])]]) };
	const more = revealMore(model, entities, 500);
	assert.equal(more.nodes.size, 500);
	assert.equal(more.hiddenNodes, 100);
	assert.equal(more.expansions.get('x')?.has('y'), true);
	assert.equal(revealMore(more, entities, 5000).nodes.size, 600);
});

test('expanding adds at most 100 NEW neighbours and reports what the cap left out', () => {
	const base = modelFromResult(entitiesOf([node('c')], []));
	const outcome = expandNode(base, 'c', star(250));
	assert.equal(outcome.addedNodes.length, MAX_NEW_NEIGHBORS);
	assert.equal(outcome.skippedNeighbors, 150);
	assert.equal(outcome.model.nodes.size, 101);
	assert.equal(outcome.addedRelationships.length, 100, 'only relationships to drawn nodes');
	assert.deepEqual(outcome.addedNodes, Array.from({ length: 100 }, (_, i) => `leaf${i}`), 'answer order, deterministic');
	assert.equal(isExpanded(outcome.model, 'c'), true);
	assert.equal(outcome.budget, null);
});

test('neighbours that are already drawn do not count against the 100 and are not duplicated', () => {
	const shown = Array.from({ length: 30 }, (_, i) => node(`leaf${i}`));
	const base = modelFromResult(entitiesOf([node('c'), ...shown], shown.map((n, i) => rel(`leaf-r${i}`, 'T', 'c', n.id))));
	const outcome = expandNode(base, 'c', star(250));
	assert.equal(outcome.alreadyShown, 30);
	assert.equal(outcome.addedNodes.length, 100, 'a full 100 NEW neighbours on top of the 30 shown');
	assert.equal(outcome.model.nodes.size, 1 + 30 + 100);
	assert.equal(new Set(outcome.model.nodes.keys()).size, outcome.model.nodes.size);
	assert.equal(outcome.addedRelationships.length, 100, 'the 30 existing relationships are not added twice');
	assert.equal(outcome.skippedNeighbors, 120);
	// Expanding again with the same answer adds the next batch with no repeats.
	const again = expandNode(outcome.model, 'c', star(250));
	assert.equal(again.addedNodes.length, 100);
	assert.ok(again.addedNodes.every((id) => !outcome.addedNodes.includes(id)));
});

test('expansion respects the 1,000-node and 2,000-relationship budgets', () => {
	const full = modelFromResult(entitiesOf(generateGraph({ nodes: 995, relationships: 0, seed: 1 }).nodes.concat([node('c')]), []), 1000);
	assert.equal(full.nodes.size, 996);
	const outcome = expandNode(full, 'c', star(50, 'n'));
	assert.equal(outcome.model.nodes.size, MAX_NODES);
	assert.equal(outcome.addedNodes.length, 4);
	assert.equal(outcome.budget, 'nodes');
	assert.equal(outcome.skippedNeighbors, 46);

	const nodes = Array.from({ length: 5 }, (_, i) => node(`m${i}`));
	let rels = [];
	for (let i = 0; i < MAX_RELATIONSHIPS; i++) rels.push(rel(`full-${i}`, 'T', 'm0', 'm1'));
	const crowded = modelFromResult(entitiesOf(nodes, rels));
	assert.equal(crowded.relationships.size, MAX_RELATIONSHIPS);
	const blocked = expandNode(crowded, 'm0', entitiesOf([node('m0'), node('m2')], [rel('one-more', 'T', 'm0', 'm2')]));
	assert.equal(blocked.budget, 'relationships');
	assert.equal(blocked.model.relationships.size, MAX_RELATIONSHIPS);
	rels = [];
});

test('an expansion also draws relationships between new neighbours and nodes already shown', () => {
	const base = modelFromResult(entitiesOf([node('c'), node('old')], []));
	const answer = entitiesOf([node('c'), node('new'), node('old')], [rel('r1', 'T', 'c', 'new'), rel('r2', 'T', 'new', 'old')]);
	const outcome = expandNode(base, 'c', answer);
	assert.deepEqual(outcome.addedNodes, ['new']);
	assert.deepEqual(outcome.addedRelationships.sort(), ['r1', 'r2']);
});

test('a self relationship and parallel relationships on the center are kept', () => {
	const base = modelFromResult(entitiesOf([node('c')], []));
	const answer = entitiesOf([node('c'), node('x')], [rel('loop', 'T', 'c', 'c'), rel('p1', 'T', 'c', 'x'), rel('p2', 'T', 'c', 'x'), rel('rev', 'T', 'x', 'c')]);
	const outcome = expandNode(base, 'c', answer);
	assert.deepEqual(outcome.addedNodes, ['x']);
	assert.equal(outcome.addedRelationships.length, 4);
});

test('the answer replaces the drawn copy of a node (the fresher read wins)', () => {
	const base = modelFromResult(entitiesOf([node('c', ['A'], { v: 1 })], []));
	const outcome = expandNode(base, 'c', entitiesOf([node('c', ['A'], { v: 2 }), node('x')], [rel('r', 'T', 'c', 'x')]));
	assert.equal(outcome.model.nodes.get('c')?.properties.v, 2);
});

test('operations never mutate the previous model or the wire objects', () => {
	const entities = deepFreeze(star(10));
	const base = deepFreeze(modelFromResult(entitiesOf([node('c')], [])));
	const outcome = expandNode(base, 'c', entities);
	assert.equal(base.nodes.size, 1, 'the input model is untouched');
	assert.equal(outcome.model.nodes.size, 11);
	const gone = dismissNodes(outcome.model, ['leaf0']);
	assert.equal(outcome.model.nodes.size, 11);
	assert.equal(gone.nodes.size, 10);
	// The stored objects ARE the wire objects (no copy), and they were frozen the whole time.
	assert.equal(outcome.model.nodes.get('leaf1'), entities.nodes.get('leaf1'));
});

test('dismiss removes nodes and every relationship touching them', () => {
	const model = modelFromResult(entitiesOf([node('a'), node('b'), node('c')], [rel('ab', 'T', 'a', 'b'), rel('bc', 'T', 'b', 'c'), rel('ac', 'T', 'a', 'c')]));
	const next = dismissNodes(model, ['b']);
	assert.deepEqual([...next.nodes.keys()], ['a', 'c']);
	assert.deepEqual([...next.relationships.keys()], ['ac']);
	assert.equal(next.roots.has('b'), false);
	assert.equal(dismissNodes(model, []), model, 'dismissing nothing returns the same model');
});

test('collapse removes what hangs only from the collapsed node', () => {
	let model = modelFromResult(entitiesOf([node('c')], []));
	model = expandNode(model, 'c', star(3)).model;
	const { model: collapsed, removed } = collapseNode(model, 'c');
	assert.deepEqual(removed.sort(), ['leaf0', 'leaf1', 'leaf2']);
	assert.deepEqual([...collapsed.nodes.keys()], ['c']);
	assert.equal(collapsed.relationships.size, 0);
	assert.equal(isExpanded(collapsed, 'c'), false);
});

test('collapse keeps result nodes, nodes held by another expansion, and nodes still connected elsewhere', () => {
	// Result: c and r. Expanding c adds a (also linked to r), b (also added by expanding d), e (only from c).
	let model = modelFromResult(entitiesOf([node('c'), node('r'), node('d')], []));
	const answerC = entitiesOf([node('c'), node('a'), node('b'), node('e'), node('r')], [rel('ca', 'T', 'c', 'a'), rel('cb', 'T', 'c', 'b'), rel('ce', 'T', 'c', 'e'), rel('ar', 'T', 'a', 'r'), rel('cr', 'T', 'c', 'r')]);
	model = expandNode(model, 'c', answerC).model;
	model = expandNode(model, 'd', entitiesOf([node('d'), node('b')], [rel('db', 'T', 'd', 'b')])).model;
	assert.equal(model.nodes.has('b'), true);
	const { model: collapsed, removed } = collapseNode(model, 'c');
	assert.deepEqual(removed, ['e'], 'e hangs only from c; a stays via r, b stays via d');
	assert.ok(collapsed.nodes.has('a') && collapsed.nodes.has('b') && collapsed.nodes.has('r'));
	assert.equal(collapsed.relationships.has('ce'), false);
	assert.equal(collapsed.relationships.has('ar'), true);
});

test('collapse removes a chain that hangs only from the collapsed node, and is a no-op when never expanded', () => {
	let model = modelFromResult(entitiesOf([node('c')], []));
	model = expandNode(model, 'c', entitiesOf([node('c'), node('a')], [rel('ca', 'T', 'c', 'a')])).model;
	model = expandNode(model, 'a', entitiesOf([node('a'), node('b')], [rel('ab', 'T', 'a', 'b')])).model;
	const { removed } = collapseNode(model, 'c');
	assert.deepEqual(removed.sort(), ['a', 'b'], 'b was added by a, which only hangs from c');
	const untouched = modelFromResult(star(2));
	assert.equal(collapseNode(untouched, 'c').model, untouched);
	assert.equal(collapseNode(EMPTY_MODEL, 'nope').model, EMPTY_MODEL);
});

test('connect draws relationships among drawn nodes only, within the budget', () => {
	const model = modelFromResult(entitiesOf([node('a'), node('b')], []));
	const { model: next, addedRelationships } = connectNodes(model, entitiesOf([node('a'), node('b'), node('z')], [rel('ab', 'T', 'a', 'b'), rel('az', 'T', 'a', 'z')]));
	assert.deepEqual(addedRelationships, ['ab']);
	assert.equal(next.relationships.size, 1);
	assert.equal(next.nodes.size, 2, 'connect never adds nodes');
});

test('neighbour queries are deterministic and exclude the node itself', () => {
	const model = modelFromResult(entitiesOf([node('a'), node('b'), node('c')], [rel('1', 'T', 'a', 'b'), rel('2', 'T', 'c', 'a'), rel('3', 'T', 'a', 'a'), rel('4', 'T', 'a', 'b')]));
	assert.deepEqual(neighborIds(model, 'a'), ['b', 'c']);
	assert.equal(relationshipsOf(model, 'a').length, 4);
	assert.deepEqual(neighborIds(model, 'missing'), []);
});

test('a collect() result feeds the model the same way as plain rows', () => {
	const entities = collectEntities([[[node('1'), node('2')], rel('r', 'T', '1', '2')]]);
	assert.equal(modelFromResult(entities).relationships.size, 1);
});
