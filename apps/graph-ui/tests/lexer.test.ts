// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// CYPHER LEXER
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codeTokens, nameOf, stripComments, tokenize } from '../src/cypher/lexer';
import type { IToken } from '../src/cypher/lexer';

/** The kinds and texts of the code tokens, for compact assertions. */
function code(src: string): Array<[string, string]> {
	return codeTokens(tokenize(src)).map((t) => [t.kind, t.text]);
}

/** Tokens must tile the input exactly: no gap, no overlap, nothing lost. */
function assertTiles(src: string, tokens: IToken[]): void {
	let at = 0;
	for (const token of tokens) {
		assert.equal(token.start, at, `gap or overlap before token at ${token.start} in ${JSON.stringify(src)}`);
		assert.equal(token.text, src.slice(token.start, token.end));
		assert.ok(token.end > token.start, 'empty token');
		at = token.end;
	}
	assert.equal(at, src.length, `tokens stop at ${at}, input is ${src.length} long`);
	assert.equal(tokens.map((t) => t.text).join(''), src);
}

test('-- is two punctuation tokens (a relationship), never a comment', () => {
	assert.deepEqual(code('(a)--(b)'), [
		['punct', '('], ['word', 'a'], ['punct', ')'], ['punct', '-'], ['punct', '-'], ['punct', '('], ['word', 'b'], ['punct', ')'],
	]);
	assert.deepEqual(code('MATCH (a)-->(b) RETURN a -- not a comment'), [
		['word', 'MATCH'], ['punct', '('], ['word', 'a'], ['punct', ')'], ['punct', '-'], ['punct', '-'], ['punct', '>'], ['punct', '('], ['word', 'b'], ['punct', ')'],
		['word', 'RETURN'], ['word', 'a'], ['punct', '-'], ['punct', '-'], ['word', 'not'], ['word', 'a'], ['word', 'comment'],
	]);
});

test('// runs to the line break and /* */ spans lines', () => {
	const tokens = tokenize('RETURN 1 // note; RETURN 2\nRETURN 3 /* a;\nb */ RETURN 4');
	assert.deepEqual(tokens.filter((t) => t.kind === 'lineComment').map((t) => t.text), ['// note; RETURN 2']);
	assert.deepEqual(tokens.filter((t) => t.kind === 'blockComment').map((t) => t.text), ['/* a;\nb */']);
	assert.equal(tokens.filter((t) => t.kind === 'semicolon').length, 0, 'semicolons inside comments are not separators');
});

test('a line comment also ends at a bare carriage return', () => {
	const tokens = tokenize('// a\rRETURN 1');
	assert.equal(tokens[0].text, '// a');
	assert.equal(tokens[1].kind, 'space');
});

test('an unterminated block comment runs to the end and is flagged', () => {
	const tokens = tokenize('RETURN 1 /* open ; RETURN 2');
	const last = tokens[tokens.length - 1];
	assert.equal(last.kind, 'blockComment');
	assert.equal(last.unterminated, true);
	assert.equal(last.text, '/* open ; RETURN 2');
});

test('a closing */ outside a comment is two punctuation tokens', () => {
	assert.deepEqual(code('a */ b'), [['word', 'a'], ['punct', '*'], ['punct', '/'], ['word', 'b']]);
});

test('strings honour backslash escapes and hide comment markers and semicolons', () => {
	assert.deepEqual(code(`RETURN 'it\\'s; // not a comment', "say \\"hi\\"; /* x */"`), [
		['word', 'RETURN'], ['string', `'it\\'s; // not a comment'`], ['punct', ','], ['string', '"say \\"hi\\"; /* x */"'],
	]);
	// A backslash before the closing quote's escape pair: '\\' ends the string.
	assert.deepEqual(code(`'a\\\\' ; 'b'`), [['string', `'a\\\\'`], ['semicolon', ';'], ['string', `'b'`]]);
});

test('an unterminated string runs to the end of the input and is flagged', () => {
	const tokens = tokenize(`RETURN 'oops; RETURN 2`);
	const last = tokens[tokens.length - 1];
	assert.equal(last.kind, 'string');
	assert.equal(last.unterminated, true);
	assert.equal(tokens.filter((t) => t.kind === 'semicolon').length, 0);
});

test('backtick names double the backtick to escape it and hide everything inside', () => {
	assert.deepEqual(code('MATCH (n:`a``b;c // d`) RETURN n'), [
		['word', 'MATCH'], ['punct', '('], ['word', 'n'], ['punct', ':'], ['backtick', '`a``b;c // d`'], ['punct', ')'], ['word', 'RETURN'], ['word', 'n'],
	]);
	const open = tokenize('MATCH (n:`never closed');
	assert.equal(open[open.length - 1].kind, 'backtick');
	assert.equal(open[open.length - 1].unterminated, true);
});

test('nameOf removes the quotes and un-doubles backticks', () => {
	const [word, quoted, odd, open] = [tokenize('db')[0], tokenize('`db`')[0], tokenize('`a``b`')[0], tokenize('`open')[0]];
	assert.equal(nameOf(word), 'db');
	assert.equal(nameOf(quoted), 'db');
	assert.equal(nameOf(odd), 'a`b');
	assert.equal(nameOf(open), 'open');
});

test('only a semicolon outside strings, comments and backticks is a semicolon token', () => {
	const tokens = tokenize(`RETURN ';' ; RETURN "a;b" ; // ;\n RETURN \`;\`;/* ; */`);
	assert.equal(tokens.filter((t) => t.kind === 'semicolon').length, 3);
});

test('numbers: a range keeps its two dots, decimals, exponents and hex stay whole', () => {
	assert.deepEqual(code('[*1..3]'), [['punct', '['], ['punct', '*'], ['number', '1'], ['punct', '..'], ['number', '3'], ['punct', ']']]);
	assert.deepEqual(code('1.5e-3 + 0xFF + 12'), [['number', '1.5e-3'], ['punct', '+'], ['number', '0xFF'], ['punct', '+'], ['number', '12']]);
	assert.deepEqual(code('a.b'), [['word', 'a'], ['punct', '.'], ['word', 'b']]);
});

test('parameters: named, numbered, quoted, and a lone dollar sign', () => {
	assert.deepEqual(code('$id $0 $`odd name` $ x'), [['param', '$id'], ['param', '$0'], ['param', '$`odd name`'], ['punct', '$'], ['word', 'x']]);
});

test('Unicode identifiers are words; characters outside the BMP stay whole', () => {
	assert.deepEqual(code('MATCH (ñandú:Café) RETURN 日本語'), [
		['word', 'MATCH'], ['punct', '('], ['word', 'ñandú'], ['punct', ':'], ['word', 'Café'], ['punct', ')'], ['word', 'RETURN'], ['word', '日本語'],
	]);
	const emoji = tokenize('😀');
	assert.equal(emoji.length, 1);
	assert.equal(emoji[0].kind, 'punct');
	assert.equal(emoji[0].text.length, 2);
	// A word may start with a supplementary-plane letter.
	assert.equal(tokenize('𝒜b')[0].kind, 'word');
});

test('stripComments removes comments and nothing else', () => {
	assert.equal(stripComments(`RETURN '// keep' /* drop */ // drop too\n, 1`), "RETURN '// keep'    \n, 1");
	assert.ok(!stripComments('a /* b */ c').includes('b'));
	assert.equal(stripComments(`'/* in string */'`), `'/* in string */'`);
});

test('the tokens tile every input exactly (fixed corpus)', () => {
	const corpus = [
		'', ' ', ';', '`', "'", '"', '/*', '//', '$', '\\', "'\\", '`a``', '/* a */ /* b', 'MATCH (a)--(b) RETURN a;;\n\n', '𝒜😀\ud800x\udc00', 'a\r\nb\rc\nd e', '1..2..3', '.5', '0x', '1e', '1e+', '$`',
		"RETURN 'a\\'b' // c\n/* d */ `e``f` $g 1.5 ; MATCH (n)-[:R*1..3]->(m)",
	];
	for (const src of corpus) assertTiles(src, tokenize(src));
});

test('the tokens tile randomly generated inputs exactly (seeded fuzz)', () => {
	// mulberry32: a tiny deterministic PRNG so a failure is reproducible.
	let state = 0x9e3779b9;
	const rand = (): number => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const alphabet = ["'", '"', '`', '/', '*', ';', '\\', '-', '$', '.', ' ', '\n', '\r', 'a', 'Z', '_', '1', '9', '(', ')', '{', ':', 'ñ', '日', '😀', '\ud800', '\udc00', 'e', 'x', '0'];
	for (let round = 0; round < 600; round++) {
		const length = Math.floor(rand() * 40);
		let src = '';
		for (let i = 0; i < length; i++) src += alphabet[Math.floor(rand() * alphabet.length)];
		assertTiles(src, tokenize(src));
	}
});
