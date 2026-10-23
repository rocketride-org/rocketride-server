// =============================================================================
// MIT License
//
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
// SCHEMA STORE — unit tests for the refresh policy
// =============================================================================
//
// The store keeps module-level state keyed by endpoint key, so every test
// binds its OWN key and the suites stay independent.
//
// What is asserted here is which TOOLS a refresh reaches for, because that is
// the whole behaviour under test: whether a fresh read is attempted at all,
// and whether a caller that needs one is made to wait for it.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { SqlEndpoint, SqlSession } from '../src/connect';
import type { SqlWireClient } from '../src/connect/busClient';
import { createSqlSession } from '../src/connect/session';
import { refreshSchema } from '../src/schema/schemaStore';

// =============================================================================
// FAKE CLIENT
// =============================================================================

/** A fake client plus the tool names it was asked for, in order. */
interface IFakeClient {
	/** The client handed to the store. */
	client: SqlWireClient;
	/** Every tool invoked, in order. */
	tools: string[];
}

/**
 * Build an endpoint with its own key, so one test's snapshot cannot reach
 * another's.
 *
 * @param key - The endpoint key.
 * @returns The endpoint.
 */
function endpointFor(key: string): SqlEndpoint {
	return {
		key,
		projectId: 'p1',
		pipelineName: 'Pipeline A',
		source: 's1',
		nodeId: key,
		nodeName: 'Orders DB',
		provider: 'db_postgres',
		running: true,
	};
}

/**
 * Build a fake client whose tool calls are answered by `behave`.
 *
 * The token never changes, which matches a task that did not restart: the
 * session's one retry is then declined and the first failure is the answer.
 *
 * @param behave - Called per invocation with the tool name and its ordinal.
 * @returns The fake client and its tool log.
 */
function fakeClient(behave: (tool: string, index: number) => unknown): IFakeClient {
	const tools: string[] = [];
	const client = {
		getTaskToken: async () => 'token-1',
		tool: async ({ tool }: { tool: string }) => {
			tools.push(tool);
			return behave(tool, tools.length - 1);
		},
	} as unknown as SqlWireClient;
	return { client, tools };
}

/** One session per (fake client, endpoint key), as the app keeps one per connection. */
const sessions = new WeakMap<SqlWireClient, Map<string, SqlSession>>();

/**
 * The session a refresh runs on (refreshSchema takes a session, not a client).
 *
 * @param client - The fake client.
 * @param endpoint - The endpoint.
 * @returns The session, created once per client and endpoint.
 */
function sessionFor(client: SqlWireClient, endpoint: SqlEndpoint): SqlSession {
	const byKey = sessions.get(client) ?? new Map<string, SqlSession>();
	sessions.set(client, byKey);
	let session = byKey.get(endpoint.key);
	if (session === undefined) {
		session = createSqlSession(client, endpoint);
		byKey.set(endpoint.key, session);
	}
	return session;
}

/** How many times one tool was invoked. */
const countOf = (tools: string[], tool: string): number => tools.filter((name) => name === tool).length;

// =============================================================================
// THE REFRESH-TOOL LATCH
// =============================================================================

describe('refreshSchema — fresh reflection after a fallback', () => {
	it('still attempts a fresh read after ONE fallback', async () => {
		// The regression: a task restart (or a timed-out call) during a single
		// fresh refresh used to latch `unavailable`, and every later Refresh
		// Schema, Reverse Engineer and post-DDL read served the task-start
		// snapshot for the rest of the app session.
		const endpoint = endpointFor('latch:one');
		const { client, tools } = fakeClient((tool) => {
			if (tool === 'dialect') return { dialect: 'postgres' };
			if (tool === 'refresh_schema' && countOf(tools, 'refresh_schema') === 1) throw new Error('task restarted');
			return { database: 'shop', tables: {} };
		});

		await refreshSchema(sessionFor(client, endpoint), { fresh: true });
		assert.equal(countOf(tools, 'refresh_schema'), 1);
		// The first attempt fell back, so the snapshot came from get_schema.
		assert.equal(countOf(tools, 'get_schema'), 1);

		await refreshSchema(sessionFor(client, endpoint), { fresh: true });
		assert.equal(countOf(tools, 'refresh_schema'), 2);
		// The second attempt answered, so no fallback read was needed.
		assert.equal(countOf(tools, 'get_schema'), 1);
	});

	it('stops attempting only after a SECOND consecutive fallback', async () => {
		// A node that genuinely has no `refresh_schema` tool must still stop
		// costing two round trips per refresh.
		const endpoint = endpointFor('latch:two');
		const { client, tools } = fakeClient((tool) => {
			if (tool === 'dialect') return { dialect: 'postgres' };
			if (tool === 'refresh_schema') throw new Error('no such tool');
			return { database: 'shop', tables: {} };
		});

		await refreshSchema(sessionFor(client, endpoint), { fresh: true });
		await refreshSchema(sessionFor(client, endpoint), { fresh: true });
		assert.equal(countOf(tools, 'refresh_schema'), 2);

		await refreshSchema(sessionFor(client, endpoint), { fresh: true });
		assert.equal(countOf(tools, 'refresh_schema'), 2, 'the latch holds after two fallbacks');
	});

	it('clears the suspicion when a fresh read answers', async () => {
		const endpoint = endpointFor('latch:recovers');
		const { client, tools } = fakeClient((tool) => {
			if (tool === 'dialect') return { dialect: 'postgres' };
			// Fails once, answers once, fails once: never twice in a row, so
			// the tool must never be written off.
			if (tool === 'refresh_schema' && countOf(tools, 'refresh_schema') !== 2) throw new Error('flaky');
			return { database: 'shop', tables: {} };
		});

		await refreshSchema(sessionFor(client, endpoint), { fresh: true });
		await refreshSchema(sessionFor(client, endpoint), { fresh: true });
		await refreshSchema(sessionFor(client, endpoint), { fresh: true });
		await refreshSchema(sessionFor(client, endpoint), { fresh: true });
		assert.equal(countOf(tools, 'refresh_schema'), 4);
	});
});

// =============================================================================
// CONCURRENT REFRESHES
// =============================================================================

describe('refreshSchema — concurrency', () => {
	it('makes a fresh request wait for its own reflection instead of returning early', async () => {
		// The regression: `refreshSchema` returned immediately while another
		// refresh was loading, so the post-DDL call in TableDesignView neither
		// started nor awaited a reflection and the outcome banner described
		// the change against the pre-DDL snapshot.
		const endpoint = endpointFor('concurrent:fresh');
		let release = (): void => {};
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const { client, tools } = fakeClient(async (tool) => {
			if (tool === 'dialect') return { dialect: 'postgres' };
			// The ordinary read is held open; the fresh one answers at once.
			if (tool === 'get_schema') await blocked;
			return { database: 'shop', tables: {} };
		});

		const ordinary = refreshSchema(sessionFor(client, endpoint));
		// Let the ordinary refresh reach its held `get_schema` call.
		await new Promise((resolve) => { setTimeout(resolve, 0); });
		const fresh = refreshSchema(sessionFor(client, endpoint), { fresh: true });
		assert.equal(countOf(tools, 'refresh_schema'), 0, 'the queued fresh read has not jumped the queue');

		release();
		await ordinary;
		await fresh;
		assert.equal(countOf(tools, 'refresh_schema'), 1, 'the fresh read actually ran before its promise settled');
	});

	it('collapses an ordinary refresh onto the one already running', async () => {
		const endpoint = endpointFor('concurrent:ordinary');
		let release = (): void => {};
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const { client, tools } = fakeClient(async (tool) => {
			if (tool === 'dialect') return { dialect: 'postgres' };
			await blocked;
			return { database: 'shop', tables: {} };
		});

		const first = refreshSchema(sessionFor(client, endpoint));
		await new Promise((resolve) => { setTimeout(resolve, 0); });
		const second = refreshSchema(sessionFor(client, endpoint));
		release();
		await Promise.all([first, second]);
		assert.equal(countOf(tools, 'get_schema'), 1);
	});
});
