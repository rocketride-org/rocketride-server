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
// EXPLORER NAV — active-key store, request channel, document addresses
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createActiveKeyStore, createRequestChannel } from './stores';
import { createCounter, endpointKeyFromAnyUri, endpointKeyFromUri } from './addresses';
import type { IDocSchemes } from './addresses';
import { buildEndpointKey } from '../keys';

// =============================================================================
// STORES
// =============================================================================

/**
 * Render a hook's current value (the stores expose React hooks).
 *
 * @param use - The hook.
 * @returns The value it returned during a render.
 */
function read<T>(use: () => T): T {
	let seen: T | undefined;
	const Probe: React.FC = () => {
		seen = use();
		return null;
	};
	renderToStaticMarkup(<Probe />);
	return seen as T;
}

describe('createActiveKeyStore', () => {
	it('starts with no active connection and follows set()', () => {
		const store = createActiveKeyStore();
		assert.equal(read(store.use), null);
		store.set('a');
		assert.equal(read(store.use), 'a');
		store.set(null);
		assert.equal(read(store.use), null);
	});

	it('keeps separate stores independent (Graph\'s active connection never reaches SQL\'s sidebar)', () => {
		const sql = createActiveKeyStore();
		const graph = createActiveKeyStore();
		graph.set('graph-key');
		assert.equal(read(sql.use), null);
		assert.equal(read(graph.use), 'graph-key');
	});

	it('serves non-React readers too: get() is the key now, subscribe() fires on each change until unsubscribed', () => {
		// A dev-tool frame pushes its active key to the controller from plain
		// code, outside any render.
		const store = createActiveKeyStore();
		assert.equal(store.get(), null);
		const seen: (string | null)[] = [];
		const off = store.subscribe(() => seen.push(store.get()));
		store.set('a');
		store.set('a');
		store.set(null);
		assert.deepEqual(seen, ['a', null], 'one call per change, none for a repeat');
		off();
		store.set('b');
		assert.deepEqual(seen, ['a', null], 'nothing after unsubscribe');
		assert.equal(store.get(), 'b');
		assert.equal(read(store.use), 'b', 'the hook and get() read the same key');
	});
});

describe('createRequestChannel', () => {
	it('numbers every request so a repeat for the same target re-fires', () => {
		const channel = createRequestChannel<{ key: string; table: string }>();
		assert.equal(read(channel.use), null);
		channel.request({ key: 'k', table: 't' });
		const first = read(channel.use);
		channel.request({ key: 'k', table: 't' });
		const second = read(channel.use);
		assert.deepEqual(first, { key: 'k', table: 't', seq: 1 });
		assert.deepEqual(second, { key: 'k', table: 't', seq: 2 });
	});

	it('does not share sequence or payload between channels', () => {
		const a = createRequestChannel<{ n: number }>();
		const b = createRequestChannel<{ n: number }>();
		a.request({ n: 1 });
		a.request({ n: 2 });
		b.request({ n: 9 });
		assert.deepEqual(read(b.use), { n: 9, seq: 1 });
		assert.deepEqual(read(a.use), { n: 2, seq: 2 });
	});
});

// =============================================================================
// ADDRESSES
// =============================================================================

/** SQL Explorer's schemes. */
const SQL: IDocSchemes = { bare: ['connection', 'diagram'], suffixed: ['query', 'table', 'design'] };

/**
 * The key extraction SQL Explorer shipped before it moved here, verbatim, kept
 * only as the oracle the shared rule must agree with.
 *
 * @param uri - A document URI.
 * @returns The key, or null.
 */
function legacyExtract(uri: string): string | null {
	const m = /^(connection|diagram|query|table|design):(.+)$/.exec(uri);
	if (!m || !m[1] || !m[2]) return null;
	if (m[1] === 'connection' || m[1] === 'diagram') return m[2];
	const cut = m[2].lastIndexOf(':');
	return cut > 0 ? m[2].slice(0, cut) : null;
}

describe('endpointKeyFromAnyUri', () => {
	const OLD_KEY = '5badc60c-1b62-4c00-83ef-081f0c96d02a:src-1:db_mysql_1';
	const NEW_KEY = buildEndpointKey({ runKind: 'dev', ownerKind: 'user', ownerId: 'u', teamId: 't', projectId: 'p', roles: { tools: 'tools_1' }, nodeId: 'db_1' });

	it('recovers the key from every scheme, for old colon keys and new owner-aware keys', () => {
		for (const key of [OLD_KEY, NEW_KEY]) {
			assert.equal(endpointKeyFromAnyUri(`connection:${key}`, SQL), key);
			assert.equal(endpointKeyFromAnyUri(`diagram:${key}`, SQL), key);
			assert.equal(endpointKeyFromAnyUri(`query:${key}:3`, SQL), key);
			assert.equal(endpointKeyFromAnyUri(`table:${key}:orders`, SQL), key);
			assert.equal(endpointKeyFromAnyUri(`table:${key}:odd%3Aname`, SQL), key);
			assert.equal(endpointKeyFromAnyUri(`design:${key}:*new*2`, SQL), key);
		}
	});

	it('returns null for the landing document, unknown schemes and empty keys', () => {
		assert.equal(endpointKeyFromAnyUri('connections', SQL), null);
		assert.equal(endpointKeyFromAnyUri('graph:abc', SQL), null);
		assert.equal(endpointKeyFromAnyUri('connection:', SQL), null);
		assert.equal(endpointKeyFromAnyUri(':x', SQL), null);
		assert.equal(endpointKeyFromAnyUri('query:nokey', SQL), null);
	});

	it('agrees with the pre-extraction regex on a corpus, including hostile shapes', () => {
		const corpus: string[] = [];
		const keys = ['a', 'a:b', 'a:b:c', OLD_KEY, NEW_KEY, ':', '::', 'x::y', ' ', 'k:', ':k'];
		const schemes = ['connection', 'diagram', 'query', 'table', 'design', 'connections', 'conn', 'QUERY', 'graph', ''];
		for (const scheme of schemes) {
			for (const key of keys) {
				corpus.push(`${scheme}:${key}`, `${scheme}:${key}:1`, `${scheme}:${key}:a:b`, `${scheme}${key}`);
			}
		}
		corpus.push('', ':', 'connection', 'query:');
		for (const uri of corpus) {
			assert.equal(endpointKeyFromAnyUri(uri, SQL), legacyExtract(uri), JSON.stringify(uri));
		}
	});

	it('takes the schemes as a parameter, so Graph can have its own', () => {
		const graph: IDocSchemes = { bare: ['connection'], suffixed: ['query', 'schema'] };
		assert.equal(endpointKeyFromAnyUri('schema:k1:overview', graph), 'k1');
		assert.equal(endpointKeyFromAnyUri('diagram:k1', graph), null);
	});
});

describe('endpointKeyFromUri', () => {
	it('accepts only the named scheme', () => {
		assert.equal(endpointKeyFromUri('connection:k', 'connection'), 'k');
		assert.equal(endpointKeyFromUri('diagram:k', 'connection'), null);
		assert.equal(endpointKeyFromUri('connections', 'connection'), null);
	});
});

describe('createCounter', () => {
	it('counts from one, per counter', () => {
		const a = createCounter();
		const b = createCounter();
		assert.deepEqual([a(), a(), a()], [1, 2, 3]);
		assert.equal(b(), 1);
	});
});
