// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// A CHANGE OF IDENTITY: every console and document tab closes, every per-connection cache clears
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IExplorerEndpoint } from 'shared/explorer';
import { manualClock } from 'shared/explorer/connect/testing';
import { connectionEntry, savedFilters } from '../src/adapters/connections';
import { connectionCaches, neighbourRequests } from '../src/adapters/explorer';
import { savedFiltersFor } from '../src/vector/savedFilters';
import { DEFAULT_LIMITS } from '../src/vector/results';
import { CONNECTIONS_URI, consoleUri, documentUri, endpointKeyFromUri } from '../src/vector/addresses';
import { connectionEditorIds, createCacheRegistry, forgetConnections } from '../src/vector/identityChange';
import type { IConnectionDocs } from '../src/vector/identityChange';

const KEY_A = 'k1|dev|user|u1|team-1|vp|chat=chat_1,ingest=ingest_1,tools=tools_1|store_1';
const KEY_B = 'k1|dev|user|u1|team-1|vq|tools=tools_1|store_1';
const LANDING = { uri: CONNECTIONS_URI, label: 'Connections' };

/** A Documents stand-in that records what was closed and opened. */
function fakeDocs(uris: string[]): IConnectionDocs & { closed: string[]; opened: string[] } {
	const editors: Record<string, { documentUri: string }> = {};
	uris.forEach((uri, i) => {
		editors[`e${i}`] = { documentUri: uri };
	});
	const docs = {
		closed: [] as string[],
		opened: [] as string[],
		getState: () => ({ editors }),
		closeEditor(id: string) {
			docs.closed.push(editors[id].documentUri);
			delete editors[id];
		},
		openStaticDocument(uri: string) {
			docs.opened.push(uri);
		},
	};
	return docs;
}

test('the addresses: a console per connection, a document tab per document, and the key of any of them', () => {
	assert.equal(endpointKeyFromUri(consoleUri(KEY_A)), KEY_A);
	assert.equal(endpointKeyFromUri(documentUri(KEY_A, 'doc-kestrel')), KEY_A);
	assert.equal(endpointKeyFromUri(documentUri(KEY_A, 'odd:id/with:colons')), KEY_A, 'an objectId with a colon cannot break the key');
	assert.equal(endpointKeyFromUri(CONNECTIONS_URI), null);
	assert.notEqual(documentUri(KEY_A, 'x'), documentUri(KEY_B, 'x'));
});

test('every console and document tab closes, the landing stays and is focused, and every cache clears', () => {
	const docs = fakeDocs([CONNECTIONS_URI, consoleUri(KEY_A), documentUri(KEY_A, 'doc-1'), consoleUri(KEY_B)]);
	const caches = createCacheRegistry();
	const cleared: string[] = [];
	for (const name of ['documents', 'chunks', 'uploads', 'chat', 'samples']) caches.register(name, () => cleared.push(name));
	const result = forgetConnections(docs, caches, endpointKeyFromUri, LANDING);
	assert.equal(result.closed, 3);
	assert.deepEqual(docs.closed, [consoleUri(KEY_A), documentUri(KEY_A, 'doc-1'), consoleUri(KEY_B)]);
	assert.deepEqual(docs.opened, [CONNECTIONS_URI]);
	assert.deepEqual(cleared, ['documents', 'chunks', 'uploads', 'chat', 'samples']);
	assert.deepEqual(result.cleared, cleared);
});

test('with nothing open, nothing closes and the landing is not reopened; before the documents exist the caches still clear', () => {
	const docs = fakeDocs([CONNECTIONS_URI]);
	const caches = createCacheRegistry();
	let cleared = 0;
	caches.register('chunks', () => {
		cleared += 1;
	});
	assert.deepEqual(forgetConnections(docs, caches, endpointKeyFromUri, LANDING), { closed: 0, cleared: ['chunks'] });
	assert.deepEqual(docs.opened, []);
	assert.deepEqual(forgetConnections(null, caches, endpointKeyFromUri, LANDING), { closed: 0, cleared: ['chunks'] });
	assert.equal(cleared, 2);
});

test('a cache that throws does not keep the others; registering a name again replaces it; unregister removes only its own', () => {
	const caches = createCacheRegistry();
	const order: string[] = [];
	caches.register('a', () => {
		throw new Error('boom');
	});
	caches.register('b', () => order.push('b'));
	const off = caches.register('c', () => order.push('c-old'));
	caches.register('c', () => order.push('c'));
	off();
	assert.deepEqual(caches.names(), ['a', 'b', 'c'], 'the old unregister does not remove the replacement');
	assert.deepEqual(caches.clearAll(), ['b', 'c']);
	assert.deepEqual(order, ['b', 'c']);
});

test('connectionEditorIds lists connection documents only', () => {
	const ids = connectionEditorIds({ x: { documentUri: CONNECTIONS_URI }, y: { documentUri: consoleUri(KEY_A) } }, endpointKeyFromUri);
	assert.deepEqual(ids, ['y']);
});

test("the app's registry clears the neighbour request queues of every connection", () => {
	const before = neighbourRequests(KEY_A);
	assert.equal(neighbourRequests(KEY_A), before, 'one channel per connection');
	assert.ok(connectionCaches.names().includes('neighbour queues'));
	connectionCaches.clearAll();
	assert.notEqual(neighbourRequests(KEY_A), before, 'a new identity gets a new channel');
});

test("the console's scope and the saved filters are per connection and gone after a change of identity", () => {
	const endpoint = (key: string) => ({ key, nodeId: 'store_1', roles: {}, provider: 'postgres', pipelineName: 'p' }) as unknown as IExplorerEndpoint;
	const a = connectionEntry(endpoint(KEY_A), null, DEFAULT_LIMITS, manualClock());
	a.scope.set({ filter: { path_prefix: 'C:/demo/' }, label: 'folder is under C:/demo/', objectIds: ['doc-1'], overflow: null, applyTo: { documents: true, map: true, search: true, chat: true } });
	assert.ok(savedFiltersFor(savedFilters, KEY_A).save('demo', { path_prefix: 'C:/demo/' }, 1).ok);
	assert.equal(connectionEntry(endpoint(KEY_B), null, DEFAULT_LIMITS, manualClock()).scope.get(), null, 'another connection has its own scope');
	assert.deepEqual(savedFiltersFor(savedFilters, KEY_B).list(), [], 'and its own saved filters');
	assert.equal(connectionEntry(endpoint(KEY_A), null).scope.get()?.label, 'folder is under C:/demo/', 'switching back keeps it within the session');
	connectionCaches.clearAll();
	assert.equal(connectionEntry(endpoint(KEY_A), null, DEFAULT_LIMITS, manualClock()).scope.get(), null, 'a new identity starts without a scope');
	assert.deepEqual(savedFiltersFor(savedFilters, KEY_A).list(), [], 'and without saved filters');
	connectionCaches.clearAll();
});
