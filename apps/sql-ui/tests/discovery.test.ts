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
// DISCOVERY — database endpoints by address and node over `interfaces()`
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RocketRideClient } from 'shell';
import { DATABASE_CLASS_TYPE, describeSqlAddress, discoverSqlEndpoints } from '../src/connect/discovery';

// =============================================================================
// FAKE CLIENT
// =============================================================================

/** One row of the fake `listTasks` response. */
interface IFakeTask {
	/** The control's address. */
	address?: string;
	/** Project id (direct connections are skipped by prefix). */
	projectId?: string;
	/** Task display name. */
	name?: string;
	/** Task state (>= 4 is stopping / finished). */
	state?: number;
	/** Completion flag. */
	completed?: boolean;
}

/** One node under a classType in the fake `interfaces()` answer. */
type FakeNode = { nodeId: string; name: string };

/** The fake `interfaces()` answer per address: pipe address -> classType -> nodes, or a thrown error. */
type FakeInterfaces = Record<string, Record<string, Record<string, FakeNode[]>> | Error>;

/**
 * Build a fake RocketRide client over a task list and per-address interface maps.
 *
 * @param rows - The tasks `listTasks` reports.
 * @param interfaces - Per queried address, the `interfaces` map to answer (or an Error to throw).
 * @returns The fake client and the addresses `interfaces` was asked about.
 */
function fakeClient(rows: IFakeTask[], interfaces: FakeInterfaces = {}): { client: RocketRideClient; asked: string[] } {
	const asked: string[] = [];
	const client = {
		listTasks: async () => ({ rows }),
		interfaces: async (address: string) => {
			asked.push(address);
			const answer = interfaces[address];
			if (answer instanceof Error) throw answer;
			if (!answer) throw new Error(`TASK_NOT_REGISTERED ${address}`);
			return { address, rung: 'team', version: 1, interfaces: answer };
		},
	} as unknown as RocketRideClient;
	return { client, asked };
}

/** A live task row for `acme.p1.s1`. */
function task(over: Partial<IFakeTask> = {}): IFakeTask {
	return { address: 'acme.p1.s1', projectId: 'p1', name: 'Pipeline A', state: 2, completed: false, ...over };
}

/** A one-database-node answer for a pipe address. */
function dbPipe(pipeAddress: string, nodes: FakeNode[] = [{ nodeId: 'db_1', name: 'Orders DB' }]) {
	return { [pipeAddress]: { [DATABASE_CLASS_TYPE]: nodes, tool: nodes } };
}

// =============================================================================
// describeSqlAddress
// =============================================================================

describe('describeSqlAddress', () => {
	it('turns every database node of the answer into an endpoint keyed by address and node', async () => {
		const { client } = fakeClient([], {
			'acme.p1': {
				'acme.p1.chat': { source: [{ nodeId: 'chat', name: 'chat' }], chat: [{ nodeId: 'chat', name: 'chat' }] },
				'acme.p1': {
					database: [{ nodeId: 'pg_1', name: 'Analytics' }, { nodeId: 'ch_1', name: 'ch_1' }],
					tool: [{ nodeId: 'pg_1', name: 'Analytics' }],
					llm: [{ nodeId: 'llm_1', name: 'GPT' }],
				},
			},
		});
		const endpoints = await describeSqlAddress(client, 'acme.p1');
		assert.deepEqual(endpoints, [
			{ key: 'acme.p1:pg_1', address: 'acme.p1', pipelineName: 'p1', nodeId: 'pg_1', nodeName: 'Analytics' },
			{ key: 'acme.p1:ch_1', address: 'acme.p1', pipelineName: 'p1', nodeId: 'ch_1', nodeName: 'ch_1' },
		]);
	});

	it('keeps a node under the source address it was answered under', async () => {
		const { client } = fakeClient([], {
			'acme.p1.chat': { 'acme.p1.chat': { database: [{ nodeId: 'db_main', name: 'Ops DB' }] } },
		});
		const [endpoint] = await describeSqlAddress(client, 'acme.p1.chat', 'Doc brain');
		assert.equal(endpoint!.address, 'acme.p1.chat');
		assert.equal(endpoint!.pipelineName, 'Doc brain');
	});

	it('answers nothing for a pipe without a database node', async () => {
		const { client } = fakeClient([], { 'acme.p1': { 'acme.p1': { llm: [{ nodeId: 'llm_1', name: 'GPT' }] } } });
		assert.deepEqual(await describeSqlAddress(client, 'acme.p1'), []);
	});

	it('lets the server error through for an address the caller cannot use', async () => {
		const { client } = fakeClient([], {});
		await assert.rejects(describeSqlAddress(client, 'zeta.secret'), /TASK_NOT_REGISTERED/);
	});
});

// =============================================================================
// discoverSqlEndpoints
// =============================================================================

describe('discoverSqlEndpoints task filtering', () => {
	it('skips tasks whose state has reached the stopping threshold', async () => {
		const { client, asked } = fakeClient(
			[task({ address: 'acme.live.s1' }), task({ address: 'acme.stopping.s1', state: 4 }), task({ address: 'acme.cancelled.s1', state: 6 })],
			{ 'acme.live.s1': dbPipe('acme.live') },
		);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => e.address), ['acme.live']);
		assert.deepEqual(asked, ['acme.live.s1']);
	});

	it('skips tasks already flagged completed even below the state threshold', async () => {
		const { client, asked } = fakeClient(
			[task({ address: 'acme.done.s1', completed: true }), task({ address: 'acme.live.s1' })],
			{ 'acme.live.s1': dbPipe('acme.live') },
		);
		await discoverSqlEndpoints(client);
		assert.deepEqual(asked, ['acme.live.s1']);
	});

	it('skips rows without an address and sql-ui\'s own direct connections', async () => {
		const { client, asked } = fakeClient(
			[task({ address: undefined }), task({ address: 'acme.sqlconn-x.tools_1', projectId: 'sqlconn-x' }), task()],
			{ 'acme.p1.s1': dbPipe('acme.p1') },
		);
		await discoverSqlEndpoints(client);
		assert.deepEqual(asked, ['acme.p1.s1']);
	});

	it('describes each address once across restart rows and keeps the first name', async () => {
		const { client, asked } = fakeClient(
			[task({ name: 'Pipeline A (restart 2)' }), task({ name: 'Pipeline A (restart 1)' }), task({ address: 'acme.p1.s2', name: 'Pipeline B' })],
			{ 'acme.p1.s1': dbPipe('acme.p1'), 'acme.p1.s2': dbPipe('acme.p1', [{ nodeId: 'db_2', name: 'db_2' }]) },
		);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(asked, ['acme.p1.s1', 'acme.p1.s2']);
		assert.equal(endpoints.find((e) => e.nodeId === 'db_1')!.pipelineName, 'Pipeline A (restart 2)');
	});

	it('keeps discovering after one address fails to describe', async () => {
		const { client } = fakeClient(
			[task({ address: 'acme.bad.s1' }), task({ address: 'acme.good.s1', name: 'Good' })],
			{ 'acme.bad.s1': new Error('went away'), 'acme.good.s1': dbPipe('acme.good') },
		);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => e.address), ['acme.good']);
	});

	it('lists a node once when two addresses answer the same pipe', async () => {
		const { client } = fakeClient(
			[task({ address: 'acme.p1.s1' }), task({ address: 'acme.p1.s2' })],
			{ 'acme.p1.s1': dbPipe('acme.p1'), 'acme.p1.s2': dbPipe('acme.p1') },
		);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => e.key), ['acme.p1:db_1']);
	});
});

describe('discoverSqlEndpoints shape and order', () => {
	it('describes each endpoint fully, with no running flag and no provider', async () => {
		const { client } = fakeClient([task()], { 'acme.p1.s1': dbPipe('acme.p1', [{ nodeId: 'pg_1', name: 'Analytics' }]) });
		const [pg] = await discoverSqlEndpoints(client);
		assert.deepEqual(pg, { key: 'acme.p1:pg_1', address: 'acme.p1', pipelineName: 'Pipeline A', nodeId: 'pg_1', nodeName: 'Analytics' });
	});

	it('sorts by pipeline name, then node id', async () => {
		const { client } = fakeClient(
			[task({ address: 'acme.p2.s1', name: 'Zeta' }), task({ address: 'acme.p1.s1', name: 'Alpha' })],
			{
				'acme.p2.s1': dbPipe('acme.p2', [{ nodeId: 'z1', name: 'z1' }]),
				'acme.p1.s1': dbPipe('acme.p1', [{ nodeId: 'b', name: 'b' }, { nodeId: 'a', name: 'a' }]),
			},
		);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => `${e.pipelineName}/${e.nodeId}`), ['Alpha/a', 'Alpha/b', 'Zeta/z1']);
	});
});
