// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// MARKS ON STATEMENTS THE READ WORKBENCH WOULD REFUSE
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readRefusalMarkers } from '../src/graph/writeWarnings';
import { refuseNonReads, prepareStatement } from '../src/graph/runConfig';

test('a write clause is marked where it is, in buffer offsets, with the plain sentence', () => {
	const buffer = 'MATCH (n) RETURN n;\nCREATE (x:Person)';
	const marks = readRefusalMarkers(buffer);
	assert.equal(marks.length, 1);
	assert.equal(buffer.slice(marks[0].start, marks[0].end), 'CREATE');
	assert.equal(marks[0].severity, 'warning');
	assert.equal(marks[0].message, 'This looks like a write; Run will refuse it.');
});

test('reads, empty statements and a buffer with nothing in it are not marked', () => {
	assert.deepEqual(readRefusalMarkers(''), []);
	assert.deepEqual(readRefusalMarkers('MATCH (n) RETURN n; ;\n// note only\n'), []);
	assert.deepEqual(readRefusalMarkers('CALL db.labels() YIELD label RETURN label'), []);
	assert.deepEqual(readRefusalMarkers("MATCH (n) WHERE n.note = 'CREATE me' RETURN n"), [], 'a word inside a string is not a clause');
});

test('every refused statement is marked once, each at its first finding, and the verdict is the one Run uses', () => {
	const buffer = 'MERGE (a) SET a.x = 1;\nMATCH (n) RETURN n;\nCALL apoc.periodic.iterate("a","b",{})\n';
	const marks = readRefusalMarkers(buffer);
	assert.equal(marks.length, 2);
	assert.equal(buffer.slice(marks[0].start, marks[0].end), 'MERGE');
	assert.match(marks[1].message, /procedure/);
	for (const statement of buffer.split(';').map((s) => s.trim()).filter(Boolean)) {
		const refused = refuseNonReads([prepareStatement(statement, null, null)], false) !== null;
		const marked = readRefusalMarkers(statement).length > 0;
		assert.equal(marked, refused, statement);
	}
});

test('a statement that is not closed says so rather than calling it a write', () => {
	const marks = readRefusalMarkers("MATCH (n) WHERE n.a = 'open");
	assert.equal(marks.length, 1);
	assert.match(marks[0].message, /not closed/);
});

test('a statement that does not start like a read is marked at its first word', () => {
	const marks = readRefusalMarkers('EXPLAIN MATCH (n) RETURN n');
	assert.equal(marks.length, 1);
	assert.match(marks[0].message, /does not start like a read/);
});

test('a very large buffer is not scanned: past the limit nothing is marked', () => {
	assert.deepEqual(readRefusalMarkers(`CREATE (n)${' '.repeat(400_000)}`), []);
});
