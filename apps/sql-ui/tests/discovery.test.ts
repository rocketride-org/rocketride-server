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
// DISCOVERY — SQL Explorer's provider set and its endpoint store over a fake client
// =============================================================================
//
// The generic discovery rules (running tasks only, own tokens, >100 tasks,
// owner and run-kind keys, role grouping, token containment) are tested where
// they live, in shared/explorer/connect. What is SQL Explorer's own is checked
// here: the exact provider set, and that its store (createSqlEndpoints) finds
// database nodes, describes them, and nothing else.
//
// Port of f63da6e22 (tests/discovery.test.ts). The page-and-lookup discovery
// these suites tested before is gone: its task filtering (stopping tasks,
// restart rows, a token that no longer resolves, one task that throws) is now
// the shared discovery's, and is tested there; its component selection cases
// are kept below, over the store.
// =============================================================================

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IExplorerClient } from 'shared/explorer/types';
import { buildEndpointKey } from 'shared/explorer/keys';
import { DATABASE_PROVIDERS } from '../src/connect';
import { resetEndpoints, sqlEndpoints, taskRow } from './support';

// =============================================================================
// PROVIDER SET
// =============================================================================

describe('DATABASE_PROVIDERS', () => {
	it('covers exactly the relational node providers: MySQL, PostgreSQL, ClickHouse, the Supabase preset and RocketRide SQL', () => {
		assert.deepEqual([...DATABASE_PROVIDERS].sort(), ['db_clickhouse', 'db_mysql', 'db_postgres', 'db_supabase', 'rocketride_sql']);
	});

	it('does not claim the graph or vector providers', () => {
		for (const provider of ['graph_neo4j', 'graph_falkordb', 'rocketride_graph', 'rocketride_vector']) {
			assert.equal(DATABASE_PROVIDERS.has(provider), false, provider);
		}
	});
});

// =============================================================================
// THE STORE
// =============================================================================

/**
 * A client reporting these rows, answering every tool like a postgres node.
 *
 * @param rows - The task rows.
 * @returns The client.
 */
function clientFor(rows: ReturnType<typeof taskRow>[]): IExplorerClient {
	return {
		getTasks: async () => rows.map((row) => ({ ...row })),
		getTaskPipeline: async () => undefined,
		tool: async () => ({ dialect: 'postgres' }) as never,
	};
}

describe('SQL Explorer endpoint store', () => {
	beforeEach(() => { resetEndpoints(); });

	it('keeps only database-provider components and describes each one fully, with an owner-aware key', async () => {
		const row = taskRow('p1');
		row.pipeline.components = [
			{ id: 'llm_1', provider: 'llm_openai', name: 'GPT' },
			{ id: 'pg_1', provider: 'db_postgres', name: 'Analytics' },
			{ id: 'ch_1', provider: 'db_clickhouse' },
			{ id: 'g_1', provider: 'graph_neo4j' },
		];
		await sqlEndpoints.refresh(clientFor([row]));
		const endpoints = sqlEndpoints.getState().endpoints;
		assert.deepEqual(endpoints.map((e) => e.nodeId), ['ch_1', 'pg_1']);
		const pg = endpoints.find((e) => e.nodeId === 'pg_1')!;
		assert.deepEqual(pg, {
			key: buildEndpointKey({ runKind: 'dev', ownerKind: 'user', ownerId: 'u1', teamId: 'team-1', projectId: 'p1', roles: { tools: 's1' }, nodeId: 'pg_1' }),
			legacyKey: 'p1:s1:pg_1',
			projectId: 'p1',
			pipelineName: 'Pipeline A',
			runKind: 'dev',
			ownerKind: 'user',
			ownerId: 'u1',
			teamId: 'team-1',
			roles: { tools: { source: 's1' } },
			missingRoles: [],
			source: 's1',
			nodeId: 'pg_1',
			nodeName: 'Analytics',
			provider: 'db_postgres',
			state: 'ready',
			running: true,
		});
		// A component without a display name falls back to its id.
		assert.equal(endpoints.find((e) => e.nodeId === 'ch_1')!.nodeName, 'ch_1');
	});

	it('finds the Supabase preset and the RocketRide SQL node like any other database node, but not their vector or graph siblings', async () => {
		const row = taskRow('p1');
		row.pipeline.components = [
			{ id: 'sb_1', provider: 'db_supabase', name: 'Supabase' },
			{ id: 'rr_1', provider: 'rocketride_sql', name: 'Managed SQL' },
			{ id: 'rrv_1', provider: 'rocketride_vector' },
			{ id: 'rrg_1', provider: 'rocketride_graph' },
		];
		await sqlEndpoints.refresh(clientFor([row]));
		assert.deepEqual(sqlEndpoints.getState().endpoints.map((e) => `${e.provider}:${e.nodeId}`), ['rocketride_sql:rr_1', 'db_supabase:sb_1']);
	});

	it('ignores components missing an id or a provider', async () => {
		const row = taskRow('p1');
		row.pipeline.components = [{ provider: 'db_mysql' }, { id: 'x' }, { id: 'ok', provider: 'db_mysql' }];
		await sqlEndpoints.refresh(clientFor([row]));
		assert.deepEqual(sqlEndpoints.getState().endpoints.map((e) => e.nodeId), ['ok']);
	});

	it('returns nothing when the pipeline reports no components at all', async () => {
		const row = taskRow('p1');
		row.pipeline.components = [];
		await sqlEndpoints.refresh(clientFor([row]));
		assert.deepEqual(sqlEndpoints.getState().endpoints, []);
	});

	it('sorts by pipeline name, then node id', async () => {
		const zeta = taskRow('p2', { name: 'Zeta' });
		zeta.pipeline.components = [{ id: 'z1', provider: 'db_mysql' }];
		const alpha = taskRow('p1', { name: 'Alpha' });
		alpha.pipeline.components = [{ id: 'b', provider: 'db_mysql' }, { id: 'a', provider: 'db_mysql' }];
		await sqlEndpoints.refresh(clientFor([zeta, alpha]));
		assert.deepEqual(sqlEndpoints.getState().endpoints.map((e) => `${e.pipelineName}/${e.nodeId}`), ['Alpha/a', 'Alpha/b', 'Zeta/z1']);
	});

	it('lists a developer run and the team deployment of one pipeline as two connections', async () => {
		await sqlEndpoints.refresh(clientFor([
			taskRow('p1'),
			taskRow('p1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1', token: 'tk_sentinel_deploy' }),
		]));
		const endpoints = sqlEndpoints.getState().endpoints;
		assert.equal(endpoints.length, 2);
		assert.equal(new Set(endpoints.map((e) => e.key)).size, 2);
		// Only the caller's own dev run carries the `projectId:source:nodeId` key a saved connection names.
		assert.deepEqual(endpoints.map((e) => e.legacyKey).sort((a, b) => String(a).localeCompare(String(b))), [null, 'p1:s1:db_1']);
	});

	it('is not capped at one page of tasks and keeps the stopped badge for a task that went away', async () => {
		const rows = Array.from({ length: 150 }, (_, i) => taskRow(`p${i}`, { name: `Pipe ${String(i).padStart(3, '0')}` }));
		await sqlEndpoints.refresh(clientFor(rows));
		assert.equal(sqlEndpoints.getState().endpoints.length, 150);
		await sqlEndpoints.refresh(clientFor(rows.slice(1)));
		const states = sqlEndpoints.getState().endpoints.map((e) => e.state);
		assert.equal(states.filter((s) => s === 'stopped').length, 1);
		assert.equal(states.filter((s) => s === 'ready').length, 149);
	});

	it('never holds a task token in an endpoint or in the snapshot', async () => {
		await sqlEndpoints.refresh(clientFor([taskRow('p1')]));
		assert.equal(JSON.stringify(sqlEndpoints.getState()).includes('tk_sentinel'), false);
	});
});
