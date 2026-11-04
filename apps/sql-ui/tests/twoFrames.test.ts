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
// SQL-UI — TWO FRAMES ON ONE DIRECT CONNECTION
// =============================================================================
//
// Two connection documents (frames) opened on the same direct connection:
//
//   - the controller starts ONE temporary pipeline (no second `use`);
//   - closing one frame (its `release`) never stops what the other still uses;
//   - the last frame's release stops it, once;
//   - deleting the connection while a frame is on it stops the pipeline, and
//     that frame gets a clear `invalid` error at once, not a hang.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer/errors';
import { settle, shellProtocol } from 'shared/explorer/devtool/testing';
import { attachSqlFrame, sqlChannel } from '../src/sqlFrame';
import { createRemoteSqlEnv } from '../src/sqlEnv';
import { createRemoteHistory } from '../src/history/remoteHistory';
import { taskRow } from './support';
import type { IFakeTaskRow } from './support';
import { until } from './realm';
import { DIRECT, PIPELINE, rig } from './devtoolRig';
import type { IRig } from './devtoolRig';

/** The direct connection's temp pipeline once `use` started it. */
const directRow = (): IFakeTaskRow => taskRow('sqlconn-c-direct', {
	name: 'SQL: Scratch',
	source: 'tools_1',
	token: 'tk_direct',
	pipeline: { project_id: 'sqlconn-c-direct', name: 'SQL: Scratch', components: [{ id: 'tools_1', provider: 'tools' }, { id: 'db_mysql_1', provider: 'db_mysql' }] },
});

/** A rig whose engine starts the direct pipeline on `use`, plus a second frame on the same controller. */
async function twoFrames() {
	const rows: IFakeTaskRow[] = [taskRow('p1')];
	const r = await rig({ saved: [PIPELINE, DIRECT], rows, docKey: 'c-direct', tool: (params) => (params.tool === 'execute' ? { rows: [{ ok: 1 }], affected_rows: 0 } : { dialect: 'mysql' }) });
	r.engine.script['client.use'] = async () => {
		await new Promise<void>((resolve) => { setImmediate(resolve); });
		if (rows.length === 1) rows.push(directRow());
		return {};
	};
	r.engine.script['client.getTaskToken'] = () => 'tk_direct';
	r.engine.script['client.terminate'] = () => ({});
	const second = attachSqlFrame({ channel: shellProtocol.createToolChannel(r.h.newFramePeer()), docKey: 'c-direct', documents: { open: () => undefined, close: () => undefined }, protocol: r.protocol });
	const history = createRemoteHistory({ caller: second.caller, channel: sqlChannel(second.channel), owner: second.owner });
	const env2 = createRemoteSqlEnv(second.caller, true, second.owner, history);
	await settle();
	const uses = (): number => r.engine.requests.filter((q) => q.op === 'client.use').length;
	const terminated = (): number => r.engine.requests.filter((q) => q.op === 'client.terminate').length;
	return { r, env2, second, history, uses, terminated, dispose: () => { history.dispose(); second.dispose(); r.dispose(); } };
}

describe('two frames on one direct connection', () => {
	it('start one temporary pipeline; closing one frame stops nothing; closing the last stops it once', async () => {
		const t = await twoFrames();
		try {
			const [a, b] = await Promise.all([t.r.env.resolveEndpoint(DIRECT), t.env2.resolveEndpoint(DIRECT)]);
			assert.equal(a.key, b.key);
			assert.equal(t.uses(), 1, 'no redundant temporary pipeline');

			// The first frame closes: its release is keyed by the endpoint it opened.
			t.r.env.releaseEndpoint(DIRECT.id, a.key);
			await settle();
			await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
			assert.equal(t.terminated(), 0, 'the other frame\'s endpoint is not terminated');
			const result = await t.env2.getSession(b).execute('SELECT 1', { idempotent: true });
			assert.deepEqual(result.rows, [{ ok: 1 }], 'and it still answers');

			t.env2.releaseEndpoint(DIRECT.id, b.key);
			await until(() => t.terminated() === 1, 'the last release to stop the pipeline');
			await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
			assert.equal(t.terminated(), 1, 'stopped exactly once');
		} finally {
			t.dispose();
		}
	});

	it('a delete from one frame stops the pipeline; the other frame gets a clear error at once, not a hang', async () => {
		const t = await twoFrames();
		try {
			const [a, b] = await Promise.all([t.r.env.resolveEndpoint(DIRECT), t.env2.resolveEndpoint(DIRECT)]);
			assert.equal(a.key, b.key);
			await t.r.env.deleteConnection(DIRECT);
			assert.equal(t.terminated(), 1, 'the delete stops the pipeline');
			const started = Date.now();
			await assert.rejects(t.env2.getSession(b).execute('SELECT 1', { idempotent: true }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && /no saved connection/i.test(error.message));
			assert.ok(Date.now() - started < 2_000, 'the answer came at once');
			// Its own close afterwards finds nothing to stop.
			t.env2.releaseEndpoint(DIRECT.id, b.key);
			await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
			assert.equal(t.terminated(), 1);
		} finally {
			t.dispose();
		}
	});
});
