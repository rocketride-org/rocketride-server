// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// INSPECTOR MODEL AND ASK ANSWERS
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { askQuestion, explainAskFailure, readAskAnswer } from '../src/graph/ask';
import { ID_NOTE, inspectNode, inspectRelationship } from '../src/graph/inspector';
import { collectEntities } from '../src/graph/results';
import { classifyStatement } from '../src/cypher/classify';
import { node, readQueryFixture, rel } from './support/builders';
import type { GraphNode } from '../src/graph/types';

test('the inspector shows labels, exact property values and the user\'s own key names', () => {
	const alice = [...collectEntities(readQueryFixture('neo4j', 'v1').rows).nodes.values()].find((n) => n.properties.name === 'Alice') as GraphNode;
	const model = inspectNode(alice, 'Alice');
	assert.equal(model.kind, 'node');
	assert.equal(model.title, 'Alice');
	assert.equal(model.subtitle, ':Employee:Person');
	assert.deepEqual(model.tags, ['Employee', 'Person']);
	const by = Object.fromEntries(model.fields.map((f) => [f.label, f.value]));
	assert.equal(by.name, 'Alice');
	assert.equal(by.age, '37');
	assert.equal(by.big, '9007199254740993', 'a number tag shows its exact text');
	assert.equal(model.id, alice.id);
	assert.ok(model.notes.includes(ID_NOTE));
	// A nested user map shows its keys as the user wrote them (one leading @ removed at every level), not the
	// escaped wire form; Copy JSON keeps the wire form.
	assert.equal(by.meta, '{"@kind":"node","@@kind":"already","_labels":["not","metadata"],"_type":"user value","":"empty key"}');
	assert.match(model.json, /"@@kind": "node"/, 'Copy JSON is the wire form');
	assert.deepEqual(model.fields.map((f) => f.label).slice(0, 3), ['name', 'age', 'score'], 'wire order');
});

test('nested maps in a property, at any depth and inside lists, show decoded keys; tagged values inside them keep their shape', () => {
	const model = inspectNode(node('1', ['P'], { '@@a': { '@@b': 1, list: [{ '@@c': true }], big: { '@kind': 'number', value: '9007199254740993' } } }), 'c');
	assert.deepEqual(model.fields, [{ label: '@a', value: '{"@b":1,"list":[{"@c":true}],"big":{"@kind":"number","value":"9007199254740993"}}' }]);
	const relModel = inspectRelationship(rel('r', 'T', 'a', 'b', { m: { '@@x': 'y' } }), (id) => id);
	assert.deepEqual(relModel.fields, [{ label: 'm', value: '{"@x":"y"}' }]);
	const odd = inspectNode(node('2', ['P'], { m: JSON.parse('{"__proto__":{"x":1}}') }), 'c');
	assert.equal(odd.fields[0].value, '{"__proto__":{"x":1}}', 'any key is kept as data');
});

test('property keys that start with @ are shown with exactly one @ removed', () => {
	const model = inspectNode(node('1', ['P'], { '@@kind': 'x', '@name': 'y', plain: 'z' }), 'c');
	assert.deepEqual(model.fields.map((f) => f.label), ['@kind', 'name', 'plain']);
});

test('Copy as JSON is the wire form and round-trips exactly', () => {
	const alice = [...collectEntities(readQueryFixture('age', 'v1').rows).nodes.values()][0];
	assert.deepEqual(JSON.parse(inspectNode(alice, 'x').json), alice);
	const r = rel('r1', 'KNOWS', 'a', 'b', { since: 2019 });
	assert.deepEqual(JSON.parse(inspectRelationship(r, (id) => id).json), r);
});

test('a relationship shows its stored direction, whatever way it was walked', () => {
	const r = rel('r1', 'KNOWS', 'a-id', 'b-id', { since: 2019 });
	const model = inspectRelationship(r, (id) => (id === 'a-id' ? 'Alice' : id === 'b-id' ? 'Bob' : id));
	assert.equal(model.title, ':KNOWS');
	assert.equal(model.subtitle, 'Alice → Bob (as stored)');
	assert.deepEqual(model.endpoints, { start: 'a-id', end: 'b-id' });
	assert.deepEqual(model.fields, [{ label: 'since', value: '2019' }]);
	assert.ok(model.notes.includes(ID_NOTE));
});

test('values are shown in full: long strings are not clipped, containers are exact JSON', () => {
	const long = 'x'.repeat(5000);
	const model = inspectNode(node('1', [], { long, list: [1, { '@kind': 'number', value: '9007199254740993' }], bytes: { '@kind': 'bytes', size: 70000, base64: null } }), 'c');
	assert.equal(model.fields[0].value.length, 5000);
	assert.equal(model.fields[1].value, '[1,{"@kind":"number","value":"9007199254740993"}]');
	assert.equal(model.fields[2].value, 'binary, 70,000 bytes');
	assert.equal(model.subtitle, 'no label');
});

// -----------------------------------------------------------------------------
// Ask
// -----------------------------------------------------------------------------

test('Cypher is a preview, prose is an answer, everything else is not an answer', () => {
	assert.deepEqual(readAskAnswer({ query: ' MATCH (n) RETURN n LIMIT 5 ', valid: true }), { kind: 'cypher', cypher: 'MATCH (n) RETURN n LIMIT 5' });
	assert.deepEqual(readAskAnswer({ answer: 'A graph stores nodes.', valid: false }), { kind: 'prose', text: 'A graph stores nodes.' });
	for (const bad of [null, 'x', {}, { valid: true }, { valid: true, query: '' }, { valid: false }, { valid: false, answer: '  ' }, { query: 'MATCH (n) RETURN n' }, { valid: false, error: 'boom' }]) assert.equal(readAskAnswer(bad as never), null, JSON.stringify(bad));
});

test('the text check also runs on previewed Cypher, so a write is recognised before the user runs it', () => {
	// The node already refuses to return write Cypher, but the app's own text check is a second look at what it is about to put in the editor.
	const answer = readAskAnswer({ query: 'MATCH (n) DETACH DELETE n', valid: true });
	assert.equal(answer?.kind, 'cypher');
	assert.equal(classifyStatement((answer as { cypher: string }).cypher).kind, 'write');
});

test('a failure that looks like a missing model is unavailable; a safety refusal is not', () => {
	assert.equal(explainAskFailure({ kind: 'raised', headline: 'No LLM connected to this node' }).unavailable, true);
	assert.equal(explainAskFailure({ kind: 'raised', headline: 'Tool failed', detail: 'invoke.llm is not wired' }).unavailable, true);
	assert.equal(explainAskFailure({ kind: 'raised', headline: 'The language model is not configured' }).unavailable, true);
	assert.equal(explainAskFailure({ kind: 'invalid', headline: 'Generated query contains write or admin clauses' }).unavailable, false);
	assert.equal(explainAskFailure({ kind: 'raised', headline: 'Query timed out after 30000 ms', detail: 'Database said: canceling statement' }).unavailable, false);
	assert.equal(explainAskFailure({ kind: 'invalid', headline: 'no llm' }).unavailable, false, 'only a raised error can mean the pipeline has no model');
	// What the engine raises when the pipeline has no LLM node (filter.callbacks.target.cpp), as captured live.
	assert.equal(explainAskFailure({ kind: 'raised', headline: 'InvalidParam: No control listeners registered for llm at (filter.callbacks.target.cpp:96)' }).unavailable, true);
	// ...and texts that only mention a model or a connection: the node's own empty-answer error, the SDK's lost connection.
	for (const headline of ['LLM failed to return a Cypher query.', 'Server is not connected', 'WebSocket not connected: call connect() first', 'The LLM returned an empty answer']) {
		assert.equal(explainAskFailure({ kind: 'raised', headline }).unavailable, false, headline);
	}
});

// The browse editor's timeout note is about a database query still running. Ask's wait is mostly the node's language
// model, and the session's own timeout text already says the node may still be working on it and cannot be cancelled.
test("an Ask the app stopped waiting for is a warning in the session's own words, without the browse editor's query note", async () => {
	const message = 'Stopped waiting for get_query after 120 s. The node may still be running it; there is no way to cancel it from here.';
	const outcome = await askQuestion('who?', () => Promise.reject(new ExplorerToolError({ kind: 'timeout', tool: 'get_query', message })), 'no model');
	assert.deepEqual(outcome, { kind: 'failed', headline: message, detail: '', hint: null, variant: 'warning' });
});

test("Ask never points at the write console: a raised write refusal gets the read-only hint, the node's verdict on generated Cypher none", async () => {
	const raised = new ExplorerToolError({ kind: 'raised', tool: 'get_query', message: 'Refused: read_query is read-only; this statement writes (CREATE)\nUse the write console (execute) on a node with allow_execute enabled.' });
	const fromRaised = await askQuestion('who?', () => Promise.reject(raised), 'no model');
	assert.equal(fromRaised.kind === 'failed' ? fromRaised.hint : 'not failed', 'Browsing is read-only. To change data, use a node with direct execution turned on.');
	// get_query reports its refusal of what the model wrote as {valid: false, error}: an `invalid` verdict, with no hint.
	const verdict = new ExplorerToolError({ kind: 'invalid', tool: 'get_query', message: 'Refused: read_query is read-only; this statement writes (CREATE)' });
	const fromVerdict = await askQuestion('who?', () => Promise.reject(verdict), 'no model');
	assert.equal(fromVerdict.kind === 'failed' ? fromVerdict.hint : 'not failed', null);
});
