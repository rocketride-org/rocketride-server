// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DOCUMENT ADDRESSES AND THE SCHEMA STORE
// =============================================================================

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONNECTIONS_URI, endpointKeyFromUri, isWorkbenchUri, isWriteUri, workbenchUri, writeUri } from '../src/graph/addresses';
import { createSchemaStore } from '../src/graph/schemaStore';
import type { IFailureNotice } from '../src/graph/failures';
import { fixture } from './support/builders';

const KEY = 'k1|dev|user|u1|t1|p1|tools=tools_1|graph_1';
const notice = (headline: string): IFailureNotice => ({ variant: 'error', headline, detail: '', verbatim: '', generic: false, hint: null, ignore: false });

test('every document address round-trips to its connection key, and the landing has none', () => {
	assert.equal(endpointKeyFromUri(workbenchUri(KEY)), KEY);
	assert.equal(endpointKeyFromUri(writeUri(KEY)), KEY);
	assert.equal(endpointKeyFromUri(CONNECTIONS_URI), null);
	assert.equal(isWorkbenchUri(workbenchUri(KEY)), true);
	assert.equal(isWorkbenchUri(writeUri(KEY)), false);
	assert.equal(isWriteUri(writeUri(KEY)), true);
	assert.notEqual(workbenchUri(KEY), writeUri(KEY), 'a connection has two distinct documents');
	// A key that carries encoded colons and percent signs survives.
	const odd = 'k1|deploy|team|t%3A1|t%3A1|p%25x|tools=a%3Ab|n';
	assert.equal(endpointKeyFromUri(workbenchUri(odd)), odd);
	assert.equal(endpointKeyFromUri('unknown:abc'), null);
});

test('a load stores the parsed schema; an old node is unknown evidence', async () => {
	const store = createSchemaStore(() => 1234);
	await store.load(KEY, async () => fixture('schema_v2'), () => notice('x'));
	let entry = store.get(KEY);
	assert.equal(entry.status, 'ready');
	assert.equal(entry.view.evidence, 'fresh');
	assert.equal(entry.loadedAt, 1234);
	assert.deepEqual(entry.view.labels.map((l) => l.name), ['Company', 'Person']);
	await store.load(KEY, async () => fixture('schema_old_node'), () => notice('x'));
	entry = store.get(KEY);
	assert.equal(entry.view.evidence, 'unknown');
	assert.equal(entry.view.legacy, true);
});

test('a failed load keeps the last good snapshot and records why', async () => {
	const store = createSchemaStore();
	await store.load(KEY, async () => fixture('schema_v2'), () => notice('x'));
	await store.load(KEY, async () => { throw new Error('boom'); }, (e) => notice(`failed: ${(e as Error).message}`));
	const entry = store.get(KEY);
	assert.equal(entry.status, 'error');
	assert.equal(entry.view.labels.length, 2, 'the good schema is still there');
	assert.equal(entry.failure?.headline, 'failed: boom');
	// And a later success clears the failure.
	await store.load(KEY, async () => fixture('schema_v2'), () => notice('x'));
	assert.equal(store.get(KEY).failure, null);
	assert.equal(store.get(KEY).status, 'ready');
});

test('a connection that never loaded is idle and empty, and says nothing about the graph', () => {
	const store = createSchemaStore();
	const entry = store.get('never');
	assert.equal(entry.status, 'idle');
	assert.equal(entry.view.evidence, 'unknown');
	assert.equal(store.get('never'), entry, 'a stable object between changes');
});

test('concurrent loads coalesce into one call', async () => {
	const store = createSchemaStore();
	let calls = 0;
	let release: (v: unknown) => void = () => undefined;
	const fetch = () => {
		calls += 1;
		return new Promise<unknown>((resolve) => {
			release = resolve;
		});
	};
	const a = store.load(KEY, fetch, () => notice('x'));
	const b = store.load(KEY, fetch, () => notice('x'));
	assert.equal(a, b);
	assert.equal(store.get(KEY).status, 'loading');
	release(fixture('schema_v2'));
	await a;
	assert.equal(calls, 1);
	assert.equal(store.get(KEY).status, 'ready');
});

test('clearing drops the snapshot and a late answer cannot bring it back', async () => {
	const store = createSchemaStore();
	let release: (v: unknown) => void = () => undefined;
	const pending = store.load(KEY, () => new Promise<unknown>((r) => { release = r; }), () => notice('x'));
	store.clear(KEY);
	assert.equal(store.get(KEY).status, 'idle');
	release(fixture('schema_v2'));
	await pending;
	assert.equal(store.get(KEY).status, 'idle', 'the stale answer was dropped');
	// clear() with no key forgets everything, in-flight loads included.
	await store.load('a', async () => fixture('schema_v2'), () => notice('x'));
	store.clear();
	assert.equal(store.get('a').status, 'idle');
});

test('listeners hear every change and can unsubscribe', async () => {
	const store = createSchemaStore();
	let heard = 0;
	const off = store.subscribe(() => { heard += 1; });
	await store.load(KEY, async () => fixture('schema_v2'), () => notice('x'));
	assert.equal(heard, 2, 'loading, then ready');
	off();
	store.clear(KEY);
	assert.equal(heard, 2);
});
