// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

// =============================================================================
// SQL SPLIT — unit tests for the multi-statement scanner
// =============================================================================
//
// The contract under test: a `;` separates statements ONLY in code. Every
// dialect difference the scanner claims (MySQL `#` comments, PostgreSQL nested
// block comments and dollar-quoted bodies, ClickHouse having neither) is
// asserted here rather than assumed, because the node executes exactly one
// statement per call and a wrong split sends the wrong SQL to a database.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlDialect } from '../src/connect';
import { hasTopLevelKeyword, keywordSites, splitStatements, splitStatementsIn, statementAtOffset, stripSqlComments } from '../src/sql/split';

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Split and return just the statement texts.
 *
 * @param sql - The buffer.
 * @param dialect - The engine dialect (default 'unknown').
 * @returns The statement texts in order.
 */
function texts(sql: string, dialect: SqlDialect = 'unknown'): string[] {
	return splitStatements(sql, dialect).map((s) => s.sql);
}

// =============================================================================
// TABLE-DRIVEN SPLIT CASES
// =============================================================================

/** One splitter case: buffer in, statement texts out. */
interface ISplitCase {
	/** What the case pins down. */
	name: string;
	/** The buffer to split. */
	sql: string;
	/** Dialect to scan with. */
	dialect: SqlDialect;
	/** Expected statement texts. */
	expect: string[];
}

const CASES: ISplitCase[] = [
	{ name: 'empty buffer', sql: '', dialect: 'unknown', expect: [] },
	{ name: 'whitespace only', sql: '   \n\t ', dialect: 'unknown', expect: [] },
	{ name: 'semicolons only', sql: ';;;', dialect: 'unknown', expect: [] },
	{ name: 'comment only', sql: '-- just a note', dialect: 'unknown', expect: [] },
	{ name: 'block comment only', sql: '/* nothing here */', dialect: 'unknown', expect: [] },
	{ name: 'single statement, no terminator', sql: 'SELECT 1', dialect: 'unknown', expect: ['SELECT 1'] },
	{ name: 'single statement, terminated', sql: 'SELECT 1;', dialect: 'unknown', expect: ['SELECT 1'] },
	{ name: 'trailing whitespace after terminator', sql: 'SELECT 1;\n\n', dialect: 'unknown', expect: ['SELECT 1'] },
	{ name: 'two statements', sql: 'SELECT 1; SELECT 2', dialect: 'unknown', expect: ['SELECT 1', 'SELECT 2'] },
	{
		name: 'three statements across lines',
		sql: 'SELECT 1;\nUPDATE t SET a = 1;\nDELETE FROM t',
		dialect: 'unknown',
		expect: ['SELECT 1', 'UPDATE t SET a = 1', 'DELETE FROM t'],
	},
	{
		name: 'semicolon inside a single-quoted literal',
		sql: "SELECT 'a;b'; SELECT 2",
		dialect: 'unknown',
		expect: ["SELECT 'a;b'", 'SELECT 2'],
	},
	{
		name: 'doubled single quote escapes the delimiter',
		sql: "SELECT 'it''s; fine'; SELECT 2",
		dialect: 'unknown',
		expect: ["SELECT 'it''s; fine'", 'SELECT 2'],
	},
	{
		name: 'semicolon inside a double-quoted identifier',
		sql: 'SELECT "od;d" FROM t; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT "od;d" FROM t', 'SELECT 2'],
	},
	{
		name: 'doubled double quote inside a quoted identifier',
		sql: 'SELECT "we""ird;" FROM t; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT "we""ird;" FROM t', 'SELECT 2'],
	},
	{
		name: 'semicolon inside a backtick identifier',
		sql: 'SELECT `we;ird` FROM t; SELECT 2',
		dialect: 'mysql',
		expect: ['SELECT `we;ird` FROM t', 'SELECT 2'],
	},
	{
		name: 'doubled backtick inside a backtick identifier',
		sql: 'SELECT `a``b;c` FROM t; SELECT 2',
		dialect: 'mysql',
		expect: ['SELECT `a``b;c` FROM t', 'SELECT 2'],
	},
	{
		name: 'semicolon inside a line comment',
		sql: 'SELECT 1 -- ; not a split\n; SELECT 2',
		dialect: 'unknown',
		expect: ['SELECT 1 -- ; not a split', 'SELECT 2'],
	},
	{
		name: 'semicolon inside a block comment',
		sql: 'SELECT 1 /* ; not a split */; SELECT 2',
		dialect: 'unknown',
		expect: ['SELECT 1 /* ; not a split */', 'SELECT 2'],
	},
	{
		name: 'multi-line block comment between statements attaches to the next one',
		sql: 'SELECT 1;\n/* a\n b; c */\nSELECT 2',
		dialect: 'unknown',
		expect: ['SELECT 1', '/* a\n b; c */\nSELECT 2'],
	},
	{
		name: 'mysql # line comment hides a semicolon',
		sql: 'SELECT 1 # ; not a split\n; SELECT 2',
		dialect: 'mysql',
		expect: ['SELECT 1 # ; not a split', 'SELECT 2'],
	},
	{
		// MySQL requires whitespace after `--`; without it the dashes are
		// arithmetic and the semicolon still separates two statements.
		name: 'mysql needs whitespace after -- before it is a comment',
		sql: 'SELECT 1--2; SELECT 3',
		dialect: 'mysql',
		expect: ['SELECT 1--2', 'SELECT 3'],
	},
	{
		name: 'mysql honours -- when whitespace follows',
		sql: 'SELECT 1-- ; not a split\n; SELECT 2',
		dialect: 'mysql',
		expect: ['SELECT 1-- ; not a split', 'SELECT 2'],
	},
	{
		name: 'mysql -- at the very end of the buffer stays a comment',
		sql: 'SELECT 1--',
		dialect: 'mysql',
		expect: ['SELECT 1--'],
	},
	{
		// The same text on Postgres IS a comment, which is the whole point of
		// making the precondition dialect-specific.
		name: 'postgres takes a bare -- and hides the semicolon',
		sql: 'SELECT 1--2; SELECT 3',
		dialect: 'postgres',
		expect: ['SELECT 1--2; SELECT 3'],
	},
	{
		name: 'clickhouse has NO # comment — the semicolon splits',
		sql: 'SELECT 1 # ; x\n; SELECT 2',
		dialect: 'clickhouse',
		expect: ['SELECT 1 #', 'x', 'SELECT 2'],
	},
	{
		name: 'clickhouse honours -- comments',
		sql: 'SELECT 1 -- ; x\n; SELECT 2',
		dialect: 'clickhouse',
		expect: ['SELECT 1 -- ; x', 'SELECT 2'],
	},
	{
		name: 'clickhouse honours block comments',
		sql: 'SELECT 1 /* ; x */; SELECT 2',
		dialect: 'clickhouse',
		expect: ['SELECT 1 /* ; x */', 'SELECT 2'],
	},
	{
		name: 'postgres nested block comment',
		sql: 'SELECT 1 /* outer /* inner ; */ still ; comment */; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT 1 /* outer /* inner ; */ still ; comment */', 'SELECT 2'],
	},
	{
		name: 'mysql does NOT nest block comments — the inner close ends it',
		sql: 'SELECT 1 /* outer /* inner */ ; SELECT 2',
		dialect: 'mysql',
		expect: ['SELECT 1 /* outer /* inner */', 'SELECT 2'],
	},
	{
		name: 'postgres dollar-quoted body keeps its semicolons',
		sql: "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 2",
		dialect: 'postgres',
		expect: ['CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql', 'SELECT 2'],
	},
	{
		name: 'postgres tagged dollar quote',
		sql: 'SELECT $body$ a; b $body$; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT $body$ a; b $body$', 'SELECT 2'],
	},
	{
		// `$` is a legal identifier character in PostgreSQL, so `foo$tag$` is
		// one identifier — reading it as a dollar quote would swallow the `;`.
		name: 'postgres dollar quote must not continue an identifier',
		sql: 'SELECT foo$tag$; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT foo$tag$', 'SELECT 2'],
	},
	{
		name: 'postgres dollar quote still opens after a separator',
		sql: 'SELECT ($tag$ a; b $tag$); SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT ($tag$ a; b $tag$)', 'SELECT 2'],
	},
	{
		name: 'postgres positional parameter is not a dollar quote',
		sql: 'SELECT * FROM t WHERE a = $1; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT * FROM t WHERE a = $1', 'SELECT 2'],
	},
	{
		name: 'dollar quoting is postgres-only — mysql splits inside it',
		sql: 'SELECT $$ a; b $$; SELECT 2',
		dialect: 'mysql',
		expect: ['SELECT $$ a', 'b $$', 'SELECT 2'],
	},
	{
		// PostgreSQL: a dollar-quote tag "follows the same rules as an
		// unquoted identifier", and an identifier may begin with "letters
		// with diacritical marks and non-Latin letters".
		name: 'postgres dollar-quote tag with a diacritic',
		sql: 'DO $caf\u00e9$ BEGIN PERFORM 1; END $caf\u00e9$; SELECT 2',
		dialect: 'postgres',
		expect: ['DO $caf\u00e9$ BEGIN PERFORM 1; END $caf\u00e9$', 'SELECT 2'],
	},
	{
		name: 'postgres dollar-quote tag in a non-Latin script',
		sql: 'DO $\u0442\u0435\u0433$ BEGIN PERFORM 1; END $\u0442\u0435\u0433$; SELECT 2',
		dialect: 'postgres',
		expect: ['DO $\u0442\u0435\u0433$ BEGIN PERFORM 1; END $\u0442\u0435\u0433$', 'SELECT 2'],
	},
	{
		name: 'postgres dollar-quote tag in CJK',
		sql: 'DO $\u6807\u7b7e$ SELECT 1; SELECT 2 $\u6807\u7b7e$; SELECT 3',
		dialect: 'postgres',
		expect: ['DO $\u6807\u7b7e$ SELECT 1; SELECT 2 $\u6807\u7b7e$', 'SELECT 3'],
	},
	{
		// Outside the BMP: scanned as a surrogate pair, which the tag class
		// accepts without the `u` flag.
		name: 'postgres dollar-quote tag outside the BMP',
		sql: 'DO $\u{1d6fc}$ SELECT 1; SELECT 2 $\u{1d6fc}$; SELECT 3',
		dialect: 'postgres',
		expect: ['DO $\u{1d6fc}$ SELECT 1; SELECT 2 $\u{1d6fc}$', 'SELECT 3'],
	},
	{
		name: 'postgres dollar-quote tag may start with an underscore',
		sql: 'SELECT $_x1$ a; b $_x1$; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT $_x1$ a; b $_x1$', 'SELECT 2'],
	},
	{
		// An identifier cannot start with a digit, so this is the positional
		// parameter `$1` followed by ordinary text — nothing is quoted.
		name: 'postgres digit-first tag is not a dollar quote',
		sql: 'SELECT $1abc$ a; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT $1abc$ a', 'SELECT 2'],
	},
	{
		// The identifier `café` continues across the `$`, exactly as `foo$tag$`
		// does above; reading it as a quote would swallow the separator.
		name: 'postgres dollar quote must not continue a non-ASCII identifier',
		sql: 'SELECT caf\u00e9$tag$; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT caf\u00e9$tag$', 'SELECT 2'],
	},
	{
		// "Tags are case sensitive, so $tag$String content$tag$ is correct,
		// but $TAG$String content$tag$ is not."
		name: 'postgres dollar-quote tags are case sensitive',
		sql: 'SELECT $Tag$ a; b $tag$ x $Tag$; SELECT 2',
		dialect: 'postgres',
		expect: ['SELECT $Tag$ a; b $tag$ x $Tag$', 'SELECT 2'],
	},
	{
		// `Straße` is one identifier, so its trailing `e` is not the `E'...'`
		// escape prefix: the backslash does not escape the closing quote and
		// the `;` after it still separates. The identifier class decides this,
		// which is why it has to match the one the tag rule uses.
		name: 'postgres E-prefix does not trigger after a non-ASCII identifier',
		sql: "SELECT Stra\u00dfe'a\\'; SELECT 2",
		dialect: 'postgres',
		expect: ["SELECT Stra\u00dfe'a\\'", 'SELECT 2'],
	},
	{
		name: 'mysql backslash escapes a quote inside a literal',
		sql: "SELECT 'a\\'; b'; SELECT 2",
		dialect: 'mysql',
		expect: ["SELECT 'a\\'; b'", 'SELECT 2'],
	},
	{
		name: 'clickhouse backslash escapes a quote inside a literal',
		sql: "SELECT 'a\\'; b'; SELECT 2",
		dialect: 'clickhouse',
		expect: ["SELECT 'a\\'; b'", 'SELECT 2'],
	},
	{
		name: 'postgres plain literal does NOT take a backslash escape',
		sql: "SELECT 'a\\', ';'; SELECT 2",
		dialect: 'postgres',
		expect: ["SELECT 'a\\', ';'", 'SELECT 2'],
	},
	{
		name: 'postgres E-string DOES take a backslash escape',
		sql: "SELECT E'a\\'; b'; SELECT 2",
		dialect: 'postgres',
		expect: ["SELECT E'a\\'; b'", 'SELECT 2'],
	},
	{
		name: 'unterminated string literal consumes the tail',
		sql: "SELECT 'oops; SELECT 2",
		dialect: 'unknown',
		expect: ["SELECT 'oops; SELECT 2"],
	},
	{
		name: 'unterminated block comment consumes the tail',
		sql: 'SELECT 1 /* oops; SELECT 2',
		dialect: 'unknown',
		expect: ['SELECT 1 /* oops; SELECT 2'],
	},
	{
		name: 'blank statement between two terminators is dropped',
		sql: 'SELECT 1;;SELECT 2',
		dialect: 'unknown',
		expect: ['SELECT 1', 'SELECT 2'],
	},
	{
		name: 'trailing comment after the last terminator is dropped',
		sql: 'SELECT 1; -- done',
		dialect: 'unknown',
		expect: ['SELECT 1'],
	},
	{
		name: 'leading comment attaches to the statement that follows',
		sql: '-- why\nSELECT 1;',
		dialect: 'unknown',
		expect: ['-- why\nSELECT 1'],
	},
	{
		name: 'DELIMITER is NOT supported — the body splits (documented gap)',
		sql: 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;',
		dialect: 'mysql',
		expect: ['DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1', 'END$$\nDELIMITER'],
	},
];

describe('splitStatements', () => {
	for (const testCase of CASES) {
		it(`${testCase.dialect}: ${testCase.name}`, () => {
			assert.deepEqual(texts(testCase.sql, testCase.dialect), testCase.expect);
		});
	}

	it('reports contiguous zero-based indices', () => {
		const statements = splitStatements('SELECT 1;;SELECT 2;SELECT 3', 'unknown');
		assert.deepEqual(statements.map((s) => s.index), [0, 1, 2]);
	});

	it('offsets slice the original buffer back out', () => {
		const buffer = "  SELECT 'a;b' ;\n   UPDATE t SET x = 1  ";
		for (const statement of splitStatements(buffer, 'unknown')) {
			assert.equal(buffer.slice(statement.start, statement.end), statement.sql);
		}
	});

	it('reports one-based line ranges', () => {
		const buffer = 'SELECT 1;\n\nSELECT\n  2\n;\nSELECT 3';
		const statements = splitStatements(buffer, 'unknown');
		assert.deepEqual(statements.map((s) => [s.startLine, s.endLine]), [[1, 1], [3, 4], [6, 6]]);
	});
});

// =============================================================================
// STATEMENT AT OFFSET
// =============================================================================

describe('statementAtOffset', () => {
	const buffer = 'SELECT 1;\nUPDATE t SET a = 1;\nDELETE FROM t';

	it('returns null for a buffer with no statements', () => {
		assert.equal(statementAtOffset('   \n-- nothing', 3, 'unknown'), null);
	});

	it('finds the statement the cursor sits inside', () => {
		assert.equal(statementAtOffset(buffer, 12, 'unknown')?.sql, 'UPDATE t SET a = 1');
	});

	it('treats the caret at a statement start as inside it', () => {
		assert.equal(statementAtOffset(buffer, 10, 'unknown')?.sql, 'UPDATE t SET a = 1');
	});

	it('treats the caret at a statement end as inside it', () => {
		assert.equal(statementAtOffset(buffer, 8, 'unknown')?.sql, 'SELECT 1');
	});

	it('falls back to the preceding statement in the gap after a terminator', () => {
		assert.equal(statementAtOffset(buffer, 9, 'unknown')?.sql, 'SELECT 1');
	});

	it('falls back to the first statement before any statement text', () => {
		assert.equal(statementAtOffset('\n\nSELECT 1', 0, 'unknown')?.sql, 'SELECT 1');
	});

	it('returns the last statement for a caret past the end', () => {
		assert.equal(statementAtOffset(buffer, buffer.length, 'unknown')?.sql, 'DELETE FROM t');
	});
});

// =============================================================================
// COMMENT STRIPPING
// =============================================================================

describe('stripSqlComments', () => {
	it('blanks a line comment but keeps the code', () => {
		assert.equal(stripSqlComments('SELECT 1 -- note\nFROM t', 'unknown'), 'SELECT 1  \nFROM t');
	});

	it('leaves a separator behind so tokens do not fuse', () => {
		assert.equal(stripSqlComments('SELECT/**/1', 'unknown'), 'SELECT 1');
	});

	it('keeps comment-looking text inside a literal', () => {
		assert.equal(stripSqlComments("SELECT '-- not a comment'", 'unknown'), "SELECT '-- not a comment'");
	});

	it('strips a mysql # comment', () => {
		assert.equal(stripSqlComments('SELECT 1 # note\nFROM t', 'mysql'), 'SELECT 1  \nFROM t');
	});

	it('leaves a # alone for clickhouse', () => {
		assert.equal(stripSqlComments('SELECT 1 # note', 'clickhouse'), 'SELECT 1 # note');
	});

	it('strips a nested postgres block comment whole', () => {
		assert.equal(stripSqlComments('SELECT /* a /* b */ c */ 1', 'postgres'), 'SELECT   1');
	});
});

// =============================================================================
// TOP-LEVEL KEYWORD SEARCH
// =============================================================================

describe('hasTopLevelKeyword', () => {
	it('finds a top-level WHERE', () => {
		assert.equal(hasTopLevelKeyword('DELETE FROM t WHERE id = 1', 'where', 'unknown'), true);
	});

	it('ignores a WHERE inside a string literal', () => {
		assert.equal(hasTopLevelKeyword("UPDATE t SET note = 'where is it'", 'where', 'unknown'), false);
	});

	it('ignores a WHERE inside a comment', () => {
		assert.equal(hasTopLevelKeyword('DELETE FROM t -- WHERE id = 1', 'where', 'unknown'), false);
	});

	it('ignores a WHERE that only occurs inside parentheses', () => {
		assert.equal(hasTopLevelKeyword('DELETE FROM t USING (SELECT id FROM u WHERE x) s', 'where', 'unknown'), false);
	});

	it('finds a top-level WHERE that follows a subquery', () => {
		assert.equal(hasTopLevelKeyword('DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x)', 'where', 'unknown'), true);
	});

	it('does not match a WHERE inside a longer word', () => {
		assert.equal(hasTopLevelKeyword('UPDATE t SET wherewithal = 1', 'where', 'unknown'), false);
	});

	it('does not match a word that continues with a non-ASCII letter', () => {
		// The identifier class decides where a word ends, and it reaches past
		// ASCII; `\b` does not, and would end the word at the `\u00e9`.
		assert.equal(hasTopLevelKeyword('DELETE FROM t where\u00e9', 'where', 'unknown'), false);
		assert.equal(hasTopLevelKeyword('DELETE FROM t \u00e9where', 'where', 'unknown'), false);
		assert.equal(hasTopLevelKeyword('DELETE FROM t caf\u00e9where_x', 'where', 'unknown'), false);
	});

	it('still matches a keyword between non-identifier characters', () => {
		assert.equal(hasTopLevelKeyword('DELETE FROM t WHERE id = 1', 'where', 'unknown'), true);
		assert.equal(hasTopLevelKeyword('DELETE FROM t\nWHERE id = 1', 'where', 'unknown'), true);
		assert.equal(hasTopLevelKeyword('SELECT 1 LIMIT 5', 'limit', 'unknown'), true);
	});

	it('finds two occurrences that share one separator', () => {
		const sites = keywordSites('SELECT a WHERE WHERE', ['where'], 'unknown');
		assert.equal(sites.length, 2);
	});
});

// =============================================================================
// KEYWORD SITES
// =============================================================================
//
// Where each keyword sits, which is all the pattern check needs to tell an
// outer verb from a locking clause: the FIRST leader at depth 0 is the verb a
// WITH chain carries, and a mutation only belongs to a CTE body when it OPENS
// that body.
// =============================================================================

describe('keywordSites', () => {
	it('reports depth 0 for a leading keyword', () => {
		const sites = keywordSites('DELETE FROM t WHERE id = 1', ['delete'], 'unknown');
		assert.deepEqual(sites, [{ keyword: 'delete', index: 0, depth: 0, group: -1 }]);
	});

	it('reports the depth of a keyword inside parentheses', () => {
		const sites = keywordSites('WITH g AS (DELETE FROM t RETURNING *) SELECT 1', ['delete'], 'unknown');
		assert.deepEqual(sites.map((site) => site.depth), [1]);
	});

	it('counts depth through nesting', () => {
		const sites = keywordSites('SELECT (SELECT (SELECT 1 WHERE x))', ['where'], 'unknown');
		assert.deepEqual(sites.map((site) => site.depth), [2]);
	});

	it('returns nothing for a keyword inside a string literal', () => {
		assert.deepEqual(keywordSites("SELECT ('delete me') AS t", ['delete'], 'unknown'), []);
	});

	it('returns nothing for a keyword inside a comment', () => {
		assert.deepEqual(keywordSites('SELECT (1 /* delete */) AS t', ['delete'], 'unknown'), []);
	});

	it('returns nothing for a keyword inside a quoted identifier', () => {
		assert.deepEqual(keywordSites('SELECT ("delete") FROM t', ['delete'], 'postgres'), []);
	});

	it('does not match a keyword inside a longer word', () => {
		assert.deepEqual(keywordSites('SELECT (deleted_at) FROM t', ['delete'], 'unknown'), []);
	});

	it('orders sites by position, not by the order of the keywords', () => {
		const sites = keywordSites(
			'WITH u AS (UPDATE a SET x = 1), d AS (DELETE FROM b) SELECT 1',
			['delete', 'update', 'select'],
			'unknown',
		);
		assert.deepEqual(sites.map((site) => site.keyword), ['update', 'delete', 'select']);
	});

	it('reports -1 as the group of a keyword at depth 0', () => {
		const sites = keywordSites('DELETE FROM t', ['delete'], 'unknown');
		assert.deepEqual(sites.map((site) => site.group), [-1]);
	});

	it('groups a keyword by the parenthesis that encloses it', () => {
		const sql = 'WITH x AS (\n\tDELETE FROM t\n) SELECT 1';
		const sites = keywordSites(sql, ['delete'], 'unknown');
		assert.deepEqual(sites.map((site) => site.group), [sql.indexOf('(')]);
	});

	it('gives sibling groups different identities at the same depth', () => {
		// Depth alone would call these one body; they are two CTEs.
		const sql = 'WITH u AS (UPDATE a SET x = 1), d AS (DELETE FROM b) SELECT 1';
		const sites = keywordSites(sql, ['update', 'delete'], 'unknown');
		assert.deepEqual(sites.map((site) => site.group), [sql.indexOf('(UPDATE') , sql.indexOf('(DELETE')]);
		assert.deepEqual(sites.map((site) => site.depth), [1, 1]);
	});

	it('groups a keyword by its innermost enclosing parenthesis', () => {
		const sql = 'WITH a AS (WITH b AS (SELECT 1) DELETE FROM t) SELECT 1';
		const sites = keywordSites(sql, ['select', 'delete'], 'unknown');
		assert.deepEqual(
			sites.map((site) => [site.keyword, site.depth, site.group]),
			[['select', 2, sql.indexOf('(SELECT')], ['delete', 1, sql.indexOf('(WITH')], ['select', 0, -1]],
		);
	});

	it('reopens a group identity after a sibling group closes', () => {
		const sql = 'SELECT (1) FROM t WHERE x IN (SELECT 1)';
		const sites = keywordSites(sql, ['where'], 'unknown');
		assert.deepEqual(sites.map((site) => [site.depth, site.group]), [[0, -1]]);
	});

	it('reports every occurrence of the same keyword', () => {
		const sites = keywordSites('DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x)', ['where'], 'unknown');
		assert.deepEqual(sites.map((site) => site.depth), [0, 1]);
	});

	it('leaves the top-level search unchanged on the same statements', () => {
		// The two read one scan; neither answers the other's question.
		assert.equal(hasTopLevelKeyword('WITH g AS (DELETE FROM t RETURNING *) SELECT 1', 'delete', 'unknown'), false);
		assert.equal(hasTopLevelKeyword('WITH g AS (SELECT 1) DELETE FROM t', 'delete', 'unknown'), true);
	});
});

// =============================================================================
// SPLITTING A SELECTION
// =============================================================================

describe('splitStatementsIn', () => {
	const buffer = 'SELECT 1;\nUPDATE t SET a = 1;\nDELETE FROM t';

	it('splits a selection that holds two statements', () => {
		// Selects "UPDATE t SET a = 1;\nDELETE FROM t".
		const out = splitStatementsIn(buffer, 10, buffer.length, 'unknown');
		assert.deepEqual(out.map((s) => s.sql), ['UPDATE t SET a = 1', 'DELETE FROM t']);
	});

	it('reports offsets in the whole buffer, not the slice', () => {
		const out = splitStatementsIn(buffer, 10, buffer.length, 'unknown');
		for (const statement of out) {
			assert.equal(buffer.slice(statement.start, statement.end), statement.sql);
		}
	});

	it('reports line numbers of the whole buffer', () => {
		const out = splitStatementsIn(buffer, 10, buffer.length, 'unknown');
		assert.deepEqual(out.map((s) => [s.startLine, s.endLine]), [[2, 2], [3, 3]]);
	});

	it('yields one fragment for a partial-statement selection', () => {
		// Selects "t SET a = 1" out of the middle of statement 2.
		const out = splitStatementsIn(buffer, 17, 28, 'unknown');
		assert.deepEqual(out.map((s) => s.sql), ['t SET a = 1']);
		assert.equal(out[0].startLine, 2);
	});

	it('yields nothing for a comment-only selection', () => {
		const commented = 'SELECT 1;\n-- just a note\n';
		assert.deepEqual(splitStatementsIn(commented, 10, commented.length, 'unknown'), []);
	});

	it('yields nothing for an empty selection', () => {
		assert.deepEqual(splitStatementsIn(buffer, 5, 5, 'unknown'), []);
	});

	it('clamps a slice that runs past the buffer', () => {
		const out = splitStatementsIn(buffer, 0, buffer.length + 50, 'unknown');
		assert.equal(out.length, 3);
	});

	it('keeps a semicolon inside a literal out of the split', () => {
		const withLiteral = "SELECT 'a;b'; SELECT 2";
		const out = splitStatementsIn(withLiteral, 0, withLiteral.length, 'unknown');
		assert.deepEqual(out.map((s) => s.sql), ["SELECT 'a;b'", 'SELECT 2']);
	});

	it('exposes a trailing transaction statement the runner must refuse', () => {
		// The regression DA-1 describes: selecting "UPDATE ...; ROLLBACK;" used
		// to be sent as ONE statement, classified by its first keyword, so the
		// ROLLBACK was never seen and never refused.
		const script = 'UPDATE t SET a = 1;\nROLLBACK;';
		const out = splitStatementsIn(script, 0, script.length, 'unknown');
		assert.deepEqual(out.map((s) => s.sql), ['UPDATE t SET a = 1', 'ROLLBACK']);
	});
});
