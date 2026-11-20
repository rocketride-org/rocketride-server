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
// EXPLORER DISCOVERY — role-aware, owner-aware, token-contained
// =============================================================================

import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { TASK_NAMES_REQUEST, TASK_NAMES_TIMEOUT_MS, discoverToolEndpoints, mapWithConcurrency, readTaskRow } from './discovery';
import type { IDiscoveredEndpoint, IDiscoveryOptions } from './discovery';
import { fakeWorld, row } from './testing';
import { SINGLE_TOOLS_ROLE, VECTOR_ROLES } from '../types';
import type { IExplorerClient, IExplorerIdentity, IRoleSpec } from '../types';
import { legacyKeyFromKey, parseEndpointKey } from '../keys';

const DB = new Set(['db_postgres', 'db_mysql']);
const VECTOR = new Set(['rocketride_vector']);

/**
 * Discover over a world with the SQL/Graph single-role spec.
 *
 * @param rows - The task rows.
 * @param providers - The provider set.
 * @param identity - Who is signed in.
 * @returns The discovered endpoints and the world.
 */
async function discover(rows: ReturnType<typeof row>[], providers: ReadonlySet<string> = DB, identity: IExplorerIdentity | null = null) {
	const world = fakeWorld(rows);
	const found = await discoverToolEndpoints(world.client, { providers, roles: SINGLE_TOOLS_ROLE, identity });
	return { world, found };
}

describe('discoverToolEndpoints — one tools role (SQL, Graph)', () => {
	it('lists each running task with ITS OWN token and never looks a token up', async () => {
		const { world, found } = await discover([row({ pipeline: { project_id: 'p1', components: [{ id: 'db_1', provider: 'db_postgres' }] } }), row({ source: 'tools_2', pipeline: { project_id: 'p2', components: [{ id: 'db_9', provider: 'db_mysql' }] } })]);
		assert.deepEqual(found.map((f) => f.endpoint.nodeId), ['db_1', 'db_9']);
		assert.deepEqual(found.map((f) => f.token), [world.rows[0]!.token, world.rows[1]!.token]);
		// The fake client has no getTaskToken / listTasks at all: nothing could have called them.
		assert.equal(world.getTasksCalls, 1);
		assert.deepEqual(world.pipelineFetches, []);
	});

	it('is not capped at one page: 250 running tasks all appear', async () => {
		const rows = Array.from({ length: 250 }, (_, i) => row({ source: `s${i}`, pipeline: { project_id: `p${i}`, name: `Pipe ${String(i).padStart(3, '0')}`, components: [{ id: 'db_1', provider: 'db_postgres' }] }, name: `Pipe ${String(i).padStart(3, '0')}` }));
		const { found } = await discover(rows);
		assert.equal(found.length, 250);
		assert.equal(new Set(found.map((f) => f.endpoint.key)).size, 250);
	});

	it('keeps a developer run and the team deployment of the SAME project, source and node apart', async () => {
		const dev = row();
		const deploy = row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' });
		const { found } = await discover([dev, deploy]);
		assert.equal(found.length, 2);
		const [a, b] = found.map((f) => f.endpoint);
		assert.notEqual(a!.key, b!.key);
		assert.deepEqual(new Set(found.map((f) => f.token)), new Set([dev.token, deploy.token]));
		assert.deepEqual(new Set(found.map((f) => `${f.endpoint.runKind}/${f.endpoint.ownerKind}`)), new Set(['dev/user', 'deploy/team']));
	});

	it('never merges two teams\' deployments or a personal deploy with the user\'s dev run', async () => {
		const rows = [
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1', teamId: 'team-1' }),
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-2', teamId: 'team-2' }),
			row({ runKind: 'deploy', ownerKind: 'user', ownerId: 'u1' }),
			row(),
		];
		const { found } = await discover(rows);
		assert.equal(new Set(found.map((f) => f.endpoint.key)).size, 4);
	});

	it('gives SQL\'s old key ONLY to the caller\'s own dev run', async () => {
		const { found } = await discover([
			row(),
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' }),
			row({ runKind: 'deploy', ownerKind: 'user', ownerId: 'u1' }),
		]);
		const byRun = Object.fromEntries(found.map((f) => [`${f.endpoint.runKind}/${f.endpoint.ownerKind}`, f.endpoint.legacyKey]));
		assert.equal(byRun['dev/user'], 'proj-1:tools_1:db_1');
		assert.equal(byRun['deploy/team'], null);
		assert.equal(byRun['deploy/user'], null);
		for (const { endpoint } of found) assert.equal(endpoint.legacyKey, legacyKeyFromKey(endpoint.key));
	});

	it('handles a pipeline with no project_id: projectId is empty, no legacy key, and the key is never token-derived', async () => {
		const noProject = (source: string) => row({ source, pipeline: null, name: 'Anon' });
		const a = noProject('tools_1');
		a.pipeline = { components: [{ id: 'db_1', provider: 'db_postgres' }] };
		const b = noProject('tools_2');
		b.pipeline = { components: [{ id: 'db_1', provider: 'db_postgres' }] };
		const { found } = await discover([a, b]);
		assert.equal(found.length, 2);
		for (const { endpoint } of found) {
			assert.equal(endpoint.projectId, '');
			assert.equal(endpoint.legacyKey, null);
			assert.equal(endpoint.key.includes('tk_sentinel'), false);
		}
		assert.notEqual(found[0]!.endpoint.key, found[1]!.endpoint.key);
	});

	it('describes an endpoint fully, with the tools source bound and nothing else', async () => {
		const { found } = await discover([row()]);
		const { endpoint } = found[0]!;
		assert.deepEqual({ ...endpoint, key: '<k>' }, {
			key: '<k>',
			legacyKey: 'proj-1:tools_1:db_1',
			projectId: 'proj-1',
			pipelineName: 'Pipeline A',
			runKind: 'dev',
			ownerKind: 'user',
			ownerId: 'u1',
			teamId: 'team-1',
			roles: { tools: { source: 'tools_1' } },
			missingRoles: [],
			source: 'tools_1',
			nodeId: 'db_1',
			nodeName: 'Orders DB',
			provider: 'db_postgres',
			state: 'probing',
			running: true,
		});
		assert.deepEqual(parseEndpointKey(endpoint.key)?.roles, { tools: 'tools_1' });
	});

	it('NEVER puts a token inside an endpoint: serialising endpoints leaks nothing', async () => {
		const { world, found } = await discover([row(), row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' })]);
		const text = JSON.stringify(found.map((f) => f.endpoint));
		for (const r of world.rows) assert.equal(text.includes(r.token), false);
		assert.equal(text.includes('tk_sentinel'), false);
		for (const f of found) assert.equal(JSON.stringify(f.endpoint.roles).includes('tk_'), false);
	});

	it('keeps only components of the exact provider set and names each one', async () => {
		const r = row({ pipeline: { project_id: 'p1', components: [
			{ id: 'llm_1', provider: 'llm_openai', name: 'GPT' },
			{ id: 'pg_1', provider: 'db_postgres', name: 'Analytics' },
			{ id: 'my_1', provider: 'db_mysql' },
			{ id: 'g_1', provider: 'graph_neo4j' },
			{ provider: 'db_mysql' },
			{ id: 'noprov' },
			{ id: '', provider: 'db_mysql' },
		] } });
		const { found } = await discover([r]);
		assert.deepEqual(found.map((f) => `${f.endpoint.nodeId}:${f.endpoint.nodeName}`), ['my_1:my_1', 'pg_1:Analytics']);
	});

	it('reads components from the row, and falls back to getTaskPipeline(token) only when the row has none', async () => {
		const withComponents = row();
		const bare = row({ source: 'tools_2', pipeline: { project_id: 'p2', name: 'Pipe B' } });
		const world = fakeWorld([withComponents, bare]);
		world.pipelines[bare.token] = { components: [{ id: 'db_7', provider: 'db_mysql' }] };
		const found = await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
		assert.deepEqual(found.map((f) => f.endpoint.nodeId).sort(), ['db_1', 'db_7']);
		assert.deepEqual(world.pipelineFetches, [bare.token]);
	});

	it('skips ONE task whose pipeline cannot be read and keeps discovering the rest', async () => {
		const bad = row({ source: 'tools_9', pipeline: { project_id: 'bad' } });
		const good = row();
		const world = fakeWorld([bad, good]);
		world.pipelines[bad.token] = 'throw';
		const found = await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
		assert.deepEqual(found.map((f) => f.endpoint.projectId), ['proj-1']);
	});

	it('drops rows that cannot be used (no token, no source, not objects) without throwing', async () => {
		const world = fakeWorld([]);
		world.getTasksImpl = async () => [null, 'x', 7, { source: 's' }, { token: 't' }, { ...row() }] as unknown as Array<Record<string, unknown>>;
		const found = await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
		assert.equal(found.length, 1);
	});

	it('propagates a getTasks failure (the only thing that aborts discovery)', async () => {
		const world = fakeWorld([]);
		world.getTasksImpl = async () => { throw new Error('connection lost'); };
		await assert.rejects(discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE }), /connection lost/);
	});

	it('reads ownerKind from an older server that does not stamp it: deploy is team-owned, anything else user-owned', async () => {
		const old = row({ runKind: 'deploy', ownerKind: '' });
		const older = row({ runKind: 'dev', ownerKind: '' });
		const { found } = await discover([old, older]);
		assert.deepEqual(found.map((f) => f.endpoint.ownerKind).sort(), ['team', 'user']);
	});

	it('hints whether the identity can call tools, without ever deciding it', async () => {
		const identity: IExplorerIdentity = { userId: 'u1', orgId: 'o1', devTeam: 't0', teamPermissions: { 'team-1': ['task.monitor'], 'team-2': ['task.monitor', 'task.data'] }, orgPermissions: [] };
		const { found } = await discover([
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' }),
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-2', source: 'tools_2' }),
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-3', source: 'tools_3' }),
			row({ source: 'tools_4' }),
		], DB, identity);
		const hints = Object.fromEntries(found.map((f) => [f.endpoint.ownerId + '/' + f.endpoint.source, f.callHint]));
		assert.equal(hints['team-1/tools_1'], false);
		assert.equal(hints['team-2/tools_2'], true);
		assert.equal(hints['team-3/tools_3'], undefined);
		assert.equal(hints['u1/tools_4'], true);
		assert.equal(found.every((f) => f.endpoint.state === 'probing'), true);
	});

	it('lists only runs whose team belongs to the signed-in organization: the caller\'s own runs in another organization are left out', async () => {
		// Signed in to org B, a member of teams b1 and b2. The server still lists
		// the caller's own runs from org A (owner visibility survives an org switch).
		const identity: IExplorerIdentity = { userId: 'u1', orgId: 'org-B', devTeam: 'team-b1', teamPermissions: { 'team-b1': ['task.data'], 'team-b2': ['task.monitor'] }, orgPermissions: [] };
		const { found } = await discover([
			row({ teamId: 'team-a1', source: 'own_dev_in_A' }),
			row({ teamId: 'team-a1', runKind: 'deploy', ownerKind: 'user', ownerId: 'u1', source: 'own_personal_deploy_in_A' }),
			row({ teamId: 'team-b1', source: 'own_dev_in_B' }),
			// A dev run under the organization's OTHER team is still this organization's.
			row({ teamId: 'team-b2', source: 'own_dev_in_B_other_team' }),
			row({ teamId: 'team-b2', runKind: 'deploy', ownerKind: 'team', ownerId: 'team-b2', source: 'team_deploy_in_B' }),
		], DB, identity);
		assert.deepEqual(found.map((f) => f.endpoint.source).sort(), ['own_dev_in_B', 'own_dev_in_B_other_team', 'team_deploy_in_B']);
		// No token of a left-out run is handed back for the vault.
		const tokens = found.map((f) => f.token);
		assert.equal(tokens.some((token) => token?.includes('_in_A')), false);
	});

	it('keeps every run when the identity cannot tell its organization\'s teams, or a row names no team', async () => {
		const rows = [row({ teamId: 'team-a1', source: 's1' }), row({ teamId: '', source: 's2' })];
		const noTeams: IExplorerIdentity = { userId: 'u1', orgId: 'org-B', devTeam: 'team-b1' };
		assert.equal((await discover(rows, DB, noTeams)).found.length, 2);
		assert.equal((await discover(rows, DB, null)).found.length, 2);
		const withTeams: IExplorerIdentity = { ...noTeams, teamPermissions: { 'team-b1': [] } };
		assert.deepEqual((await discover(rows, DB, withTeams)).found.map((f) => f.endpoint.source), ['s2']);
	});

	it('sorts by pipeline name, then node id, then key', async () => {
		const z = row({ name: 'Zeta', source: 'tools_1', pipeline: { project_id: 'pz', components: [{ id: 'z1', provider: 'db_mysql' }] } });
		const a = row({ name: 'Alpha', source: 'tools_2', pipeline: { project_id: 'pa', components: [{ id: 'b', provider: 'db_mysql' }, { id: 'a', provider: 'db_mysql' }] } });
		const { found } = await discover([z, a]);
		assert.deepEqual(found.map((f) => `${f.endpoint.pipelineName}/${f.endpoint.nodeId}`), ['Alpha/a', 'Alpha/b', 'Zeta/z1']);
	});
});

describe('discoverToolEndpoints — role map (Vector\'s ingest_1 / chat_1 / tools_1, mocked)', () => {
	const vec = (source: string, over: Partial<ReturnType<typeof row>> = {}) => row({ source, pipeline: { project_id: 'vp', name: 'Vector', components: [{ id: 'vec_1', provider: 'rocketride_vector', name: 'Store' }] }, name: 'Vector', ...over });

	/**
	 * Discover over the vector role map.
	 *
	 * @param rows - Rows.
	 * @returns Found endpoints.
	 */
	async function discoverVector(rows: ReturnType<typeof row>[], spec: IRoleSpec = VECTOR_ROLES) {
		const world = fakeWorld(rows);
		return discoverToolEndpoints(world.client, { providers: VECTOR, roles: spec });
	}

	it('groups the three running sources of one project into ONE connection, calling through the tools task', async () => {
		const rows = [vec('ingest_1'), vec('chat_1'), vec('tools_1')];
		const found = await discoverVector(rows);
		assert.equal(found.length, 1);
		const { endpoint, token } = found[0]!;
		assert.deepEqual(endpoint.roles, { ingest: { source: 'ingest_1' }, chat: { source: 'chat_1' }, tools: { source: 'tools_1' } });
		assert.deepEqual(endpoint.missingRoles, []);
		assert.equal(endpoint.state, 'probing');
		assert.equal(endpoint.source, 'tools_1');
		assert.equal(token, rows[2]!.token);
		assert.equal(endpoint.legacyKey, null);
	});

	it('reports a missing optional role explicitly and stays callable', async () => {
		const found = await discoverVector([vec('chat_1'), vec('tools_1')]);
		assert.equal(found.length, 1);
		assert.deepEqual(found[0]!.endpoint.roles, { ingest: null, chat: { source: 'chat_1' }, tools: { source: 'tools_1' } });
		assert.deepEqual(found[0]!.endpoint.missingRoles, ['ingest']);
		assert.equal(found[0]!.endpoint.state, 'probing');
	});

	it('marks the connection stopped when the REQUIRED tools role is not running, and holds no token for it', async () => {
		const found = await discoverVector([vec('ingest_1'), vec('chat_1')]);
		assert.equal(found.length, 1);
		const { endpoint, token } = found[0]!;
		assert.equal(endpoint.state, 'stopped');
		assert.equal(endpoint.running, false);
		assert.deepEqual(endpoint.missingRoles, ['tools']);
		assert.equal(endpoint.source, '');
		assert.equal(token, null);
		assert.match(endpoint.stateDetail ?? '', /tools/);
	});

	it('keeps the connection\'s key stable while its optional sources start and stop', async () => {
		const all = (await discoverVector([vec('ingest_1'), vec('chat_1'), vec('tools_1')]))[0]!.endpoint.key;
		const noIngest = (await discoverVector([vec('chat_1'), vec('tools_1')]))[0]!.endpoint.key;
		const onlyTools = (await discoverVector([vec('tools_1')]))[0]!.endpoint.key;
		assert.equal(all, noIngest);
		assert.equal(all, onlyTools);
	});

	it('NEVER borrows a source from another owner or run kind: dev and deploy of one project are two connections', async () => {
		const rows = [
			vec('ingest_1'), vec('tools_1'),
			vec('chat_1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' }),
			vec('tools_1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' }),
		];
		const found = await discoverVector(rows);
		assert.equal(found.length, 2);
		const dev = found.find((f) => f.endpoint.runKind === 'dev')!.endpoint;
		const deploy = found.find((f) => f.endpoint.runKind === 'deploy')!.endpoint;
		assert.deepEqual(dev.roles, { ingest: { source: 'ingest_1' }, chat: null, tools: { source: 'tools_1' } });
		assert.deepEqual(deploy.roles, { ingest: null, chat: { source: 'chat_1' }, tools: { source: 'tools_1' } });
		assert.notEqual(dev.key, deploy.key);
	});

	it('does not merge two users\' dev runs or two teams\' deployments of the same project id', async () => {
		const found = await discoverVector([
			vec('tools_1', { ownerId: 'u1' }),
			vec('tools_1', { ownerId: 'u2' }),
			vec('chat_1', { ownerId: 'u2' }),
			vec('tools_1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'tA', teamId: 'tA' }),
			vec('tools_1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'tB', teamId: 'tB' }),
		]);
		assert.equal(found.length, 4);
		assert.equal(found.filter((f) => f.endpoint.ownerId === 'u2')[0]!.endpoint.missingRoles.join(','), 'ingest');
		assert.equal(found.filter((f) => f.endpoint.ownerId === 'u1')[0]!.endpoint.missingRoles.join(','), 'ingest,chat');
	});

	it('does not group rows whose pipeline carries no project id: the callable row wins, the stopped lookalike never hides it', async () => {
		const a = vec('ingest_1');
		a.pipeline = { name: 'x', components: [{ id: 'vec_1', provider: 'rocketride_vector' }] };
		const b = vec('tools_1');
		b.pipeline = { name: 'x', components: [{ id: 'vec_1', provider: 'rocketride_vector' }] };
		for (const rows of [[a, b], [b, a]]) {
			const found = await discoverVector(rows);
			assert.equal(found.length, 1);
			// The ingest row was NOT merged into it: ingest stays reported as not running.
			assert.deepEqual(found[0]!.endpoint.roles, { ingest: null, chat: null, tools: { source: 'tools_1' } });
			assert.equal(found[0]!.endpoint.state, 'probing');
		}
	});

	it('ignores a project none of whose running sources fills a role', async () => {
		assert.deepEqual(await discoverVector([vec('other_1')]), []);
	});
});

// =============================================================================
// READABLE NAMES (one listTasks per discovery, names only)
// =============================================================================

/**
 * A run's display id, built the way the engine builds it (task_server.py).
 *
 * @param r - The getTasks row.
 * @returns The id.
 */
function idOf(r: { token: string; source: string }): string {
	return `${r.token.replace(/^tk_/, '').slice(0, 8)}.${r.source}`;
}

/**
 * A live `listTasks` row for a run, as the server sends it (rrext_list_tasks):
 * its status name is `{task name}.{source component name}`.
 *
 * @param r - The run's getTasks row.
 * @param over - Fields to override.
 * @returns The row.
 */
function listed(r: ReturnType<typeof row>, over: Record<string, unknown> = {}): Record<string, unknown> {
	return { id: idOf(r), name: 'Shop Postgres.Tools', projectId: r.pipeline?.project_id ?? '', source: r.source, runKind: r.runKind, completed: false, state: 3, ...over };
}

/**
 * A getTasks row the way a live engine sends it for a pipeline started with
 * `use(name='Shop Postgres')` and no top-level pipeline name: its `name` is
 * the source id.
 *
 * @param over - Fields to override.
 * @returns The row.
 */
function unnamed(over: Partial<ReturnType<typeof row>> = {}): ReturnType<typeof row> {
	return row({ name: 'tools_1', token: 'tk_aaaa0001_sentinel_dev', pipeline: { project_id: 'proj-1', components: [{ id: 'tools_1', provider: 'tools', name: 'Tools' }, { id: 'db_1', provider: 'db_postgres', name: 'Shop Postgres' }] }, ...over });
}

/**
 * Discover with a client whose `listTasks` answers through `answer`.
 *
 * @param rows - The getTasks rows.
 * @param answer - The listTasks behaviour (may throw, or never settle); null = the client has no listTasks.
 * @param options - Discovery options over the single-role SQL spec.
 * @returns The found endpoints, the world, and every listTasks request.
 */
async function discoverNamed(rows: ReturnType<typeof row>[], answer: ((req: unknown) => Promise<unknown>) | null, options: Partial<IDiscoveryOptions> = {}) {
	const world = fakeWorld(rows);
	const requests: unknown[] = [];
	if (answer) {
		(world.client as IExplorerClient).listTasks = (req: unknown) => {
			requests.push(req);
			return answer(req);
		};
	}
	const found = await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE, ...options });
	return { world, found, requests };
}

/** The listTasks envelope. */
const page = (rows: Record<string, unknown>[]) => async () => ({ rows, total: rows.length, page: 1, pageSize: 100 });

/**
 * Everything discovery decides except the display name, keyed and sorted by key.
 *
 * @param found - Discovered endpoints.
 * @returns The comparable view.
 */
function withoutNames(found: IDiscoveredEndpoint[]): unknown[] {
	return found
		.map((f) => ({ ...f, endpoint: { ...f.endpoint, pipelineName: '(name)' } }))
		.sort((a, b) => a.endpoint.key.localeCompare(b.endpoint.key));
}

describe('discoverToolEndpoints — readable names (one listTasks per discovery, names only)', () => {
	it('names a covered run the way #2625 does: listTasks\'s `{task name}.{source component name}`, from ONE request', async () => {
		const run = unnamed();
		const { found, requests } = await discoverNamed([run], page([listed(run)]));
		assert.equal(found[0]!.endpoint.pipelineName, 'Shop Postgres.Tools');
		assert.deepEqual(requests, [TASK_NAMES_REQUEST]);
		assert.deepEqual(TASK_NAMES_REQUEST, { page_size: 100, filters: { completed: 'false' }, sort: [{ field: 'startTime', dir: 'desc' }] }, 'the newest 100 live tasks (the server pages at 100)');
	});

	it('falls back to the pipeline name, then the source component\'s name, then the source id, where listTasks does not name the run', async () => {
		const run = unnamed();
		const no = await discoverNamed([run], null);
		assert.equal(no.found[0]!.endpoint.pipelineName, 'Tools', 'no listTasks at all: the source component\'s name');
		const other = await discoverNamed([run], page([listed(unnamed({ token: 'tk_ffffffff00000000', pipeline: { project_id: 'proj-2', components: [] } }))]));
		assert.equal(other.found[0]!.endpoint.pipelineName, 'Tools', 'listTasks names another run only');
		const named = await discoverNamed([unnamed({ pipeline: { project_id: 'proj-1', name: 'Orders pipeline', components: [{ id: 'tools_1', provider: 'tools', name: 'Tools' }, { id: 'db_1', provider: 'db_postgres' }] } })], page([]));
		assert.equal(named.found[0]!.endpoint.pipelineName, 'Orders pipeline', 'a pipeline name comes first');
		const bare = await discoverNamed([unnamed({ pipeline: { project_id: 'proj-1', components: [{ id: 'tools_1', provider: 'tools' }, { id: 'db_1', provider: 'db_postgres' }] } })], page([]));
		assert.equal(bare.found[0]!.endpoint.pipelineName, 'tools_1', 'no names anywhere: the source id');
		const configured = await discoverNamed([unnamed({ pipeline: { project_id: 'proj-1', components: [{ id: 'tools_1', provider: 'tools', config: { name: 'Tools (config)' } } as never, { id: 'db_1', provider: 'db_postgres' }] } })], page([]));
		assert.equal(configured.found[0]!.endpoint.pipelineName, 'Tools (config)', 'the source component\'s config.name, as the engine reads it');
		const told = await discoverNamed([unnamed({ name: 'Named by the server' })], page([]));
		assert.equal(told.found[0]!.endpoint.pipelineName, 'Named by the server', 'getTasks\'s own name, when it is more than the source id, is the pipeline\'s name');
	});

	it('takes a name only for the same run (its display id), from a live row, never from a run started without a task name', async () => {
		const run = unnamed();
		for (const [what, rows] of [
			['a completed row', [listed(run, { completed: true })]],
			['a stopping row', [listed(run, { state: 4 })]],
			['another run of the same project and source', [listed(run, { id: 'ffffffff.tools_1' })]],
			['the engine\'s name for a run started without a task name: `{display id}.{component}`', [listed(run, { name: `${idOf(run)}.Tools` })]],
			['two live rows for one id that disagree', [listed(run), listed(run, { name: 'Other run.Tools' })]],
		] as const) {
			const { found } = await discoverNamed([run], page([...rows]));
			assert.equal(found[0]!.endpoint.pipelineName, 'Tools', what);
		}
		const agree = await discoverNamed([run], page([listed(run), listed(run), listed(run, { name: 'Old.Tools', completed: true })]));
		assert.equal(agree.found[0]!.endpoint.pipelineName, 'Shop Postgres.Tools', 'live rows that agree, a completed one ignored');
	});

	it('keeps a deploy run\'s pipeline name: every deploy runs without a task name', async () => {
		const deploy = unnamed({ name: 'Shop Orders', runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1', pipeline: { project_id: 'proj-1', name: 'Shop Orders', components: [{ id: 'tools_1', provider: 'tools', name: 'Tools' }, { id: 'db_1', provider: 'db_postgres' }] } });
		const { found } = await discoverNamed([deploy], page([listed(deploy, { name: `${idOf(deploy)}.Tools` })]));
		assert.equal(found[0]!.endpoint.pipelineName, 'Shop Orders');
	});

	it('never lends one run\'s name to another run of the same project, source and run kind (two teams\' deployments, one off the page)', async () => {
		const prod = unnamed({ name: 'Shop', runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1', teamId: 'team-1', token: 'tk_1111111100000000' });
		const staging = unnamed({ name: 'Shop', runKind: 'deploy', ownerKind: 'team', ownerId: 'team-2', teamId: 'team-2', token: 'tk_2222222200000000' });
		const { found } = await discoverNamed([prod, staging], page([listed(prod, { name: 'Prod Shop.Tools' })]));
		const byOwner = new Map(found.map((f) => [f.endpoint.ownerId, f.endpoint.pipelineName]));
		assert.equal(byOwner.get('team-1'), 'Prod Shop.Tools');
		assert.equal(byOwner.get('team-2'), 'Shop', 'the run listTasks did not cover keeps its own name');
	});

	it('falls back when listTasks throws, answers something unusable, never answers within its own timeout, or cannot even be read', async () => {
		const warn = mock.method(console, 'warn', () => undefined);
		try {
			for (const [what, answer] of [
				['throws at once', () => { throw new Error('no listTasks here'); }],
				['rejects', async () => { throw new Error('denied'); }],
				['answers undefined', async () => undefined],
				['answers rows that are not a list', async () => ({ rows: 'x' })],
			] as const) {
				const { found } = await discoverNamed([unnamed()], answer as (req: unknown) => Promise<unknown>);
				assert.equal(found[0]!.endpoint.pipelineName, 'Tools', what);
			}
			const started = Date.now();
			const hung = await discoverNamed([unnamed()], () => new Promise(() => undefined), { taskNamesTimeoutMs: 20 });
			assert.equal(hung.found[0]!.endpoint.pipelineName, 'Tools', 'a listTasks that never answers');
			assert.ok(Date.now() - started < 2_000, 'it waits only its own timeout');
			assert.ok(TASK_NAMES_TIMEOUT_MS > 0 && TASK_NAMES_TIMEOUT_MS <= 10_000, 'a third of the store\'s 30 s discovery bound, at most');
			const world = fakeWorld([unnamed()]);
			Object.defineProperty(world.client, 'listTasks', { get() { throw new Error('getter'); } });
			const found = await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
			assert.equal(found[0]!.endpoint.pipelineName, 'Tools', 'a listTasks that cannot be read');
		} finally {
			warn.mock.restore();
		}
	});

	it('logs a listTasks failure once per client, not once per discovery', async () => {
		const warn = mock.method(console, 'warn', () => undefined);
		try {
			const world = fakeWorld([unnamed()]);
			(world.client as IExplorerClient).listTasks = async () => { throw new Error('denied'); };
			await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
			await discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
			assert.equal(warn.mock.callCount(), 1);
		} finally {
			warn.mock.restore();
		}
	});

	it('starts listTasks with getTasks, so a slow listTasks overlaps the list call instead of following it', async () => {
		const run = unnamed();
		const world = fakeWorld([run]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		world.getTasksImpl = async () => {
			await gate;
			return world.rows.map((r) => ({ ...r })) as unknown as Array<Record<string, unknown>>;
		};
		let asked = 0;
		(world.client as IExplorerClient).listTasks = async () => {
			asked += 1;
			return { rows: [listed(run)] };
		};
		const discovery = discoverToolEndpoints(world.client, { providers: DB, roles: SINGLE_TOOLS_ROLE });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(asked, 1, 'asked before getTasks answered');
		release();
		assert.equal((await discovery)[0]!.endpoint.pipelineName, 'Shop Postgres.Tools');
	});

	it('never changes which endpoints are found, their keys, tokens or states: names only', async () => {
		const dev = unnamed();
		const deploy = unnamed({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1', token: 'tk_d3d3d3d3d3d3' });
		const zeta = unnamed({ source: 'tools_2', token: 'tk_e4e4e4e4e4e4', pipeline: { project_id: 'proj-2', name: 'Zeta', components: [{ id: 'db_9', provider: 'db_mysql' }, { id: 'db_2', provider: 'db_postgres' }] } });
		const rows = [dev, deploy, zeta, unnamed({ ownerId: 'u2', token: 'tk_f5f5f5f5f5f5', pipeline: null })];
		const plain = await discoverNamed(rows, null);
		const covered = await discoverNamed(rows, page([listed(dev), listed(deploy, { name: 'Deploy.Tools' }), listed(zeta, { name: 'Aaa first.Tools' })]));
		const warn = mock.method(console, 'warn', () => undefined);
		const failing = await discoverNamed(rows, async () => { throw new Error('denied'); }).finally(() => warn.mock.restore());
		assert.ok(plain.found.length >= 4);
		assert.notDeepEqual(covered.found.map((f) => f.endpoint.pipelineName).sort(), plain.found.map((f) => f.endpoint.pipelineName).sort(), 'listTasks was read: the names differ');
		assert.deepEqual(withoutNames(covered.found), withoutNames(plain.found));
		assert.deepEqual(withoutNames(failing.found), withoutNames(plain.found));
		assert.equal(covered.world.getTasksCalls, 1);
	});

	it('names a role-map connection by its tools run only, so the label does not change when another role\'s run is the anchor', async () => {
		const vecRow = (source: string, token: string) => row({ source, token, name: 'Vector', pipeline: { project_id: 'vp', name: 'Vector', components: [{ id: 'vec_1', provider: 'rocketride_vector', name: 'Store' }] } });
		const ingest = vecRow('ingest_1', 'tk_aaaa1111bbbb');
		const tools = vecRow('tools_1', 'tk_cccc2222dddd');
		const names = page([listed(ingest, { name: 'Vec.Ingest' }), listed(tools, { name: 'Vec.Tools' })]);
		const running = fakeWorld([ingest, tools]);
		(running.client as IExplorerClient).listTasks = names;
		assert.equal((await discoverToolEndpoints(running.client, { providers: VECTOR, roles: VECTOR_ROLES }))[0]!.endpoint.pipelineName, 'Vec.Tools');
		const toolsStopped = fakeWorld([ingest]);
		(toolsStopped.client as IExplorerClient).listTasks = names;
		assert.equal((await discoverToolEndpoints(toolsStopped.client, { providers: VECTOR, roles: VECTOR_ROLES }))[0]!.endpoint.pipelineName, 'Vector', 'the pipeline\'s name while the tools run is stopped, never the ingest run\'s');
	});
});

describe('mapWithConcurrency', () => {
	it('never runs more than the limit at once and keeps result order', async () => {
		let now = 0;
		let peak = 0;
		const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
			now += 1;
			peak = Math.max(peak, now);
			await new Promise((resolve) => setImmediate(resolve));
			now -= 1;
			return n * 2;
		});
		assert.deepEqual(out, [2, 4, 6, 8, 10, 12, 14]);
		assert.equal(peak, 3);
	});

	it('treats a limit below one as one, and an empty input as empty', async () => {
		assert.deepEqual(await mapWithConcurrency([], 4, async (n: number) => n), []);
		assert.deepEqual(await mapWithConcurrency([1, 2], 0, async (n) => n), [1, 2]);
	});
});

describe('readTaskRow', () => {
	it('reads exactly the keys a live engine sends and defaults the rest', () => {
		const live = { description: 'd', name: 'n', ownerId: 'o', ownerKind: 'user', pipeline: { project_id: 'p' }, runKind: 'dev', source: 's', status: 'ok', teamId: 't', token: 'tk' };
		assert.deepEqual(readTaskRow(live), { ...live });
		assert.equal(readTaskRow({ ...live, runKind: undefined })?.runKind, 'dev');
		assert.equal(readTaskRow({ ...live, name: '' })?.name, 's');
		assert.equal(readTaskRow({ ...live, pipeline: 'nope' })?.pipeline, null);
	});
});
