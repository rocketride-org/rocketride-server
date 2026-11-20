// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CYPHER IDENTIFIER QUOTING
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_IDENTIFIER_LENGTH, isQuotable, quoteIdentifier } from '../src/cypher/quote';
import { tokenize } from '../src/cypher/lexer';

test('Neo4j and FalkorDB wrap every name in backticks; Neo4j doubles a literal backtick', () => {
	for (const dialect of ['neo4j', 'falkordb'] as const) {
		assert.equal(quoteIdentifier('Person', dialect), '`Person`');
		assert.equal(quoteIdentifier('has space', dialect), '`has space`');
		assert.equal(quoteIdentifier('Café 日本語 😀', dialect), '`Café 日本語 😀`');
		assert.equal(quoteIdentifier("x'; MATCH (n) DETACH DELETE n //", dialect), "`x'; MATCH (n) DETACH DELETE n //`");
	}
	assert.equal(quoteIdentifier('a`b', 'neo4j'), '`a``b`');
	assert.equal(quoteIdentifier('``', 'neo4j'), '````````'.slice(0, 6));
});

// FalkorDB's parser rejects a doubled backtick inside a quoted name (live: `MATCH (n:\`a\`\`b\`)` fails with
// "Invalid input '`b`': expected ')'"; FalkorDB issue #154), and the FalkorDB node lists such labels without sampling
// them for that reason. Doubling it would make clicking the label fail with a parse error, so no quoted form is made.
test('FalkorDB refuses a name holding a backtick, as the node says the server cannot quote one', () => {
	for (const name of ['a`b', '``', '`', 'x`;`y', '`) DETACH DELETE n //']) assert.equal(quoteIdentifier(name, 'falkordb'), null, name);
});

test('a quoted name always lexes back to exactly one backtick token', () => {
	for (const name of ['Person', 'a`b', '``', 'x`;`y', 'MATCH (n) RETURN n', '/* no */', "it's", '\\']) {
		const quoted = quoteIdentifier(name, 'neo4j');
		assert.ok(quoted);
		const tokens = tokenize(`MATCH (n:${quoted}) RETURN n`).filter((t) => t.kind === 'backtick');
		assert.equal(tokens.length, 1, name);
		assert.equal(tokens[0].text, quoted);
		assert.ok(!tokens[0].unterminated, name);
	}
});

test('Apache AGE only accepts plain identifiers and refuses the rest rather than guess', () => {
	assert.equal(quoteIdentifier('Person', 'age'), 'Person');
	assert.equal(quoteIdentifier('_x1', 'age'), '_x1');
	for (const odd of ['has space', 'a`b', 'Café', '1abc', 'a-b']) assert.equal(quoteIdentifier(odd, 'age'), null, odd);
});

test('every dialect refuses names that cannot be quoted', () => {
	const bad = ['', 'a\nb', 'a\u0000b', 'a\u0007b', 'a\u007fb', 'x'.repeat(MAX_IDENTIFIER_LENGTH + 1), 'lone\ud800surrogate', '\udc00'];
	for (const dialect of ['age', 'neo4j', 'falkordb'] as const) {
		for (const name of bad) assert.equal(quoteIdentifier(name, dialect), null, `${dialect}: ${JSON.stringify(name)}`);
	}
	assert.equal(isQuotable('x'.repeat(MAX_IDENTIFIER_LENGTH)), true);
	assert.equal(isQuotable(undefined as unknown as string), false);
	assert.equal(isQuotable(42 as unknown as string), false);
	assert.equal(isQuotable('😀'), true, 'a well-formed surrogate pair is fine');
});
