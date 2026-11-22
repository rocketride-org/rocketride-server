// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_PAGE_LIMIT, fetchCatalogPages, fetchReadme, isReadmePath, readmeBaseUrl, reconcileAdded } from './catalogLogic';

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

test('a README path is a URL path on the serving origin and nothing else', () => {
	assert.equal(isReadmePath('/pipelines/acme.myPipe/v4/README.md'), true);
	assert.equal(isReadmePath('/apps/acme.app/v2/docs/README.md'), true);
	// Absent, not a string, relative, absolute, and another origin's network path.
	for (const value of [undefined, null, '', 42, 'README.md', './README.md', 'https://rr.example/apps/a/v1/README.md', '//cdn.example/README.md', '/\\cdn.example/README.md']) {
		assert.equal(isReadmePath(value), false, String(value));
	}
});

test('the README base URL is its folder, through the last slash of the path', () => {
	assert.equal(readmeBaseUrl('/pipelines/acme.myPipe/v4/README.md'), '/pipelines/acme.myPipe/v4/');
	assert.equal(readmeBaseUrl('/apps/acme.app/v2/docs/README.md'), '/apps/acme.app/v2/docs/');
	assert.equal(readmeBaseUrl('/README.md'), '/');
	// A query or fragment is not part of the path, slashes in it included.
	assert.equal(readmeBaseUrl('/apps/a/v1/README.md?ref=/x/y#top/of'), '/apps/a/v1/');
});

test('fetchReadme answers the markdown of an OK response, asked for by its path with the abort signal', async () => {
	const { signal } = new AbortController();
	const calls: Array<{ url: string; signal: AbortSignal }> = [];
	const get = async (url: string, init: { signal: AbortSignal }) => {
		calls.push({ url, signal: init.signal });
		return { ok: true, text: async () => '# Doc Brain' };
	};
	assert.equal(await fetchReadme(get, '/pipelines/acme.docBrain/v3/README.md', signal), '# Doc Brain');
	assert.deepEqual(calls, [{ url: '/pipelines/acme.docBrain/v3/README.md', signal }]);
});

test('a response that is not OK, a failed request and an aborted one are all no README', async () => {
	const { signal } = new AbortController();
	// Not OK: the body (an error page) is never read as markdown.
	assert.equal(await fetchReadme(async () => ({ ok: false, text: async () => 'Not Found' }), '/apps/a/v1/README.md', signal), '');
	assert.equal(await fetchReadme(async () => { throw new TypeError('network'); }, '/apps/a/v1/README.md', signal), '');
	// Aborted while the body streams: the read rejects.
	const aborted = async () => ({ ok: true, text: async (): Promise<string> => { throw new DOMException('aborted', 'AbortError'); } });
	assert.equal(await fetchReadme(aborted, '/apps/a/v1/README.md', signal), '');
});
