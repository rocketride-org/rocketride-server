// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// THE GRAPH SESSION, REDESIGN: selection by kind, the out-of-date state said once,
// Expand by type, the found path (one shortestPath call or the depth search) and
// "new query from here"
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGraphSession } from '../src/graph/graphSession';
import type { IGraphSessionDeps } from '../src/graph/graphSession';
import { DATA_CHANGED_TEXT, STALE_REFUSAL_TEXT } from '../src/graph/identity';
import type { GraphValue, ReadQueryResult } from '../src/graph/types';
import type { IEngine, IRecipe } from '../src/cypher/recipes';
import { neighboursQueryText, pathQueryText, relationshipQueryText } from '../src/cypher/recipes';
import { node, rel } from './support/builders';

const NEO: IEngine = { dialect: 'neo4j', version: '5.26.31' };
const NEO_SP: IEngine = { ...NEO, shortestPath: true };
const FALKOR: IEngine = { dialect: 'falkordb', version: '4.2.0' };
const AGE: IEngine = { dialect: 'age', version: '1.5.0' };

const envelope = (rows: GraphValue[][]): ReadQueryResult => ({ columns: rows[0]?.map((_, i) => `c${i}`) ?? ['c'], rows, row_limit: 1000, truncated: false, truncated_by: null, element_limit: 10000, elements: 0, value_limit: 500000, values: 0 });

/** A session over a scripted node. */
function rig(engine: IEngine | null = NEO, answer: (recipe: IRecipe) => Promise<ReadQueryResult> | ReadQueryResult = () => envelope([])) {
	const log = { recipes: [] as IRecipe[], said: [] as string[] };
	const deps: IGraphSessionDeps = {
		engine: () => engine,
		invoke: async (recipe) => {
			log.recipes.push(recipe);
			return answer(recipe);
		},
		describe: (error) => ({ variant: 'error', headline: error instanceof Error ? error.message : String(error), detail: '', verbatim: '', generic: false, hint: null, ignore: false }),
		announce: (text) => log.said.push(text),
		captionChoice: () => undefined,
	};
	return { session: createGraphSession(deps), log };
}
const base = (): ReadQueryResult => envelope([[node('a', ['P'], { name: 'A' }), node('b', ['P'], { name: 'B' }), rel('r1', 'T', 'a', 'b')]]);
/** A path a - m - b, the second relationship stored against the walk. */
const PATH = { '@kind': 'path', nodes: [node('a', ['P']), node('m', ['P'], { name: 'M' }), node('b', ['P'])], relationships: [rel('p1', 'T', 'a', 'm'), rel('p2', 'T', 'b', 'm')] } as unknown as GraphValue;

// -----------------------------------------------------------------------------
// Selection, keyed by kind
// -----------------------------------------------------------------------------

// FalkorDB numbers nodes and relationships separately, both from 0 (NODE-FACTS section 2).
test('selection and the inspector are keyed by kind: on FalkorDB, relationship 0 never stands for node 0', () => {
	const { session } = rig(FALKOR);
	session.load(envelope([[node('0', ['P'], { name: 'Zero' }), node('1', ['P']), node('2', ['P']), rel('0', 'T', '1', '2'), rel('5', 'T', '0', '1')]]));
	session.select('0', 'toggle');
	session.selectRelationship('0');
	let s = session.getState();
	assert.equal(s.selectedRelationship, '0');
	assert.equal(s.selected.size, 0, 'a click on a relationship selects only it');
	assert.deepEqual(s.inspect, { kind: 'relationship', id: '0' });
	session.select('0', 'toggle');
	s = session.getState();
	assert.ok(s.selected.has('0'), 'node 0 is selected as a node');
	assert.equal(s.selectedRelationship, '0', 'and relationship 0 stays selected as a relationship');
	// Dismissing NODE 0 takes relationship 5 with it, not relationship 0.
	session.dismiss('0');
	s = session.getState();
	assert.equal(s.selectedRelationship, '0');
	assert.deepEqual(s.inspect, { kind: 'relationship', id: '0' }, 'the inspector keeps relationship 0');
	assert.equal(s.selected.has('0'), false);
	// Dismissing an end of relationship 0 takes it off the canvas, and out of the selection and the inspector.
	session.dismiss('1');
	s = session.getState();
	assert.equal(s.selectedRelationship, null);
	assert.equal(s.inspect, null);
});

test('a relationship that is not drawn is not selected; clearing the selection clears both kinds; selecting a node replaces a relationship', () => {
	const { session, log } = rig();
	session.load(base());
	session.selectRelationship('ghost');
	assert.equal(session.getState().selectedRelationship, null);
	session.selectRelationship('r1');
	assert.match(log.said.at(-1) ?? '', /^T from A to B selected\.$/);
	session.clearSelection();
	assert.equal(session.getState().selectedRelationship, null);
	session.selectRelationship('r1');
	session.select('a', 'only');
	const s = session.getState();
	assert.equal(s.selectedRelationship, null);
	assert.deepEqual([...s.selected], ['a']);
	assert.deepEqual(s.inspect, { kind: 'node', id: 'a' });
});

// The legend selects every drawn node of a label: one state update, not one per node.
test('selectMany: `only` replaces the selection in one update and the inspector follows the first node; `toggle` adds them all unless all are selected', () => {
	const { session, log } = rig(FALKOR);
	session.load(envelope([[node('0', ['P'], { name: 'Zero' }), node('1', ['P']), node('2', ['Q']), rel('0', 'T', '1', '2')]]));
	let updates = 0;
	session.subscribe(() => (updates += 1));
	session.selectRelationship('0');
	updates = 0;
	session.selectMany(['0', '1', 'ghost', '1'], 'only');
	let s = session.getState();
	assert.equal(updates, 1, 'one update');
	assert.deepEqual([...s.selected], ['0', '1'], 'drawn nodes only, each once');
	assert.equal(s.selectedRelationship, null, 'relationship 0 is not node 0, and it is no longer selected');
	assert.deepEqual(s.inspect, { kind: 'node', id: '0' });
	assert.equal(log.said.at(-1), '2 nodes selected.');
	session.selectMany(['1', '2'], 'toggle');
	s = session.getState();
	assert.deepEqual([...s.selected].sort(), ['0', '1', '2'], 'one of them was not selected, so all are added');
	assert.deepEqual(s.inspect, { kind: 'node', id: '0' }, 'a toggle leaves the inspector alone');
	session.selectMany(['1', '2'], 'toggle');
	assert.deepEqual([...session.getState().selected], ['0'], 'all were selected, so all are removed');
	assert.equal(log.said.at(-1), '2 nodes deselected. 1 node selected.');
	updates = 0;
	session.selectMany(['ghost'], 'toggle');
	assert.equal(updates, 0, 'nothing drawn, nothing changes');
	session.selectMany([], 'only');
	s = session.getState();
	assert.equal(s.selected.size, 0);
	assert.equal(s.inspect, null, 'the inspector closes when nothing is selected');
});

test('collapse keeps a relationship that is still drawn in the inspector, and lets go of one that left with its end', () => {
	const { session } = rig(NEO, () => envelope([[node('a', ['P']), rel('r2', 'T', 'a', 'c'), node('c', ['P'], { name: 'C' })]]));
	session.load(base());
	return session.expand('a').then(() => {
		session.selectRelationship('r1');
		session.collapse('a');
		assert.deepEqual(session.getState().inspect, { kind: 'relationship', id: 'r1' }, 'r1 is between two nodes of the result');
		return session.expand('a').then(() => {
			session.selectRelationship('r2');
			session.collapse('a');
			assert.equal(session.getState().selectedRelationship, null);
			assert.equal(session.getState().inspect, null);
		});
	});
});

// -----------------------------------------------------------------------------
// The out-of-date state has one renderer
// -----------------------------------------------------------------------------

test('a write marks the drawing out of date once: it is announced, the notice slot stays empty, and a refused action says the short refusal', async () => {
	const { session, log } = rig();
	session.load(base());
	await session.expand('a');
	assert.ok(session.getState().notice, 'a notice about the drawing is showing before the write');
	session.markStale();
	let s = session.getState();
	assert.equal(s.stale, true);
	assert.equal(s.notice, null, 'the out-of-date line is drawn from `stale`, not repeated as a notice, and no notice about the old drawing stays');
	assert.equal(log.said.filter((t) => t === DATA_CHANGED_TEXT).length, 1, 'screen readers hear it once');
	session.markStale();
	assert.equal(log.said.filter((t) => t === DATA_CHANGED_TEXT).length, 1, 'and not again');
	await session.expand('a');
	s = session.getState();
	assert.equal(s.notice?.text, STALE_REFUSAL_TEXT);
	assert.notEqual(s.notice?.text, DATA_CHANGED_TEXT);
	assert.equal(STALE_REFUSAL_TEXT, 'Not sent: this drawing is out of date. Run the query again.');
	await session.expandByType('a', 'T');
	session.toggleSelect('a');
	session.toggleSelect('b');
	await session.findPath();
	await session.connect();
	assert.equal(log.recipes.length, 1, 'only the Expand sent before the write');
	assert.equal(session.getState().notice?.text, STALE_REFUSAL_TEXT);
});

// -----------------------------------------------------------------------------
// Expand by type
// -----------------------------------------------------------------------------

test('Expand by type sends one recipe for that type, leaves out only the drawn relationships of that type, and names what it added', async () => {
	const { session, log } = rig(NEO, () => envelope([[node('a', ['P']), rel('m1', 'MAKES', 'a', 'c'), node('c', ['Product'], { name: 'Lighthouse' })], [node('a', ['P']), rel('m0', 'MAKES', 'a', 'd'), node('d', ['Product'], { name: 'Tidewater' })]]));
	session.load(envelope([[node('a', ['P'], { name: 'Northwind' }), node('b', ['P']), rel('r1', 'T', 'a', 'b'), node('d', ['Product'], { name: 'Tidewater' }), rel('m0', 'MAKES', 'a', 'd')]]));
	await session.expandByType('a', 'MAKES');
	assert.equal(log.recipes.length, 1);
	assert.match(log.recipes[0].cypher, /OPTIONAL MATCH \(n\)-\[r:`MAKES`\]-\(m\)/);
	assert.deepEqual(log.recipes[0].params, { id: 'a', drawn: ['m0'] }, 'the drawn MAKES relationship is left out; the T one could not come back anyway');
	const s = session.getState();
	assert.ok(s.model.nodes.has('c'));
	assert.deepEqual(s.hint, { centerId: 'a', newIds: ['c'] });
	assert.equal(s.notice?.text, 'Added 1 MAKES neighbour of Northwind: Lighthouse.');
	assert.equal(s.busy, null);
	session.collapse('a');
	assert.equal(session.getState().model.nodes.has('c'), false, 'what it added collapses like any expansion');
});

test('Expand by type says when the node has no relationship of that type, and refuses a type the engine cannot take without sending anything', async () => {
	const { session } = rig(NEO, () => envelope([[node('a', ['P']), null, null]]));
	session.load(base());
	await session.expandByType('a', 'MAKES');
	assert.equal(session.getState().notice?.text, 'A has no MAKES relationships in the database. Nothing was added.');
	const age = rig(AGE);
	age.session.load(base());
	await age.session.expandByType('a', 'works at');
	assert.equal(age.log.recipes.length, 0);
	assert.match(age.session.getState().notice?.text ?? '', /relationship type "works at" cannot be put in a generated query on this engine/);
	await age.session.expandByType('ghost', 'T');
	assert.equal(age.log.recipes.length, 0, 'a node that is not drawn is not expanded');
});

test('Expand by type on a node whose neighbours of that type are all drawn says nothing new, not that the node is gone', async () => {
	// The node is matched on its own and its relationships OPTIONALLY: it answers with itself even when nothing is new.
	const { session, log } = rig(NEO, () => envelope([[node('a', ['P'], { name: 'A' }), null, null]]));
	session.load(envelope([[node('a', ['P'], { name: 'A' }), rel('m0', 'MAKES', 'a', 'd'), node('d', ['Product'])]]));
	await session.expandByType('a', 'MAKES');
	assert.match(log.recipes[0].cypher, /^MATCH \(n\) WHERE .* OPTIONAL MATCH \(n\)-\[r:`MAKES`\]-\(m\)/);
	assert.equal(session.getState().notice?.text, 'No new MAKES neighbours of A.');
	assert.equal(session.getState().notice?.variant, 'info');
});

test('Expand by type is one request at a time like every other action, and its late answer is dropped by a new result', async () => {
	let release: (r: ReadQueryResult) => void = () => undefined;
	const { session, log } = rig(NEO, () => new Promise<ReadQueryResult>((resolve) => { release = resolve; }));
	session.load(base());
	const pending = session.expandByType('a', 'T');
	await new Promise((r) => setImmediate(r));
	assert.equal(session.getState().busy, 'expand');
	await session.expandByType('b', 'T');
	assert.equal(log.recipes.length, 1, 'the second is declined');
	session.load(base());
	release(envelope([[node('a', ['P']), rel('x', 'T', 'a', 'z'), node('z', ['P'])]]));
	await pending;
	assert.equal(session.getState().model.nodes.has('z'), false);
});

// -----------------------------------------------------------------------------
// The found path
// -----------------------------------------------------------------------------

test('on an engine with shortestPath, Find path makes ONE call, keeps the path in order with how it was found, and Clear path forgets it', async () => {
	const { session, log } = rig(NEO_SP, (recipe) => envelope(/shortestPath/.test(recipe.cypher) ? [[PATH]] : []));
	session.load(base());
	session.toggleSelect('a');
	session.toggleSelect('b');
	await session.findPath();
	assert.equal(log.recipes.length, 1, 'one read_query');
	assert.match(log.recipes[0].cypher, /shortestPath\(/);
	let s = session.getState();
	assert.deepEqual(s.path, { nodes: ['a', 'm', 'b'], relationships: ['p1', 'p2'], method: 'shortest-path' });
	assert.deepEqual([...s.highlight].sort(), ['p1', 'p2']);
	assert.equal(s.notice?.text, 'Shortest path A → B: 2 relationships, found with one shortestPath call. Laid out left to right; other nodes dimmed. Relationships keep their stored direction.');
	session.clearPath();
	s = session.getState();
	assert.equal(s.path, null);
	assert.equal(s.highlight.size, 0);
	// The found-path sentence ("laid out left to right; other nodes dimmed") is no longer true: it does not stay.
	assert.equal(s.notice?.text, 'Path cleared.');
});

test('Clear path leaves the selection, the inspected element and the selected relationship exactly as they were', async () => {
	const { session } = rig(NEO_SP, (recipe) => envelope(/shortestPath/.test(recipe.cypher) ? [[PATH]] : []));
	session.load(base());
	session.select('a', 'only');
	session.select('b', 'toggle');
	await session.findPath();
	const before = session.getState();
	assert.notEqual(before.path, null);
	session.clearPath();
	const after = session.getState();
	assert.equal(after.path, null);
	assert.deepEqual([...after.selected], [...before.selected]);
	assert.deepEqual(after.inspect, before.inspect);
	assert.equal(after.selectedRelationship, before.selectedRelationship);
});

test('a failed shortestPath call falls back to the depth search, which finds the path and is named as the method; an empty one is final', async () => {
	const { session, log } = rig(NEO_SP, (recipe) => {
		if (/shortestPath/.test(recipe.cypher)) throw new Error('Query failed');
		return envelope(/\[\*2\.\.2\]/.test(recipe.cypher) ? [[PATH]] : []);
	});
	session.load(base());
	session.toggleSelect('a');
	session.toggleSelect('b');
	await session.findPath();
	assert.deepEqual(log.recipes.map((r) => (/shortestPath/.test(r.cypher) ? 'one call' : /\[\*(\d)\.\./.exec(r.cypher)?.[1])), ['one call', '1', '2']);
	assert.equal(session.getState().path?.method, 'depth');
	assert.match(session.getState().notice?.text ?? '', /^Shortest path A → B: 2 relationships, found by trying depth 1 to 2, one call each\./);
	const empty = rig(NEO_SP, () => envelope([]));
	empty.session.load(base());
	empty.session.toggleSelect('a');
	empty.session.toggleSelect('b');
	await empty.session.findPath();
	assert.equal(empty.log.recipes.length, 1, 'the undirected call already searched depth 1 to 10');
	assert.match(empty.session.getState().notice?.text ?? '', /^No path within depth 10\./);
});

test('AGE, and an engine that does not report shortestPath, go straight to the depth search; the progress line says which search runs', async () => {
	for (const engine of [AGE, NEO]) {
		const { session, log } = rig(engine, (recipe) => envelope(/\[\*2\.\.2\]/.test(recipe.cypher) ? [[PATH]] : []));
		session.load(base());
		session.toggleSelect('a');
		session.toggleSelect('b');
		await session.findPath();
		assert.ok(log.recipes.every((r) => !/shortestPath/.test(r.cypher)), engine.dialect);
		assert.equal(session.getState().path?.method, 'depth');
	}
	let release: (r: ReadQueryResult) => void = () => undefined;
	const { session } = rig(NEO_SP, () => new Promise<ReadQueryResult>((resolve) => { release = resolve; }));
	session.load(base());
	session.toggleSelect('a');
	session.toggleSelect('b');
	const running = session.findPath();
	await new Promise((r) => setImmediate(r));
	assert.equal(session.getState().progress, 'Asking for a shortest path in one call…');
	session.stopWaiting();
	await running;
	release(envelope([[PATH]]));
	assert.equal(session.getState().path, null, 'nothing found, nothing shown');
});

test('the path follows the drawing: dismissing a node on it, a new search, a new result and a write each clear it', async () => {
	const found = async () => {
		const r = rig(NEO_SP, () => envelope([[PATH]]));
		r.session.load(base());
		r.session.toggleSelect('a');
		r.session.toggleSelect('b');
		await r.session.findPath();
		assert.ok(r.session.getState().path);
		return r.session;
	};
	let session = await found();
	session.dismiss('m');
	assert.equal(session.getState().path, null);
	assert.equal(session.getState().highlight.size, 0);
	session = await found();
	session.dismiss('ghost');
	assert.ok(session.getState().path, 'an unrelated dismissal keeps it');
	session.load(base());
	assert.equal(session.getState().path, null);
	session = await found();
	session.markStale();
	assert.equal(session.getState().path, null);
});

// -----------------------------------------------------------------------------
// New query from here
// -----------------------------------------------------------------------------

test('queryTextFor: a node, a relationship and the current path, written for the engine; null for what is not drawn or an unknown engine', async () => {
	const { session } = rig(NEO, (recipe) => envelope(/\[\*2\.\.2\]/.test(recipe.cypher) ? [[PATH]] : []));
	session.load(base());
	assert.equal(session.queryTextFor({ kind: 'node', id: 'a' }), neighboursQueryText(NEO, 'a'));
	assert.equal(session.queryTextFor({ kind: 'relationship', id: 'r1' }), relationshipQueryText(NEO, 'r1'));
	assert.equal(session.queryTextFor({ kind: 'node', id: 'r1' }), null, 'a relationship id is not a node');
	assert.equal(session.queryTextFor({ kind: 'relationship', id: 'a' }), null);
	assert.equal(session.queryTextFor({ kind: 'path' }), null, 'no path yet');
	session.toggleSelect('a');
	session.toggleSelect('b');
	await session.findPath();
	assert.equal(session.queryTextFor({ kind: 'path' }), pathQueryText(NEO, 'a', 'b', { method: 'depth', depth: 2 }));
	const none = rig(null);
	none.session.load(base());
	assert.equal(none.session.queryTextFor({ kind: 'node', id: 'a' }), null);
});
