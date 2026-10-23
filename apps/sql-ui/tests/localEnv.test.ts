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
// T12 — THE FULL APP (`app:`) ON THE LOCAL ENV
// =============================================================================
//
// The full app owns its engine connection: its views call the realm's engine
// core directly (localEnv.ts), with the same core a dev-tool controller uses.
// Every other suite here (schema store, history, splitting, classification,
// row limits, paging, DDL, the runner's wording) runs against the app's own
// modules and so covers this path too; this suite drives the LOCAL SqlEnv end
// to end over a scripted engine, as SqlApp builds it.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import { SQL_APP_ID } from '../src/appId';
import { getSavedConnections, resetSavedConnections } from '../src/connect';
import { createSqlCore } from '../src/sqlCore';
import { LOCAL_HISTORY, createLocalSqlEnv } from '../src/localEnv';
import { taskRow } from './support';
import { SAVED_PATH, USER, engineScript, scriptedClientRealm, until } from './realm';
import { PIPELINE, postgres } from './devtoolRig';

describe('T12 — the full app path runs on the LOCAL env over its own engine core', () => {
	it('resolves, runs, discovers, saves and keeps its preferences and history where the full app keeps them', async () => {
		resetSavedConnections({ force: true });
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1'), taskRow('p2')], postgres));
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
		const values = new Map<string, unknown>();
		const prefs: IPrefsAccessor = { getPref: (key) => values.get(key), setPref: (key, value) => { values.set(key, value); } };
		const env = createLocalSqlEnv(core, true, (provider) => (provider === 'db_postgres' ? 'PostgreSQL' : undefined), prefs);
		try {
			engine.realm.login(USER);
			await until(() => getSavedConnections().length === 1, 'the saved list');
			const endpoint = await env.resolveEndpoint(PIPELINE);
			assert.equal(endpoint.connId, 'c-pipe');
			const result = await env.getSession(endpoint).execute('SELECT * FROM orders', { idempotent: true });
			assert.deepEqual(result, { rows: [{ id: 1, name: 'a' }, { id: 2, name: null }], affected_rows: 0 });
			assert.deepEqual((await env.discoverEndpoints()).map((e) => e.key), ['p1:s1:db_1', 'p2:s1:db_1']);
			await env.saveConnection({ ...PIPELINE, id: 'c-two', name: 'Two', projectId: 'p2' });
			assert.ok(engine.requests.some((q) => q.op === 'client.fsWriteJson' && (q.params as { path: string }).path === SAVED_PATH));
			assert.equal(env.serviceTitle('db_postgres'), 'PostgreSQL');
			assert.equal(env.prefs, prefs, 'the full app keeps its workspace preferences');
			assert.equal(env.history, LOCAL_HISTORY, 'and its module history store');
			assert.deepEqual(engine.requests.filter((q) => typeof q.timeoutMs !== 'number').map((q) => q.op), []);
		} finally {
			core.dispose();
		}
	});
});
