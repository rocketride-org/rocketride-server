// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// THE GRAPH SESSION: expand, collapse, dismiss, connect, find path, refresh
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphSession } from '../src/graph/graphSession';
import type { IGraphSessionDeps } from '../src/graph/graphSession';
import type { IFailureNotice } from '../src/graph/failures';
import type { GraphValue, ReadQueryResult } from '../src/graph/types';
import type { IEngine, IRecipe } from '../src/cypher/recipes';
import { node, readQueryFixture, rel } from './support/builders';

const NEO: IEngine = { dialect: 'neo4j', version: '5.26.31' };
const AGE: IEngine = { dialect: 'age', version: '1.5.0' };

const envelope = (rows: GraphValue[][], extra: Partial<ReadQueryResult> = {}): ReadQueryResult => ({ columns: rows[0]?.map((_, i) => `c${i}`) ?? ['c'], rows, row_limit: 1000, truncated: false, truncated_by: null, element_limit: 10000, elements: 0, value_limit: 500000, values: 0, ...extra });
const notice = (headline: string, over: Partial<IFailureNotice> = {}): IFailureNotice => ({ variant: 'error', headline, detail: '', verbatim: '', generic: false, hint: null, ignore: false, ...over });

/** A session over a scripted node. */
function rig(engine: IEngine | null = NEO, answer: (recipe: IRecipe, call: number) => Promise<ReadQueryResult> | ReadQueryResult = () => envelope([[]])) {
	const log = { recipes: [] as IRecipe[], said: [] as string[] };
	const deps: IGraphSessionDeps = {
		engine: () => engine,
		invoke: async (recipe) => {
			log.recipes.push(recipe);
			return answer(recipe, log.recipes.length - 1);
		},
		describe: (error) => notice(error instanceof Error ? error.message : String(error)),
		announce: (text) => log.said.push(text),
		captionChoice: () => undefined,
	};
	const session = createGraphSession(deps);
	return { session, log };
}
const base = (): ReadQueryResult => envelope([[node('a', ['P'], { name: 'A' }), node('b', ['P'], { name: 'B' }), rel('r1', 'T', 'a', 'b')]]);
const tick = () => new Promise((r) => setImmediate(r));

test('loading a result draws its nodes, focuses the first and clears everything else', () => {
	const { session } = rig();
	session.load(base());
	const s = session.getState();
	assert.deepEqual([...s.model.nodes.keys()], ['a', 'b']);
	assert.equal(s.focusedId, 'a');
	assert.equal(s.selected.size, 0);
	assert.equal(s.busy, null);
	session.load(envelope([[1, 2]]));
	assert.equal(session.getState().model.nodes.size, 0, 'a scalar-only result draws nothing');
	session.load(null);
	assert.equal(session.getState().entities, null);
});

test('selection toggles and is announced with a count', () => {
	const { session, log } = rig();
	session.load(base());
	session.toggleSelect('a');
	session.toggleSelect('b');
	assert.deepEqual([...session.getState().selected], ['a', 'b']);
	assert.deepEqual(log.said.slice(-2), ['A selected. 1 node selected.', 'B selected. 2 nodes selected.']);
	session.toggleSelect('a');
	assert.equal(log.said[log.said.length - 1], 'A deselected. 1 node selected.');
	session.clearSelection();
	assert.equal(session.getState().selected.size, 0);
});

test('expand sends one parameterised read_query, draws only NEW neighbours and says what happened', async () => {
	const { session, log } = rig(NEO, () => envelope([[node('a', ['P']), rel('r2', 'T', 'a', 'c'), node('c', ['P'], { name: 'C' })], [node('a', ['P']), rel('r1', 'T', 'a', 'b'), node('b', ['P'])]]));
	session.load(base());
	await session.expand('a');
	assert.equal(log.recipes.length, 1);
	assert.deepEqual(log.recipes[0].params, { id: 'a', drawn: ['r1'] }, 'the relationship already drawn is left out by parameter');
	assert.ok(!log.recipes[0].cypher.includes("'a'"));
	const s = session.getState();
	assert.deepEqual([...s.model.nodes.keys()], ['a', 'b', 'c']);
	assert.deepEqual(s.hint, { centerId: 'a', newIds: ['c'] });
	assert.equal(s.busy, null);
	assert.equal(s.notice?.text, 'Added 1 neighbour.');
	assert.equal(log.said[log.said.length - 1], 'Added 1 neighbour.');
	// The relationship that was already drawn is not duplicated.
	assert.equal(s.model.relationships.size, 2);
});

test('an expansion that fills its row allowance says more may exist', async () => {
	const rows = Array.from({ length: 5 }, (_, i) => [node('a'), rel(`x${i}`, 'T', 'a', `n${i}`), node(`n${i}`)] as GraphValue[]);
	const { session } = rig(NEO, (recipe) => envelope(rows, { row_limit: recipe.limit }));
	session.load(envelope([[node('a')]]));
	// ask for exactly the rows the answer holds: wanted 100 + shown 0 + 1 = 101, so 5 rows is NOT incomplete...
	await session.expand('a');
	assert.equal(session.getState().notice?.text, 'Added 5 neighbours.');
	// ...but a truncated answer is.
	const { session: s2 } = rig(NEO, () => envelope(rows, { truncated: true, truncated_by: 'rows' }));
	s2.load(envelope([[node('a')]]));
	await s2.expand('a');
	assert.match(s2.getState().notice?.text ?? '', /This node has more relationships than were fetched; expand again for more\./);
});

/**
 * A hub `a` with `size` neighbours behind a node that applies its own row cap (`row_limit = min(limit, cap)`, as
 * graph_instance_base.py does) and honours the ids an expansion leaves out (`$drawn` on Neo4j and FalkorDB, `$d0..`
 * on AGE). Rows come back in one stable order, as a database without ORDER BY usually returns them.
 *
 * @param size - Neighbours of the hub.
 * @param cap - The node's row cap.
 * @returns The scripted answer.
 */
function cappedHub(size: number, cap: number) {
	const all = Array.from({ length: size }, (_, i) => [node('a'), rel(`x${i}`, 'T', 'a', `n${i}`), node(`n${i}`)] as GraphValue[]);
	return (recipe: IRecipe): ReadQueryResult => {
		const left = new Set<string>();
		for (const [key, value] of Object.entries(recipe.params)) {
			if (key === 'drawn' && Array.isArray(value)) value.forEach((id) => left.add(id));
			else if (/^d\d+$/.test(key) && typeof value === 'string') left.add(value);
		}
		const rowLimit = Math.min(recipe.limit, cap);
		const matched = all.filter((row) => !left.has((row[1] as { id: string }).id));
		const cut = matched.length > rowLimit;
		// OPTIONAL MATCH: the node itself answers even when nothing new hangs from it.
		const rows = matched.length === 0 ? [[node('a'), null, null]] : matched.slice(0, rowLimit);
		return envelope(rows, { row_limit: rowLimit, truncated: cut, truncated_by: cut ? 'rows' : null });
	};
}

// A request for `shown + wanted + 1` rows with nothing left out stops working once that passes the node's row cap (250
// on a default FalkorDB node): every repeat would get the same first 250 rows, all drawn, and be told "expand again".
test('repeating Expand on a hub behind a row cap keeps adding the next neighbours until there are none', async () => {
	const { session, log } = rig(NEO, cappedHub(450, 250));
	session.load(envelope([[node('a')]]));
	const texts: string[] = [];
	for (let i = 0; i < 5; i++) {
		await session.expand('a');
		texts.push(session.getState().notice?.text ?? '');
	}
	assert.equal(session.getState().model.nodes.size, 451, 'every neighbour is drawn');
	for (const text of texts.slice(0, 4)) assert.match(text, /^Added 100 neighbours\. .*expand again/);
	assert.equal(texts[4], 'Added 50 neighbours.');
	assert.ok(log.recipes.every((r) => r.limit === 101), 'drawn relationships are left out, so wanted + 1 rows are enough');
	await session.expand('a');
	assert.equal(session.getState().notice?.text, 'No new neighbours.');
});

test('on AGE, past the relationships it can leave out, an expansion the row cap stops says a repeat cannot help', async () => {
	const { session } = rig(AGE, cappedHub(600, 250));
	session.load(envelope([[node('a')]]));
	const drawn: number[] = [];
	const texts: string[] = [];
	for (let i = 0; i < 6; i++) {
		await session.expand('a');
		drawn.push(session.getState().model.nodes.size - 1);
		texts.push(session.getState().notice?.text ?? '');
	}
	assert.deepEqual(drawn, [100, 200, 300, 400, 450, 450], 'each repeat that can make progress does');
	assert.match(texts[4], /^Added 50 neighbours\. This node has more relationships than were fetched; expand again for more\.$/);
	assert.match(texts[5], /the node stops at 250 rows/);
	assert.match(texts[5], /expanding again returns the same rows/);
	assert.doesNotMatch(texts[5], /expand again for more/);
	assert.equal(session.getState().notice?.variant, 'warning');
});

test('only one request at a time: a second action is declined with a sentence and sends nothing', async () => {
	let release: (r: ReadQueryResult) => void = () => undefined;
	const { session, log } = rig(NEO, () => new Promise<ReadQueryResult>((resolve) => { release = resolve; }));
	session.load(base());
	const first = session.expand('a');
	await tick();
	assert.equal(session.getState().busy, 'expand');
	await session.expand('b');
	await session.connect();
	assert.equal(log.recipes.length, 1);
	assert.match(session.getState().notice?.text ?? '', /Another request is still running/);
	release(envelope([[node('a'), rel('r2', 'T', 'a', 'c'), node('c')]]));
	await first;
	assert.equal(session.getState().busy, null);
});

test('a result loaded while an expansion is in flight wins: the late answer is dropped', async () => {
	let release: (r: ReadQueryResult) => void = () => undefined;
	const { session } = rig(NEO, () => new Promise<ReadQueryResult>((resolve) => { release = resolve; }));
	session.load(base());
	const pending = session.expand('a');
	await tick();
	session.load(envelope([[node('z', ['Q'])]]));
	release(envelope([[node('a'), rel('r2', 'T', 'a', 'c'), node('c')]]));
	await pending;
	const s = session.getState();
	assert.deepEqual([...s.model.nodes.keys()], ['z'], 'the new result is untouched by the old answer');
	assert.equal(s.busy, null);
	assert.equal(s.notice, null);
});

test('dispose drops everything in flight', async () => {
	let release: (r: ReadQueryResult) => void = () => undefined;
	const { session, log } = rig(NEO, () => new Promise<ReadQueryResult>((resolve) => { release = resolve; }));
	session.load(base());
	const pending = session.expand('a');
	await tick();
	session.dispose();
	release(envelope([[node('a'), rel('r2', 'T', 'a', 'c'), node('c')]]));
	await pending;
	assert.deepEqual([...session.getState().model.nodes.keys()], ['a', 'b']);
	assert.ok(!log.said.some((s) => /Added/.test(s)));
});

test('a failed expansion keeps the canvas as it was and shows the node\'s text', async () => {
	const { session } = rig(NEO, () => { throw new Error('Query timed out after 30000 ms'); });
	session.load(base());
	await session.expand('a');
	const s = session.getState();
	assert.equal(s.model.nodes.size, 2);
	assert.equal(s.busy, null);
	assert.equal(s.notice?.variant, 'error');
	assert.equal(s.notice?.text, 'Query timed out after 30000 ms');
});

test('an element that is no longer found is said to be, not replaced by another', async () => {
	const { session } = rig(NEO, () => envelope([]));
	session.load(base());
	await session.expand('a');
	assert.match(session.getState().notice?.text ?? '', /no longer found: element ids are live handles\. Nothing was added\./);
	assert.equal(session.getState().model.nodes.size, 2);
});

test('a node that answers with itself alone has no relationships, or none that are not drawn', async () => {
	const { session } = rig(NEO, () => envelope([[node('a', ['P'], { name: 'A' }), null, null]]));
	session.load(envelope([[node('a', ['P'], { name: 'A' })]]));
	await session.expand('a');
	assert.equal(session.getState().notice?.text, 'A has no relationships in the database. Nothing was added.');
	const { session: drawn } = rig(NEO, () => envelope([[node('a', ['P'], { name: 'A' }), null, null]]));
	drawn.load(base());
	await drawn.expand('a');
	assert.equal(drawn.getState().notice?.text, 'No new neighbours.');
});

test('expanding without a probed engine sends nothing and says why', async () => {
	const { session, log } = rig(null);
	session.load(base());
	await session.expand('a');
	assert.equal(log.recipes.length, 0);
	assert.match(session.getState().notice?.text ?? '', /has not been checked yet/);
});

test('collapse removes what only hung from the node; dismiss removes a node and its relationships; both are local', async () => {
	const { session, log } = rig(NEO, () => envelope([[node('a', ['P']), rel('r2', 'T', 'a', 'c'), node('c', ['P'])]]));
	session.load(base());
	session.collapse('a');
	assert.match(session.getState().notice?.text ?? '', /Nothing to collapse/);
	await session.expand('a');
	const calls = log.recipes.length;
	session.collapse('a');
	assert.deepEqual([...session.getState().model.nodes.keys()], ['a', 'b']);
	assert.match(session.getState().notice?.text ?? '', /^Collapsed\. 1 node removed from the graph\./);
	session.toggleSelect('b');
	session.dismiss('b');
	const s = session.getState();
	assert.deepEqual([...s.model.nodes.keys()], ['a']);
	assert.equal(s.model.relationships.size, 0);
	assert.equal(s.selected.has('b'), false);
	assert.match(s.notice?.text ?? '', /dismissed from the graph\. It is still in the results table\./);
	assert.equal(log.recipes.length, calls, 'no node call');
});

test('dismissing the focused node moves focus to a remaining one', () => {
	const { session } = rig();
	session.load(base());
	session.focus('a');
	session.dismiss('a');
	assert.equal(session.getState().focusedId, 'b');
});

test('connect asks for the relationships among the drawn nodes and adds only those; AGE is bounded', async () => {
	const { session, log } = rig(NEO, () => envelope([[node('a'), rel('r9', 'T', 'b', 'a'), node('b')]]));
	session.load(envelope([[node('a'), node('b')]]));
	await session.connect();
	assert.deepEqual(log.recipes[0].params, { ids: ['a', 'b'] });
	assert.equal(session.getState().model.relationships.size, 1);
	assert.equal(session.getState().notice?.text, 'Added 1 relationship among the nodes on the canvas.');
	await session.connect();
	assert.equal(session.getState().notice?.text, 'No further relationships among the nodes on the canvas.');
	const many = envelope([Array.from({ length: 41 }, (_, i) => node(`n${i}`))]);
	const { session: age, log: ageLog } = rig(AGE);
	age.load(many);
	await age.connect();
	assert.equal(ageLog.recipes.length, 0, 'refused before sending');
	assert.match(age.getState().notice?.text ?? '', /not supported on Apache AGE yet/);
});

test('find path needs exactly two selected nodes, merges the first path found, highlights it and keeps stored direction', async () => {
	const path = { '@kind': 'path', nodes: [node('a', ['P']), node('m', ['P']), node('b', ['P'])], relationships: [rel('p1', 'T', 'a', 'm'), rel('p2', 'T', 'b', 'm')] };
	const { session, log } = rig(NEO, (recipe) => envelope(/\[\*2\.\.2\]/.test(recipe.cypher) ? [[path as unknown as GraphValue]] : []));
	session.load(base());
	await session.findPath();
	assert.match(session.getState().notice?.text ?? '', /Select exactly two nodes/);
	assert.equal(log.recipes.length, 0);
	session.toggleSelect('a');
	session.toggleSelect('b');
	await session.findPath();
	const s = session.getState();
	assert.deepEqual(log.recipes.map((r) => /\[\*(\d)\.\.\d\]/.exec(r.cypher)?.[1]), ['1', '2'], 'deepening stopped at the first depth that answered');
	assert.deepEqual([...s.highlight].sort(), ['p1', 'p2']);
	assert.ok(s.model.nodes.has('m'), 'the path\'s middle node joined the canvas');
	assert.equal(s.model.relationships.get('p2')?.start, 'b', 'stored direction kept');
	assert.match(s.notice?.text ?? '', /^Found a path of 2 relationships \(the first, so a shortest one\)\./);
	assert.equal(s.busy, null);
	assert.equal(s.progress, null);
});

test('no path within the depth limit is said in budget terms; Stop waiting is honest', async () => {
	const { session } = rig(NEO, () => envelope([]));
	session.load(base());
	session.toggleSelect('a');
	session.toggleSelect('b');
	await session.findPath();
	assert.match(session.getState().notice?.text ?? '', /^No path within depth 10\./);
	// Stop waiting mid-search.
	let release: (r: ReadQueryResult) => void = () => undefined;
	const { session: s2, log } = rig(NEO, () => new Promise<ReadQueryResult>((resolve) => { release = resolve; }));
	s2.load(base());
	s2.toggleSelect('a');
	s2.toggleSelect('b');
	const running = s2.findPath();
	await tick();
	assert.equal(s2.getState().busy, 'path');
	assert.match(s2.getState().progress ?? '', /Looking for a path of 1 relationship/);
	s2.stopWaiting();
	await running;
	assert.equal(s2.getState().busy, null);
	assert.match(s2.getState().notice?.text ?? '', /^Stopped waiting\. Stop waiting stops this app/);
	release(envelope([]));
	await tick();
	assert.equal(log.recipes.length, 1, 'no further depth after stopping');
});

test('refreshing an inspected node updates the drawn copy, or says the element was not found', async () => {
	const { session } = rig(NEO, () => envelope([[node('a', ['P'], { name: 'Renamed' })]]));
	session.load(base());
	session.inspect({ kind: 'node', id: 'a' });
	await session.refreshInspected();
	assert.equal(session.getState().model.nodes.get('a')?.properties.name, 'Renamed');
	assert.equal(session.getState().notice?.text, 'Refreshed from the database.');
	const { session: gone } = rig(NEO, () => envelope([]));
	gone.load(base());
	gone.inspect({ kind: 'node', id: 'a' });
	await gone.refreshInspected();
	assert.match(gone.getState().notice?.text ?? '', /was not found any more\. Element ids are live handles/);
	assert.equal(gone.getState().model.nodes.get('a')?.properties.name, 'A', 'the drawn copy is left alone');
});

test('show more draws more of the same result, up to the canvas maximum', () => {
	const big = envelope([Array.from({ length: 600 }, (_, i) => node(`n${i}`))]);
	const { session } = rig();
	session.load(big);
	assert.equal(session.getState().model.nodes.size, 300);
	session.showMore();
	assert.equal(session.getState().model.nodes.size, 600);
	assert.match(session.getState().notice?.text ?? '', /^Showing 300 more nodes \(600 of 600\)\./);
	session.showMore();
	assert.match(session.getState().notice?.text ?? '', /already shows as many nodes as it can hold/);
});

test('the real fixtures load into a drawable session on every engine', () => {
	for (const engine of ['neo4j', 'falkordb', 'age'] as const) {
		const { session } = rig();
		session.load(readQueryFixture(engine, 'v1'));
		const s = session.getState();
		assert.equal(s.model.nodes.size, 3, engine);
		assert.equal(s.model.relationships.size, 5, engine);
	}
});

test('subscribers hear changes and can unsubscribe', () => {
	const { session } = rig();
	let heard = 0;
	const off = session.subscribe(() => { heard += 1; });
	session.load(base());
	session.focus('b');
	assert.equal(heard, 2);
	off();
	session.focus('a');
	assert.equal(heard, 2);
});

// -----------------------------------------------------------------------------
// Reused ids: an id is a live handle, not an identity
// -----------------------------------------------------------------------------

test('refresh: the same id returned with different labels is a different element: not merged, marked out of date, and the next action on it is declined', async () => {
	let answer: ReadQueryResult = envelope([[node('a', ['Other'], { name: 'unrelated' })]]);
	const { session, log } = rig(NEO, () => answer);
	session.load(base());
	session.inspect({ kind: 'node', id: 'a' });
	await session.refreshInspected();
	const s = session.getState();
	assert.deepEqual(s.model.nodes.get('a')?.labels, ['P'], 'the drawn copy is untouched');
	assert.deepEqual(s.model.nodes.get('a')?.properties, { name: 'A' });
	assert.ok(s.staleIds.has('a'));
	assert.equal(s.notice?.variant, 'warning');
	assert.match(s.notice?.text ?? '', /different element under an id drawn here.*was label P, and is now label Other.*Dismiss it/);
	assert.doesNotMatch(s.notice?.text ?? '', /Refreshed/);
	// The marked element is not asked about again: Expand and Refresh decline without sending.
	const sent = log.recipes.length;
	answer = envelope([[node('a', ['P'])]]);
	await session.expand('a');
	await session.refreshInspected();
	assert.equal(log.recipes.length, sent, 'nothing was sent for an out-of-date element');
	assert.match(session.getState().notice?.text ?? '', /out of date: the database now holds a different element under its id/);
	// Dismissing it clears the mark.
	session.dismiss('a');
	assert.equal(session.getState().staleIds.has('a'), false);
});

test('refresh: the same id, same labels and different properties IS the same element, and the fresh properties are shown', async () => {
	const { session } = rig(NEO, () => envelope([[node('a', ['P'], { name: 'Renamed' })]]));
	session.load(base());
	session.inspect({ kind: 'node', id: 'a' });
	await session.refreshInspected();
	assert.deepEqual(session.getState().model.nodes.get('a')?.properties, { name: 'Renamed' });
	assert.equal(session.getState().staleIds.size, 0);
	assert.equal(session.getState().notice?.text, 'Refreshed from the database.');
});

test('refresh: label order does not make an element different', async () => {
	const { session } = rig(NEO, () => envelope([[node('a', ['Q', 'P'], { name: 'A2' })]]));
	session.load(envelope([[node('a', ['P', 'Q'], { name: 'A' })]]));
	session.inspect({ kind: 'node', id: 'a' });
	await session.refreshInspected();
	assert.equal(session.getState().staleIds.size, 0);
	assert.deepEqual(session.getState().model.nodes.get('a')?.properties, { name: 'A2' });
});

test('expand: the centre comes back with the same id and other labels: nothing is added, old relationships stay with the old copy, the centre is marked', async () => {
	const { session, log } = rig(NEO, () => envelope([[node('a', ['Other'], { name: 'unrelated' }), rel('r9', 'T', 'a', 'c'), node('c', ['P'])]]));
	session.load(base());
	await session.expand('a');
	const s = session.getState();
	assert.deepEqual([...s.model.nodes.keys()], ['a', 'b'], 'no neighbour was added');
	assert.deepEqual([...s.model.relationships.keys()], ['r1'], 'the answer\'s relationships were not attached');
	assert.deepEqual(s.model.nodes.get('a')?.labels, ['P']);
	assert.ok(s.staleIds.has('a'));
	assert.equal(s.hint, null);
	assert.match(s.notice?.text ?? '', /nothing from this answer was added/);
	assert.equal(log.said[log.said.length - 1], s.notice?.text, 'announced as the warning, not as success');
	assert.doesNotMatch(log.said.join('\n'), /Added/);
});

test('expand: a NEIGHBOUR that shares an id with a different drawn node rejects the whole answer', async () => {
	const { session } = rig(NEO, () => envelope([[node('a', ['P']), rel('r9', 'T', 'a', 'b'), node('b', ['Elsewhere'])]]));
	session.load(base());
	await session.expand('a');
	const s = session.getState();
	assert.deepEqual(s.model.nodes.get('b')?.labels, ['P']);
	assert.ok(s.staleIds.has('b'));
	assert.equal(s.model.relationships.has('r9'), false);
});

test('a relationship that returns with the same id and another type, start or end is a different relationship', async () => {
	for (const changed of [rel('r1', 'OTHER', 'a', 'b'), rel('r1', 'T', 'b', 'a'), rel('r1', 'T', 'a', 'c')]) {
		const { session } = rig(NEO, () => envelope([[node('a', ['P']), changed, node('c', ['P'])]]));
		session.load(base());
		await session.expand('a');
		const s = session.getState();
		assert.equal(s.model.relationships.get('r1')?.type, 'T', 'the drawn relationship is untouched');
		assert.deepEqual([s.model.relationships.get('r1')?.start, s.model.relationships.get('r1')?.end], ['a', 'b']);
		assert.equal(s.model.nodes.has('c'), false, 'nothing new was added');
		assert.ok(s.staleRelationshipIds.has('r1'), `relationship marked (${changed.type} ${changed.start}>${changed.end})`);
		assert.equal(s.staleIds.has('r1'), false, 'among the relationships, not the nodes');
		assert.match(s.notice?.text ?? '', /the relationship r1 was type T from a to b, and is now type /);
	}
});

test('connect: an answer that holds a drawn id as another element is rejected, and Connect is declined while out-of-date nodes remain', async () => {
	const { session, log } = rig(NEO, () => envelope([[node('a', ['P']), rel('rx', 'T', 'a', 'b'), node('b', ['Gone'])]]));
	session.load(base());
	await session.connect();
	assert.equal(session.getState().model.relationships.has('rx'), false);
	assert.ok(session.getState().staleIds.has('b'));
	const sent = log.recipes.length;
	await session.connect();
	assert.equal(log.recipes.length, sent);
	assert.match(session.getState().notice?.text ?? '', /Some drawn nodes are out of date/);
	session.dismiss('b');
	assert.equal(session.getState().staleIds.size, 0);
});

test('find path: a path whose nodes are other elements under drawn ids is not merged or highlighted, and a stale endpoint is not searched', async () => {
	const path = { '@kind': 'path', nodes: [node('a', ['P']), node('m', ['P']), node('b', ['Reused'])], relationships: [rel('p1', 'T', 'a', 'm'), rel('p2', 'T', 'm', 'b')] };
	const { session, log } = rig(NEO, (recipe) => envelope(/\[\*2\.\.2\]/.test(recipe.cypher) ? [[path as unknown as GraphValue]] : []));
	session.load(base());
	session.toggleSelect('a');
	session.toggleSelect('b');
	await session.findPath();
	const s = session.getState();
	assert.equal(s.model.nodes.has('m'), false);
	assert.equal(s.highlight.size, 0);
	assert.ok(s.staleIds.has('b'));
	const sent = log.recipes.length;
	await session.findPath();
	assert.equal(log.recipes.length, sent, 'an out-of-date endpoint is not searched from');
});

test('a write that ran on the connection marks the drawing out of date: Expand, Connect, Find path and Refresh send nothing, and the drawing is kept', async () => {
	const { session, log } = rig(NEO, () => envelope([[node('a', ['P']), rel('r2', 'T', 'a', 'c'), node('c', ['P'])]]));
	session.load(base());
	session.toggleSelect('a');
	session.toggleSelect('b');
	session.inspect({ kind: 'node', id: 'a' });
	session.markStale();
	const s = session.getState();
	assert.equal(s.stale, true);
	assert.deepEqual([...s.model.nodes.keys()], ['a', 'b'], 'the answer as it was is still shown');
	assert.equal(s.notice?.variant, 'warning');
	assert.match(s.notice?.text ?? '', /ran on this connection after this graph was drawn/);
	await session.expand('a');
	await session.connect();
	await session.findPath();
	await session.refreshInspected();
	assert.equal(log.recipes.length, 0, 'no query went to the node');
	// Collapse and dismiss are local and still work.
	session.dismiss('b');
	assert.deepEqual([...session.getState().model.nodes.keys()], ['a']);
	// Running the query again draws fresh and clears the mark.
	session.load(base());
	assert.equal(session.getState().stale, false);
	await session.expand('a');
	assert.equal(log.recipes.length, 1);
});

test('a write while an expansion is in flight drops that answer: its ids were asked about before the write', async () => {
	let release: (r: ReadQueryResult) => void = () => undefined;
	const { session } = rig(NEO, () => new Promise<ReadQueryResult>((resolve) => { release = resolve; }));
	session.load(base());
	const pending = session.expand('a');
	await tick();
	session.markStale();
	release(envelope([[node('a', ['P']), rel('r2', 'T', 'a', 'c'), node('c', ['P'])]]));
	await pending;
	assert.deepEqual([...session.getState().model.nodes.keys()], ['a', 'b'], 'the late answer was not drawn');
	assert.equal(session.getState().busy, null);
	assert.equal(session.getState().stale, true);
});

test('markStale on an empty canvas does nothing', () => {
	const { session } = rig();
	session.markStale();
	assert.equal(session.getState().stale, false);
	assert.equal(session.getState().notice, null);
});

// -----------------------------------------------------------------------------
// Escape closes the inspector after a new result: `dispose()` (run when a new result replaces
// the old) must not drop the component's subscription, or the cleared state is never re-rendered.
// -----------------------------------------------------------------------------

test('a subscriber keeps hearing after dispose and a later load: closing the inspector re-renders it', () => {
	const { session } = rig();
	let heard = 0;
	session.subscribe(() => { heard += 1; });
	session.load(base());
	session.dispose();
	session.load(base());
	const before = heard;
	session.inspect({ kind: 'node', id: 'a' });
	assert.equal(heard, before + 1, 'opening the inspector is announced to subscribers');
	session.inspect(null);
	assert.equal(heard, before + 2, 'closing it is too');
	assert.equal(session.getState().inspect, null);
});

test('dispose ends what is in flight but leaves subscriptions alone, and the session is reusable afterwards', async () => {
	let release: (r: ReadQueryResult) => void = () => undefined;
	const { session } = rig(NEO, () => new Promise<ReadQueryResult>((resolve) => { release = resolve; }));
	let heard = 0;
	const off = session.subscribe(() => { heard += 1; });
	session.load(base());
	const pending = session.expand('a');
	await tick();
	session.dispose();
	release(envelope([[node('a', ['P']), rel('r2', 'T', 'a', 'c'), node('c', ['P'])]]));
	await pending;
	assert.deepEqual([...session.getState().model.nodes.keys()], ['a', 'b'], 'the answer that was in flight is dropped');
	const before = heard;
	session.focus('b');
	assert.equal(heard, before + 1);
	off();
	session.focus('a');
	assert.equal(heard, before + 1, 'an explicit unsubscribe still works');
});

// -----------------------------------------------------------------------------
// While the connection is checked again, the drawing stays and nothing is sent
// -----------------------------------------------------------------------------

test('a paused session keeps its drawing and sends nothing for Expand, Connect, Find path or Refresh, and says why', async () => {
	let why: string | null = 'Checking this connection again.';
	const log = { recipes: [] as IRecipe[] };
	const session = createGraphSession({
		engine: () => NEO,
		invoke: async (recipe) => {
			log.recipes.push(recipe);
			return envelope([[node('a', ['P']), rel('r2', 'T', 'a', 'c'), node('c', ['P'])]]);
		},
		describe: (error) => notice(String(error)),
		announce: () => undefined,
		captionChoice: () => undefined,
		paused: () => why,
	});
	session.load(base());
	session.toggleSelect('a');
	session.toggleSelect('b');
	session.inspect({ kind: 'node', id: 'a' });
	await session.expand('a');
	await session.connect();
	await session.findPath();
	await session.refreshInspected();
	assert.equal(log.recipes.length, 0);
	assert.deepEqual([...session.getState().model.nodes.keys()], ['a', 'b'], 'the drawing is kept');
	assert.equal(session.getState().notice?.text, 'Nothing was sent. Checking this connection again.');
	why = null;
	await session.expand('a');
	assert.equal(log.recipes.length, 1, 'it sends again once the connection answers');
});

// -----------------------------------------------------------------------------
// Connect honours `truncated`
// -----------------------------------------------------------------------------

test('connect never says "no further relationships" when the node cut its answer, and says that more may exist', async () => {
	// The node clamps the 2,000 rows asked for to its own cap (250 on a default FalkorDB node): every row it sent is
	// already drawn, but the answer was cut.
	const { session } = rig(NEO, () => envelope([[node('a', ['P']), rel('r1', 'T', 'a', 'b'), node('b', ['P'])]], { row_limit: 250, truncated: true, truncated_by: 'rows' }));
	session.load(base());
	await session.connect();
	const said = session.getState().notice;
	assert.doesNotMatch(said?.text ?? '', /No further relationships/);
	assert.match(said?.text ?? '', /stopped at 250 rows, so more relationships among the nodes on the canvas may exist/);
	assert.equal(said?.variant, 'warning');
	// Something added from a cut answer says both.
	const { session: some } = rig(NEO, () => envelope([[node('a', ['P']), rel('r2', 'T', 'b', 'a'), node('b', ['P'])]], { row_limit: 250, truncated: true, truncated_by: 'rows' }));
	some.load(base());
	await some.connect();
	assert.match(some.getState().notice?.text ?? '', /^Added 1 relationship among the nodes on the canvas, but the node stopped at 250 rows/);
});

// -----------------------------------------------------------------------------
// Node and relationship ids are separate namespaces (FalkorDB numbers both from 0)
// -----------------------------------------------------------------------------

test('a relationship marked out of date does not mark the node that has the same id (FalkorDB numbers both from 0), and Connect says which kind is out of date', async () => {
	// Nodes 0, 1, 2 and relationship 2 (0 -> 1): the live FalkorDB fixture has exactly this kind of overlap.
	const drawn = envelope([[node('0', ['P']), rel('2', 'T', '0', '1'), node('1', ['P']), node('2', ['P'])]]);
	const { session, log } = rig(NEO, (_recipe, call) => (call === 0 ? envelope([[node('0', ['P']), rel('2', 'OTHER', '0', '1'), node('1', ['P'])]]) : envelope([[node('2', ['P']), rel('9', 'T', '2', '1'), node('1', ['P'])]])));
	session.load(drawn);
	await session.expand('0');
	let s = session.getState();
	assert.equal(s.staleIds.has('2'), false, 'the node with the same number is not marked');
	assert.ok(s.staleRelationshipIds.has('2'), 'the relationship is');
	// Node 2 is still asked about.
	await session.expand('2');
	assert.equal(log.recipes.length, 2, 'node 2 was expanded');
	assert.doesNotMatch(session.getState().notice?.text ?? '', /out of date/);
	// Connect names relationships, not dashed nodes that do not exist.
	const sent = log.recipes.length;
	await session.connect();
	assert.equal(log.recipes.length, sent, 'nothing is sent while a drawn relationship is out of date');
	assert.match(session.getState().notice?.text ?? '', /Some drawn relationships are out of date/);
	assert.doesNotMatch(session.getState().notice?.text ?? '', /out-of-date nodes/);
	// Dismissing node 2 (not an end of relationship 2) keeps the relationship's mark; dismissing an end clears it.
	session.dismiss('2');
	s = session.getState();
	assert.ok(s.staleRelationshipIds.has('2'), 'dismissing an unrelated node with the same id does not clear it');
	session.dismiss('1');
	assert.equal(session.getState().staleRelationshipIds.size, 0, 'the relationship left the canvas with its end');
});

// -----------------------------------------------------------------------------
// "Stop waiting" exists for every request the graph sends
// -----------------------------------------------------------------------------

test('Stop waiting lets go of Expand, Connect and Refresh as well as a path search: the late answer is dropped and the next action may start', async () => {
	const starts: Array<[string, (session: ReturnType<typeof rig>['session']) => Promise<void>]> = [
		['expand', (session) => session.expand('a')],
		['connect', (session) => session.connect()],
		['inspect', (session) => { session.inspect({ kind: 'node', id: 'a' }); return session.refreshInspected(); }],
	];
	for (const [busy, start] of starts) {
		let release: (r: ReadQueryResult) => void = () => undefined;
		const { session, log } = rig(NEO, () => new Promise<ReadQueryResult>((resolve) => { release = resolve; }));
		session.load(base());
		const pending = start(session);
		await tick();
		assert.equal(session.getState().busy, busy);
		session.stopWaiting();
		assert.equal(session.getState().busy, null, `${busy}: no longer busy`);
		assert.match(session.getState().notice?.text ?? '', /^Stopped waiting\. Stop waiting stops this app from waiting; the query may still be running/, busy);
		release(envelope([[node('a', ['Q'], { name: 'late' }), rel('r2', 'T', 'a', 'c'), node('c', ['P'])]]));
		await pending;
		const s = session.getState();
		assert.deepEqual([...s.model.nodes.keys()], ['a', 'b'], `${busy}: the late answer was dropped`);
		assert.equal(s.staleIds.size, 0, `${busy}: and not judged either`);
		assert.match(s.notice?.text ?? '', /^Stopped waiting\./, `${busy}: the notice is not replaced by the late answer`);
		const sent = log.recipes.length;
		void session.expand('b');
		await tick();
		assert.equal(log.recipes.length, sent + 1, `${busy}: a new action starts`);
	}
});

test('Stop waiting with nothing running does nothing', () => {
	const { session } = rig();
	session.load(base());
	session.stopWaiting();
	assert.equal(session.getState().notice, null);
});
