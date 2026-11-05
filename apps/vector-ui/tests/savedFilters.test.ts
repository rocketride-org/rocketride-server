// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// SAVED FILTERS (pure): per connection, in memory, conditions only, cleared on a change of identity
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ISavedFilter } from '../src/contract/types';
import { connectionCaches } from '../src/adapters/explorer';
import { savedFilters } from '../src/adapters/connections';
import { SAVED_FILTERS_MAX, SAVED_NAME_MAX, savedFiltersFor } from '../src/vector/savedFilters';

const KEY_A = 'owner|team|project-a|tools|store_1';
const KEY_B = 'owner|team|project-b|tools|store_1';

/** A fresh map and a counter for ids. */
function fresh() {
	const map = new Map<string, readonly ISavedFilter[]>();
	let n = 0;
	const make = (key: string) => savedFiltersFor(map, key, { newId: () => `f${(n += 1)}` });
	return { map, make };
}

test('round trip: save a condition set under a name, list it, read it back, delete it', () => {
	const { make } = fresh();
	const saved = make(KEY_A);
	assert.deepEqual(saved.list(), []);
	const out = saved.save('  handbooks ', { path_prefix: 'C:/demo/handbooks/', file_types: ['md'] }, 1_000);
	assert.ok(out.ok);
	assert.deepEqual(out.saved, { id: 'f1', name: 'handbooks', filter: { path_prefix: 'C:/demo/handbooks/', file_types: ['md'] }, savedAt: 1_000 });
	assert.deepEqual(saved.list(), [out.saved]);
	assert.deepEqual(saved.get('f1'), out.saved);
	saved.remove('f1');
	assert.deepEqual(saved.list(), []);
	assert.equal(saved.get('f1'), null);
});

test('conditions only: the path box is not saved, and a set without a condition is refused', () => {
	const { make } = fresh();
	const saved = make(KEY_A);
	const out = saved.save('greenhouse', { path_prefix: 'C:/demo/greenhouse/', path_contains: 'orchid' }, 1);
	assert.ok(out.ok);
	assert.deepEqual(out.saved.filter, { path_prefix: 'C:/demo/greenhouse/' });
	const empty = saved.save('nothing', { path_contains: 'orchid' }, 2);
	assert.deepEqual(empty, { ok: false, error: 'Add a condition before saving.' });
});

test('names: required, at most 60 characters, and saving under a name already used replaces that filter', () => {
	const { make } = fresh();
	const saved = make(KEY_A);
	assert.deepEqual(saved.save('   ', { min_chunks: 2 }, 1), { ok: false, error: 'Name the filter first.' });
	assert.deepEqual(saved.save('x'.repeat(SAVED_NAME_MAX + 1), { min_chunks: 2 }, 1), { ok: false, error: `A name has at most ${SAVED_NAME_MAX} characters.` });
	const first = saved.save('Big', { min_chunks: 64 }, 1);
	const again = saved.save('big', { min_chunks: 100 }, 2);
	assert.ok(first.ok && again.ok);
	assert.equal(saved.list().length, 1);
	assert.equal(again.saved.id, first.saved.id, 'the same entry, updated');
	assert.deepEqual(saved.list()[0], { id: first.saved.id, name: 'big', filter: { min_chunks: 100 }, savedAt: 2 });
});

test('a filter the node would refuse is not saved', () => {
	const { make } = fresh();
	const out = make(KEY_A).save('bad', { min_chunks: 9, max_chunks: 2 }, 1);
	assert.equal(out.ok, false);
});

test(`at most ${SAVED_FILTERS_MAX} per connection`, () => {
	const { make } = fresh();
	const saved = make(KEY_A);
	for (let i = 0; i < SAVED_FILTERS_MAX; i += 1) assert.ok(saved.save(`f${i}`, { min_chunks: i }, i).ok);
	assert.deepEqual(saved.save('one more', { min_chunks: 99 }, 99), { ok: false, error: `At most ${SAVED_FILTERS_MAX} saved filters per connection; delete one first.` });
	assert.ok(saved.save('f3', { min_chunks: 33 }, 100).ok, 'replacing one by its name is still allowed');
});

test('per connection: what one connection saved is never listed for another; the saved list is a copy', () => {
	const { map, make } = fresh();
	make(KEY_A).save('handbooks', { path_prefix: 'C:/demo/handbooks/' }, 1);
	assert.deepEqual(make(KEY_B).list(), []);
	assert.equal(make(KEY_A).list().length, 1, 'a second accessor of the same connection sees it (switching away and back)');
	const listed = make(KEY_A).list();
	assert.throws(() => (listed as ISavedFilter[]).push(listed[0] as ISavedFilter));
	assert.equal(map.get(KEY_A)?.length, 1);
});

test("the app's own map is registered with the cache registry as 'saved filters' and emptied on a change of identity", () => {
	assert.ok(connectionCaches.names().includes('saved filters'));
	const saved = savedFiltersFor(savedFilters, KEY_A);
	assert.ok(saved.save('handbooks', { path_prefix: 'C:/demo/handbooks/' }, 1).ok);
	assert.equal(savedFiltersFor(savedFilters, KEY_A).list().length, 1);
	connectionCaches.clearAll();
	assert.deepEqual(savedFiltersFor(savedFilters, KEY_A).list(), []);
	assert.equal(savedFilters.size, 0);
});
