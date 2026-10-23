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
// SQL DEV TOOL — HISTORY AND PREFERENCES IN DEV-TOOL MOUNTS (§3.5)
// =============================================================================
//
// In a dev tool the controller owns SQL history, in a per-user file beside the
// saved connections, `@/User/.workspace/rocketride.sql.history.json`; frames
// read it through the retained `history` topic and the `sql.history` op, and
// change it through ops only. Nothing on a dev-tool path calls `usePrefs`:
// the pattern-check switch is session-only there.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ExplorerToolError } from 'shared/explorer/errors';
import { historyPrefsPath, PREFS_FILE_VERSION } from 'shared/explorer/devtool/prefs';
import { settle } from 'shared/explorer/devtool/testing';
import { APP_PRIVACY_NOTICE, devToolPrivacyNotice } from '../src/history/api';
import type { HistoryEntry } from '../src/history/types';
import { SESSION_PREFS } from '../src/sqlEnv';
import { SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { until } from './realm';
import { rig } from './devtoolRig';

const SRC = path.resolve(__dirname, '..', 'src');
const HISTORY_PATH = '@/User/.workspace/rocketride.sql.history.json';
const OWNER = 'u1|org-1|team-1';
const KEY = 'p1:s1:db_1';

/** A finished statement. */
const entry = (id: string, sql: string, at: number): HistoryEntry => ({ id, sql, at, ms: 3, outcome: 'rows', rows: 1, kind: 'read' });

/**
 * A history file in the dev-tool library's format.
 *
 * @param owner - The owner bag.
 * @param bag - The owner's sql.history.
 * @returns The file.
 */
function historyFile(owner: string, bag: Record<string, HistoryEntry[]>): unknown {
	return { version: PREFS_FILE_VERSION, owners: { [owner]: { at: 1, prefs: { 'sql.history': bag, 'sql.historyRecording': {} } } } };
}

describe('§3.5 — the controller keeps SQL history in the user\'s history file', () => {
	it('names the file beside the saved connections', () => {
		assert.equal(historyPrefsPath('sql'), HISTORY_PATH);
	});

	it('reads the file before it attaches (stat, then read), so a frame sees what was saved', async () => {
		const files: Record<string, unknown> = { [HISTORY_PATH]: historyFile(OWNER, { [KEY]: [entry('o1', 'SELECT 1', 10)] }) };
		const r = await rig({ files });
		try {
			const read = async (): Promise<HistoryEntry[]> => r.frame.caller.callReply('sql.history', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] });
			await until(() => r.engine.ops().includes('client.fsReadJson') && r.engine.requests.filter((q) => q.op === 'client.fsReadJson').some((q) => (q.params as { path: string }).path === HISTORY_PATH), 'the history file to be read');
			await settle();
			assert.deepEqual((await read()).map((e) => e.id), ['o1']);
			const order = r.engine.requests.filter((q) => (q.params as { path?: string })?.path === HISTORY_PATH).map((q) => q.op);
			assert.deepEqual(order.slice(0, 2), ['client.fsStat', 'client.fsReadJson']);
			assert.equal(order.includes('client.fsWriteJson'), false, 'nothing is written by reading');
		} finally {
			r.dispose();
		}
	});

	it('records a frame\'s run into the file (folder made first, debounced), under the signed-in identity', async () => {
		const files: Record<string, unknown> = {};
		const r = await rig({ files });
		try {
			await until(() => r.engine.ops().includes('client.fsStat'), 'the history file check');
			const owner = r.frame.owner();
			await r.frame.caller.callReply('sql.historyRecord', { connId: 'c-pipe', entry: entry('n1', 'SELECT 2', 20), owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
			await until(() => files[HISTORY_PATH] !== undefined, 'the history write', 5_000);
			const written = files[HISTORY_PATH] as { version: number; owners: Record<string, { prefs: Record<string, Record<string, Array<{ id: string }>>> }> };
			assert.equal(written.version, PREFS_FILE_VERSION);
			assert.deepEqual(Object.keys(written.owners), [OWNER]);
			assert.deepEqual(written.owners[OWNER]!.prefs['sql.history']![KEY]!.map((e) => e.id), ['n1']);
			const ops = r.engine.requests.map((q) => q.op);
			const mkdir = r.engine.requests.findIndex((q) => q.op === 'client.fsMkdir' && (q.params as { path: string }).path === '@/User/.workspace');
			assert.ok(mkdir >= 0 && mkdir < ops.lastIndexOf('client.fsWriteJson'), 'the folder is made before the first write');
			assert.deepEqual(r.h.violations, []);
		} finally {
			r.dispose();
		}
	});

	it('a run recorded within the store\'s debounce just before the controller unmounts is still written', async () => {
		const files: Record<string, unknown> = {};
		const r = await rig({ files });
		try {
			await until(() => r.engine.ops().includes('client.fsStat'), 'the history file check');
			await settle();
			const owner = r.frame.owner();
			await r.frame.caller.callReply('sql.historyRecord', { connId: 'c-pipe', entry: entry('last', 'SELECT 9', 90), owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
			// The controller unmounts at once (a VS Code disconnect), inside the 300 ms debounce.
			r.mount.dispose();
			await until(() => files[HISTORY_PATH] !== undefined, 'the flushed write', 5_000);
			const written = files[HISTORY_PATH] as { owners: Record<string, { prefs: Record<string, Record<string, Array<{ id: string }>>> }> };
			assert.deepEqual(written.owners[OWNER]!.prefs['sql.history']![KEY]!.map((e) => e.id), ['last']);
		} finally {
			r.dispose();
		}
	});

	it('moves a connection\'s revision when its history changes, and carries the recording switch, on the retained topic', async () => {
		const r = await rig();
		try {
			await until(() => r.engine.ops().includes('client.fsStat'), 'the history file check');
			const owner = r.frame.owner();
			const call = r.frame.caller;
			await call.callReply('sql.history', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] });
			const snapshots: Array<{ storage: string; keys: Record<string, { rev: number; recording: boolean }> }> = [];
			const off = r.frame.channel.onState('history', (snapshot) => { snapshots.push(snapshot as never); });
			try {
				await settle();
				const rev = (): number | undefined => snapshots.at(-1)?.keys[KEY]?.rev;
				const first = rev();
				assert.equal(snapshots.at(-1)?.storage, 'file');
				await call.callReply('sql.historyRecord', { connId: 'c-pipe', entry: entry('n1', 'SELECT 2', 20), owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
				await settle();
				assert.ok((rev() ?? 0) > (first ?? 0), 'a recorded run moves the revision');
				await call.callReply('sql.historyEdit', { connId: 'c-pipe', edit: { action: 'recording', on: false }, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyEdit'] });
				await settle();
				assert.equal(snapshots.at(-1)?.keys[KEY]?.recording, false);
				// Recording off: a run is not kept.
				await call.callReply('sql.historyRecord', { connId: 'c-pipe', entry: entry('n2', 'SELECT 3', 30), owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
				assert.deepEqual((await call.callReply('sql.history', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] })).map((e) => e.id), ['n1']);
			} finally {
				off();
			}
		} finally {
			r.dispose();
		}
	});

	it('refuses a frame\'s write for another identity, and a malformed entry or edit', async () => {
		const r = await rig();
		try {
			await until(() => r.engine.ops().includes('client.fsStat'), 'the history file check');
			const owner = r.frame.owner();
			const record = (value: unknown, who: string | null) => r.frame.caller.callReply('sql.historyRecord', { connId: 'c-pipe', entry: value as HistoryEntry, owner: who }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
			await assert.rejects(record(entry('x', 'SELECT 1', 1), 'someone-else'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			await assert.rejects(record({ id: 'x', sql: 'SELECT 1' }, owner), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			await assert.rejects(r.frame.caller.callReply('sql.historyEdit', { connId: 'c-pipe', edit: { action: 'wipe-everything' } as never, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyEdit'] }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			assert.deepEqual(await r.frame.caller.callReply('sql.history', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] }), []);
		} finally {
			r.dispose();
		}
	});

	it('never writes a file it could not read: history is kept for the session, and the topic says so', async () => {
		const files: Record<string, unknown> = { [HISTORY_PATH]: { not: 'the history format' } };
		const r = await rig({ files });
		try {
			const snapshots: Array<{ storage: string }> = [];
			const off = r.frame.channel.onState('history', (snapshot) => { snapshots.push(snapshot as never); });
			try {
				await until(() => snapshots.at(-1)?.storage === 'session', 'the session-only state');
				const owner = r.frame.owner();
				await r.frame.caller.callReply('sql.historyRecord', { connId: 'c-pipe', entry: entry('n1', 'SELECT 2', 20), owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
				await new Promise<void>((resolve) => { setTimeout(resolve, 1_600); });
				assert.deepEqual(files[HISTORY_PATH], { not: 'the history format' }, 'the unreadable file is left alone');
				assert.equal(r.engine.requests.some((q) => q.op === 'client.fsWriteJson' && (q.params as { path: string }).path === HISTORY_PATH), false);
				assert.deepEqual((await r.frame.caller.callReply('sql.history', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.history'] })).map((e) => e.id), ['n1'], 'kept for the session');
			} finally {
				off();
			}
		} finally {
			r.dispose();
		}
	});
});

describe('§3.5 — a frame\'s view of the controller\'s history', () => {
	it('reads a connection\'s entries, reads them again when the revision moves, and retries a read made before sign-in', async () => {
		const r = await rig({ login: false });
		try {
			const endpoint = { key: KEY, connId: 'c-pipe', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', nodeName: 'Orders', provider: 'db_postgres', running: true };
			r.history.watch(endpoint);
			await settle();
			assert.deepEqual(r.history.entriesOf(endpoint), [], 'nothing to read while nobody is signed in');
			r.engine.realm.login({ userId: 'u1', devTeam: 'team-1', organization: { id: 'org-1', teams: [{ id: 'team-1', permissions: ['task.data'] }] } });
			await until(() => r.frame.owner() !== null, 'the identity');
			const owner = r.frame.owner();
			await r.frame.caller.callReply('sql.historyRecord', { connId: 'c-pipe', entry: entry('n1', 'SELECT 1', 10), owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.historyRecord'] });
			await until(() => r.history.entriesOf(endpoint).length === 1, 'the view to read the entry');
			r.history.record(endpoint, { ...entry('n2', 'SELECT 2', 20), error: undefined } as HistoryEntry);
			await until(() => r.history.entriesOf(endpoint).length === 2, 'the view to follow the revision');
			r.history.togglePin(endpoint, 'n1');
			await until(() => r.history.entriesOf(endpoint).find((e) => e.id === 'n1')?.pinned === true, 'the pin');
			assert.deepEqual(r.h.violations, [], 'an entry with an undefined field crossed as clean JSON');
		} finally {
			r.dispose();
		}
	});
});

describe('§3.5 — no usePrefs on any dev-tool path; switches are session-only there', () => {
	it('nothing reachable from the frame mount or the controller calls usePrefs or mounts the preferences bridge', () => {
		const reach = (entry: string): string[] => {
			const seen = new Set<string>();
			const visit = (rel: string): void => {
				if (seen.has(rel)) return;
				seen.add(rel);
				const text = fs.readFileSync(path.join(SRC, rel), 'utf8');
				for (const match of text.matchAll(/^import (?!type )[^;]*?from '(\.{1,2}\/[^']+)'/gm)) {
					const target = path.normalize(path.join(path.dirname(rel), match[1] as string));
					const found = [`${target}.ts`, `${target}.tsx`, path.join(target, 'index.ts')].find((candidate) => fs.existsSync(path.join(SRC, candidate)));
					if (found) visit(found);
				}
			};
			visit(entry);
			return [...seen];
		};
		for (const entry of ['SqlDevTool.tsx', 'sqlController.ts']) {
			const files = reach(entry);
			assert.equal(files.includes('localEnv.ts'), false, `${entry} reaches the full app's env`);
			for (const file of files) {
				const text = fs.readFileSync(path.join(SRC, file), 'utf8');
				assert.doesNotMatch(text, /\busePrefs\s*\(/, `${file} (reached from ${entry}) calls usePrefs`);
				assert.doesNotMatch(text, /import \{[^}]*\busePrefs\b[^}]*\} from 'shell'/, `${file} (reached from ${entry}) imports usePrefs`);
				assert.doesNotMatch(text, /<HistoryPrefsBridge/, `${file} (reached from ${entry}) mounts the preferences bridge`);
			}
		}
		assert.equal(reach('SqlDevTool.tsx').includes('history/historyStore.ts'), false, 'frames do not hold a history store');
	});

	it('the full app keeps usePrefs (its workspace preferences) and mounts the bridge once, app-level', () => {
		const app = fs.readFileSync(path.join(SRC, 'SqlApp.tsx'), 'utf8');
		assert.match(app, /usePrefs\(\)/);
		assert.equal(app.match(/<HistoryPrefsBridge \/>/g)?.length, 1);
	});

	it('a dev-tool frame\'s switches live in this session only', () => {
		SESSION_PREFS.setPref('sql.patternChecks', { [KEY]: false });
		assert.deepEqual(SESSION_PREFS.getPref('sql.patternChecks'), { [KEY]: false });
		assert.match(fs.readFileSync(path.join(SRC, 'sqlEnv.ts'), 'utf8'), /prefs: SESSION_PREFS,/);
	});
});

describe('§3.5 — the privacy line is accurate for each mount', () => {
	it('the full app says workspace file; the dev tool says its history file, session-only, or not saved', () => {
		assert.match(APP_PRIVACY_NOTICE, /workspace file on the server/);
		assert.match(devToolPrivacyNotice('file'), /rocketride\.sql\.history\.json/);
		assert.match(devToolPrivacyNotice('file'), /last one to save wins/);
		assert.match(devToolPrivacyNotice('session'), /this session only/);
		assert.match(devToolPrivacyNotice('none'), /Not saved/);
		for (const notice of [APP_PRIVACY_NOTICE, devToolPrivacyNotice('file'), devToolPrivacyNotice('session')]) assert.match(notice, /as typed, including literal values/);
	});
});
