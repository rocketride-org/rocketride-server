// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// USER DATA - the pure store: saved queries and label styles, their checks and
// their caps (saved queries ported from sql-ui's tests/savedQueries.test.ts)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer';
import { memoryPrefs } from '../src/env';
import {
	MAX_SAVED_BAG_CHARS,
	MAX_SAVED_CYPHER_CHARS,
	MAX_SAVED_NAME_CHARS,
	MAX_SAVED_QUERIES,
	MAX_STYLES_BAG_CHARS,
	SAVED_QUERIES_PREF,
	STYLES_PREF,
	SAVED_QUERIES_PATH,
	STYLES_PATH,
	applySavedEdit,
	applyStyleChange,
	moveLegacyCaptions,
	assignmentFor,
	checkSavedEdit,
	checkStyleEdit,
	editSavedIn,
	editStyleIn,
	readConnectionStyle,
	readSavedQueriesBag,
	savedQueriesIn,
	styleIn,
} from '../src/graph/userDataStore';
import type { ISavedQuery } from '../src/graph/userData';
import { EMPTY_STYLE } from '../src/graph/userData';
import { TYPE_COLOR_SLOTS } from '../src/graph/colors';

const KEY = 'k1|neo';
const OTHER = 'k2|falkor';

/** A saved query with a fixed id and time. */
const query = (id: string, name = `Query ${id}`, cypher = `MATCH (n) RETURN n LIMIT ${id.length}`): ISavedQuery => ({ id, name, cypher, savedAt: 1_000 });

/** The id and time a save is given. */
const made = (id: string) => ({ id, at: 1_000 });

/** A save of {@link query}. */
const save = (bag: Record<string, unknown>, key: string, q: ISavedQuery): Record<string, unknown> => applySavedEdit(bag, key, { action: 'save', name: q.name, cypher: q.cypher }, made(q.id));

/** One connection's queries as the reader shows them. */
const listOf = (bag: unknown, key: string): ISavedQuery[] => readSavedQueriesBag(bag)[key] ?? [];

/**
 * Whether a failure is the store's refusal, worded as the user reads it.
 *
 * @param pattern - What the message says.
 * @returns The throws predicate.
 */
const refused = (pattern: RegExp) => (error: unknown): boolean => error instanceof ExplorerToolError && error.kind === 'invalid' && pattern.test(error.message);

describe('user data: the persisted names never change', () => {
	it('keeps saved queries under graph.savedQueries and styles under graph.styles, keyed by connection; the dev tool\'s two files sit beside the history file', () => {
		assert.equal(SAVED_QUERIES_PREF, 'graph.savedQueries');
		assert.equal(STYLES_PREF, 'graph.styles');
		assert.equal(SAVED_QUERIES_PATH, '@/User/.workspace/rocketride.graph.saved.json');
		assert.equal(STYLES_PATH, '@/User/.workspace/rocketride.graph.styles.json');
		const prefs = memoryPrefs();
		editSavedIn(prefs, KEY, { action: 'save', name: 'Who works where', cypher: 'MATCH (p)-[:WORKS_AT]->(c) RETURN p, c' }, made('a'));
		assert.deepEqual(prefs.getPref(SAVED_QUERIES_PREF), { [KEY]: [{ id: 'a', name: 'Who works where', cypher: 'MATCH (p)-[:WORKS_AT]->(c) RETURN p, c', savedAt: 1_000 }] });
		editStyleIn(prefs, KEY, { kind: 'label', label: 'Person', patch: { slot: 4 } });
		assert.deepEqual(prefs.getPref(STYLES_PREF), { [KEY]: { assigned: {}, labels: { Person: { slot: 4 } }, types: {} } });
	});
});

describe('saved queries: save, rename, delete', () => {
	it('saves newest first, per connection, and never touches another connection', () => {
		let bag: Record<string, unknown> = { [OTHER]: [query('x')] };
		bag = save(bag, KEY, query('a'));
		bag = save(bag, KEY, query('b'));
		assert.deepEqual(listOf(bag, KEY).map((q) => q.id), ['b', 'a']);
		assert.deepEqual(bag[OTHER], [query('x')]);
	});

	it('applySavedEdit: a save with an id already listed replaces that query in place', () => {
		let bag = save({}, KEY, query('a'));
		bag = save(bag, KEY, query('b'));
		bag = save(bag, KEY, query('a', 'Renamed', 'RETURN 2'));
		assert.deepEqual(listOf(bag, KEY), [query('b'), query('a', 'Renamed', 'RETURN 2')]);
	});

	it('renames in place, trimmed; a query that is gone is refused, not created', () => {
		let bag = save({}, KEY, query('a'));
		bag = applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: '  Who works where  ' }, made('unused'));
		assert.equal(listOf(bag, KEY)[0]!.name, 'Who works where');
		assert.throws(() => applySavedEdit(bag, KEY, { action: 'rename', id: 'gone', name: 'x' }, made('unused')), refused(/no longer exists/));
	});

	it('deletes one; deleting the last drops the connection; an unknown id changes nothing', () => {
		let bag = save({}, KEY, query('a'));
		assert.equal(applySavedEdit(bag, KEY, { action: 'delete', id: 'gone' }, made('unused')), bag);
		bag = applySavedEdit(bag, KEY, { action: 'delete', id: 'a' }, made('unused'));
		assert.deepEqual(bag, {});
	});

	it('never changes the bag it was given', () => {
		const bag = { [KEY]: [query('a')] };
		const before = JSON.stringify(bag);
		save(bag, KEY, query('b'));
		applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: 'New' }, made('unused'));
		applySavedEdit(bag, KEY, { action: 'delete', id: 'a' }, made('unused'));
		assert.equal(JSON.stringify(bag), before);
	});
});

describe('saved queries: the caps refuse a save and keep everything already saved', () => {
	it(`keeps at most ${MAX_SAVED_QUERIES} per connection`, () => {
		let bag: Record<string, unknown> = {};
		for (let i = 0; i < MAX_SAVED_QUERIES; i += 1) bag = save(bag, KEY, query(`q${i}`));
		assert.throws(() => save(bag, KEY, query('one-more')), refused(new RegExp(`already keeps ${MAX_SAVED_QUERIES} saved queries\\. Delete one to save another\\.`)));
		assert.equal(listOf(bag, KEY).length, MAX_SAVED_QUERIES);
		assert.doesNotThrow(() => save(bag, OTHER, query('one-more')), 'another connection has its own count');
		assert.doesNotThrow(() => save(bag, KEY, query('q3', 'Again')), 'replacing one by id is not a new one');
	});

	it(`holds at most ${MAX_SAVED_CYPHER_CHARS} characters of statement and ${MAX_SAVED_NAME_CHARS} of name`, () => {
		assert.equal(MAX_SAVED_CYPHER_CHARS, 16 * 1024);
		assert.equal(MAX_SAVED_NAME_CHARS, 120);
		const long = `RETURN '${'x'.repeat(MAX_SAVED_CYPHER_CHARS)}'`;
		assert.throws(() => save({}, KEY, query('a', 'Long', long)), refused(/holds at most 16,384 characters, and this one has/));
		assert.doesNotThrow(() => save({}, KEY, query('a', 'Fits', 'x'.repeat(MAX_SAVED_CYPHER_CHARS))));
		assert.throws(() => save({}, KEY, query('a', 'n'.repeat(MAX_SAVED_NAME_CHARS + 1))), refused(/a name holds at most 120 characters/));
		const bag = save({}, KEY, query('a'));
		assert.throws(() => applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: 'n'.repeat(MAX_SAVED_NAME_CHARS + 1) }, made('unused')), refused(/a name holds at most 120 characters/));
	});

	it('refuses an empty name or an empty statement', () => {
		assert.throws(() => save({}, KEY, query('a', '   ')), refused(/give it a name/));
		assert.throws(() => save({}, KEY, query('a', 'Empty', ' \n ')), refused(/no statement to save/));
		const bag = save({}, KEY, query('a'));
		assert.throws(() => applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: '' }, made('unused')), refused(/give it a name/));
	});

	it(`keeps the whole bag within ${MAX_SAVED_BAG_CHARS} characters as the file is written (indented)`, () => {
		assert.equal(MAX_SAVED_BAG_CHARS, 256 * 1024);
		const big = 'x'.repeat(15_000);
		let bag: Record<string, unknown> = {};
		let refusedAt = -1;
		for (let i = 0; i < 40; i += 1) {
			try {
				bag = save(bag, `conn-${i}`, query(`q${i}`, 'Big', big));
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

describe('saved queries: a name is one plain line', () => {
	it('collapses line breaks and runs of white space, and drops control characters and direction overrides', () => {
		const bag = save({}, KEY, query('a', 'ok\n‮evil\u0000'));
		assert.equal(listOf(bag, KEY)[0]!.name, 'ok evil');
		const renamed = applySavedEdit(bag, KEY, { action: 'rename', id: 'a', name: '\tWho\r\n works ⁦where⁩‏ ' }, made('unused'));
		assert.equal(listOf(renamed, KEY)[0]!.name, 'Who works where');
	});

	it('a name made only of such characters is no name', () => {
		assert.throws(() => save({}, KEY, query('a', '‮\u0007\n')), refused(/give it a name/));
	});
});

describe('saved queries: a write keeps what this build cannot read', () => {
	it('entries it cannot parse, and fields it does not know, survive a save, a rename and a delete', () => {
		const newer = { ...query('n'), tags: ['finance'] };
		const damaged = { id: 'd', name: 'No time', cypher: 'RETURN 9' };
		const stored = { [KEY]: [newer, damaged, 'junk', query('a')], [OTHER]: [{ format: 2 }] };
		let bag = save(stored, KEY, query('b'));
		bag = applySavedEdit(bag, KEY, { action: 'rename', id: 'n', name: 'Renamed' }, made('unused'));
		bag = applySavedEdit(bag, KEY, { action: 'delete', id: 'a' }, made('unused'));
		assert.deepEqual(bag[KEY], [query('b'), { ...newer, name: 'Renamed' }, damaged, 'junk']);
		assert.deepEqual(bag[OTHER], [{ format: 2 }], 'another connection\'s list is untouched');
		assert.deepEqual(listOf(bag, KEY).map((q) => q.id), ['b', 'n'], 'the reader shows what it can');
	});

	it('the count cap counts the queries a user can see', () => {
		const stored = { [KEY]: [...Array.from({ length: MAX_SAVED_QUERIES - 1 }, (_, i) => query(`q${i}`)), { id: 'hidden' }] };
		assert.doesNotThrow(() => save(stored, KEY, query('last')));
	});

	it('through an accessor too: the stored value keeps them', () => {
		const prefs = memoryPrefs();
		prefs.setPref(SAVED_QUERIES_PREF, { [KEY]: [{ id: 'x', future: true }] });
		editSavedIn(prefs, KEY, { action: 'save', name: 'Query a', cypher: query('a').cypher }, made('a'));
		assert.deepEqual(prefs.getPref(SAVED_QUERIES_PREF), { [KEY]: [query('a'), { id: 'x', future: true }] });
	});
});

describe('saved queries: reading what is stored', () => {
	it('keeps well-formed queries and drops anything else, without throwing', () => {
		const stored = { [KEY]: [query('a'), { id: 'b' }, null, 7, query('c')], [OTHER]: 'not a list', empty: [] };
		assert.deepEqual(readSavedQueriesBag(stored), { [KEY]: [query('a'), query('c')] });
		for (const junk of [undefined, null, 'x', [query('a')], 3]) assert.deepEqual(readSavedQueriesBag(junk), {});
	});

	it('reads one connection through an accessor, empty for an unknown one; a refused edit writes nothing', () => {
		const prefs = memoryPrefs();
		assert.deepEqual(savedQueriesIn(prefs, KEY), []);
		editSavedIn(prefs, KEY, { action: 'save', name: 'Query a', cypher: query('a').cypher }, made('a'));
		assert.deepEqual(savedQueriesIn(prefs, KEY), [query('a')]);
		assert.deepEqual(savedQueriesIn(prefs, OTHER), []);
		const before = prefs.getPref(SAVED_QUERIES_PREF);
		assert.throws(() => editSavedIn(prefs, KEY, { action: 'rename', id: 'gone', name: 'x' }, made('unused')));
		assert.equal(prefs.getPref(SAVED_QUERIES_PREF), before);
	});
});

describe('styles: what is stored, read back clean', () => {
	it('keeps valid slots, sizes and badges, and drops anything else without throwing', () => {
		const raw = { assigned: { Person: 0, Company: 7, Odd: 1.5, Bad: '2', Topic: 5 }, labels: { Person: { slot: 3, size: 'L', badge: 'dot', caption: 'name', glow: true }, Junk: 'x', Empty: { slot: 9, caption: '' } }, types: { KNOWS: { slot: 2 }, BAD: { slot: -1 } }, future: 1 };
		assert.deepEqual(readConnectionStyle(raw), { assigned: { Person: 0, Topic: 5 }, labels: { Person: { slot: 3, size: 'L', badge: 'dot', caption: 'name' } }, types: { KNOWS: { slot: 2 } } });
		for (const junk of [undefined, null, 'x', [], 3]) assert.deepEqual(readConnectionStyle(junk), EMPTY_STYLE);
	});

	it('a connection nobody styled reads as the empty style, the same object each time', () => {
		const prefs = memoryPrefs();
		assert.equal(styleIn(prefs, KEY), EMPTY_STYLE);
	});
});

describe('styles: field-level edits, and the colour slots', () => {
	it('a label or type edit merges field by field, a clear removes fields; reset clears the choices and keeps the slots', () => {
		let bag: Record<string, unknown> = { [OTHER]: { labels: { X: { slot: 1 } } } };
		bag = applyStyleChange(bag, KEY, { kind: 'assign', add: { Person: 0, Company: 1 }, release: [] });
		bag = applyStyleChange(bag, KEY, { kind: 'label', label: 'Person', patch: { slot: 4 } });
		bag = applyStyleChange(bag, KEY, { kind: 'label', label: 'Person', patch: { size: 'S' } });
		bag = applyStyleChange(bag, KEY, { kind: 'type', type: 'KNOWS', patch: { slot: 2 } });
		assert.deepEqual(readConnectionStyle(bag[KEY]), { assigned: { Person: 0, Company: 1 }, labels: { Person: { slot: 4, size: 'S' } }, types: { KNOWS: { slot: 2 } } }, 'two quick edits: both kept');
		bag = applyStyleChange(bag, KEY, { kind: 'label', label: 'Person', clear: ['slot'] });
		assert.deepEqual(readConnectionStyle(bag[KEY]).labels, { Person: { size: 'S' } });
		bag = applyStyleChange(bag, KEY, { kind: 'label', label: 'Person', clear: ['size'] });
		assert.deepEqual(readConnectionStyle(bag[KEY]).labels, {}, 'nothing left: the label is back to its defaults');
		bag = applyStyleChange(bag, KEY, { kind: 'reset' });
		assert.deepEqual(readConnectionStyle(bag[KEY]), { assigned: { Person: 0, Company: 1 }, labels: {}, types: {} });
		assert.deepEqual(bag[OTHER], { labels: { X: { slot: 1 } } }, 'another connection is untouched');
	});

	it('an assignment only adds, and releases only what it names: a slot already given is never moved', () => {
		let bag = applyStyleChange({}, KEY, { kind: 'assign', add: { Person: 0 }, release: [] });
		bag = applyStyleChange(bag, KEY, { kind: 'assign', add: { Person: 3, Aardvark: 1 }, release: [] });
		assert.deepEqual(readConnectionStyle(bag[KEY]).assigned, { Person: 0, Aardvark: 1 });
		assert.equal(applyStyleChange(bag, KEY, { kind: 'assign', add: {}, release: [] }), bag, 'nothing new: the same bag');
		bag = applyStyleChange(bag, KEY, { kind: 'assign', add: { Zebra: 1 }, release: ['Aardvark'] });
		assert.deepEqual(readConnectionStyle(bag[KEY]).assigned, { Person: 0, Zebra: 1 });
	});

	it('a write keeps what this build cannot read: fields it does not know, here and in another connection', () => {
		const stored = { [KEY]: { assigned: { Person: 0 }, labels: { Person: { slot: 2, ring: 'gold' } }, future: { a: 1 } }, [OTHER]: 'v2-format' };
		let bag = applyStyleChange(stored, KEY, { kind: 'label', label: 'Company', patch: { badge: 'none' } });
		bag = applyStyleChange(bag, KEY, { kind: 'label', label: 'Person', patch: { size: 'M' } });
		assert.deepEqual(bag[KEY], { assigned: { Person: 0 }, labels: { Person: { slot: 2, ring: 'gold', size: 'M' }, Company: { badge: 'none' } }, types: {}, future: { a: 1 } });
		assert.equal(bag[OTHER], 'v2-format');
	});

	it(`refuses a person's edit past ${MAX_STYLES_BAG_CHARS} characters; an assignment past it is skipped, never an error`, () => {
		assert.equal(MAX_STYLES_BAG_CHARS, 64 * 1024);
		const long = 'L'.repeat(1_000);
		let bag: Record<string, unknown> = {};
		let refusedAt = -1;
		for (let i = 0; i < 200; i += 1) {
			try {
				bag = applyStyleChange(bag, KEY, { kind: 'label', label: `${long}${i}`, patch: { slot: 1 } });
			} catch (error) {
				assert.ok(refused(/styles are full \(64 KB across all connections\)\. Resetting a connection's styles frees what its own choices take\./)(error));
				refusedAt = i;
				break;
			}
		}
		assert.ok(refusedAt > 0, 'the cap refused an edit');
		assert.equal(applyStyleChange(bag, OTHER, { kind: 'assign', add: { [`${long}x`]: 0 }, release: [] }), bag, 'an assignment that does not fit is skipped');
		assert.doesNotThrow(() => applyStyleChange(bag, KEY, { kind: 'reset' }), 'a reset always fits');
	});
});

describe('colour slots for a connection\'s schema (assignmentFor)', () => {
	const six = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };

	it('new labels take the lowest free slots; nothing changes when every label has one', () => {
		assert.deepEqual(assignmentFor({}, ['Person', 'Company'], true), { add: { Company: 0, Person: 1 }, release: [] });
		assert.deepEqual(assignmentFor({ Company: 0, Person: 1 }, ['Person', 'Company'], true), { add: {}, release: [] });
	});

	it('a slot is released only when a new label needs one and a complete read no longer lists its label', () => {
		assert.deepEqual(assignmentFor(six, ['A', 'B', 'C', 'D', 'E', 'G'], true), { add: { G: 5 }, release: ['F'] }, 'F is gone and G needs a slot');
		assert.deepEqual(assignmentFor(six, ['A', 'B', 'C', 'D', 'E', 'G'], false), { add: {}, release: [] }, 'a read that may be partial releases nothing (G is hashed)');
		assert.deepEqual(assignmentFor(six, ['A', 'B', 'C'], true), { add: {}, release: [] }, 'nobody needs a slot: none is released');
		assert.deepEqual(assignmentFor({ ...six, X: 6 }, ['A'], true), { add: {}, release: [] });
	});

	it('the labels that keep their slot never move when others are released', () => {
		const { add, release } = assignmentFor(six, ['A', 'C', 'E', 'G', 'H'], true);
		assert.deepEqual([...release].sort(), ['B', 'D', 'F']);
		assert.deepEqual(add, { G: 1, H: 3 });
	});
});

describe('user data: what may cross from a frame', () => {
	it('accepts the edits this app makes and rebuilds them with their own fields only', () => {
		assert.deepEqual(checkSavedEdit({ action: 'save', name: 'N', cypher: 'RETURN 1', extra: 1 }), { action: 'save', name: 'N', cypher: 'RETURN 1' });
		assert.deepEqual(checkSavedEdit({ action: 'rename', id: 'a', name: 'B' }), { action: 'rename', id: 'a', name: 'B' });
		assert.deepEqual(checkSavedEdit({ action: 'delete', id: 'a' }), { action: 'delete', id: 'a' });
		assert.deepEqual(checkStyleEdit({ kind: 'label', label: 'Person', patch: { slot: 2, size: 'M', badge: 'initials', caption: 'name' }, extra: 1 }), { kind: 'label', label: 'Person', patch: { slot: 2, size: 'M', badge: 'initials', caption: 'name' }, clear: [] });
		assert.deepEqual(checkStyleEdit({ kind: 'label', label: 'Person', clear: ['slot', 'caption'] }), { kind: 'label', label: 'Person', patch: {}, clear: ['slot', 'caption'] });
		assert.deepEqual(checkStyleEdit({ kind: 'type', type: 'KNOWS', patch: { slot: 0 } }), { kind: 'type', type: 'KNOWS', patch: { slot: 0 }, clear: [] });
		assert.deepEqual(checkStyleEdit({ kind: 'reset' }), { kind: 'reset' });
	});

	it('refuses anything else, an assignment included (only the owning realm assigns)', () => {
		for (const bad of [null, 'save', {}, { action: 'clear' }, { action: 'delete' }, { action: 'delete', id: '' }, { action: 'rename', id: 'a' }, { action: 'save', name: 'n' }, { action: 'save', name: 1, cypher: 'x' }]) {
			assert.throws(() => checkSavedEdit(bad), refused(/not one this app makes/), JSON.stringify(bad));
		}
		for (const bad of [null, {}, { kind: 'assign', add: { A: 0 }, release: [] }, { kind: 'label', patch: {} }, { kind: 'label', label: 'P', patch: { slot: 6 } }, { kind: 'label', label: 'P', patch: { size: 'XL' } }, { kind: 'label', label: 'P', patch: { badge: 'star' } }, { kind: 'label', label: 'P', patch: { caption: '' } }, { kind: 'label', label: 'P', patch: { caption: 'x'.repeat(257) } }, { kind: 'label', label: 'P', patch: { glow: true } }, { kind: 'label', label: 'P', clear: ['glow'] }, { kind: 'label', label: 'P', clear: 'slot' }, { kind: 'type', type: 'T', patch: { slot: 1.5 } }, { kind: 'type', type: 'T', patch: { size: 'S' } }, { kind: 'label', label: 'P', patch: 'red' }]) {
			assert.throws(() => checkStyleEdit(bad), refused(/not one this app makes/), JSON.stringify(bad));
		}
	});
});

describe('labels named like Object members are just labels', () => {
	const odd = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];

	it('they take free slots, wait for one, and are released like any other label', () => {
		assert.deepEqual(assignmentFor({}, odd, true).add, Object.fromEntries([['__proto__', 0], ['constructor', 1], ['hasOwnProperty', 2], ['toString', 3], ['valueOf', 4]]));
		const six = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5 };
		const { add, release } = assignmentFor(six, ['A', 'B', 'C', 'D', 'E', 'constructor'], true);
		assert.deepEqual({ ...add }, { constructor: 5 }, 'constructor waits for a slot, and F (gone) gives one back');
		assert.deepEqual(release, ['F']);
	});

	it('they round-trip through the stored bag and the reader', () => {
		let bag: Record<string, unknown> = {};
		bag = applyStyleChange(bag, KEY, { kind: 'assign', ...assignmentFor({}, odd, true) });
		bag = applyStyleChange(bag, KEY, { kind: 'label', label: '__proto__', patch: { slot: 5, size: 'L' } });
		bag = applyStyleChange(bag, KEY, { kind: 'label', label: 'constructor', patch: { badge: 'dot' } });
		const read = readConnectionStyle(JSON.parse(JSON.stringify(bag))[KEY]);
		assert.deepEqual(Object.keys(read.assigned).sort(), [...odd].sort());
		assert.ok(Object.hasOwn(read.labels, '__proto__'), 'an own entry, not the prototype');
		assert.deepEqual(Object.getOwnPropertyDescriptor(read.labels, '__proto__')?.value, { slot: 5, size: 'L' });
		assert.deepEqual(Object.getOwnPropertyDescriptor(read.labels, 'constructor')?.value, { badge: 'dot' });
		assert.equal(Object.getPrototypeOf(read.labels), Object.prototype, 'still a plain object');
		assert.equal(Object.hasOwn(read.labels, 'toString'), false, 'an inherited member is not a label');
	});
});

describe('relationship-type colours: only the measured slots', () => {
	it('a type slot outside TYPE_COLOR_SLOTS is refused from a frame and from the owning realm, and dropped when read', () => {
		assert.deepEqual([...TYPE_COLOR_SLOTS], [0, 1, 2, 4], 'the premise: yellow (5) and orange (3) fail 3:1 on the light themes');
		assert.throws(() => checkStyleEdit({ kind: 'type', type: 'KNOWS', patch: { slot: 5 } }), refused(/not one this app makes/));
		assert.throws(() => applyStyleChange({}, KEY, { kind: 'type', type: 'KNOWS', patch: { slot: 3 } }), refused(/cannot be drawn in that colour/));
		assert.doesNotThrow(() => applyStyleChange({}, KEY, { kind: 'type', type: 'KNOWS', patch: { slot: 4 } }));
		assert.deepEqual(readConnectionStyle({ types: { OLD: { slot: 5 }, OK: { slot: 1 } } }).types, { OK: { slot: 1 } }, 'an older file\'s yellow type is read as no choice');
	});
});

describe('captions from 1.2: a choice that does not fit stays where it was', () => {
	const LEGACY = 'graph.captions';
	/**
	 * Accessor holding a styles bag with exactly `room` characters left under the cap.
	 *
	 * @param room - Characters left.
	 * @returns The accessor.
	 */
	function nearlyFull(room: number) {
		const fill = (n: number) => ({ [OTHER]: { labels: { ['F'.repeat(n)]: { slot: 1 } } } });
		const base = JSON.stringify(fill(0), null, 2).length;
		const prefs = memoryPrefs();
		prefs.setPref(STYLES_PREF, fill(MAX_STYLES_BAG_CHARS - room - base));
		return prefs;
	}

	it('the choices that fit are moved; the one that does not is kept under the old key, and is tried again later', () => {
		const prefs = nearlyFull(140);
		prefs.setPref(LEGACY, { [KEY]: { A: 'a', B: 'x'.repeat(250) } });
		assert.equal(moveLegacyCaptions(prefs, LEGACY), true);
		assert.equal(styleIn(prefs, KEY).labels.A?.caption, 'a', 'moved');
		assert.equal(styleIn(prefs, KEY).labels.B, undefined, 'did not fit');
		assert.deepEqual(prefs.getPref(LEGACY), { [KEY]: { B: 'x'.repeat(250) } }, 'kept, not lost');
	});

	it('nothing fits: nothing is written, and the old key is left as it was', () => {
		const prefs = nearlyFull(0);
		const legacy = { [KEY]: { A: 'name' } };
		prefs.setPref(LEGACY, legacy);
		const styles = prefs.getPref(STYLES_PREF);
		assert.equal(moveLegacyCaptions(prefs, LEGACY), false);
		assert.equal(prefs.getPref(LEGACY), legacy);
		assert.equal(prefs.getPref(STYLES_PREF), styles);
	});

	it('everything moved (or already captioned in the style): the old key is removed', () => {
		const prefs = memoryPrefs();
		prefs.setPref(STYLES_PREF, { [KEY]: { labels: { B: { caption: 'mine' } } } });
		prefs.setPref(LEGACY, { [KEY]: { A: 'a', B: 'old' } });
		assert.equal(moveLegacyCaptions(prefs, LEGACY), true);
		assert.equal(prefs.getPref(LEGACY), undefined);
		assert.equal(styleIn(prefs, KEY).labels.B?.caption, 'mine', 'the style\'s own caption wins');
	});
});
