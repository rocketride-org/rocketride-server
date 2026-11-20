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
// SQL-UI — DEVELOP'S #2625 BEHAVIOURS, IN THEIR NEW HOME (the engine core)
// =============================================================================
//
// Develop's final SQL Explorer kept these rules in its resolver, discovery and
// saved-connection modules; the controller-op design keeps them in the core:
//
//   - a direct connection's temporary pipeline is stopped by its LAST holder:
//     a re-resolve (a remount, a second frame) is not cut off by the previous
//     holder's late release;
//   - concurrent resolutions of one direct connection start one pipeline;
//   - the New Connection picker never offers a direct temp pipeline
//     (`sqlconn-<id>`), which would let a pipeline binding alias it;
//   - a failed saved-list load is tried once more from the next call, never
//     more than once;
//   - deleting a connection stops its pipeline, and a document still on it
//     gets a clear `invalid` error at once.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer/errors';
import type { IFakeClientRealm } from 'shared/explorer/devtool/testing';
import type { SavedSqlConnection } from '../src/connect';
import { createSqlCore } from '../src/sqlCore';
import type { SqlCore } from '../src/sqlCore';
import { taskRow } from './support';
import type { IFakeTaskRow } from './support';
import { USER, engineScript, scriptedClientRealm, until } from './realm';
import type { IScriptedRealm } from './realm';

const PIPELINE: SavedSqlConnection = { id: 'c-pipe', mode: 'pipeline', name: 'Orders', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', provider: 'db_postgres' };
const DIRECT: SavedSqlConnection = { id: 'c-direct', mode: 'direct', name: 'Scratch', provider: 'db_mysql', config: { host: 'db.internal' } };

/** The direct connection's temp pipeline, once `client.use` started it. */
const directRow = (): IFakeTaskRow => taskRow('sqlconn-c-direct', {
	name: 'SQL: Scratch',
	source: 'tools_1',
	token: 'tk_direct',
	pipeline: { project_id: 'sqlconn-c-direct', name: 'SQL: Scratch', components: [{ id: 'tools_1', provider: 'tools' }, { id: 'db_mysql_1', provider: 'db_mysql' }] },
});

/**
 * A full-app core over a scripted engine, signed in, with `use` starting the direct pipeline.
 *
 * @param saved - The saved-connection file.
 * @param rows - The running tasks (mutable).
 * @returns The rig.
 */
async function rig(saved: SavedSqlConnection[], rows: IFakeTaskRow[]): Promise<{ engine: IScriptedRealm<IFakeClientRealm>; core: SqlCore; terminated: () => string[]; uses: () => number }> {
	const engine = scriptedClientRealm(engineScript(saved, rows, (params) => (params.tool === 'execute' ? { rows: [], affected_rows: 0 } : { dialect: 'mysql' })));
	engine.script['client.use'] = async () => {
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		if (rows.length === 0) rows.push(directRow());
		return {};
	};
	engine.script['client.getTaskToken'] = () => rows[0]?.token ?? '';
	engine.script['client.terminate'] = () => ({});
	const core = createSqlCore({ ...engine.source, mode: 'app', focusTarget: null });
	engine.realm.login(USER);
	await until(() => core.identity.get().known, 'the signed-in identity');
	return {
		engine,
		core,
		terminated: () => engine.requests.filter((q) => q.op === 'client.terminate').map((q) => (q.params as { token: string }).token),
		uses: () => engine.requests.filter((q) => q.op === 'client.use').length,
	};
}

describe('a direct connection\'s pipeline stops with its LAST holder', () => {
	it('two resolutions are two holders: the first release (keyed) stops nothing, the second stops it once', async () => {
		const { core, terminated } = await rig([DIRECT], []);
		try {
			const first = await core.resolve('c-direct');
			await core.resolve('c-direct');
			await core.release('c-direct', first.key);
			assert.deepEqual(terminated(), [], 'another holder is still on it');
			await core.release('c-direct', first.key);
			assert.deepEqual(terminated(), ['tk_direct']);
		} finally {
			core.dispose();
		}
	});

	it('a remount\'s late release (cleanup, then a new resolve) does not cut off the new holder', async () => {
		const { core, terminated } = await rig([DIRECT], []);
		try {
			const opened = await core.resolve('c-direct');
			// StrictMode / a tab move: the old mount releases while the new one resolves.
			const again = core.resolve('c-direct');
			await core.release('c-direct', opened.key);
			await again;
			assert.deepEqual(terminated(), [], 'the new holder keeps the pipeline');
			await core.release('c-direct', opened.key);
			assert.deepEqual(terminated(), ['tk_direct']);
		} finally {
			core.dispose();
		}
	});

	it('an unkeyed release (the full app\'s last document, a delete) stops it whatever the holders', async () => {
		const { core, terminated } = await rig([DIRECT], []);
		try {
			await core.resolve('c-direct');
			await core.resolve('c-direct');
			await core.release('c-direct');
			assert.deepEqual(terminated(), ['tk_direct']);
		} finally {
			core.dispose();
		}
	});

	it('two frames resolving at once start ONE temporary pipeline', async () => {
		const { core, uses } = await rig([DIRECT], []);
		try {
			await Promise.all([core.resolve('c-direct'), core.resolve('c-direct')]);
			assert.equal(uses(), 1, 'one `use`, shared by both resolutions');
		} finally {
			core.dispose();
		}
	});
});

describe('deleting a connection a document is still on', () => {
	it('stops its pipeline, and the other document gets a clear `invalid` error at once (no hang)', async () => {
		const { core, terminated } = await rig([DIRECT], []);
		try {
			const endpoint = await core.resolve('c-direct');
			await core.resolve('c-direct');
			await core.deleteConnection('c-direct');
			assert.deepEqual(terminated(), ['tk_direct'], 'a delete force-stops the pipeline, holders or not');
			const started = Date.now();
			await assert.rejects(core.sessionFor(endpoint).execute('SELECT 1'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && /no saved connection/i.test(error.message));
			await assert.rejects(core.resolve('c-direct'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			assert.ok(Date.now() - started < 1_000, 'answered at once, not after a timeout');
			// The closing document's own release finds no connection: nothing more is sent.
			await core.release('c-direct', endpoint.key);
			assert.equal(terminated().length, 1);
		} finally {
			core.dispose();
		}
	});
});

describe('the New Connection picker', () => {
	it('never offers a direct connection\'s temporary pipeline (it would let a pipeline binding alias a direct endpoint)', async () => {
		const rows: IFakeTaskRow[] = [taskRow('p1'), directRow()];
		const { core } = await rig([PIPELINE, DIRECT], rows);
		try {
			const keys = (await core.pickable()).map((entry) => entry.key);
			assert.deepEqual(keys, ['p1:s1:db_1']);
		} finally {
			core.dispose();
		}
	});
});

describe('a failed saved-list load is tried once more, from the next call', () => {
	it('a transient read failure: the next call reads again, once, and succeeds', async () => {
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')]));
		const good = engine.script['client.fsReadJson']!;
		let reads = 0;
		engine.script['client.fsReadJson'] = (params) => {
			reads += 1;
			if (reads === 1) throw new Error('socket closed');
			return good(params);
		};
		const core = createSqlCore({ ...engine.source, mode: 'app', focusTarget: null });
		engine.realm.login(USER);
		try {
			await until(() => reads === 1, 'the first (failed) read');
			assert.deepEqual(await core.connection('c-pipe'), PIPELINE, 'the retry from listReady loaded the list');
			assert.equal(reads, 2);
		} finally {
			core.dispose();
		}
	});

	it('a read that keeps failing is tried once more and then reported, never in a loop', async () => {
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')]));
		let reads = 0;
		engine.script['client.fsReadJson'] = () => { reads += 1; throw new Error('socket closed'); };
		const core = createSqlCore({ ...engine.source, mode: 'app', focusTarget: null });
		engine.realm.login(USER);
		try {
			await until(() => reads === 1, 'the first (failed) read');
			await assert.rejects(core.connection('c-pipe'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
			assert.equal(reads, 2, 'the first attempt and one retry');
			await assert.rejects(core.connection('c-pipe'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
			assert.equal(reads, 2, 'no further retry for this account');
		} finally {
			core.dispose();
		}
	});
});

describe('endpoint probes wait for a person (holdProbes / markUserPresent)', () => {
	it('a dev-tool controller discovers but sends no tool call until a person is present; the full app does not wait', async () => {
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')]));
		const core = createSqlCore({ ...engine.source, mode: 'devtool', focusTarget: null });
		engine.realm.login(USER);
		try {
			await until(() => engine.ops().includes('client.getTasks'), 'the first discovery');
			await new Promise<void>((resolve) => { setTimeout(resolve, 200); });
			assert.equal(engine.ops().includes('client.tool'), false, 'discovery is reads only: no probe yet');
			core.discovery.markUserPresent('user');
			await until(() => engine.ops().includes('client.tool'), 'the held probe to go out');
		} finally {
			core.dispose();
		}
		const app = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')]));
		const appCore = createSqlCore({ ...app.source, mode: 'app', focusTarget: null });
		app.realm.login(USER);
		try {
			await until(() => app.ops().includes('client.tool'), 'the full app\'s probe, with nobody holding it back');
		} finally {
			appCore.dispose();
		}
	});
});

describe('the engine tears a terminated pipeline down asynchronously', () => {
	it('a resolution straight after a release waits for the old task to go, then starts a fresh pipeline (never reuses the dying one)', async () => {
		const rows: IFakeTaskRow[] = [];
		const fresh = (token: string): IFakeTaskRow => ({ ...directRow(), token });
		const { engine, core, uses } = await rig([DIRECT], rows);
		let generation = 0;
		let terminatedAt = 0;
		engine.script['client.use'] = async () => {
			// useExisting: the dying task is reattached while it still answers; otherwise a new one starts.
			if (terminatedAt === 0 || Date.now() - terminatedAt >= 500) {
				generation += 1;
				rows.splice(0, rows.length, fresh(`tk_gen${generation}`));
			}
			return {};
		};
		// The old token keeps resolving for 500 ms after `terminate` answers (the engine's teardown).
		engine.script['client.getTaskToken'] = () => (terminatedAt !== 0 && Date.now() - terminatedAt < 500 ? 'tk_gen1' : rows[0]?.token ?? '');
		engine.script['client.terminate'] = () => { terminatedAt = Date.now(); return {}; };
		try {
			const first = await core.resolve('c-direct');
			assert.equal(rows[0]?.token, 'tk_gen1');
			await core.release('c-direct', first.key);
			const started = Date.now();
			const again = await core.resolve('c-direct');
			assert.ok(Date.now() - started >= 400, 'it waited for the teardown');
			assert.equal(uses(), 2, 'a fresh pipeline was started');
			assert.equal(rows[0]?.token, 'tk_gen2', 'and it is the new one');
			await core.sessionFor(again).execute('SELECT 1', { idempotent: true });
			const executes = engine.requests.filter((q) => q.op === 'client.tool' && (q.params as { tool: string }).tool === 'execute');
			assert.equal((executes.at(-1)?.params as { token: string }).token, 'tk_gen2', 'the statement went to the new task');
		} finally {
			core.dispose();
		}
	});
});
