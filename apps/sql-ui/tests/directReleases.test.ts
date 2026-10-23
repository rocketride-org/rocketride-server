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
// FULL APP — STOPPING A DIRECT PIPELINE WHEN ITS LAST DOCUMENT CLOSES (T12)
// =============================================================================
//
// The full app's documents keep the endpoint key they opened; an edit to the
// connection changes the key without re-keying them. The plan groups closed
// keys by connection: the last document of a connection releases UNKEYED.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SQL_APP_ID } from '../src/appId';
import { createSqlCore } from '../src/sqlCore';
import type { SavedSqlConnection } from '../src/connect';
import { directReleasesOnClose } from '../src/directReleases';
import { USER, engineScript, scriptedClientRealm } from './realm';
import { taskRow } from './support';
import type { IFakeTaskRow } from './support';

const OLD = 'sqlconn-c-direct:tools_1:db_mysql_1';
const NEW = 'sqlconn-c-direct:tools_1:db_postgres_1';
const OTHER = 'sqlconn-c-other:tools_1:db_mysql_1';
const set = (...keys: string[]): Set<string> => new Set(keys);

describe('T12 — the full app stops a direct pipeline when the last document of its connection closes', () => {
	it('the last document closes under the key it opened before an edit: released UNKEYED (whatever the connection runs now)', () => {
		assert.deepEqual(directReleasesOnClose(set(OLD), set()), [{ connId: 'c-direct' }]);
	});

	it('another document of the connection stays open: the closed key only; when the last closes: unkeyed', () => {
		assert.deepEqual(directReleasesOnClose(set(OLD, NEW), set(NEW)), [{ connId: 'c-direct', key: OLD }]);
		assert.deepEqual(directReleasesOnClose(set(NEW), set()), [{ connId: 'c-direct' }]);
	});

	it('two documents under one key: closing one releases nothing; connections are independent; other keys are ignored', () => {
		assert.deepEqual(directReleasesOnClose(set(OLD), set(OLD)), []);
		assert.deepEqual(directReleasesOnClose(set(OLD, OTHER), set(OLD)), [{ connId: 'c-other' }]);
		assert.deepEqual(directReleasesOnClose(set('p1:s1:db_1', OLD), set()), [{ connId: 'c-direct' }]);
		assert.deepEqual(directReleasesOnClose(set(OLD, NEW), set()), [{ connId: 'c-direct' }], 'one release per connection');
	});

	it('end to end: open, edit the provider, close the last document: the edited pipeline is stopped (not left to the TTL)', async () => {
		const DIRECT: SavedSqlConnection = { id: 'c-direct', mode: 'direct', name: 'Scratch', provider: 'db_mysql', config: { host: 'db.internal' } };
		const rows: IFakeTaskRow[] = [];
		const engine = scriptedClientRealm(engineScript([DIRECT], rows, (params) => (params.tool === 'execute' ? { rows: [], affected_rows: 0 } : { dialect: 'mysql' })));
		engine.script['client.use'] = (params) => {
			const provider = (params as { pipeline: { components: Array<{ provider: string }> } }).pipeline.components[1]!.provider;
			rows.splice(0, rows.length, taskRow('sqlconn-c-direct', {
				name: 'SQL: Scratch', source: 'tools_1', token: `tk_direct_${provider}`,
				pipeline: { project_id: 'sqlconn-c-direct', name: 'SQL: Scratch', components: [{ id: 'tools_1', provider: 'tools' }, { id: `${provider}_1`, provider }] },
			}));
			return {};
		};
		engine.script['client.getTaskToken'] = () => rows[0]?.token ?? '';
		engine.script['client.terminate'] = () => ({});
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
		engine.realm.login(USER);
		try {
			const opened = await core.resolve('c-direct');
			await core.saveConnection({ ...DIRECT, provider: 'db_postgres' });
			await core.resolve('c-direct');
			const terminated = (): string[] => engine.requests.filter((q) => q.op === 'client.terminate').map((q) => (q.params as { token: string }).token);
			// What the effect did before (keyed by the closed document's key): nothing stops.
			await core.release('c-direct', opened.key);
			assert.deepEqual(terminated(), [], 'the regression: keyed by the old key, the edited pipeline was left to the TTL');
			for (const release of directReleasesOnClose(set(opened.key), set())) await core.release(release.connId, release.key);
			assert.deepEqual(terminated(), ['tk_direct_db_postgres']);
		} finally {
			core.dispose();
		}
	});

	it('the full app\'s close effect follows the plan', () => {
		const app = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'SqlApp.tsx'), 'utf8');
		assert.match(app, /for \(const release of directReleasesOnClose\(openDirectKeysRef\.current, open\)\) env\.releaseEndpoint\(release\.connId, release\.key\);/);
		assert.doesNotMatch(app, /env\.releaseEndpoint\(connId, key\)/);
	});
});
