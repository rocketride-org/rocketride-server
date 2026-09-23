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
// DISCOVERY — unit tests for endpoint enumeration over a fake client
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { RocketRideClient } from 'shell';
import { DATABASE_PROVIDERS, discoverSqlEndpoints } from '../src/connect/discovery';

// =============================================================================
// FAKE CLIENT
// =============================================================================

/** One row of the fake `listTasks` response. */
interface IFakeTask {
	/** Project (pipeline) id. */
	projectId: string;
	/** Source component id of the task. */
	source: string;
	/** Task display name. */
	name: string;
	/** Task state (>= 4 is stopping / finished). */
	state: number;
	/** Completion flag. */
	completed: boolean;
}

/** How the fake client should answer for one task. */
interface IFakeTaskBehaviour {
	/** Token to return, or null to simulate "no running task". */
	token?: string | null;
	/** Components of the task's pipeline. */
	components?: { id?: string; provider?: string; name?: string }[];
	/** Throw from getTaskPipeline instead of answering. */
	fail?: boolean;
}

/**
 * Build a fake RocketRide client over a task list and per-task behaviour.
 *
 * @param rows - The tasks `listTasks` reports.
 * @param behaviour - Per `projectId:source` behaviour (default: one db node).
 * @returns The fake client and the token lookups it received.
 */
function fakeClient(rows: IFakeTask[], behaviour: Record<string, IFakeTaskBehaviour> = {}): { client: RocketRideClient; tokenLookups: string[] } {
	const tokenLookups: string[] = [];
	const client = {
		listTasks: async () => ({ rows }),
		getTaskToken: async ({ projectId, source }: { projectId: string; source: string }) => {
			const id = `${projectId}:${source}`;
			tokenLookups.push(id);
			const spec = behaviour[id];
			return spec && 'token' in spec ? spec.token : `token-${id}`;
		},
		getTaskPipeline: async (token: string) => {
			const id = token.replace(/^token-/, '');
			const spec = behaviour[id];
			if (spec?.fail) throw new Error('task went away');
			return { components: spec?.components ?? [{ id: 'db_1', provider: 'db_mysql', name: 'Orders DB' }] };
		},
	} as unknown as RocketRideClient;
	return { client, tokenLookups };
}

/**
 * Build a task row over a running default.
 *
 * @param over - Fields to override.
 * @returns The task row.
 */
function task(over: Partial<IFakeTask> = {}): IFakeTask {
	return { projectId: 'p1', source: 's1', name: 'Pipeline A', state: 2, completed: false, ...over };
}

// =============================================================================
// PROVIDER SET
// =============================================================================

describe('DATABASE_PROVIDERS', () => {
	it('covers exactly the three relational node providers', () => {
		assert.deepEqual([...DATABASE_PROVIDERS].sort(), ['db_clickhouse', 'db_mysql', 'db_postgres']);
	});
});

// =============================================================================
// TASK FILTERING
// =============================================================================

describe('discoverSqlEndpoints task filtering', () => {
	it('skips tasks whose state has reached the stopping threshold', async () => {
		const { client, tokenLookups } = fakeClient([
			task({ projectId: 'live' }),
			task({ projectId: 'stopping', state: 4 }),
			task({ projectId: 'cancelled', state: 6 }),
		]);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => e.projectId), ['live']);
		assert.deepEqual(tokenLookups, ['live:s1']);
	});

	it('skips tasks already flagged completed even below the state threshold', async () => {
		const { client } = fakeClient([task({ projectId: 'done', state: 2, completed: true }), task({ projectId: 'live' })]);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => e.projectId), ['live']);
	});

	it('resolves each project and source pair only once across restart rows', async () => {
		const { client, tokenLookups } = fakeClient([
			task({ name: 'Pipeline A (restart 2)' }),
			task({ name: 'Pipeline A (restart 1)' }),
			task({ source: 's2', name: 'Pipeline B' }),
		]);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(tokenLookups, ['p1:s1', 'p1:s2']);
		assert.equal(endpoints.length, 2);
		// The FIRST row of a duplicated pair wins — the list arrives newest first.
		assert.equal(endpoints.find((e) => e.source === 's1')!.pipelineName, 'Pipeline A (restart 2)');
	});

	it('skips a task whose token no longer resolves', async () => {
		const { client } = fakeClient([task({ projectId: 'gone' })], { 'gone:s1': { token: null } });
		assert.deepEqual(await discoverSqlEndpoints(client), []);
	});

	it('keeps discovering after one task throws', async () => {
		const { client } = fakeClient(
			[task({ projectId: 'bad' }), task({ projectId: 'good' })],
			{ 'bad:s1': { fail: true } },
		);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => e.projectId), ['good']);
	});
});

// =============================================================================
// COMPONENT SELECTION
// =============================================================================

describe('discoverSqlEndpoints component selection', () => {
	it('keeps only database-provider components and describes each fully', async () => {
		const { client } = fakeClient([task()], {
			'p1:s1': {
				components: [
					{ id: 'llm_1', provider: 'llm_openai', name: 'GPT' },
					{ id: 'pg_1', provider: 'db_postgres', name: 'Analytics' },
					{ id: 'ch_1', provider: 'db_clickhouse' },
				],
			},
		});
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => e.nodeId), ['ch_1', 'pg_1']);
		const pg = endpoints.find((e) => e.nodeId === 'pg_1')!;
		assert.deepEqual(pg, {
			key: 'p1:s1:pg_1',
			projectId: 'p1',
			pipelineName: 'Pipeline A',
			source: 's1',
			nodeId: 'pg_1',
			nodeName: 'Analytics',
			provider: 'db_postgres',
			running: true,
		});
		// A component without a display name falls back to its id.
		assert.equal(endpoints.find((e) => e.nodeId === 'ch_1')!.nodeName, 'ch_1');
	});

	it('ignores components missing an id or a provider', async () => {
		const { client } = fakeClient([task()], {
			'p1:s1': { components: [{ provider: 'db_mysql' }, { id: 'x' }, { id: 'ok', provider: 'db_mysql' }] },
		});
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => e.nodeId), ['ok']);
	});

	it('returns nothing when the pipeline reports no components at all', async () => {
		const { client } = fakeClient([task()], { 'p1:s1': { components: undefined } });
		// `components: undefined` falls back to the fake's default single node,
		// so assert the genuinely empty case explicitly.
		const { client: empty } = fakeClient([task()], { 'p1:s1': { components: [] } });
		assert.equal((await discoverSqlEndpoints(client)).length, 1);
		assert.deepEqual(await discoverSqlEndpoints(empty), []);
	});

	it('sorts by pipeline name, then node id', async () => {
		const { client } = fakeClient(
			[task({ projectId: 'p2', name: 'Zeta' }), task({ projectId: 'p1', name: 'Alpha' })],
			{
				'p2:s1': { components: [{ id: 'z1', provider: 'db_mysql' }] },
				'p1:s1': { components: [{ id: 'b', provider: 'db_mysql' }, { id: 'a', provider: 'db_mysql' }] },
			},
		);
		const endpoints = await discoverSqlEndpoints(client);
		assert.deepEqual(endpoints.map((e) => `${e.pipelineName}/${e.nodeId}`), ['Alpha/a', 'Alpha/b', 'Zeta/z1']);
	});
});
