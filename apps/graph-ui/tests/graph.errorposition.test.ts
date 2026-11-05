// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// WHERE A FAILED STATEMENT WENT WRONG
// =============================================================================

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { failurePosition, locateFailure } from '../src/graph/errorPosition';
import { splitStatements } from '../src/cypher/split';

/** One live error fixture. */
const live = (name: string): Record<string, string> => JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures', 'v1', 'live', `${name}.json`), 'utf8')) as Record<string, string>;

const neo4j = live('neo4j_errors');
const age = live('age_errors');
const falkor = live('falkordb_errors');

test('Neo4j: the live db_error text gives line 1, column 10', () => {
	assert.deepEqual(failurePosition(neo4j.db_error, 'neo4j'), { line: 1, column: 10 });
});

test('AGE: a syntax error gives the first position, with its 0-based column made 1-based', () => {
	assert.deepEqual(failurePosition(age.invalid_cypher, 'age'), { line: 1, column: 1 });
	assert.deepEqual(failurePosition('Invalid Cypher for Apache AGE\nCypher syntax error: line 3:7 mismatched input', 'age'), { line: 3, column: 8 });
});

/** The text FalkorDB 4.22.2 returned live for `MATCH (n RETURN n` (gxr live tester, err-fal). */
const FALKOR_LIVE = "Query failed\nerrMsg: Invalid input 'R': expected a label, '{', a parameter or ')' line: 1, column: 10, offset: 9 errCtx: MATCH (n RETURN n) errCtxOffset: 9";

test('FalkorDB 4.22.2: the live error text gives line 1, column 10, and the marker underlines RETURN', () => {
	assert.deepEqual(failurePosition(FALKOR_LIVE, 'falkordb'), { line: 1, column: 10 });
	assert.deepEqual(failurePosition(FALKOR_LIVE, null), { line: 1, column: 10 });
	assert.equal(failurePosition(FALKOR_LIVE, 'neo4j'), null);
	assert.equal(failurePosition(FALKOR_LIVE, 'age'), null);
	const buffer = 'MATCH (n RETURN n';
	const [statement] = splitStatements(buffer);
	const at = locateFailure(buffer, statement, FALKOR_LIVE, 'falkordb');
	assert.ok(at);
	assert.equal(buffer.slice(at.start, at.end), 'RETURN');
});

test('a position-looking phrase in FalkorDB\'s echo of the query is not read', () => {
	assert.equal(failurePosition("Query failed\nerrMsg: Invalid input errCtx: RETURN 'line: 1, column: 5, offset: 4' errCtxOffset: 9", 'falkordb'), null);
});

test('FalkorDB and every text without a position give null', () => {
	for (const text of Object.values(falkor)) assert.equal(failurePosition(text, 'falkordb'), null);
	assert.equal(failurePosition(neo4j.refused_write, 'neo4j'), null);
	assert.equal(failurePosition(age.refused_write, 'age'), null);
	assert.equal(failurePosition(age.hint_date, 'age'), null);
	assert.equal(failurePosition(neo4j.timeout, 'neo4j'), null);
	assert.equal(failurePosition('', 'neo4j'), null);
});

test('an engine does not read the other engine\'s form', () => {
	assert.equal(failurePosition(neo4j.db_error, 'age'), null);
	assert.equal(failurePosition(age.invalid_cypher, 'neo4j'), null);
	assert.equal(failurePosition(neo4j.db_error, 'falkordb'), null);
});

test('with the engine unknown, either form is read', () => {
	assert.deepEqual(failurePosition(neo4j.db_error, null), { line: 1, column: 10 });
	assert.deepEqual(failurePosition(age.invalid_cypher, null), { line: 1, column: 1 });
});

test('a line or column of zero or an absurd size is not a position', () => {
	assert.equal(failurePosition('x (line 0, column 3 (offset: 1))', 'neo4j'), null);
	assert.equal(failurePosition('x (line 1, column 0 (offset: 1))', 'neo4j'), null);
	assert.equal(failurePosition('x (line 99999999999, column 3 (offset: 1))', 'neo4j'), null);
});

// -----------------------------------------------------------------------------
// Mapping into the editor buffer
// -----------------------------------------------------------------------------

test('a failure in a one-statement buffer underlines the offending word', () => {
	const buffer = 'MATCH (n RETURN n';
	const [statement] = splitStatements(buffer);
	const at = locateFailure(buffer, statement, neo4j.db_error, 'neo4j');
	assert.ok(at);
	assert.equal(buffer.slice(at.start, at.end), 'RETURN');
	assert.deepEqual([at.line, at.column], [1, 10]);
});

test('a failure in statement 3 of a batch lands inside statement 3, in buffer lines and columns', () => {
	const buffer = 'MATCH (n) RETURN n;\nMATCH (a) RETURN a;\nMATCH (n) RETURNN labels(n)[0] AS label;\nRETURN 1;';
	const statements = splitStatements(buffer);
	assert.equal(statements.length, 4);
	const text = 'Query failed\nInvalid input \'RETURNN\' (line 1, column 11 (offset: 10))';
	const at = locateFailure(buffer, statements[2], text, 'neo4j');
	assert.ok(at);
	assert.equal(buffer.slice(at.start, at.end), 'RETURNN');
	assert.ok(at.start >= statements[2].start && at.end <= statements[2].end, 'inside statement 3');
	assert.deepEqual([at.line, at.column], [3, 11]);
});

test('a position on a later line of a multi-line statement maps through the statement\'s own lines', () => {
	const buffer = 'RETURN 1;\n\nMATCH (n)\nWHERE n.x = = 1\nRETURN n';
	const statements = splitStatements(buffer);
	const text = 'Query failed\nInvalid input (line 2, column 13 (offset: 22))';
	const at = locateFailure(buffer, statements[1], text, 'neo4j');
	assert.ok(at);
	assert.equal(at.line, 4);
	assert.equal(buffer.slice(at.start, at.start + 1), '=');
	assert.equal(at.column, 13);
});

test('a statement that starts mid-line reports the column in the buffer', () => {
	const buffer = 'RETURN 1; MATCHX (n) RETURN n';
	const statements = splitStatements(buffer);
	const at = locateFailure(buffer, statements[1], 'Invalid Cypher for Apache AGE\nCypher syntax error: line 1:0 extraneous input', 'age');
	assert.ok(at);
	assert.equal(buffer.slice(at.start, at.end), 'MATCHX');
	assert.deepEqual([at.line, at.column], [1, 11]);
});

test('a position past the end of the statement is clamped inside it, and no position is null', () => {
	const buffer = 'MATCH (n';
	const [statement] = splitStatements(buffer);
	const at = locateFailure(buffer, statement, 'x (line 1, column 40 (offset: 39))', 'neo4j');
	assert.ok(at);
	assert.ok(at.start >= statement.start && at.start <= statement.end);
	assert.ok(at.end > at.start || at.start === buffer.length);
	assert.equal(locateFailure(buffer, statement, 'nothing here', 'neo4j'), null);
	assert.equal(locateFailure(buffer, statement, neo4j.db_error, 'falkordb'), null);
});
