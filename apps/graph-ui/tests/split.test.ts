// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CYPHER STATEMENT SPLITTING
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitStatements, splitStatementsIn, statementAtOffset } from '../src/cypher/split';

const texts = (src: string): string[] => splitStatements(src).map((s) => s.text);

test('statements split on semicolons that are code', () => {
	assert.deepEqual(texts('MATCH (n) RETURN n; MATCH (m) RETURN m;'), ['MATCH (n) RETURN n', 'MATCH (m) RETURN m']);
	assert.deepEqual(texts('RETURN 1'), ['RETURN 1']);
	assert.deepEqual(texts(''), []);
});

test('a semicolon inside a string, comment or backtick name does not split', () => {
	assert.deepEqual(texts(`RETURN 'a;b'; RETURN "c;d"`), [`RETURN 'a;b'`, `RETURN "c;d"`]);
	assert.deepEqual(texts('RETURN 1 // x; y\n; RETURN 2'), ['RETURN 1 // x; y', 'RETURN 2']);
	assert.deepEqual(texts('RETURN 1 /* x; y */; RETURN 2'), ['RETURN 1 /* x; y */', 'RETURN 2']);
	assert.deepEqual(texts('MATCH (n:`a;b`) RETURN n; RETURN 2'), ['MATCH (n:`a;b`) RETURN n', 'RETURN 2']);
	assert.deepEqual(texts(`RETURN 'it\\'s; still one'; RETURN 2`), [`RETURN 'it\\'s; still one'`, 'RETURN 2']);
});

test('-- is a relationship: a statement with it stays whole and its neighbours split normally', () => {
	assert.deepEqual(texts('MATCH (a)--(b) RETURN a, b; RETURN 1'), ['MATCH (a)--(b) RETURN a, b', 'RETURN 1']);
	assert.deepEqual(texts('MATCH (a)--(b) RETURN a, b --; RETURN 1'), ['MATCH (a)--(b) RETURN a, b --', 'RETURN 1']);
});

test('whitespace- and comment-only stretches produce no statement', () => {
	assert.deepEqual(texts(';;  ;\n// only a comment\n;/* and another */;'), []);
	assert.deepEqual(texts('RETURN 1;\n// trailing note\n'), ['RETURN 1']);
	assert.deepEqual(texts('// lead\nRETURN 1;'), ['// lead\nRETURN 1']);
});

test('an unterminated string swallows the rest of the buffer into one statement', () => {
	assert.deepEqual(texts(`RETURN 'open; RETURN 2`), [`RETURN 'open; RETURN 2`]);
});

test('offsets, trimmed text and one-based lines point at the buffer', () => {
	const buffer = 'MATCH (n)\nRETURN n;\n\n  MATCH (m)\n  RETURN m  ;';
	const [a, b] = splitStatements(buffer);
	assert.equal(a.index, 0);
	assert.equal(b.index, 1);
	assert.equal(buffer.slice(a.start, a.end), a.text);
	assert.equal(buffer.slice(b.start, b.end), b.text);
	assert.deepEqual([a.startLine, a.endLine, b.startLine, b.endLine], [1, 2, 4, 5]);
	assert.equal(b.text, 'MATCH (m)\n  RETURN m');
});

test('CRLF and bare CR line breaks count as lines', () => {
	const [a, b] = splitStatements('RETURN 1;\r\nRETURN 2;\rRETURN 3');
	assert.equal(a.startLine, 1);
	assert.equal(b.startLine, 2);
	assert.equal(splitStatements('RETURN 1;\r\nRETURN 2;\rRETURN 3')[2].startLine, 3);
});

test('splitting a slice reports offsets and lines in the whole buffer and handles a fragment', () => {
	const buffer = 'RETURN 0;\nMATCH (n) RETURN n; RETURN 2; RETURN 3';
	const from = buffer.indexOf('MATCH');
	const to = buffer.indexOf(' RETURN 3');
	const statements = splitStatementsIn(buffer, from, to);
	assert.deepEqual(statements.map((s) => s.text), ['MATCH (n) RETURN n', 'RETURN 2']);
	for (const s of statements) assert.equal(buffer.slice(s.start, s.end), s.text);
	assert.equal(statements[0].startLine, 2);
	// A selection that holds only part of a statement is one fragment.
	assert.deepEqual(splitStatementsIn('MATCH (n) RETURN n', 6, 12).map((s) => s.text), ['(n) RE']);
	// Out-of-range slices clamp instead of throwing.
	assert.deepEqual(splitStatementsIn('RETURN 1', -5, 99).map((s) => s.text), ['RETURN 1']);
});

test('statementAtOffset: inside, between (the preceding one) and before the first', () => {
	const buffer = 'RETURN 1;  RETURN 2;  ';
	assert.equal(statementAtOffset(buffer, 3)?.text, 'RETURN 1');
	assert.equal(statementAtOffset(buffer, 9)?.text, 'RETURN 1', 'the caret just after the semicolon stays on the preceding statement');
	assert.equal(statementAtOffset(buffer, 14)?.text, 'RETURN 2');
	assert.equal(statementAtOffset(buffer, buffer.length)?.text, 'RETURN 2');
	assert.equal(statementAtOffset('  RETURN 1', 0)?.text, 'RETURN 1');
	assert.equal(statementAtOffset('  // nothing\n', 3), null);
});
