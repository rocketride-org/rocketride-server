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
// SQL-UI — ACCOUNT A TO B WITH A DELAYED READ, A DELAYED WRITE AND A PREFERENCE MUTATION
// =============================================================================
//
// What must hold when an account changes while A's requests are still in
// flight and the shell keeps mutating preferences:
//
//   dev tool    A's history read is still waiting when B signs in: its late
//               answer is dropped, B is served only B's statements, and no
//               write ever carries A's statements into B's bag;
//               A's history write is in flight when B signs in and records
//               its own run: A's file bag holds A's run, B's holds B's, and
//               neither leaks into the other;
//   full app    the history store sits on the shell's workspace preferences,
//               whose accessor object is replaced by every preference change
//               (a theme, an app switch). The mutation neither re-attaches
//               nor re-owns the store; A's pending batch is handed to A's
//               accessor before B attaches; B is never served A's statements
//               and nothing B writes carries them.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { account, createDevToolHarness, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import { PREFS_FILE_VERSION } from 'shared/explorer/devtool/prefs';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import { SQL_APP_ID } from '../src/appId';
import { resetSavedConnections } from '../src/connect';
import type { HistoryEntry } from '../src/history/types';
import { createSqlHistoryStore } from '../src/history/historyStore';
import { attachSqlController } from '../src/sqlController';
import { attachSqlFrame } from '../src/sqlFrame';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { taskRow } from './support';
import { engineScript, scriptedMirroredRealm, until } from './realm';
import { PIPELINE, postgres } from './devtoolRig';

const USER_A = account('uA', 'org-1', 'team-1');
const USER_B = account('uB', 'org-1', 'team-1');
const FP_A = 'uA|org-1|team-1';
const FP_B = 'uB|org-1|team-1';
const HISTORY_PATH = '@/User/.workspace/rocketride.sql.history.json';
const KEY = 'p1:s1:db_1';

/** A finished statement. */
const entry = (id: string, sql: string, at: number): HistoryEntry => ({ id, sql, at, ms: 3, outcome: 'rows', rows: 1, kind: 'read' });

/** A history file holding one statement for each account. */
function historyOfBoth(): unknown {
	const owner = (id: string, sql: string, at: number): unknown => ({ at: 1, prefs: { 'sql.history': { [KEY]: [entry(id, sql, at)] }, 'sql.historyRecording': {} } });
	return { version: PREFS_FILE_VERSION, owners: { [FP_A]: owner('a1', 'SELECT salary FROM a_only', 10), [FP_B]: owner('b1', 'SELECT 1', 20) } };
}

/** Whether the history file holds one of an account's runs. */
function bagHas(files: Record<string, unknown>, owner: string, id: string): boolean {
	const file = files[HISTORY_PATH] as { owners?: Record<string, { prefs?: { 'sql.history'?: Record<string, Array<{ id: string }>> } }> } | undefined;
	return (file?.owners?.[owner]?.prefs?.['sql.history']?.[KEY] ?? []).some((e) => e.id === id);
}

/** Hold the first `count` requests of the given ops that match, until released. */
function holdFirst(engine: { script: Record<string, (params: unknown) => unknown> }, ops: string[], match: (params: unknown) => boolean, count = 1): { held: () => number; release: () => void } {
	const waiting: Array<() => void> = [];
	let seen = 0;
	let holding = true;
	for (const op of ops) {
		const answer = engine.script[op]!;
		engine.script[op] = (params) => {
			if (holding && match(params) && seen < count) {
				seen += 1;
				return new Promise((resolve, reject) => { waiting.push(() => { try { resolve(answer(params)); } catch (error) { reject(error); } }); });
			}
			return answer(params);
		};
	}
	return { held: () => waiting.length, release() { holding = false; waiting.splice(0).forEach((go) => go()); } };
}

const historyFile = (params: unknown): boolean => (params as { path?: string } | null)?.path === HISTORY_PATH;

/** A VS Code-style controller and one connection frame. */
async function vscodeRig(files: Record<string, unknown>) {
	resetSavedConnections({ force: true });
	const h = createDevToolHarness(SQL_APP_ID, { json: true });
	const engine = scriptedMirroredRealm(engineScript([PIPELINE], [taskRow('p1', { ownerId: 'uA' }), taskRow('p1', { ownerId: 'uB', token: 'tk_sentinel_b' })], postgres, files));
	const sidebar = spyPeer(h.sidebarPeer);
	const controller = attachSqlController({ channel: shellProtocol.createToolChannel(sidebar.peer), ...engine.source, protocol: shellProtocol, focusTarget: null });
	const frame = attachSqlFrame({ channel: shellProtocol.createToolChannel(h.newFramePeer()), docKey: 'c-pipe', documents: { open: () => undefined, close: () => undefined }, protocol: shellProtocol });
	await settle();
	const record = (id: string, sql: string, owner: string | null) => frame.caller.callReply('sql.historyRecord', { connId: 'c-pipe', entry: entry(id, sql, 70), owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
	return { h, engine, controller, frame, record, dispose() { frame.dispose(); controller.dispose(); } };
}

describe('dev tool: A\'s history read is still in flight when B signs in', () => {
	it('its late answer is dropped: B is served only B\'s statements, and no write carries A\'s statements', async () => {
		const files: Record<string, unknown> = { [HISTORY_PATH]: historyOfBoth() };
		const r = await vscodeRig(files);
		const first = holdFirst(r.engine, ['client.fsReadJson'], historyFile);
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => first.held() === 1, 'A\'s history read to be in flight');
			// B signs in (through a drop, as the extension host does) while it waits.
			r.engine.realm.root.disconnect();
			r.engine.realm.root.connect(USER_B);
			await until(() => r.controller.core.identity.get().fingerprint === FP_B, 'B');
			first.release();
			await until(() => r.controller.history.getHistory(KEY).length > 0, 'B\'s history');
			assert.deepEqual(r.controller.history.getHistory(KEY).map((e) => e.id), ['b1'], 'only B\'s statements; A\'s late answer was dropped');
			await new Promise<void>((resolve) => { setTimeout(resolve, 1_300); });
			const writes = r.engine.requests.filter((q) => q.op === 'client.fsWriteJson' && historyFile(q.params));
			for (const write of writes) {
				const bags = (write.params as { value: { owners: Record<string, unknown> } }).value.owners;
				assert.equal(JSON.stringify(bags[FP_B] ?? null).includes('a_only'), false, 'B\'s bag never holds A\'s statements');
			}
			assert.deepEqual(r.h.violations, []);
		} finally {
			r.dispose();
		}
	});
});

describe('dev tool: A\'s history write is in flight when B signs in and records', () => {
	it('A\'s bag holds A\'s run and B\'s holds B\'s: neither leaks into the other', async () => {
		const files: Record<string, unknown> = { [HISTORY_PATH]: historyOfBoth() };
		const r = await vscodeRig(files);
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.controller.history.getHistory(KEY).some((e) => e.id === 'a1'), 'A\'s history');
			const held = holdFirst(r.engine, ['client.fsWriteJson'], historyFile);
			await r.record('a-run', 'SELECT 42 FROM a_run', FP_A);
			await until(() => held.held() === 1, 'A\'s write to be in flight', 4_000);
			r.engine.realm.root.accountChanged(USER_B);
			await until(() => r.controller.core.identity.get().fingerprint === FP_B, 'B');
			held.release();
			await until(() => r.controller.history.getHistory(KEY).some((e) => e.id === 'b1'), 'B\'s history');
			await r.record('b-run', 'SELECT 7 FROM b_run', FP_B);
			await new Promise<void>((resolve) => { setTimeout(resolve, 1_500); });
			assert.equal(bagHas(files, FP_B, 'a-run'), false, 'A\'s run is not in B\'s bag');
			assert.equal(bagHas(files, FP_A, 'b-run'), false, 'B\'s run is not in A\'s bag');
			assert.equal(r.controller.history.getHistory(KEY).some((e) => e.id === 'a-run'), false, 'B is not served A\'s run');
		} finally {
			r.dispose();
		}
	});
});

describe('full app: a preference mutation between A and B', () => {
	/** A fake workspace-preferences accessor that records which account was attached when each write came. */
	function prefsFor(values: Map<string, unknown>, log: Array<{ key: string; value: unknown }>): IPrefsAccessor {
		return {
			getPref: (key) => values.get(key),
			setPref: (key, value) => { values.set(key, value); log.push({ key, value }); },
		};
	}

	it('the accessor object is replaced by a theme change; A\'s pending batch reaches A\'s accessor first; B is served and writes none of A\'s statements', async () => {
		const store = createSqlHistoryStore();
		const values = new Map<string, unknown>();
		const log: Array<{ key: string; value: unknown }> = [];
		const accessorA = prefsFor(values, log);
		const detachA = store.attachPrefs(accessorA, FP_A);
		store.runs.emitRun(KEY, entry('a-run', 'SELECT 1 FROM a_run', 1));
		assert.deepEqual(store.getHistory(KEY).map((e) => e.id), ['a-run']);
		// The shell mutates a preference (a theme, an app switch): it hands out a NEW accessor
		// for the same identity. The bridge forwards through a stable accessor, so nothing
		// re-attaches; here the store keeps its attachment and the mutation is just another write.
		values.set('shell.theme', 'dark');
		// A signs out and B signs in: A's pending batch is handed to A's accessor, THEN B attaches.
		store.flush();
		detachA();
		const writesForA = log.length;
		const accessorB = prefsFor(new Map<string, unknown>([['shell.theme', 'dark']]), log);
		const detachB = store.attachPrefs(accessorB, FP_B);
		assert.deepEqual(store.getHistory(KEY), [], 'B is not served A\'s statements');
		store.runs.emitRun(KEY, entry('b-run', 'SELECT 2 FROM b_run', 2));
		store.flush();
		const forB = log.slice(writesForA);
		assert.ok(forB.length > 0, 'B\'s run was written');
		assert.equal(JSON.stringify(forB).includes('a_run'), false, 'nothing written for B carries A\'s statements');
		assert.equal(JSON.stringify(log.slice(0, writesForA)).includes('b_run'), false, 'nor A\'s accessor B\'s');
		detachB();
	});
});
