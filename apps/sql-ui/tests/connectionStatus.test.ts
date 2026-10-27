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
// CONNECTION STATUS — what each sidebar row says about its connection
// =============================================================================
//
// A pipeline connection is Running or Stopped by the discovered endpoint whose
// legacyKey is the connection's key; a direct one is Direct, or Open while
// its temporary pipeline runs; any connection is Unreachable after it failed
// to open, until it next opens. The sidebar reads it from its bridge, in the
// realm that holds the engine core, so nothing is published for it.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONTROLLER_STATE_TOPIC } from 'shared/explorer/devtool/realm';
import { account, settle } from 'shared/explorer/devtool/testing';
import { SQL_APP_ID } from '../src/appId';
import { endpointKeyForConnection, getSavedConnections, resetSavedConnections } from '../src/connect';
import { connectionStatus } from '../src/connectionStatus';
import type { ConnectionStatusSource, DiscoveredStatus } from '../src/connectionStatus';
import { createLocalSidebarBridge } from '../src/localEnv';
import { createSqlCore } from '../src/sqlCore';
import { taskRow } from './support';
import type { IFakeTaskRow } from './support';
import { USER, engineScript, scriptedClientRealm, until } from './realm';
import { DIRECT, PIPELINE, postgres, rig } from './devtoolRig';

const PIPE_KEY = endpointKeyForConnection(PIPELINE);
const DIRECT_KEY = endpointKeyForConnection(DIRECT);

/** A discovered endpoint as status reads it. */
const found = (legacyKey: string | null, state: DiscoveredStatus['state'], stateDetail?: string): DiscoveredStatus => ({ legacyKey, state, ...(stateDetail ? { stateDetail } : {}) });

describe('connectionStatus: a pipeline connection', () => {
	it('is Running while its endpoint is ready or being probed, matched by legacyKey', () => {
		for (const state of ['ready', 'probing'] as const) {
			const status = connectionStatus(PIPELINE, [found(PIPE_KEY, state)], {});
			assert.equal(status.kind, 'running');
			assert.equal(status.label, 'Running');
			assert.match(status.detail, /Pipeline A/);
		}
	});

	it('is Stopped when its endpoint stopped or is not discovered at all; another key, or none, never matches', () => {
		assert.equal(connectionStatus(PIPELINE, [found(PIPE_KEY, 'stopped')], {}).label, 'Stopped');
		assert.equal(connectionStatus(PIPELINE, [], {}).label, 'Stopped');
		assert.equal(connectionStatus(PIPELINE, [found('p9:s1:db_1', 'ready'), found(null, 'ready')], {}).label, 'Stopped');
		assert.match(connectionStatus(PIPELINE, [], {}).detail, /not running in your workspace/);
	});

	it('the best of several runs wins (a stopped run beside a ready one is Running)', () => {
		assert.equal(connectionStatus(PIPELINE, [found(PIPE_KEY, 'stopped'), found(PIPE_KEY, 'ready')], {}).kind, 'running');
		assert.equal(connectionStatus(PIPELINE, [found(PIPE_KEY, 'stopped'), found(PIPE_KEY, 'unreachable')], {}).kind, 'unreachable');
	});

	it('is Unreachable when its node did not answer, with the store\'s own reason', () => {
		const status = connectionStatus(PIPELINE, [found(PIPE_KEY, 'unreachable', 'The node did not answer its probe.')], {});
		assert.deepEqual([status.kind, status.label, status.detail], ['unreachable', 'Unreachable', 'The node did not answer its probe.']);
	});

	it('is No access when the run is up but the signed-in role may not call it (review M5)', () => {
		const detail = 'Your role cannot call this deployment (it needs task.data; you can see it with task.monitor).';
		const status = connectionStatus(PIPELINE, [found(PIPE_KEY, 'inaccessible', detail)], {});
		assert.deepEqual([status.kind, status.label, status.detail], ['noaccess', 'No access', detail]);
		assert.equal(connectionStatus(DIRECT, [found(DIRECT_KEY, 'inaccessible')], {}).label, 'No access');
	});

	it('says nothing before the first discovery has finished', () => {
		assert.deepEqual(connectionStatus(PIPELINE, null, {}), { kind: 'unknown', label: '', detail: '' });
	});
});

describe('connectionStatus: a direct connection', () => {
	it('is Direct until its temporary pipeline runs, then Open; Direct again once it stops', () => {
		assert.equal(connectionStatus(DIRECT, null, {}).label, 'Direct');
		assert.equal(connectionStatus(DIRECT, [], {}).label, 'Direct');
		assert.equal(connectionStatus(DIRECT, [found(DIRECT_KEY, 'ready')], {}).label, 'Open');
		assert.equal(connectionStatus(DIRECT, [found(DIRECT_KEY, 'probing')], {}).label, 'Open');
		assert.equal(connectionStatus(DIRECT, [found(DIRECT_KEY, 'stopped')], {}).label, 'Direct');
		assert.equal(connectionStatus(DIRECT, [found(DIRECT_KEY, 'unreachable')], {}).label, 'Unreachable');
	});
});

describe('connectionStatus: an open failure', () => {
	it('makes any connection Unreachable with the failure\'s own text, over what discovery says', () => {
		const message = 'The pipeline \'Pipeline A\' is not running in your workspace. Start it and try again.';
		for (const [conn, discovered] of [[PIPELINE, [found(PIPE_KEY, 'ready')]], [DIRECT, null]] as const) {
			const status = connectionStatus(conn, discovered, { [conn.id]: message });
			assert.deepEqual(status, { kind: 'unreachable', label: 'Unreachable', detail: message });
		}
		assert.equal(connectionStatus(PIPELINE, [found(PIPE_KEY, 'ready')], { 'c-other': 'x' }).kind, 'running', 'another connection\'s failure is not this one\'s');
	});
});

describe('the sidebar\'s status source: discovery and open failures, in the realm that holds the core', () => {
	/** The direct connection's temporary pipeline, once it runs. */
	const directRow = (): IFakeTaskRow => taskRow('sqlconn-c-direct', {
		name: 'SQL: Scratch',
		source: 'tools_1',
		token: 'tk_sentinel_direct',
		pipeline: { project_id: 'sqlconn-c-direct', name: 'SQL: Scratch', components: [{ id: 'tools_1', provider: 'tools' }, { id: 'db_mysql_1', provider: 'db_mysql' }] },
	});
	const REFUSED = 'The server refused to start the pipeline: quota reached.';

	it('dev tool: opening a stopped pipeline leaves its row Stopped, not Unreachable; starting it makes it Running; nothing is published for it (review I1, CE1)', async () => {
		const rows = [taskRow('p1')];
		const r = await rig({ rows });
		const sources: ConnectionStatusSource[] = [];
		const off = r.mount.bridge.subscribeStatus((source) => { sources.push(source); });
		const latest = (): string => connectionStatus(PIPELINE, sources.at(-1)!.discovered, sources.at(-1)!.openErrors).label;
		try {
			assert.ok(sources.length >= 1, 'the current source is replayed at once');
			await until(() => latest() === 'Running', 'Running from discovery');
			const posts = r.spy.posts.length;

			// The pipeline stops: the task event refreshes discovery, and the row follows.
			rows.length = 0;
			r.engine.realm.emit('shell:event', { event: { event: 'apaevt_task', body: { action: 'stop' } } });
			await until(() => latest() === 'Stopped', 'Stopped after the task event', 3_000);

			// Opening it now fails because it is not running: that is what Stopped says already.
			await assert.rejects(r.env.resolveEndpoint(PIPELINE));
			await settle();
			assert.equal(latest(), 'Stopped');
			assert.deepEqual(sources.at(-1)!.openErrors, {});

			// The user starts it: the next task event's discovery shows it Running.
			rows.push(taskRow('p1'));
			r.engine.realm.emit('shell:event', { event: { event: 'apaevt_task', body: { action: 'start' } } });
			await until(() => latest() === 'Running', 'Running once the pipeline runs', 3_000);

			// None of it went through the channel: no new state topic, no event or
			// call (the sidebar's only other posts are its replies to the frame's
			// own resolve call above).
			const later = r.spy.posts.slice(posts) as Array<{ __rrtool?: string; topic?: string }>;
			assert.deepEqual(later.filter((post) => post.__rrtool !== 'state' && post.__rrtool !== 'reply'), [], 'no event or call');
			const topics = new Set(later.filter((post) => post.__rrtool === 'state').map((post) => post.topic));
			assert.deepEqual([...topics].filter((topic) => !['connections', 'history', 'identity', 'savedQueries', CONTROLLER_STATE_TOPIC].includes(String(topic))), [], 'no status topic');
		} finally {
			off();
			r.dispose();
		}
	});

	it('a failure to reach a connection is Unreachable, with its text, until discovery next shows the run up (review I1)', async () => {
		const rows = [taskRow('p1')];
		const r = await rig({ rows });
		r.engine.script['client.use'] = () => { throw new Error(REFUSED); };
		const sources: ConnectionStatusSource[] = [];
		const off = r.mount.bridge.subscribeStatus((source) => { sources.push(source); });
		const latest = (): string => connectionStatus(DIRECT, sources.at(-1)!.discovered, sources.at(-1)!.openErrors).label;
		try {
			await until(() => sources.at(-1)!.discovered !== null, 'the first discovery');
			await assert.rejects(r.env.resolveEndpoint(DIRECT));
			await until(() => latest() === 'Unreachable', 'Unreachable after the refused start');
			assert.equal(sources.at(-1)!.openErrors['c-direct'], REFUSED);
			// The pipeline is up after all (started elsewhere, or a retry by the
			// server): the next discovery shows it, and the old failure goes.
			rows.push(directRow());
			r.engine.realm.emit('shell:event', { event: { event: 'apaevt_task', body: { action: 'start' } } });
			await until(() => latest() === 'Open', 'Open once discovery shows the run', 3_000);
			assert.deepEqual(sources.at(-1)!.openErrors, {});
		} finally {
			off();
			r.dispose();
		}
	});

	it('an account change forgets the open failures', async () => {
		const r = await rig();
		r.engine.script['client.use'] = () => { throw new Error(REFUSED); };
		const sources: ConnectionStatusSource[] = [];
		const off = r.mount.bridge.subscribeStatus((source) => { sources.push(source); });
		try {
			await assert.rejects(r.env.resolveEndpoint(DIRECT));
			await until(() => sources.at(-1)!.openErrors['c-direct'] !== undefined, 'the failure');
			r.engine.realm.orgChanged('org-2');
			await until(() => Object.keys(sources.at(-1)!.openErrors).length === 0, 'the failures to be forgotten');
		} finally {
			off();
			r.dispose();
		}
	});

	it('an open that began under one account and fails under the next records nothing for the next', async () => {
		const r = await rig();
		const sources: ConnectionStatusSource[] = [];
		const off = r.mount.bridge.subscribeStatus((source) => { sources.push(source); });
		// The start answers only when released, so the open is still waiting when the account changes.
		const waiting: Array<() => void> = [];
		r.engine.script['client.use'] = () => new Promise((_resolve, reject) => { waiting.push(() => reject(new Error(REFUSED))); });
		try {
			await until(() => sources.at(-1)!.discovered !== null, 'the first discovery');
			const opening = r.env.resolveEndpoint(DIRECT);
			await until(() => waiting.length > 0, 'the open\'s start');
			r.engine.realm.orgChanged('org-2');
			r.engine.realm.accountUpdate(account('u1', 'org-2', 'team-2'));
			await until(() => r.mount.core.identity.get().known && r.mount.core.identity.get().fingerprint === 'u1|org-2|team-2', 'the next account');
			waiting.splice(0).forEach((go) => go());
			await assert.rejects(opening);
			await settle();
			assert.deepEqual(sources.at(-1)!.openErrors, {}, 'the previous account\'s failure is not the next one\'s');
		} finally {
			off();
			r.dispose();
		}
	});

	it('full app: the local bridge reads the same source from the app\'s own core', async () => {
		resetSavedConnections({ force: true });
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')], postgres));
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
		const bridge = createLocalSidebarBridge(core);
		const sources: ConnectionStatusSource[] = [];
		const off = bridge.subscribeStatus((source) => { sources.push(source); });
		try {
			engine.realm.login(USER);
			await until(() => getSavedConnections().length === 1, 'the saved list');
			await until(() => connectionStatus(PIPELINE, sources.at(-1)!.discovered, sources.at(-1)!.openErrors).label === 'Running', 'Running');
		} finally {
			off();
			core.dispose();
		}
	});

	it('the sidebar renders each row\'s status from its bridge, beside the name', () => {
		const sidebar = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'SqlSidebar.tsx'), 'utf8');
		assert.match(sidebar, /useEffect\(\(\) => bridge\.subscribeStatus\(setStatusSource\), \[bridge\]\);/);
		assert.match(sidebar, /const status = connectionStatus\(conn, statusSource\.discovered, statusSource\.openErrors\);/);
		assert.match(sidebar, /\{status\.label && <span style=\{styles\.status\(status\.kind\)\} title=\{status\.detail\}>\{status\.label\}<\/span>\}/);
	});
});

describe('connection status: the README says what the rows say', () => {
	it('names every word a row can carry', () => {
		const prose = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
		for (const word of ['Running', 'Stopped', 'Direct', 'Open', 'Unreachable', 'No access']) assert.ok(prose.includes(`**${word}**`), word);
		assert.match(prose, /from what the app already knows \(nothing is sent to find out\)/);
	});
});
