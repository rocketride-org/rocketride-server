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
// ENGINE CORE — saved connection -> running endpoint, on the shared store
// =============================================================================
//
// The core (sqlCore.ts) is what lies beneath SqlEnv wherever the engine
// connection is: the full app, or the dev tool's controller. These suites run
// it over a fake realm whose engine answers from a script, and check what it
// sends, to whom, and with what wait:
//
//   - a pipeline connection opens the caller's OWN development run (the
//     store's legacyKey), never a team deployment of the same pipeline;
//   - a direct connection starts its temp pipeline with `client.use`, then
//     finds it by discovery;
//   - nothing is discovered while no identity is known, and a dev-tool
//     controller does not discover before it is activated;
//   - the New Connection picker lists only endpoints a saved connection can
//     name (legacyKey !== null);
//   - every request names its own bus timeout.
//
// Port of f63da6e22 (discovery through the shared store), re-implemented in
// the engine core.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer/errors';
import { SQL_APP_ID } from '../src/appId';
import { endpointForConnection } from '../src/connect';
import type { SavedSqlConnection } from '../src/connect';
import { createSqlCore } from '../src/sqlCore';
import { ENV_KEYS_TIMEOUT_MS, FS_TIMEOUT_MS, RELEASE_STEP_TIMEOUT_MS, USE_TIMEOUT_MS } from '../src/sqlTimeouts';
import type { SqlCore } from '../src/sqlCore';
import { taskRow } from './support';
import type { IFakeTaskRow } from './support';
import { USER, engineScript, scriptedClientRealm, until } from './realm';
import type { IScriptedRealm } from './realm';
import type { IFakeClientRealm } from 'shared/explorer/devtool/testing';

const PIPELINE: SavedSqlConnection = { id: 'c-pipe', mode: 'pipeline', name: 'Orders', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', provider: 'db_postgres' };
const DIRECT: SavedSqlConnection = { id: 'c-direct', mode: 'direct', name: 'Scratch', provider: 'db_mysql', config: { host: 'db.internal' } };

/** The caller's own development run of project p1. */
const devRow = (): IFakeTaskRow => taskRow('p1');
/** The team's deployment of the same project. */
const deployRow = (): IFakeTaskRow => taskRow('p1', { runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1', token: 'tk_sentinel_deploy' });
/** The direct connection's temp pipeline, once `client.use` started it. */
const directRow = (): IFakeTaskRow => taskRow('sqlconn-c-direct', {
	name: 'SQL: Scratch',
	source: 'tools_1',
	token: 'tk_sentinel_direct',
	pipeline: { project_id: 'sqlconn-c-direct', name: 'SQL: Scratch', components: [{ id: 'tools_1', provider: 'tools' }, { id: 'db_mysql_1', provider: 'db_mysql' }] },
});

/**
 * A full-app core over a scripted engine, signed in.
 *
 * @param saved - The saved-connection file.
 * @param rows - The running tasks (mutable).
 * @param tool - The tool answers.
 * @returns The rig.
 */
async function rig(saved: SavedSqlConnection[], rows: IFakeTaskRow[], tool?: Parameters<typeof engineScript>[2]): Promise<{ engine: IScriptedRealm<IFakeClientRealm>; core: SqlCore }> {
	const engine = scriptedClientRealm(engineScript(saved, rows, tool));
	const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
	engine.realm.login(USER);
	return { engine, core };
}

describe('resolution: a saved connection names one running endpoint', () => {
	it('opens a pipeline connection on the caller\'s own development run, never the team deployment of the same pipeline', async () => {
		const { engine, core } = await rig([PIPELINE], [deployRow(), devRow()], (params) => (params.tool === 'execute' ? { rows: [{ ok: 1 }], affected_rows: 0 } : { dialect: 'postgres' }));
		try {
			assert.deepEqual(await core.resolve('c-pipe'), endpointForConnection(PIPELINE));
			assert.deepEqual(await core.withSession('c-pipe', (session) => session.execute('SELECT 1')), { rows: [{ ok: 1 }], affected_rows: 0 });
			const executes = engine.requests.filter((request) => request.op === 'client.tool' && (request.params as { tool: string }).tool === 'execute');
			assert.equal(executes.length, 1);
			assert.equal((executes[0]!.params as { token: string }).token, 'tk_sentinel_p1');
		} finally {
			core.dispose();
		}
	});

	it('with two matching development runs, opens the caller\'s own (the spec\'s resolution rule), whatever their order or state', async () => {
		// A second development run with the same legacy key as the caller's own.
		const second = (): IFakeTaskRow => taskRow('p1', { ownerId: 'u2', token: 'tk_sentinel_second' });
		const tool = (params: { tool: string; token: string }): unknown => {
			if (params.tool === 'execute') return { rows: [{ ok: 1 }], affected_rows: 0 };
			// The caller's own run answers its probe late, so its state is worse.
			if (params.token === 'tk_sentinel_p1') throw new Error('starting');
			return { dialect: 'postgres' };
		};
		const { engine, core } = await rig([PIPELINE], [second(), devRow()], tool as Parameters<typeof engineScript>[2]);
		try {
			await core.resolve('c-pipe');
			const matching = core.endpoints.getState().endpoints.filter((endpoint) => endpoint.legacyKey === 'p1:s1:db_1');
			assert.equal(matching.length, 2, 'two runs share the legacy key');
			await core.withSession('c-pipe', (session) => session.execute('SELECT 1'));
			const executes = engine.requests.filter((request) => request.op === 'client.tool' && (request.params as { tool: string }).tool === 'execute');
			assert.deepEqual(executes.map((request) => (request.params as { token: string }).token), ['tk_sentinel_p1']);
		} finally {
			core.dispose();
		}
	});

	it('a document opened before its direct connection was edited releases by its OLD key: the pipeline the edit started is not stopped (DA CE-R2-4)', async () => {
		const rows: IFakeTaskRow[] = [];
		const forProvider = (provider: string): IFakeTaskRow => taskRow('sqlconn-c-direct', {
			name: 'SQL: Scratch', source: 'tools_1', token: `tk_direct_${provider}`,
			pipeline: { project_id: 'sqlconn-c-direct', name: 'SQL: Scratch', components: [{ id: 'tools_1', provider: 'tools' }, { id: `${provider}_1`, provider }] },
		});
		const { engine, core } = await rig([DIRECT], rows, (params) => (params.tool === 'execute' ? { rows: [], affected_rows: 0 } : { dialect: 'mysql' }));
		engine.script['client.use'] = (params) => {
			const provider = (params as { pipeline: { components: Array<{ provider: string }> } }).pipeline.components[1]!.provider;
			rows.splice(0, rows.length, forProvider(provider));
			return {};
		};
		engine.script['client.getTaskToken'] = () => rows[0]?.token ?? '';
		engine.script['client.terminate'] = () => ({});
		const terminated = (): string[] => engine.requests.filter((q) => q.op === 'client.terminate').map((q) => (q.params as { token: string }).token);
		try {
			const before = await core.resolve('c-direct');
			await core.saveConnection({ ...DIRECT, provider: 'db_postgres' });
			const after = await core.resolve('c-direct');
			assert.notEqual(before.key, after.key, 'the edit changed the key');
			// The document opened before the edit goes away: it releases by its key.
			await core.release('c-direct', before.key);
			assert.deepEqual(terminated(), [], 'the edited connection\'s pipeline keeps running');
			// Its own document (and a delete, which names no key) do stop it.
			await core.release('c-direct', after.key);
			assert.deepEqual(terminated(), ['tk_direct_db_postgres']);
			await core.release('c-direct');
			assert.deepEqual(terminated(), ['tk_direct_db_postgres', 'tk_direct_db_postgres']);
		} finally {
			core.dispose();
		}
	});

	it('starts a direct connection\'s temp pipeline with client.use (explicit timeout), then finds it by discovery', async () => {
		const rows: IFakeTaskRow[] = [];
		const { engine, core } = await rig([DIRECT], rows);
		engine.script['client.use'] = () => {
			rows.push(directRow());
			return {};
		};
		try {
			const endpoint = await core.resolve('c-direct');
			assert.equal(endpoint.key, 'sqlconn-c-direct:tools_1:db_mysql_1');
			assert.equal(endpoint.connId, 'c-direct');
			const use = engine.requests.find((request) => request.op === 'client.use')!;
			assert.equal(use.timeoutMs, USE_TIMEOUT_MS);
			assert.deepEqual(use.params, {
				pipeline: {
					project_id: 'sqlconn-c-direct',
					source: 'tools_1',
					components: [
						{ id: 'tools_1', provider: 'tools', config: {} },
						{ id: 'db_mysql_1', provider: 'db_mysql', config: { host: 'db.internal' }, control: [{ classType: 'tool', from: 'tools_1' }] },
					],
				},
				useExisting: true,
				ttl: 900,
				name: 'SQL: Scratch',
			});
			// The pipeline is found by a discovery that ran after it was started.
			const ops = engine.ops();
			assert.ok(ops.lastIndexOf('client.getTasks') > ops.indexOf('client.use'));
		} finally {
			core.dispose();
		}
	});

	it('answers a connection whose pipeline is not running with an `unavailable` failure, not a hang or a throw of anything else', async () => {
		const { core } = await rig([PIPELINE], [deployRow()]);
		try {
			await assert.rejects(core.resolve('c-pipe'), (error: unknown) => {
				assert.ok(error instanceof ExplorerToolError);
				assert.equal(error.kind, 'unavailable');
				assert.match(error.message, /not running/);
				return true;
			});
		} finally {
			core.dispose();
		}
	});

	it('answers an unknown connection id with an `invalid` failure', async () => {
		const { core } = await rig([PIPELINE], [devRow()]);
		try {
			await assert.rejects(core.resolve('nope'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
		} finally {
			core.dispose();
		}
	});
});

describe('identity and activation gate discovery', () => {
	it('discovers nothing and reads no saved connections while no identity is known (a null account means no discovery call)', async () => {
		const engine = scriptedClientRealm(engineScript([PIPELINE], [devRow()]));
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
		try {
			await assert.rejects(core.resolve('c-pipe'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
			await assert.rejects(core.pickable(), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
			assert.equal(engine.ops().includes('client.getTasks'), false);
			assert.equal(engine.ops().includes('client.fsReadJson'), false);
		} finally {
			core.dispose();
		}
	});

	it('a dev-tool controller reads nothing, the saved list included, while nobody is signed in; its mount is the activation (#2625 9bd5d931f), so signing in reads and discovers', async () => {
		const engine = scriptedClientRealm(engineScript([PIPELINE], [devRow()]));
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'devtool', focusTarget: null });
		try {
			assert.equal(core.activation.reason(), 'lazyMount');
			await new Promise<void>((resolve) => { setTimeout(resolve, 400); });
			assert.deepEqual(engine.ops(), [], 'no engine request while the identity is unknown');
			engine.realm.login(USER);
			await until(() => engine.ops().includes('client.fsReadJson'), 'the saved list to be read');
			await until(() => engine.ops().includes('client.getTasks'), 'the first discovery');
		} finally {
			core.dispose();
		}
	});

	it('the full app reads its saved list as soon as it is signed in (its gate is open from the start)', async () => {
		const { engine, core } = await rig([PIPELINE], [devRow()]);
		try {
			await until(() => engine.ops().includes('client.fsReadJson'), 'the saved list to be read');
		} finally {
			core.dispose();
		}
	});
});

describe('the New Connection picker and the other engine calls', () => {
	it('lists only endpoints a saved connection can name: the caller\'s own development runs, keyed `projectId:source:nodeId`, with no token anywhere', async () => {
		const { core } = await rig([], [deployRow(), devRow(), taskRow('p2')]);
		try {
			const picks = await core.pickable();
			assert.deepEqual(picks.map((pick) => pick.key), ['p1:s1:db_1', 'p2:s1:db_1']);
			assert.equal(JSON.stringify(picks).includes('tk_'), false);
			assert.equal(JSON.stringify(picks).includes('k1|'), false);
		} finally {
			core.dispose();
		}
	});

	it('asks the engine for environment keys at the top level (client.getEnvironmentKeys), with an explicit timeout', async () => {
		const { engine, core } = await rig([], []);
		engine.script['client.getEnvironmentKeys'] = () => ['ROCKETRIDE_A', 'ROCKETRIDE_B', 7];
		try {
			assert.deepEqual(await core.envKeys(), ['ROCKETRIDE_A', 'ROCKETRIDE_B']);
			const request = engine.requests.find((r) => r.op === 'client.getEnvironmentKeys')!;
			assert.deepEqual(request.params, {});
			assert.equal(request.timeoutMs, ENV_KEYS_TIMEOUT_MS);
		} finally {
			core.dispose();
		}
	});

	it('stops a direct connection\'s pipeline on release (best effort), and does nothing for a pipeline connection', async () => {
		const { engine, core } = await rig([DIRECT, PIPELINE], []);
		engine.script['client.getTaskToken'] = () => 'tk_sentinel_direct';
		engine.script['client.terminate'] = () => ({});
		try {
			await until(() => engine.ops().includes('client.fsReadJson'), 'the saved list');
			await core.resolve('c-pipe').catch(() => undefined);
			await core.release('c-pipe');
			assert.equal(engine.ops().includes('client.terminate'), false);
			await core.release('c-direct');
			const token = engine.requests.find((r) => r.op === 'client.getTaskToken')!;
			assert.deepEqual(token.params, { projectId: 'sqlconn-c-direct', source: 'tools_1' });
			assert.equal(token.timeoutMs, RELEASE_STEP_TIMEOUT_MS);
			const terminate = engine.requests.find((r) => r.op === 'client.terminate')!;
			assert.deepEqual(terminate.params, { token: 'tk_sentinel_direct' });
			assert.equal(terminate.timeoutMs, RELEASE_STEP_TIMEOUT_MS);
		} finally {
			core.dispose();
		}
	});

	it('names an explicit bus timeout on every request it makes (none falls to the 120 s default)', async () => {
		const rows: IFakeTaskRow[] = [devRow()];
		const { engine, core } = await rig([PIPELINE, DIRECT], rows, (params) => (params.tool === 'execute' ? { rows: [], affected_rows: 0 } : params.tool === 'get_schema' ? { tables: {} } : { dialect: 'postgres' }));
		engine.script['client.use'] = () => { rows.push(directRow()); return {}; };
		engine.script['client.getService'] = () => ({ Pipe: {} });
		engine.script['client.validate'] = () => ({ errors: [], warnings: [] });
		engine.script['client.getEnvironmentKeys'] = () => [];
		try {
			await core.withSession('c-pipe', async (session) => { await session.execute('SELECT 1'); await session.getSchema(); await session.dialect(); });
			await core.resolve('c-direct');
			await core.pickable();
			await core.getService('db_mysql');
			await core.validate({ component: {} });
			await core.envKeys();
			const fsRead = engine.requests.find((r) => r.op === 'client.fsReadJson')!;
			assert.equal(fsRead.timeoutMs, FS_TIMEOUT_MS);
			const missing = engine.requests.filter((r) => typeof r.timeoutMs !== 'number');
			assert.deepEqual(missing.map((r) => r.op), []);
		} finally {
			core.dispose();
		}
	});
});
