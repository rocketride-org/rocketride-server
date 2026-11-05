// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// GENERATED QUERIES (recipes) AND BOUNDED PATH SEARCH
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGE_CONNECT_MAX_NODES, AGE_EXPAND_MAX_EXCLUDED, FALKORDB_SHORTEST_PATH, LIVE_HANDLE_NOTE, connectNodes, expandByType, expandNeighbors, idPredicate, inspectNode, isRefusal, labelPreview, majorVersion, neighboursQueryText, pathAtDepth, pathQueryText, relationshipQueryText, shortestPathRecipe, typePreview, usesShortestPath } from '../src/cypher/recipes';
import type { IEngine, IRecipe, RecipeResult } from '../src/cypher/recipes';
import { createPathSearch, noPathText } from '../src/cypher/pathSearch';
import type { ReadQueryResult } from '../src/graph/types';
import { classifyStatement } from '../src/cypher/classify';
import { node, rel } from './support/builders';

const ENGINES: IEngine[] = [
	{ dialect: 'neo4j', version: '5.26.31' },
	{ dialect: 'falkordb', version: '4.2.0' },
	{ dialect: 'age', version: '1.5.0' },
];
const HOSTILE_IDS = ["x'; MATCH (n) DETACH DELETE n //", '`; DROP', '4:6f1dbe8c-0000-4000-8000-00000000c0de:17', '11821949021847553', 'x$y', '}{', 'LIMIT 1; --'];

function recipe(result: RecipeResult): IRecipe {
	assert.ok(!isRefusal(result), isRefusal(result) ? result.refusal : '');
	return result;
}

test('an id is compared with elementId() on Neo4j 5+ and with id(n) = toInteger($id) on FalkorDB and AGE', () => {
	assert.equal(recipe(inspectNode(ENGINES[0], 'abc')).cypher, 'MATCH (n) WHERE elementId(n) = $id RETURN n LIMIT 1');
	assert.equal(recipe(inspectNode(ENGINES[1], '12')).cypher, 'MATCH (n) WHERE id(n) = toInteger($id) RETURN n LIMIT 1');
	assert.equal(recipe(inspectNode(ENGINES[2], '11821949021847553')).cypher, 'MATCH (n) WHERE id(n) = toInteger($id) RETURN n LIMIT 1');
	assert.deepEqual(recipe(inspectNode(ENGINES[2], '11821949021847553')).params, { id: '11821949021847553' }, 'the id above 2^53 is bound as the string it arrived as');
});

test('Neo4j older than 5 is refused, an unknown version is allowed, other engines ignore the version', () => {
	assert.ok(isRefusal(inspectNode({ dialect: 'neo4j', version: '4.4.30' }, 'x')));
	assert.ok(!isRefusal(inspectNode({ dialect: 'neo4j', version: null }, 'x')));
	assert.ok(!isRefusal(inspectNode({ dialect: 'neo4j', version: '5.0.0' }, 'x')));
	assert.ok(!isRefusal(inspectNode({ dialect: 'falkordb', version: '1' }, 'x')));
	assert.equal(majorVersion('5.26.31'), 5);
	assert.equal(majorVersion('v4.4'), 4);
	assert.equal(majorVersion('x'), null);
	assert.equal(majorVersion(null), null);
	assert.deepEqual(idPredicate({ dialect: 'neo4j', version: '4.0' }, 'n', 'id'), { refusal: 'Neo4j 4.0 is older than 5; Graph Explorer needs elementId(), which arrived in Neo4j 5.' });
});

test('no id or value ever appears in query text; ids travel only as parameters', () => {
	for (const engine of ENGINES) {
		for (const id of HOSTILE_IDS) {
			const inspect = recipe(inspectNode(engine, id));
			const expand = recipe(expandNeighbors(engine, id, 100, ['7', '8', '9']));
			const path = recipe(pathAtDepth(engine, id, 'other-id', 4));
			for (const r of [inspect, expand, path]) {
				assert.ok(!r.cypher.includes(id), `${engine.dialect}: id leaked into ${r.cypher}`);
				assert.ok(Object.values(r.params).some((v) => v === id || (Array.isArray(v) && v.includes(id))), 'the id is bound');
			}
			const connect = recipe(connectNodes(engine, [id, 'another'], 500));
			assert.ok(!connect.cypher.includes(id));
			// A drawn relationship's id is left out of an expansion by parameter too.
			const again = recipe(expandNeighbors(engine, 'center', 100, [id]));
			assert.ok(!again.cypher.includes(id), `${engine.dialect}: drawn id leaked into ${again.cypher}`);
			assert.ok(Object.values(again.params).some((v) => v === id || (Array.isArray(v) && v.includes(id))), 'the drawn id is bound');
		}
	}
});

test('every generated query is a read by the app classifier', () => {
	for (const engine of ENGINES) {
		const all = [
			recipe(labelPreview(engine, 'Person')),
			recipe(typePreview(engine, 'KNOWS')),
			recipe(inspectNode(engine, '1')),
			recipe(expandNeighbors(engine, '1', 100, [])),
			recipe(expandNeighbors(engine, '1', 100, ['2', '3', '4'])),
			recipe(expandNeighbors(engine, '1', 100, Array.from({ length: AGE_EXPAND_MAX_EXCLUDED + 5 }, (_, i) => String(i)))),
			recipe(connectNodes(engine, ['1', '2', '3'], 2000)),
			recipe(pathAtDepth(engine, '1', '2', 3)),
		];
		for (const r of all) assert.equal(classifyStatement(r.cypher).kind, 'read', r.cypher);
	}
});

test('label preview quotes the label for the dialect and refuses what cannot be quoted', () => {
	assert.equal(recipe(labelPreview(ENGINES[0], 'Person')).cypher, 'MATCH (n:`Person`) RETURN n LIMIT 25');
	assert.equal(recipe(labelPreview(ENGINES[0], 'we`ird')).cypher, 'MATCH (n:`we``ird`) RETURN n LIMIT 25');
	assert.equal(recipe(labelPreview(ENGINES[1], 'we ird')).cypher, 'MATCH (n:`we ird`) RETURN n LIMIT 25');
	// FalkorDB cannot parse a backtick inside a quoted name: the app says so instead of sending what fails to parse.
	for (const refusal of [labelPreview(ENGINES[1], 'we`ird'), typePreview(ENGINES[1], 'HAS`TICK')]) {
		assert.ok(isRefusal(refusal));
		assert.match(isRefusal(refusal) ? refusal.refusal : '', /cannot be put in a generated query on this engine/);
	}
	assert.equal(recipe(labelPreview(ENGINES[2], 'Person')).cypher, 'MATCH (n:Person) RETURN n LIMIT 25');
	assert.equal(recipe(labelPreview(ENGINES[0], 'Person', 25)).limit, 25);
	const refused = labelPreview(ENGINES[2], 'has space');
	assert.ok(isRefusal(refused));
	assert.match(isRefusal(refused) ? refused.refusal : '', /has space/);
	assert.ok(isRefusal(labelPreview(ENGINES[0], 'bad\nname')));
	assert.match((labelPreview(ENGINES[0], 'bad\nname') as { refusal: string }).refusal, /\\u000a/, 'control characters are shown escaped in the message');
	assert.equal(recipe(labelPreview(ENGINES[0], 'P', 99999)).limit, 1000, 'the limit is clamped');
	assert.equal(recipe(labelPreview(ENGINES[0], 'P', -4)).limit, 1);
	assert.equal(recipe(labelPreview(ENGINES[0], 'P', NaN)).limit, 1);
});

test('an injected label can never break out of its quoting', () => {
	const evil = '`) DETACH DELETE n //';
	const r = recipe(labelPreview(ENGINES[0], evil));
	const check = classifyStatement(r.cypher);
	assert.equal(check.kind, 'read', r.cypher);
	assert.equal(r.cypher, 'MATCH (n:```) DETACH DELETE n //`) RETURN n LIMIT 25');
	// FalkorDB and AGE have no way to quote a backtick, so the name is refused rather than placed.
	for (const engine of ENGINES.slice(1)) assert.ok(isRefusal(labelPreview(engine, evil)), engine.dialect);
});

// Asking for `shown + wanted + 1` rows with nothing left out would return the same, already drawn, rows on every repeat
// once a node's row cap is below that (250 on a default FalkorDB node). The relationships already drawn are left out of
// the request itself, so a repeat asks for the next ones.
test('expand leaves out the relationships already drawn and asks for the wanted NEW neighbours plus one', () => {
	const neo = recipe(expandNeighbors(ENGINES[0], 'a', 100, ['r1', 'r2', 'r1']));
	assert.equal(neo.cypher, 'MATCH (n) WHERE elementId(n) = $id OPTIONAL MATCH (n)-[r]-(m) WHERE NOT (elementId(r) IN $drawn) RETURN n, r, m LIMIT 101');
	assert.deepEqual(neo.params, { id: 'a', drawn: ['r1', 'r2'] }, 'duplicates removed, order kept');
	assert.equal(neo.limit, 101);
	const falkor = recipe(expandNeighbors(ENGINES[1], '5', 100, ['12', '13']));
	assert.equal(falkor.cypher, 'MATCH (n) WHERE id(n) = toInteger($id) OPTIONAL MATCH (n)-[r]-(m) WHERE NOT (id(r) IN [x IN $drawn | toInteger(x)]) RETURN n, r, m LIMIT 101');
	assert.deepEqual(falkor.params, { id: '5', drawn: ['12', '13'] });
	const age = recipe(expandNeighbors(ENGINES[2], '844424930131969', 100, ['1125899906842625', '1125899906842626']));
	assert.equal(age.cypher, 'MATCH (n) WHERE id(n) = toInteger($id) OPTIONAL MATCH (n)-[r]-(m) WHERE NOT (id(r) = toInteger($d0) OR id(r) = toInteger($d1)) RETURN n, r, m LIMIT 101');
	assert.deepEqual(age.params, { id: '844424930131969', d0: '1125899906842625', d1: '1125899906842626' }, 'ids above 2^53 stay strings');
	for (const engine of ENGINES) {
		const first = recipe(expandNeighbors(engine, 'a', 100, []));
		assert.ok(!/ NOT /.test(first.cypher), `${engine.dialect}: nothing drawn, nothing left out`);
		assert.match(first.cypher, /^MATCH \(n\) WHERE .* OPTIONAL MATCH \(n\)-\[r\]-\(m\) RETURN n, r, m LIMIT 101$/, 'the node answers on its own even with no relationships');
		assert.deepEqual(first.params, { id: 'a' });
		assert.equal(first.limit, 101);
	}
	assert.equal(recipe(expandNeighbors(ENGINES[0], 'a', 5000, [])).limit, 1001, 'the wanted count is bounded');
	assert.equal(recipe(expandNeighbors(ENGINES[0], 'a', 0, [])).limit, 2);
	assert.ok(isRefusal(expandNeighbors(ENGINES[0], '', 100, [])));
	assert.ok(isRefusal(inspectNode(ENGINES[0], 'x'.repeat(513))));
	assert.ok(isRefusal(inspectNode(ENGINES[0], 42 as unknown as string)));
});

test('on AGE at most AGE_EXPAND_MAX_EXCLUDED drawn relationships are left out; the rest are fetched again and counted in', () => {
	const drawn = Array.from({ length: AGE_EXPAND_MAX_EXCLUDED + 30 }, (_, i) => String(1125899906842625 + i));
	const age = recipe(expandNeighbors(ENGINES[2], '1', 100, drawn));
	assert.equal(Object.keys(age.params).length, AGE_EXPAND_MAX_EXCLUDED + 1);
	assert.equal(age.limit, 30 + 100 + 1, 'enough rows for the 30 drawn ones it may see again plus the wanted new ones');
	assert.ok(!/ IN /.test(age.cypher), 'no list comprehension or IN on AGE');
	// The rocketride_graph node refuses a statement over 10,000 characters (age/firewall.py DEFAULT_MAX_QUERY_LENGTH).
	assert.ok(age.cypher.length < 10000, `${age.cypher.length} characters`);
	// Neo4j and FalkorDB leave every drawn one out, so the limit stays at wanted + 1.
	for (const engine of ENGINES.slice(0, 2)) assert.equal(recipe(expandNeighbors(engine, '1', 100, drawn)).limit, 101);
});

test('connect: Neo4j binds the id list, FalkorDB converts it, AGE binds each id and is bounded', () => {
	const neo = recipe(connectNodes(ENGINES[0], ['a', 'b', 'a', 'c'], 2000));
	assert.deepEqual(neo.params, { ids: ['a', 'b', 'c'] }, 'duplicates removed, order kept');
	assert.match(neo.cypher, /elementId\(a\) IN \$ids AND elementId\(b\) IN \$ids/);
	const falkor = recipe(connectNodes(ENGINES[1], ['1', '2'], 2000));
	assert.match(falkor.cypher, /id\(a\) IN \[x IN \$ids \| toInteger\(x\)\]/);
	const age = recipe(connectNodes(ENGINES[2], ['11821949021847553', '844424930131969'], 2000));
	assert.deepEqual(age.params, { i0: '11821949021847553', i1: '844424930131969' });
	assert.match(age.cypher, /id\(a\) = toInteger\(\$i0\) OR id\(a\) = toInteger\(\$i1\)/);
	assert.ok(!/ IN /.test(age.cypher), 'no list comprehension or IN on AGE');
	const many = Array.from({ length: AGE_CONNECT_MAX_NODES + 1 }, (_, i) => `id${i}`);
	assert.ok(isRefusal(connectNodes(ENGINES[2], many, 100)));
	assert.ok(!isRefusal(connectNodes(ENGINES[0], many, 100)));
	assert.ok(isRefusal(connectNodes(ENGINES[0], ['only'], 100)));
	assert.ok(isRefusal(connectNodes(ENGINES[0], ['same', 'same'], 100)), 'duplicates collapse to one node');
	assert.ok(isRefusal(connectNodes({ dialect: 'neo4j', version: '4.4' }, ['a', 'b'], 100)));
});

test('path recipes use a literal exact depth clamped to 1..10 and bind both ids', () => {
	for (const engine of ENGINES) {
		const r = recipe(pathAtDepth(engine, 'a', 'b', 3));
		assert.match(r.cypher, /\[\*3\.\.3\]/);
		assert.deepEqual(r.params, { from: 'a', to: 'b' });
		assert.match(r.cypher, /LIMIT 1$/);
		assert.ok(!/\$(d|depth)\b/.test(r.cypher), 'the depth is never a parameter (AGE needs a literal range)');
	}
	assert.match(recipe(pathAtDepth(ENGINES[2], 'a', 'b', 99)).cypher, /\[\*10\.\.10\]/);
	assert.match(recipe(pathAtDepth(ENGINES[2], 'a', 'b', 0)).cypher, /\[\*1\.\.1\]/);
	assert.match(recipe(pathAtDepth(ENGINES[2], 'a', 'b', 2.9)).cypher, /\[\*2\.\.2\]/);
	assert.match(recipe(pathAtDepth(ENGINES[2], 'a', 'b', NaN)).cypher, /\[\*1\.\.1\]/);
	assert.ok(!/shortestPath/i.test(recipe(pathAtDepth(ENGINES[2], 'a', 'b', 2)).cypher), 'no shortestPath, AGE has none');
	assert.ok(isRefusal(pathAtDepth(ENGINES[0], 'a', 'a', 2)));
});

// -----------------------------------------------------------------------------
// Path search
// -----------------------------------------------------------------------------

/** A fake read_query that has a path only at one depth. */
function fakeRun(pathDepth: number | null, log: Array<{ depth: number; at: number }>, state: { inFlight: number; maxInFlight: number }) {
	return async (r: IRecipe): Promise<ReadQueryResult> => {
		state.inFlight += 1;
		state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
		const depth = Number(/\[\*(\d+)\.\./.exec(r.cypher)?.[1]);
		log.push({ depth, at: log.length });
		await new Promise((resolve) => setImmediate(resolve));
		state.inFlight -= 1;
		const rows: ReadQueryResult['rows'] = [];
		if (pathDepth === depth) {
			// Walked from `from` to `to`, with the middle relationship stored against the walk.
			const nodes = [node('from')];
			const rels = [];
			for (let i = 1; i < depth; i++) nodes.push(node(`mid${i}`));
			nodes.push(node('to'));
			for (let i = 0; i < depth; i++) rels.push(i === 1 ? rel(`r${i}`, 'T', nodes[i + 1].id, nodes[i].id) : rel(`r${i}`, 'T', nodes[i].id, nodes[i + 1].id));
			rows.push([{ '@kind': 'path', nodes, relationships: rels }]);
		}
		return { columns: ['p'], rows, row_limit: 1, truncated: false, truncated_by: null, element_limit: 10000, elements: 0, value_limit: 500000, values: 0 };
	};
}

test('the search deepens one level at a time and stops at the first (shortest) path', async () => {
	const log: Array<{ depth: number; at: number }> = [];
	const state = { inFlight: 0, maxInFlight: 0 };
	const seen: number[] = [];
	const search = createPathSearch({ engine: ENGINES[2], run: fakeRun(3, log, state), onDepth: (d) => seen.push(d) });
	const outcome = await search.start('from', 'to');
	assert.equal(outcome.status, 'found');
	if (outcome.status === 'found') {
		assert.equal(outcome.depth, 3);
		assert.equal(outcome.attempts, 3);
		assert.deepEqual(outcome.path.nodes.map((n) => n.id), ['from', 'mid1', 'mid2', 'to'], 'traversal order');
		assert.equal(outcome.path.relationships[1].start, 'mid2', 'stored direction kept: this one was stored against the walk');
		assert.equal(outcome.path.relationships[1].end, 'mid1');
	}
	assert.deepEqual(log.map((l) => l.depth), [1, 2, 3], 'no depth beyond the first hit is tried');
	assert.deepEqual(seen, [1, 2, 3]);
	assert.equal(state.maxInFlight, 1, 'one request at a time');
	assert.equal(search.running, false);
});

test('with no path within the depth limit the answer says so in budget terms, after exactly ten requests', async () => {
	const log: Array<{ depth: number; at: number }> = [];
	const state = { inFlight: 0, maxInFlight: 0 };
	const search = createPathSearch({ engine: ENGINES[0], run: fakeRun(null, log, state) });
	const outcome = await search.start('from', 'to');
	assert.deepEqual(outcome, { status: 'none', maxDepth: 10, attempts: 10 });
	assert.deepEqual(log.map((l) => l.depth), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	assert.equal(state.maxInFlight, 1);
	assert.match(noPathText(10), /^No path within depth 10\./);
	assert.ok(!/no path exists/i.test(noPathText(10)));
	// A smaller maximum is honoured, and a larger one is clamped to 10.
	assert.equal(((await createPathSearch({ engine: ENGINES[0], maxDepth: 3, run: fakeRun(null, [], { inFlight: 0, maxInFlight: 0 }) }).start('a', 'b')) as { attempts: number }).attempts, 3);
	assert.equal(((await createPathSearch({ engine: ENGINES[0], maxDepth: 50, run: fakeRun(null, [], { inFlight: 0, maxInFlight: 0 }) }).start('a', 'b')) as { attempts: number }).attempts, 10);
});

test('an error stops the search at the depth where it happened, with the node\'s text', async () => {
	const search = createPathSearch({
		engine: ENGINES[0],
		run: async (r) => {
			if (/\[\*3\.\./.test(r.cypher)) throw new Error('Query timed out after 30000 ms\nDatabase said: canceling statement due to statement timeout');
			return fakeRun(null, [], { inFlight: 0, maxInFlight: 0 })(r);
		},
	});
	const outcome = await search.start('a', 'b');
	assert.equal(outcome.status, 'error');
	if (outcome.status === 'error') {
		assert.equal(outcome.depth, 3);
		assert.equal(outcome.attempts, 3);
		assert.match(outcome.message, /Query timed out/);
	}
});

test('the total deadline stops the search between depths', async () => {
	let t = 0;
	const search = createPathSearch({ engine: ENGINES[0], deadlineMs: 25_000, now: () => t, run: async (r) => { t += 10_000; return fakeRun(null, [], { inFlight: 0, maxInFlight: 0 })(r); } });
	const outcome = await search.start('a', 'b');
	assert.deepEqual(outcome, { status: 'deadline', depthReached: 3, attempts: 3 });
});

test('Stop waiting returns at once, the late answer is ignored, and a new search can start', async () => {
	let release: (() => void) | null = null;
	const calls: string[] = [];
	const search = createPathSearch({
		engine: ENGINES[1],
		run: (r) => {
			calls.push(r.cypher);
			return new Promise<ReadQueryResult>((resolve) => {
				release = () => resolve({ columns: ['p'], rows: [[{ '@kind': 'path', nodes: [node('from'), node('to')], relationships: [rel('r', 'T', 'from', 'to')] }]], row_limit: 1, truncated: false, truncated_by: null, element_limit: 1, elements: 3, value_limit: 1, values: 1 });
			});
		},
	});
	const first = search.start('from', 'to');
	assert.equal(search.running, true);
	assert.deepEqual(await Promise.race([search.start('x', 'y'), Promise.resolve('pending')]), { status: 'refused', message: 'A path search is already running. Stop waiting for it first.' }, 'only one search at a time');
	await Promise.resolve();
	search.stop();
	assert.equal(search.running, false);
	const outcome = await first;
	assert.equal(outcome.status, 'stopped');
	// The server finishes the abandoned call later; nothing happens.
	(release as unknown as () => void)?.();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 1, 'no further depth was tried after stopping');
	// And the controller is free again.
	const second = search.start('from', 'to');
	assert.equal(search.running, true);
	await new Promise((resolve) => setImmediate(resolve));
	(release as unknown as () => void)?.();
	assert.equal((await second).status, 'found');
});

test('a path between other nodes than the two selected is an error, never shown as the answer', async () => {
	const search = createPathSearch({
		engine: ENGINES[0],
		run: async () => ({ columns: ['p'], rows: [[{ '@kind': 'path', nodes: [node('x'), node('y')], relationships: [rel('r', 'T', 'x', 'y')] }]], row_limit: 1, truncated: false, truncated_by: null, element_limit: 1, elements: 3, value_limit: 1, values: 1 }),
	});
	assert.equal((await search.start('a', 'b')).status, 'error');
});

test('refusals: the same node twice, an unsupported Neo4j, and an unusable id', async () => {
	const run = async (): Promise<ReadQueryResult> => {
		throw new Error('must not run');
	};
	assert.equal((await createPathSearch({ engine: ENGINES[0], run }).start('a', 'a')).status, 'refused');
	assert.equal((await createPathSearch({ engine: { dialect: 'neo4j', version: '4.4' }, run }).start('a', 'b')).status, 'refused');
	assert.equal((await createPathSearch({ engine: ENGINES[0], run }).start('', 'b')).status, 'refused');
});

test('a relationship type preview quotes the type for the dialect and returns both ends', () => {
	assert.equal(recipe(typePreview(ENGINES[0], 'KNOWS')).cypher, 'MATCH (a)-[r:`KNOWS`]->(b) RETURN a, r, b LIMIT 25');
	assert.equal(recipe(typePreview(ENGINES[2], 'WORKS_AT')).cypher, 'MATCH (a)-[r:WORKS_AT]->(b) RETURN a, r, b LIMIT 25');
	assert.ok(isRefusal(typePreview(ENGINES[2], 'works at')));
	assert.ok(isRefusal(typePreview(ENGINES[1], 'bad\nname')));
});

// -----------------------------------------------------------------------------
// Expand by type, the one-call shortest path, and "new query from here"
// -----------------------------------------------------------------------------

/** What Apache AGE refuses or cannot parse (NODE-FACTS section 4): none of it may reach an AGE recipe. */
function assertAgeSafe(cypher: string): void {
	for (const [rule, pattern] of [
		['elementId()', /elementId\(/],
		['shortestPath()', /shortestPath\(/i],
		['CALL', /\bCALL\b/i],
		['RETURN *', /RETURN \*/i],
		['a label predicate in WHERE', /WHERE \(?[A-Za-z_][A-Za-z0-9_]*:/],
		['a list comprehension', /\[[A-Za-z_][A-Za-z0-9_]* IN /],
		['an unbounded variable length', /\[\*\]|\[\*\d*\.\.\]/],
	] as const) {
		assert.doesNotMatch(cypher, pattern, `AGE rejects ${rule}: ${cypher}`);
	}
}

test('expand by type: one relationship type, quoted for the dialect, with the drawn relationships of that type left out by parameter', () => {
	const neo = recipe(expandByType(ENGINES[0], 'a', 'MAKES', 100, ['r1']));
	assert.equal(neo.cypher, 'MATCH (n) WHERE elementId(n) = $id OPTIONAL MATCH (n)-[r:`MAKES`]-(m) WHERE NOT (elementId(r) IN $drawn) RETURN n, r, m LIMIT 101');
	assert.deepEqual(neo.params, { id: 'a', drawn: ['r1'] });
	const falkor = recipe(expandByType(ENGINES[1], '5', 'MAKES', 100, ['12']));
	assert.equal(falkor.cypher, 'MATCH (n) WHERE id(n) = toInteger($id) OPTIONAL MATCH (n)-[r:`MAKES`]-(m) WHERE NOT (id(r) IN [x IN $drawn | toInteger(x)]) RETURN n, r, m LIMIT 101');
	const age = recipe(expandByType(ENGINES[2], '844424930131969', 'MAKES', 100, ['1125899906842625']));
	assert.equal(age.cypher, 'MATCH (n) WHERE id(n) = toInteger($id) OPTIONAL MATCH (n)-[r:MAKES]-(m) WHERE NOT (id(r) = toInteger($d0)) RETURN n, r, m LIMIT 101');
	assert.deepEqual(age.params, { id: '844424930131969', d0: '1125899906842625' });
	assertAgeSafe(age.cypher);
	assertAgeSafe(recipe(expandByType(ENGINES[2], '1', 'MAKES', 100, [])).cypher);
	assert.equal(recipe(expandByType(ENGINES[2], '1', 'MAKES', 100, [])).cypher, 'MATCH (n) WHERE id(n) = toInteger($id) OPTIONAL MATCH (n)-[r:MAKES]-(m) RETURN n, r, m LIMIT 101');
	// The name rules are quote.ts's: Neo4j doubles a backtick, FalkorDB refuses one, AGE takes plain names only.
	assert.match(recipe(expandByType(ENGINES[0], 'a', 'WE`IRD', 100, [])).cypher, /\[r:`WE``IRD`\]/);
	for (const [engine, type] of [[ENGINES[1], 'HAS`TICK'], [ENGINES[2], 'works at'], [ENGINES[2], 'MAKES`'], [ENGINES[0], 'bad\nname']] as const) {
		const refused = expandByType(engine, 'a', type, 100, []);
		assert.ok(isRefusal(refused), `${engine.dialect} ${type}`);
		assert.match(isRefusal(refused) ? refused.refusal : '', /relationship type .* cannot be put in a generated query on this engine/);
	}
	assert.ok(isRefusal(expandByType(ENGINES[0], '', 'MAKES', 100, [])));
	// One type per statement: `[:A|B]` is a syntax error on AGE 1.5.0, so a name holding `|` is one quoted name or refused.
	assert.match(recipe(expandByType(ENGINES[0], 'a', 'A|B', 100, [])).cypher, /\[r:`A\|B`\]/);
	assert.ok(isRefusal(expandByType(ENGINES[2], 'a', 'A|B', 100, [])));
	for (const engine of ENGINES) assert.doesNotMatch(recipe(expandByType(engine, '1', 'MAKES', 100, ['2'])).cypher, /\[r:[^\]`]*\|/);
	for (const engine of ENGINES) {
		for (const id of HOSTILE_IDS) {
			const r = recipe(expandByType(engine, id, 'MAKES', 100, [id]));
			assert.ok(!r.cypher.includes(id), `${engine.dialect}: id leaked into ${r.cypher}`);
			assert.equal(classifyStatement(r.cypher).kind, 'read', r.cypher);
		}
	}
});

// FalkorDB (probed on 4.22.2) refuses the undirected form and answers the directed one with a longer path than the
// undirected depth search finds (5 relationships where depth 3 has one), so it is never asked: Neo4j only.
test('one shortestPath call on Neo4j only: both ids bound; FalkorDB and AGE are refused and use the depth search', () => {
	const neo = recipe(shortestPathRecipe(ENGINES[0], 'a', 'b'));
	assert.equal(neo.cypher, 'MATCH (a), (b) WHERE elementId(a) = $from AND elementId(b) = $to MATCH p = shortestPath((a)-[*..10]-(b)) RETURN p LIMIT 1');
	assert.deepEqual(neo.params, { from: 'a', to: 'b' });
	assert.equal(neo.limit, 1);
	assert.equal(FALKORDB_SHORTEST_PATH, false);
	const falkor = shortestPathRecipe(ENGINES[1], '1', '2');
	assert.ok(isRefusal(falkor));
	assert.match(isRefusal(falkor) ? falkor.refusal : '', /one direction/);
	assert.ok(isRefusal(shortestPathRecipe(ENGINES[2], '1', '2')), 'Apache AGE has no shortestPath');
	assert.ok(isRefusal(shortestPathRecipe(ENGINES[0], 'a', 'a')));
	assert.ok(isRefusal(shortestPathRecipe({ dialect: 'neo4j', version: '4.4' }, 'a', 'b')));
	const hostile = recipe(shortestPathRecipe(ENGINES[0], HOSTILE_IDS[0], HOSTILE_IDS[1]));
	assert.ok(!hostile.cypher.includes(HOSTILE_IDS[0]) && !hostile.cypher.includes(HOSTILE_IDS[1]));
	assert.equal(classifyStatement(hostile.cypher).kind, 'read');
	// Used only where the node says the engine has it, and only on Neo4j.
	assert.equal(usesShortestPath({ ...ENGINES[0], shortestPath: true }), true);
	assert.equal(usesShortestPath(ENGINES[0]), false, 'not reported, not used');
	assert.equal(usesShortestPath({ ...ENGINES[0], shortestPath: false }), false);
	assert.equal(usesShortestPath({ ...ENGINES[1], shortestPath: true }), false, 'not on FalkorDB, whatever it reports');
	assert.equal(usesShortestPath({ ...ENGINES[2], shortestPath: true }), false, 'not on AGE, whatever it reports');
	assert.equal(usesShortestPath({ dialect: 'neo4j', version: '4.4', shortestPath: true }), false, 'not where elementId() is missing');
});

// The editor runs its text with no parameters, so the id is written in; a first comment line says it is a live handle,
// because the text can outlive the element (History and Saved keep it).
test('"new query from here" texts: an editable statement with the id written in under a live-handle note, read-only, AGE-safe, and none for an id that cannot be written safely', () => {
	const note = `${LIVE_HANDLE_NOTE}\n`;
	assert.match(LIVE_HANDLE_NOTE, /^\/\/ .*live handles/);
	assert.equal(neighboursQueryText(ENGINES[0], '4:c7e1:0'), `${note}MATCH (n) WHERE elementId(n) = '4:c7e1:0' OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 25`);
	assert.equal(neighboursQueryText(ENGINES[1], '0'), `${note}MATCH (n) WHERE id(n) = 0 OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 25`);
	assert.equal(neighboursQueryText(ENGINES[2], '11821949021847553'), `${note}MATCH (n) WHERE id(n) = 11821949021847553 OPTIONAL MATCH (n)-[r]-(m) RETURN n, r, m LIMIT 25`, 'a 64-bit id is written exactly');
	assert.equal(relationshipQueryText(ENGINES[0], '5:c7e1:163'), `${note}MATCH (a)-[r]->(b) WHERE elementId(r) = '5:c7e1:163' RETURN a, r, b`);
	assert.equal(relationshipQueryText(ENGINES[2], '1125899906842625'), `${note}MATCH (a)-[r]->(b) WHERE id(r) = 1125899906842625 RETURN a, r, b`);
	assert.equal(pathQueryText({ ...ENGINES[0], shortestPath: true }, '4:x:1', '4:x:2', { method: 'shortest-path' }), `${note}MATCH (a), (b) WHERE elementId(a) = '4:x:1' AND elementId(b) = '4:x:2' MATCH p = shortestPath((a)-[*..10]-(b)) RETURN p`);
	assert.equal(pathQueryText(ENGINES[2], '1', '2', { method: 'depth', depth: 3 }), `${note}MATCH p = (a)-[*3..3]-(b) WHERE id(a) = 1 AND id(b) = 2 RETURN p LIMIT 1`);
	assert.doesNotMatch(neighboursQueryText(ENGINES[2], '1') ?? '', /\$/, 'no parameter: the editor sends none');
	for (const engine of ENGINES) {
		const texts = [neighboursQueryText(engine, '12'), relationshipQueryText(engine, '13'), pathQueryText(engine, '12', '14', { method: 'depth', depth: 2 })];
		for (const text of texts) {
			assert.ok(text !== null, engine.dialect);
			assert.equal(classifyStatement(text as string).kind, 'read', text as string);
			if (engine.dialect === 'age') assertAgeSafe(text as string);
		}
		// Nothing that could close the literal or change the statement is ever written in.
		for (const id of ["x'; MATCH (n) DETACH DELETE n //", 'a\\b', 'line\nbreak', '', 'x'.repeat(513)]) {
			assert.equal(neighboursQueryText(engine, id), null, `${engine.dialect}: ${JSON.stringify(id)}`);
			assert.equal(relationshipQueryText(engine, id), null);
			assert.equal(pathQueryText(engine, id, '1', { method: 'depth', depth: 1 }), null);
		}
	}
	for (const id of ['4:c7e1:0', '12a', '-1', '1.5']) {
		assert.equal(neighboursQueryText(ENGINES[1], id), null, `FalkorDB ids are integers: ${id}`);
		assert.equal(neighboursQueryText(ENGINES[2], id), null, `AGE ids are integers: ${id}`);
	}
	assert.equal(pathQueryText(ENGINES[2], '1', '2', { method: 'shortest-path' }), null, 'no shortestPath text for AGE');
	assert.equal(pathQueryText(ENGINES[1], '1', '2', { method: 'shortest-path' }), null, 'nor for FalkorDB');
	assert.equal(neighboursQueryText({ dialect: 'neo4j', version: '4.4' }, '1'), null, 'no elementId() before Neo4j 5');
});

/** A read_query that answers the one shortestPath call with `single`, and the depth search like fakeRun. */
function singleRun(single: 'path' | 'empty' | 'error' | 'other-ends', pathDepth: number | null, calls: string[]) {
	return async (r: IRecipe): Promise<ReadQueryResult> => {
		calls.push(r.cypher);
		if (!/shortestPath/.test(r.cypher)) return fakeRun(pathDepth, [], { inFlight: 0, maxInFlight: 0 })(r);
		if (single === 'error') throw new Error('Query failed\nNeo.ClientError.Statement.SyntaxError');
		const ends = single === 'other-ends' ? ['x', 'y'] : ['from', 'to'];
		const nodes = [node(ends[0]), node('m1'), node('m2'), node(ends[1])];
		const rows: ReadQueryResult['rows'] = single === 'empty' ? [] : [[{ '@kind': 'path', nodes, relationships: [rel('s0', 'T', nodes[0].id, 'm1'), rel('s1', 'T', 'm2', 'm1'), rel('s2', 'T', 'm2', nodes[3].id)] }]];
		return { columns: ['p'], rows, row_limit: 1, truncated: false, truncated_by: null, element_limit: 10000, elements: 0, value_limit: 500000, values: 0 };
	};
}

test('with the one-call search on, a path the shortestPath call finds is the answer: one request', async () => {
	const calls: string[] = [];
	let single = 0;
	const search = createPathSearch({ engine: { ...ENGINES[0], shortestPath: true }, single: true, run: singleRun('path', 2, calls), onSingle: () => (single += 1), onDepth: () => assert.fail('no depth search') });
	const outcome = await search.start('from', 'to');
	assert.equal(outcome.status, 'found');
	if (outcome.status === 'found') {
		assert.equal(outcome.method, 'shortest-path');
		assert.equal(outcome.depth, 3, 'the depth is the path\'s length');
		assert.equal(outcome.attempts, 1);
	}
	assert.equal(calls.length, 1);
	assert.equal(single, 1);
});

test('an error or a path between other nodes from the shortestPath call falls back to the depth search', async () => {
	for (const single of ['error', 'other-ends'] as const) {
		const calls: string[] = [];
		const found = await createPathSearch({ engine: { ...ENGINES[0], shortestPath: true }, single: true, run: singleRun(single, 2, calls) }).start('from', 'to');
		assert.equal(found.status, 'found', single);
		if (found.status === 'found') {
			assert.equal(found.method, 'depth', single);
			assert.equal(found.depth, 2);
			assert.equal(found.attempts, 3, `${single}: the call, then depths 1 and 2`);
		}
		assert.match(calls[0], /shortestPath/);
		const none = await createPathSearch({ engine: { ...ENGINES[0], shortestPath: true }, single: true, run: singleRun(single, null, []) }).start('from', 'to');
		assert.deepEqual(none, { status: 'none', maxDepth: 10, attempts: 11 }, `${single}: then "no path" comes from the depth search`);
	}
});

// Neo4j's call is undirected and bounded at 10 (probed on Neo4j 2026.10.1: it finds what the depth search finds), so
// an empty answer already means "no path within 10": ten more calls would only say the same, slower.
test('an empty answer from the undirected shortestPath call is "no path within depth 10", after that one call', async () => {
	const calls: string[] = [];
	const outcome = await createPathSearch({ engine: { ...ENGINES[0], shortestPath: true }, single: true, run: singleRun('empty', 2, calls), onDepth: () => assert.fail('no depth search') }).start('from', 'to');
	assert.deepEqual(outcome, { status: 'none', maxDepth: 10, attempts: 1 });
	assert.equal(calls.length, 1);
});

test('the depth search alone finds paths as before and says so; AGE never sends shortestPath even when asked to', async () => {
	const calls: string[] = [];
	const outcome = await createPathSearch({ engine: ENGINES[2], single: true, run: singleRun('path', 1, calls) }).start('from', 'to');
	assert.equal(outcome.status, 'found');
	if (outcome.status === 'found') assert.equal(outcome.method, 'depth');
	assert.ok(calls.every((c) => !/shortestPath/.test(c)), 'AGE has no shortestPath');
	const plain = await createPathSearch({ engine: ENGINES[0], run: singleRun('path', 1, []) }).start('from', 'to');
	assert.equal(plain.status === 'found' && plain.method, 'depth', 'off unless asked for');
});

test('Stop waiting during the shortestPath call stops the search: nothing more is sent', async () => {
	const calls: string[] = [];
	const search = createPathSearch({ engine: { ...ENGINES[0], shortestPath: true }, single: true, run: (r) => { calls.push(r.cypher); return new Promise<ReadQueryResult>(() => undefined); } });
	const running = search.start('from', 'to');
	await Promise.resolve();
	search.stop();
	assert.deepEqual(await running, { status: 'stopped', depthReached: 0, attempts: 1 });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls.length, 1);
});
