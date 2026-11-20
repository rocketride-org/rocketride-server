// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_PAGE_LIMIT, fetchCatalogPages, reconcileAdded } from './catalogLogic';

/** A catalog of `n` apps served through the verb's offset/limit paging. */
const serving = (n: number) => {
	const all = Array.from({ length: n }, (_, i) => ({ id: `app.${i}` }));
	const calls: Array<Record<string, unknown>> = [];
	const call = async (args: Record<string, unknown>) => {
		calls.push(args);
		const offset = Number(args.offset ?? 0);
		const limit = Math.min(Number(args.limit ?? 20), 100);
		return { apps: all.slice(offset, offset + limit), total: n, offset, limit };
	};
	return { call, calls, all };
};

test('a small catalog is one request and every entry', async () => {
	const { call, calls, all } = serving(7);
	const result = await fetchCatalogPages(call, { action: 'list', shell: 'oss' });
	assert.deepEqual(result, { apps: all, total: 7 });
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0], { action: 'list', shell: 'oss', offset: 0, limit: CATALOG_PAGE_LIMIT });
});

test('a catalog past one page is fetched page by page until the total is reached', async () => {
	const { call, calls, all } = serving(250);
	const result = await fetchCatalogPages(call, { action: 'list' });
	assert.deepEqual(result.apps, all);
	assert.equal(result.total, 250);
	assert.deepEqual(calls.map((c) => c.offset), [0, 100, 200]);
});

test('an exact multiple of the page size stops at the total, not on an extra empty page', async () => {
	const { call, calls } = serving(200);
	const result = await fetchCatalogPages(call, { action: 'list' });
	assert.equal(result.apps.length, 200);
	assert.deepEqual(calls.map((c) => c.offset), [0, 100]);
});

test('a total the pages do not deliver cannot loop: a short page ends the fetch', async () => {
	let n = 0;
	const call = async () => { n += 1; return { apps: n === 1 ? [{ id: 'a' }, { id: 'b' }] : [], total: 999 }; };
	const result = await fetchCatalogPages(call, { action: 'list' }, 2);
	assert.deepEqual(result.apps.map((a) => a.id), ['a', 'b']);
	assert.equal(n, 2);
});

test('a malformed body is an empty catalog, not a throw; a thrown call propagates', async () => {
	assert.deepEqual(await fetchCatalogPages(async () => null, { action: 'list' }), { apps: [], total: 0 });
	assert.deepEqual(await fetchCatalogPages(async () => ({}), { action: 'list' }), { apps: [], total: 0 });
	await assert.rejects(fetchCatalogPages(async () => { throw new Error('nope'); }, { action: 'list' }), /nope/);
});

test('reconcileAdded drops the markers the identity confirmed and keeps the set when nothing changed', () => {
	const prev: ReadonlySet<string> = new Set(['a', 'b']);
	assert.equal(reconcileAdded(prev, () => false), prev);
	assert.deepEqual([...reconcileAdded(prev, (id) => id === 'a')], ['b']);
	assert.deepEqual([...reconcileAdded(prev, () => true)], []);
});

test('a marker recorded after the identity already confirmed the app still clears on the next run', () => {
	// The identity push landed first (isOnDesktop already true), then
	// desktop_add resolved and recorded the marker: the effect that depends
	// on `added` runs again and reconciles it away.
	const identity = new Set(['a']);
	let added: ReadonlySet<string> = new Set();
	added = reconcileAdded(added, (id) => identity.has(id)); // identity landed; nothing marked yet
	added = new Set([...added, 'a']); // desktop_add resolves late
	added = reconcileAdded(added, (id) => identity.has(id)); // the run on `added`
	assert.deepEqual([...added], []);
	// A later removal from the desktop grid is then visible: nothing masks it.
	identity.delete('a');
	assert.equal(reconcileAdded(added, (id) => identity.has(id)), added);
});
