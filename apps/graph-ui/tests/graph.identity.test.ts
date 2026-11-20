// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// ELEMENT IDENTITY AND DATA VERSIONS
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExplorerToolError } from 'shared/explorer';
import { countWrite, createDataVersions, isAbandonedWrite } from '../src/graph/dataVersion';
import { conflictText, identityConflicts } from '../src/graph/identity';
import { modelFromResult } from '../src/graph/model';
import { entitiesOf, node, rel } from './support/builders';

const model = modelFromResult(entitiesOf([node('1', ['Person', 'Employee']), node('2', [])], [rel('r', 'KNOWS', '1', '2')]));

test('the same labels in any order, and any properties, are the same node; other labels are not', () => {
	assert.deepEqual(identityConflicts(model, [node('1', ['Employee', 'Person'], { name: 'changed' })], []), []);
	assert.deepEqual(identityConflicts(model, [node('2', [], { x: 1 })], []), []);
	const conflicts = identityConflicts(model, [node('1', ['Person']), node('2', ['Thing']), node('3', ['Anything'])], []);
	assert.deepEqual(conflicts.map((c) => [c.id, c.kind, c.drawn, c.returned]), [['1', 'node', 'labels Person, Employee', 'label Person'], ['2', 'node', 'no label', 'label Thing']]);
	assert.deepEqual(identityConflicts(model, [node('9', ['New'])], []), [], 'an id the canvas does not hold is just a new element');
});

test('a relationship is the same only with the same type, start and end', () => {
	assert.deepEqual(identityConflicts(model, [], [rel('r', 'KNOWS', '1', '2', { since: 1 })]), []);
	for (const other of [rel('r', 'LIKES', '1', '2'), rel('r', 'KNOWS', '2', '1'), rel('r', 'KNOWS', '1', '3')]) {
		const [conflict] = identityConflicts(model, [], [other]);
		assert.equal(conflict.kind, 'relationship');
		assert.equal(conflict.drawn, 'type KNOWS from 1 to 2');
	}
});

test('node and relationship ids are separate namespaces: a node id equal to a relationship id conflicts with nothing', () => {
	assert.deepEqual(identityConflicts(model, [node('r', ['Whatever'])], []), []);
	assert.deepEqual(identityConflicts(model, [], [rel('1', 'T', 'a', 'b')]), []);
});

test('the sentence names the first conflict, the count, and what to do', () => {
	const [one] = identityConflicts(model, [node('1', ['Other'])], []);
	assert.match(conflictText([one]), /a different element under an id drawn here \(the node 1 was labels Person, Employee, and is now label Other\)\. Ids can be reused after a delete, so nothing from this answer was added, and the drawn copy is marked out of date\. Dismiss it, or run the query again\./);
	assert.match(conflictText([one, one]), /2 different elements under ids/);
});

test('data versions count per connection and tell subscribers', () => {
	const versions = createDataVersions();
	let heard = 0;
	const stop = versions.subscribe(() => { heard += 1; });
	assert.equal(versions.get('a'), 0);
	versions.bump('a');
	versions.bump('a');
	versions.bump('b');
	assert.deepEqual([versions.get('a'), versions.get('b'), versions.get('c')], [2, 1, 0]);
	assert.equal(heard, 3);
	stop();
	versions.bump('a');
	assert.equal(heard, 3);
});

// A write is counted where it is sent, not in the console's `record`, which the shared runner skips once the console
// is closed, and a failed statement is not assumed rolled back: the node can fail AFTER the database ran the statement
// (the answer could not be built or was rejected), and a write can land after its document closed.
const toolError = (kind: ConstructorParameters<typeof ExplorerToolError>[0]['kind'], message: string): ExplorerToolError => new ExplorerToolError({ kind, tool: 'execute', message });

test('a write is counted where it is sent, whatever happens to its document: a success, and any failure that can come after the database ran it', async () => {
	const versions = createDataVersions();
	assert.equal(await countWrite(versions, 'k', async () => 'answer'), 'answer');
	assert.equal(versions.get('k'), 1, 'a success counts');
	const after = [
		toolError('raised', 'Refused: the first row holds more than 10,000 graph elements'),
		toolError('raised', 'Query result cannot be represented\nunsupported value'),
		toolError('malformed', 'execute returned a malformed result: rows is not an array'),
		toolError('timeout', 'Stopped waiting for execute after 40 s. The node may still be running it; there is no way to cancel it from here.'),
		toolError('stale', 'The result of execute was dropped: a newer request replaced it.'),
		new Error('connection reset'),
	];
	for (const error of after) await assert.rejects(countWrite(versions, 'k', async () => { throw error; }), (thrown) => thrown === error, 'the failure still reaches the runner');
	assert.equal(versions.get('k'), 1 + after.length, 'each may have been applied');
});

test('a write refused before anything was sent changes nothing and is not counted', async () => {
	const versions = createDataVersions();
	const before = [
		toolError('upgrade', 'This node cannot run execute: it does not advertise "execute_shape_graph". Update the pipeline\'s node to a version that supports it.'),
		toolError('unavailable', "No running task for pipeline 'Graph pipeline'. Start the pipeline and retry."),
		toolError('raised', 'execute tool is disabled for this node (set allow_execute=true)'),
	];
	for (const error of before) await assert.rejects(countWrite(versions, 'k', async () => { throw error; }));
	assert.equal(versions.get('k'), 0);
});

test('at record time only a write the user stopped waiting for counts (it may still complete); the call itself counts the rest, and the read path never does', () => {
	assert.equal(isAbandonedWrite('write', 'abandoned'), true);
	for (const outcome of ['rows', 'affected', 'error', 'skipped']) assert.equal(isAbandonedWrite('write', outcome), false, `${outcome} is counted by countWrite, or was never sent`);
	for (const outcome of ['rows', 'abandoned', 'error']) assert.equal(isAbandonedWrite('read', outcome), false, 'the read path cannot write');
});
