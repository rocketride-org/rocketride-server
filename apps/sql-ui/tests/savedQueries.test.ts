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
// SAVED QUERIES — the pure store: the bag, its checks and its caps
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer/errors';
import {
	MAX_SAVED_BAG_CHARS,
	MAX_SAVED_NAME_CHARS,
	MAX_SAVED_QUERIES,
	MAX_SAVED_SQL_CHARS,
	SAVED_QUERIES_PREF,
	applySavedQueryEdit,
	checkSavedQueryEdit,
	editSavedQueriesIn,
	newSavedQuery,
	readSavedQueriesBag,
	savedQueriesIn,
	suggestQueryName,
} from '../src/history/savedQueries';
import type { SavedQueriesBag, SavedQuery } from '../src/history/savedQueries';
import { memoryPrefs } from '../src/history/historyStore';

const KEY = 'p1:s1:db_1';
const OTHER = 'p2:s1:db_1';

/**
 * One connection's queries in a bag as the reader shows them.
 *
 * @param bag - A stored bag.
 * @param key - The connection.
 * @returns Its well-formed queries.
 */
const listOf = (bag: unknown, key: string): SavedQuery[] => readSavedQueriesBag(bag)[key] ?? [];

/** A saved query with a fixed id and time. */
const query = (id: string, name = `Query ${id}`, sql = `SELECT ${id}`): SavedQuery => ({ id, name, sql, at: 1_000 });

/**
 * Whether a failure is the store's refusal, worded as the user reads it.
 *
 * @param pattern - What the message says.
 * @returns The rejects/throws predicate.
 */
const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof ExplorerToolError && error.kind === 'invalid' && pattern.test(error.message);

describe('saved queries: the persisted names never change', () => {
	it('keeps one bag under `sql.savedQueries`, keyed by connection', () => {
		assert.equal(SAVED_QUERIES_PREF, 'sql.savedQueries');
		const prefs = memoryPrefs();
		editSavedQueriesIn(prefs, KEY, { action: 'add', query: query('a') });
		assert.deepEqual(prefs.getPref(SAVED_QUERIES_PREF), { [KEY]: [query('a')] });
	});
});

describe('saved queries: add, rename, remove', () => {
	it('adds newest first, per connection, and never touches another connection', () => {
		let bag: Record<string, unknown> = { [OTHER]: [query('x')] };
		bag = applySavedQueryEdit(bag, KEY, { action: 'add', query: query('a') });
		bag = applySavedQueryEdit(bag, KEY, { action: 'add', query: query('b') });
		assert.deepEqual(listOf(bag, KEY).map((q) => q.id), ['b', 'a']);
		assert.deepEqual(bag[OTHER], [query('x')]);
	});

	it('an add that repeats an id replaces that query in place (a call sent twice saves once)', () => {
		let bag = applySavedQueryEdit({}, KEY, { action: 'add', query: query('a') });
		bag = applySavedQueryEdit(bag, KEY, { action: 'add', query: query('b') });
		bag = applySavedQueryEdit(bag, KEY, { action: 'add', query: query('a', 'Renamed', 'SELECT 2') });
		assert.deepEqual(listOf(bag, KEY), [query('b'), query('a', 'Renamed', 'SELECT 2')]);
	});

	it('renames in place, trimmed; a query that is gone is refused, not created', () => {
		let bag = applySavedQueryEdit({}, KEY, { action: 'add', query: query('a') });
		bag = applySavedQueryEdit(bag, KEY, { action: 'rename', id: 'a', name: '  Revenue by customer  ' });
		assert.equal(listOf(bag, KEY)[0]!.name, 'Revenue by customer');
		assert.throws(() => applySavedQueryEdit(bag, KEY, { action: 'rename', id: 'gone', name: 'x' }), refused(/no longer exists/));
	});

	it('removes one; removing the last drops the connection; an unknown id changes nothing', () => {
		let bag = applySavedQueryEdit({}, KEY, { action: 'add', query: query('a') });
		assert.equal(applySavedQueryEdit(bag, KEY, { action: 'remove', id: 'gone' }), bag);
		bag = applySavedQueryEdit(bag, KEY, { action: 'remove', id: 'a' });
		assert.deepEqual(bag, {});
	});

	it('never changes the bag it was given', () => {
		const bag: SavedQueriesBag = { [KEY]: [query('a')] };
		const before = JSON.stringify(bag);
		applySavedQueryEdit(bag, KEY, { action: 'add', query: query('b') });
		applySavedQueryEdit(bag, KEY, { action: 'rename', id: 'a', name: 'New' });
		applySavedQueryEdit(bag, KEY, { action: 'remove', id: 'a' });
		assert.equal(JSON.stringify(bag), before);
	});
});

describe('saved queries: the caps refuse a save and keep everything already saved', () => {
	it(`keeps at most ${MAX_SAVED_QUERIES} per connection`, () => {
		let bag: Record<string, unknown> = {};
		for (let i = 0; i < MAX_SAVED_QUERIES; i += 1) bag = applySavedQueryEdit(bag, KEY, { action: 'add', query: query(`q${i}`) });
		assert.throws(() => applySavedQueryEdit(bag, KEY, { action: 'add', query: query('one-more') }), refused(new RegExp(`already keeps ${MAX_SAVED_QUERIES} saved queries\\. Delete one to save another\\.`)));
		assert.equal(listOf(bag, KEY).length, MAX_SAVED_QUERIES);
		// Another connection has its own count; replacing one by id is not a new one.
		assert.doesNotThrow(() => applySavedQueryEdit(bag, OTHER, { action: 'add', query: query('one-more') }));
		assert.doesNotThrow(() => applySavedQueryEdit(bag, KEY, { action: 'add', query: query('q3', 'Again') }));
	});

	it(`holds at most ${MAX_SAVED_SQL_CHARS} characters of statement and ${MAX_SAVED_NAME_CHARS} of name`, () => {
		assert.equal(MAX_SAVED_SQL_CHARS, 16 * 1024);
		assert.equal(MAX_SAVED_NAME_CHARS, 120);
		const long = `SELECT '${'x'.repeat(MAX_SAVED_SQL_CHARS)}'`;
		assert.throws(() => applySavedQueryEdit({}, KEY, { action: 'add', query: query('a', 'Long', long) }), refused(/holds at most 16,384 characters, and this one has/));
		assert.doesNotThrow(() => applySavedQueryEdit({}, KEY, { action: 'add', query: query('a', 'Fits', 'x'.repeat(MAX_SAVED_SQL_CHARS)) }));
		assert.throws(() => applySavedQueryEdit({}, KEY, { action: 'add', query: query('a', 'n'.repeat(MAX_SAVED_NAME_CHARS + 1)) }), refused(/a name holds at most 120 characters/));
		const bag = applySavedQueryEdit({}, KEY, { action: 'add', query: query('a') });
		assert.throws(() => applySavedQueryEdit(bag, KEY, { action: 'rename', id: 'a', name: 'n'.repeat(MAX_SAVED_NAME_CHARS + 1) }), refused(/a name holds at most 120 characters/));
	});

	it('refuses an empty name or an empty statement', () => {
		assert.throws(() => applySavedQueryEdit({}, KEY, { action: 'add', query: query('a', '   ') }), refused(/give it a name/));
		assert.throws(() => applySavedQueryEdit({}, KEY, { action: 'add', query: query('a', 'Empty', ' \n ') }), refused(/no statement to save/));
		const bag = applySavedQueryEdit({}, KEY, { action: 'add', query: query('a') });
		assert.throws(() => applySavedQueryEdit(bag, KEY, { action: 'rename', id: 'a', name: '' }), refused(/give it a name/));
	});

	it(`keeps the whole bag within ${MAX_SAVED_BAG_CHARS} characters as the file is written (indented)`, () => {
		assert.equal(MAX_SAVED_BAG_CHARS, 256 * 1024);
		const big = 'x'.repeat(15_000);
		let bag: Record<string, unknown> = {};
		let refusedAt = -1;
		for (let i = 0; i < 40; i += 1) {
			try {
				bag = applySavedQueryEdit(bag, `conn-${i}`, { action: 'add', query: query(`q${i}`, 'Big', big) });
			} catch (error) {
				assert.ok(refused(/saved queries are full \(256 KB across all connections\)\. Delete some to save more\./)(error));
				refusedAt = i;
				break;
			}
		}
		assert.ok(refusedAt > 0, 'the bag cap refused a save');
		assert.ok(JSON.stringify(bag, null, 2).length <= MAX_SAVED_BAG_CHARS, 'what is kept stays within the cap');
		assert.equal(Object.keys(bag).length, refusedAt, 'nothing already saved was dropped');
	});
});

describe('saved queries: a name is one plain line (review M3)', () => {
	it('collapses line breaks and runs of white space, and drops control characters and direction overrides (CE3)', () => {
		const bag = applySavedQueryEdit({}, KEY, { action: 'add', query: query('a', 'ok\n\u202Eevil\u0000') });
		assert.equal(listOf(bag, KEY)[0]!.name, 'ok evil');
		const renamed = applySavedQueryEdit(bag, KEY, { action: 'rename', id: 'a', name: '\tRevenue\r\n by \u2066customer\u2069\u200f ' });
		assert.equal(listOf(renamed, KEY)[0]!.name, 'Revenue by customer');
	});

	it('a name made only of such characters is no name', () => {
		assert.throws(() => applySavedQueryEdit({}, KEY, { action: 'add', query: query('a', '\u202E\u0007\n') }), refused(/give it a name/));
	});
});

describe('saved queries: a write keeps what this build cannot read (review M4)', () => {
	it('entries it cannot parse, and fields it does not know, survive an add, a rename and a delete', () => {
		const newer = { ...query('n'), tags: ['finance'] };
		const damaged = { id: 'd', name: 'No time', sql: 'SELECT 9' };
		const stored = { [KEY]: [newer, damaged, 'junk', query('a')], [OTHER]: [{ format: 2 }] };
		let bag = applySavedQueryEdit(stored, KEY, { action: 'add', query: query('b') });
		bag = applySavedQueryEdit(bag, KEY, { action: 'rename', id: 'n', name: 'Renamed' });
		bag = applySavedQueryEdit(bag, KEY, { action: 'remove', id: 'a' });
		assert.deepEqual(bag[KEY], [query('b'), { ...newer, name: 'Renamed' }, damaged, 'junk']);
		assert.deepEqual(bag[OTHER], [{ format: 2 }], 'another connection\'s list is untouched');
		assert.deepEqual(listOf(bag, KEY).map((q) => q.id), ['b', 'n'], 'the reader shows what it can');
	});

	it('the count cap counts the queries a user can see', () => {
		const stored = { [KEY]: [...Array.from({ length: MAX_SAVED_QUERIES - 1 }, (_, i) => query(`q${i}`)), { id: 'hidden' }] };
		assert.doesNotThrow(() => applySavedQueryEdit(stored, KEY, { action: 'add', query: query('last') }));
	});

	it('through an accessor too: the stored value keeps them', () => {
		const prefs = memoryPrefs();
		prefs.setPref(SAVED_QUERIES_PREF, { [KEY]: [{ id: 'x', future: true }] });
		editSavedQueriesIn(prefs, KEY, { action: 'add', query: query('a') });
		assert.deepEqual(prefs.getPref(SAVED_QUERIES_PREF), { [KEY]: [query('a'), { id: 'x', future: true }] });
	});
});

describe('saved queries: what may cross from a frame', () => {
	it('accepts the three edits and rebuilds them with their own fields only', () => {
		assert.deepEqual(checkSavedQueryEdit({ action: 'add', query: { ...query('a'), extra: 'dropped' } }), { action: 'add', query: query('a') });
		assert.deepEqual(checkSavedQueryEdit({ action: 'rename', id: 'a', name: 'B' }), { action: 'rename', id: 'a', name: 'B' });
		assert.deepEqual(checkSavedQueryEdit({ action: 'remove', id: 'a' }), { action: 'remove', id: 'a' });
	});

	it('refuses anything else', () => {
		for (const bad of [null, 'add', {}, { action: 'clear' }, { action: 'remove' }, { action: 'remove', id: '' }, { action: 'rename', id: 'a' }, { action: 'add' }, { action: 'add', query: { id: 'a', name: 'n', sql: 's' } }, { action: 'add', query: { id: '', name: 'n', sql: 's', at: 1 } }, { action: 'add', query: { id: 'a', name: 1, sql: 's', at: 1 } }, { action: 'add', query: { id: 'a', name: 'n', sql: 's', at: Number.NaN } }]) {
			assert.throws(() => checkSavedQueryEdit(bad), refused(/not one this app makes/), JSON.stringify(bad));
		}
	});
});

describe('saved queries: reading what is stored', () => {
	it('keeps well-formed queries and drops anything else, without throwing', () => {
		const stored = { [KEY]: [query('a'), { id: 'b' }, null, 7, query('c')], [OTHER]: 'not a list', empty: [] };
		assert.deepEqual(readSavedQueriesBag(stored), { [KEY]: [query('a'), query('c')] });
		for (const junk of [undefined, null, 'x', [query('a')], 3]) assert.deepEqual(readSavedQueriesBag(junk), {});
	});

	it('reads one connection through an accessor, empty for an unknown one', () => {
		const prefs = memoryPrefs();
		assert.deepEqual(savedQueriesIn(prefs, KEY), []);
		editSavedQueriesIn(prefs, KEY, { action: 'add', query: query('a') });
		assert.deepEqual(savedQueriesIn(prefs, KEY), [query('a')]);
		assert.deepEqual(savedQueriesIn(prefs, OTHER), []);
	});

	it('a refused edit writes nothing', () => {
		const prefs = memoryPrefs();
		editSavedQueriesIn(prefs, KEY, { action: 'add', query: query('a') });
		const before = prefs.getPref(SAVED_QUERIES_PREF);
		assert.throws(() => editSavedQueriesIn(prefs, KEY, { action: 'rename', id: 'gone', name: 'x' }));
		assert.equal(prefs.getPref(SAVED_QUERIES_PREF), before);
	});
});

describe('saved queries: a new query and its suggested name', () => {
	it('makes a query with a fresh id and the time given', () => {
		const a = newSavedQuery('Name', 'SELECT 1', 42);
		const b = newSavedQuery('Name', 'SELECT 1', 42);
		assert.equal(a.at, 42);
		assert.notEqual(a.id, b.id);
		assert.deepEqual({ ...a, id: '' }, { id: '', name: 'Name', sql: 'SELECT 1', at: 42 });
	});

	it('suggests the leading comment, else the first line, else "Untitled query"', () => {
		assert.equal(suggestQueryName('-- Revenue by customer\nSELECT 1'), 'Revenue by customer');
		assert.equal(suggestQueryName('\n  SELECT name FROM customers\n  WHERE id = 1'), 'SELECT name FROM customers');
		assert.equal(suggestQueryName('--\nSELECT 1'), 'SELECT 1');
		assert.equal(suggestQueryName('   '), 'Untitled query');
		assert.equal(suggestQueryName(`SELECT ${'x'.repeat(200)}`).length, 60);
	});
});
