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
// SAVED QUERIES — where each mount keeps them, and whose they are
// =============================================================================
//
// Dev tool: the controller keeps saved queries in their own per-user file,
// `@/User/.workspace/rocketride.sql.queries.json`, one bag per account (the
// dev-tool library's createFsPrefs, a second accessor beside history's).
// Frames read them with `sql.savedQueries` and change them with
// `sql.savedQueryEdit`, both owned calls, and follow the retained
// `savedQueries` topic's revision. Full app: the shell's workspace
// preferences, key `sql.savedQueries`, through the accessor history uses.
//
// The identity cases follow T7 for history (devtool.identity.test.ts): a
// saved query is never served to, or written for, another account, in any
// order the account can change.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ExplorerToolError } from 'shared/explorer/errors';
import { PREFS_FILE_VERSION, PREFS_FS_TIMEOUT_MS, PREFS_LOAD_ATTEMPTS } from 'shared/explorer/devtool/prefs';
import { account, createDevToolHarness, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import { SQL_APP_ID } from '../src/appId';
import { getSavedConnections, getSavedConnectionsStatus, resetSavedConnections } from '../src/connect';
import { MAX_SAVED_QUERIES, SAVED_QUERIES_PATH, SAVED_QUERIES_PREF, APP_SAVED_QUERIES_NOTICE, devToolSavedQueriesNotice, newSavedQuery } from '../src/history/savedQueries';
import type { SavedQuery } from '../src/history/savedQueries';
import { createRemoteSavedQueries } from '../src/history/remoteSavedQueries';
import { createLocalSqlEnv } from '../src/localEnv';
import { createLocalSavedQueries } from '../src/history/localSavedQueries';
import type { SavedQueriesState } from '../src/ops';
import { attachSqlController } from '../src/sqlController';
import type { SqlControllerMount } from '../src/sqlController';
import { createSqlCore } from '../src/sqlCore';
import { attachSqlFrame, sqlChannel } from '../src/sqlFrame';
import { createRemoteSqlEnv } from '../src/sqlEnv';
import { createRemoteHistory } from '../src/history/remoteHistory';
import { FS_TIMEOUT_MS, SAVED_QUERIES_LOAD_WAIT_MS, SQL_OP_TIMEOUT_MS } from '../src/sqlTimeouts';
import { taskRow } from './support';
import { SAVED_PATH, USER, engineScript, scriptedClientRealm, scriptedSocketlessRealm, until } from './realm';
import { PIPELINE, postgres, rig } from './devtoolRig';

const KEY = 'p1:s1:db_1';
const OWNER = 'u1|org-1|team-1';
const USER_A = account('uA', 'org-1', 'team-1');
const USER_B = account('uB', 'org-1', 'team-1');
const FP_A = 'uA|org-1|team-1';
const FP_B = 'uB|org-1|team-1';
const ENDPOINT = { key: KEY, connId: 'c-pipe', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', nodeName: 'Orders', provider: 'db_postgres', running: true };

/** A saved query with a fixed id. */
const saved = (id: string, sql = `SELECT ${id}`): SavedQuery => ({ id, name: `Query ${id}`, sql, at: 1_000 });

/**
 * A saved-queries file in the dev-tool library's format.
 *
 * @param owners - Each account's queries for {@link KEY}.
 * @returns The file.
 */
function queriesFile(owners: Record<string, SavedQuery[]>): unknown {
	return { version: PREFS_FILE_VERSION, owners: Object.fromEntries(Object.entries(owners).map(([owner, list]) => [owner, { at: 1, prefs: { [SAVED_QUERIES_PREF]: { [KEY]: list } } }])) };
}

/**
 * The ids an account's bag holds in the file, for {@link KEY}.
 *
 * @param files - The user store.
 * @param owner - The account.
 * @returns The ids (empty when none).
 */
function writtenIds(files: Record<string, unknown>, owner: string): string[] {
	const file = files[SAVED_QUERIES_PATH] as { owners?: Record<string, { prefs?: Record<string, Record<string, SavedQuery[]>> }> } | undefined;
	return (file?.owners?.[owner]?.prefs?.[SAVED_QUERIES_PREF]?.[KEY] ?? []).map((q) => q.id);
}

/** Whether a request is for the saved-queries file. */
const queriesFileRequest = (params: unknown): boolean => (params as { path?: string } | null)?.path === SAVED_QUERIES_PATH;

/**
 * Hold the engine's answers to some requests until released.
 *
 * @param engine - The scripted engine.
 * @param engine.script - Its script.
 * @param ops - The ops to hold.
 * @param when - Which requests of those ops to hold.
 * @returns How many are held, and release.
 */
function hold(engine: { script: Record<string, (params: unknown) => unknown> }, ops: string[], when: (params: unknown) => boolean = () => true): { held: () => number; release: () => void } {
	const waiting: Array<() => void> = [];
	let holding = true;
	for (const op of ops) {
		const answer = engine.script[op]!;
		engine.script[op] = (params) => (holding && when(params)
			? new Promise((resolve, reject) => { waiting.push(() => { try { resolve(answer(params)); } catch (error) { reject(error); } }); })
			: answer(params));
	}
	return {
		held: () => waiting.length,
		release() {
			holding = false;
			waiting.splice(0).forEach((go) => go());
		},
	};
}

/**
 * A VS Code-style controller and one connection frame (as devtool.identity
 * mounts them), with the frame's view of the saved queries.
 *
 * @param files - The user's store.
 * @returns The rig.
 */
async function vscodeRig(files: Record<string, unknown> = {}) {
	resetSavedConnections({ force: true });
	const h = createDevToolHarness(SQL_APP_ID, { json: true });
	const engine = scriptedSocketlessRealm(engineScript([PIPELINE], [taskRow('p1', { ownerId: 'uA' }), taskRow('p1', { ownerId: 'uB', token: 'tk_sentinel_b' })], postgres, files));
	const sidebar = spyPeer(h.sidebarPeer);
	const hostChannel = shellProtocol.createToolChannel(sidebar.peer);
	const mountController = (): SqlControllerMount => attachSqlController({ peer: sidebar.peer, channel: hostChannel, cm: engine.cm, protocol: shellProtocol, focusTarget: null });
	let controller = mountController();
	let view: ReturnType<typeof createRemoteSavedQueries> | null = null;
	const frame = attachSqlFrame({ peer: h.newFramePeer(), docKey: 'c-pipe', documents: { open: () => undefined, close: () => undefined }, protocol: shellProtocol, onReset: () => view?.reset() });
	view = createRemoteSavedQueries({ caller: frame.caller, channel: sqlChannel(frame.channel), owner: frame.owner });
	await settle();
	const read = (owner: string | null) => frame.caller.callReply('sql.savedQueries', { connId: 'c-pipe', owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueries'] });
	const save = (owner: string | null, query: SavedQuery) => frame.caller.callReply('sql.savedQueryEdit', { connId: 'c-pipe', edit: { action: 'add', query }, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueryEdit'] });
	return {
		h, engine, frame, read, save,
		get view() { return view!; },
		get controller() { return controller; },
		remount() { controller = mountController(); return controller; },
		dispose() {
			view?.dispose();
			frame.dispose();
			controller.dispose();
		},
	};
}

/** The saved-queries file was checked (its read began). */
const fileChecked = (r: { engine: { requests: Array<{ op: string; params: unknown }> } }) => until(() => r.engine.requests.some((q) => q.op === 'client.fsStat' && queriesFileRequest(q.params)), 'the saved-queries file check');

// =============================================================================
// THE CONTROLLER'S FILE
// =============================================================================

describe('saved queries in a dev tool: the controller keeps them in their own file, per account', () => {
	it('names the file beside the history file, and waits for it as long as the library may take to read it', () => {
		assert.equal(SAVED_QUERIES_PATH, '@/User/.workspace/rocketride.sql.queries.json');
		// Frames may not import the library's prefs module (it reaches the bus
		// client), so the wait is spelled out in sqlTimeouts and pinned here.
		assert.equal(FS_TIMEOUT_MS, PREFS_FS_TIMEOUT_MS);
		assert.equal(SAVED_QUERIES_LOAD_WAIT_MS, PREFS_LOAD_ATTEMPTS * 2 * PREFS_FS_TIMEOUT_MS + 1_000 + 3_000);
	});

	it('reads the file before it serves (stat, then read), and a frame is served what was saved, with where it is kept', async () => {
		const files: Record<string, unknown> = { [SAVED_QUERIES_PATH]: queriesFile({ [OWNER]: [saved('s1')] }) };
		const r = await rig({ files });
		try {
			const answer = await r.frame.caller.callReply('sql.savedQueries', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueries'] });
			assert.deepEqual(answer, { storage: 'file', queries: [saved('s1')] });
			const order = r.engine.requests.filter((q) => queriesFileRequest(q.params)).map((q) => q.op);
			assert.deepEqual(order.slice(0, 2), ['client.fsStat', 'client.fsReadJson']);
			assert.equal(order.includes('client.fsWriteJson'), false, 'nothing is written by reading');
		} finally {
			r.dispose();
		}
	});

	it('a frame\'s save lands in the file under the signed-in account (folder made first, debounced), beside the history file, not in it', async () => {
		const files: Record<string, unknown> = {};
		const r = await rig({ files });
		try {
			const query = newSavedQuery('Revenue', 'SELECT 1', 5);
			await r.env.savedQueries.save(ENDPOINT, query);
			await until(() => writtenIds(files, OWNER).length > 0, 'the saved-queries write', 5_000);
			assert.deepEqual(writtenIds(files, OWNER), [query.id]);
			assert.deepEqual(Object.keys((files[SAVED_QUERIES_PATH] as { owners: object }).owners), [OWNER]);
			assert.equal(JSON.stringify(files['@/User/.workspace/rocketride.sql.history.json'] ?? {}).includes(query.id), false, 'not in the history file');
			const mkdir = r.engine.requests.findIndex((q) => q.op === 'client.fsMkdir' && (q.params as { path: string }).path === '@/User/.workspace');
			const write = r.engine.requests.findIndex((q) => q.op === 'client.fsWriteJson' && queriesFileRequest(q.params));
			assert.ok(mkdir >= 0 && mkdir < write, 'the folder is made before the write');
			assert.deepEqual(r.h.violations, []);
		} finally {
			r.dispose();
		}
	});

	it('rename and delete go through the op; a change made just before the controller unmounts is still written', async () => {
		const files: Record<string, unknown> = { [SAVED_QUERIES_PATH]: queriesFile({ [OWNER]: [saved('s1'), saved('s2')] }) };
		const r = await rig({ files });
		try {
			await r.env.savedQueries.rename(ENDPOINT, 's1', 'Renamed');
			await r.env.savedQueries.remove(ENDPOINT, 's2');
			// The controller unmounts at once, inside the write debounce.
			r.mount.dispose();
			await until(() => writtenIds(files, OWNER).join() === 's1', 'the flushed write', 5_000);
			const file = files[SAVED_QUERIES_PATH] as { owners: Record<string, { prefs: Record<string, Record<string, SavedQuery[]>> }> };
			assert.equal(file.owners[OWNER]!.prefs[SAVED_QUERIES_PREF]![KEY]![0]!.name, 'Renamed');
		} finally {
			r.dispose();
		}
	});

	it('the caps refuse a save through the op, and nothing past them is written', async () => {
		const full = Array.from({ length: MAX_SAVED_QUERIES }, (_, i) => saved(`q${i}`));
		const files: Record<string, unknown> = { [SAVED_QUERIES_PATH]: queriesFile({ [OWNER]: full }) };
		const r = await rig({ files });
		try {
			await assert.rejects(r.env.savedQueries.save(ENDPOINT, saved('one-more')), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid' && /already keeps 50 saved queries/.test(error.message));
			await assert.rejects(r.env.savedQueries.save(ENDPOINT, saved('long', 'x'.repeat(20_000))), (error: unknown) => error instanceof ExplorerToolError && /holds at most 16,384 characters/.test(error.message));
			await new Promise((resolve) => setTimeout(resolve, 1_300));
			assert.equal(r.engine.requests.some((q) => q.op === 'client.fsWriteJson' && queriesFileRequest(q.params)), false, 'a refused save writes nothing');
		} finally {
			r.dispose();
		}
	});

	it('refuses a frame\'s change for another account, and an edit this app does not make', async () => {
		const r = await rig();
		try {
			const edit = (owner: string | null, change: unknown) => r.frame.caller.callReply('sql.savedQueryEdit', { connId: 'c-pipe', edit: change as never, owner }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueryEdit'] });
			await assert.rejects(edit('someone-else', { action: 'add', query: saved('x') }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			await assert.rejects(edit(null, { action: 'add', query: saved('x') }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			await assert.rejects(edit(r.frame.owner(), { action: 'clear' }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
			await assert.rejects(edit(r.frame.owner(), { action: 'add', query: { id: 'x', name: 'n', sql: 's' } }), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'invalid');
		} finally {
			r.dispose();
		}
	});

	it('never writes a file it could not read: saved queries are kept for the session, and the topic and the answer say so', async () => {
		const files: Record<string, unknown> = { [SAVED_QUERIES_PATH]: { version: 99, owners: {} } };
		const r = await rig({ files });
		const snapshots: SavedQueriesState[] = [];
		const off = r.frame.channel.onState('savedQueries', (snapshot) => { snapshots.push(snapshot as SavedQueriesState); });
		try {
			await until(() => snapshots.at(-1)?.storage === 'session', 'the session-only state');
			await r.env.savedQueries.save(ENDPOINT, saved('kept'));
			const answer = await r.frame.caller.callReply('sql.savedQueries', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueries'] });
			assert.deepEqual(answer, { storage: 'session', queries: [saved('kept')] });
			await new Promise((resolve) => setTimeout(resolve, 1_300));
			assert.equal(r.engine.requests.some((q) => q.op === 'client.fsWriteJson' && queriesFileRequest(q.params)), false);
			assert.deepEqual(files[SAVED_QUERIES_PATH], { version: 99, owners: {} }, 'the file is untouched');
		} finally {
			off();
			r.dispose();
		}
	});
});

// =============================================================================
// THE REVISION TOPIC AND A FRAME'S VIEW
// =============================================================================

describe('saved queries in a dev tool: frames follow a small revision topic, and read the list as an op result', () => {
	it('the revision moves on every change; the topic carries no query text', async () => {
		const r = await rig();
		const snapshots: SavedQueriesState[] = [];
		const off = r.frame.channel.onState('savedQueries', (snapshot) => { snapshots.push(snapshot as SavedQueriesState); });
		try {
			await until(() => snapshots.at(-1)?.storage === 'file', 'the topic');
			const before = snapshots.at(-1)!.rev;
			await r.env.savedQueries.save(ENDPOINT, saved('s1', 'SELECT secret_column FROM t'));
			await until(() => (snapshots.at(-1)?.rev ?? 0) > before, 'the revision to move');
			const after = snapshots.at(-1)!.rev;
			await r.env.savedQueries.rename(ENDPOINT, 's1', 'Another');
			await until(() => (snapshots.at(-1)?.rev ?? 0) > after, 'the revision to move again');
			assert.deepEqual(Object.keys(snapshots.at(-1)!).sort(), ['rev', 'storage']);
			assert.equal(JSON.stringify(snapshots).includes('secret_column'), false);
		} finally {
			off();
			r.dispose();
		}
	});

	it('a second document\'s view of the same connection follows a save made in the first', async () => {
		const r = await rig();
		const other = createRemoteSavedQueries({ caller: r.frame.caller, channel: sqlChannel(r.frame.channel), owner: r.frame.owner });
		try {
			other.watch(ENDPOINT);
			await until(() => other.loaded(ENDPOINT), 'the second view\'s first read');
			assert.deepEqual(other.entriesOf(ENDPOINT), []);
			await r.env.savedQueries.save(ENDPOINT, saved('from-first'));
			await until(() => other.entriesOf(ENDPOINT).length === 1, 'the second view to follow');
			assert.equal(other.entriesOf(ENDPOINT)[0]!.id, 'from-first');
			assert.match(other.privacyNotice(), /rocketride\.sql\.queries\.json/);
			// A read still in flight when the controller goes would hold its op timer.
			await until(() => r.frame.caller.pending() === 0, 'the view\'s reads to be answered');
		} finally {
			other.dispose();
			r.dispose();
		}
	});
});

describe('saved queries: what a view says while it reads (review M1, M2)', () => {
	/**
	 * A caller whose `sql.savedQueries` answers come from a script, one per read.
	 *
	 * @param reads - Each read's answer in turn: a list, an error, or 'never' (an orphaned read).
	 * @returns The caller and the ops it saw.
	 */
	const scriptedCaller = (reads: Array<SavedQuery[] | Error | 'never'>) => {
		const ops: string[] = [];
		let stored: SavedQuery[] = [];
		const caller = {
			callReply: (op: string, params: { edit?: { query: SavedQuery } }) => {
				ops.push(op);
				if (op === 'sql.savedQueries') {
					const next = reads.shift();
					if (next === 'never') return new Promise(() => undefined);
					if (next instanceof Error) return Promise.reject(next);
					return Promise.resolve({ storage: 'file', queries: next ?? stored });
				}
				stored = [params.edit!.query, ...stored];
				return Promise.resolve(null);
			},
		};
		return { caller: caller as never, ops };
	};

	it('the latest read wins: a read that is never answered does not hold back the next one (CE4)', async () => {
		const { caller, ops } = scriptedCaller(['never']);
		const view = createRemoteSavedQueries({ caller, owner: () => FP_A });
		view.watch(ENDPOINT);
		await view.save(ENDPOINT, saved('q'));
		await until(() => view.entriesOf(ENDPOINT).length === 1, 'the save to show');
		assert.deepEqual(ops, ['sql.savedQueries', 'sql.savedQueryEdit', 'sql.savedQueries']);
		assert.equal(view.readStateOf(ENDPOINT).status, 'ready');
	});

	it('an older answer that arrives after a newer one is dropped', async () => {
		let release: (value: unknown) => void = () => undefined;
		const answers: Array<Promise<unknown>> = [new Promise((resolve) => { release = resolve; }), Promise.resolve({ storage: 'file', queries: [saved('new')] })];
		const view = createRemoteSavedQueries({ caller: { callReply: () => answers.shift()! } as never, owner: () => FP_A });
		view.watch(ENDPOINT);
		view.retry(ENDPOINT);
		await until(() => view.entriesOf(ENDPOINT).length === 1, 'the newer read');
		release({ storage: 'file', queries: [saved('old'), saved('older')] });
		await settle();
		assert.deepEqual(view.entriesOf(ENDPOINT).map((q) => q.id), ['new']);
	});

	it('loading until the first answer; a failed read says why, and Retry reads again', async () => {
		const failure = new ExplorerToolError({ kind: 'unavailable', tool: 'savedQueries', message: 'Your saved queries could not be read from the server yet. Try again.' });
		let fail: (error: Error) => void = () => undefined;
		const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
		const reads: Array<Promise<unknown>> = [pending, Promise.resolve({ storage: 'file', queries: [saved('s1')] })];
		const view = createRemoteSavedQueries({ caller: { callReply: () => reads.shift()! } as never, owner: () => FP_A });
		view.watch(ENDPOINT);
		assert.deepEqual(view.readStateOf(ENDPOINT), { status: 'loading' });
		fail(failure);
		await until(() => view.readStateOf(ENDPOINT).status === 'failed', 'the failure');
		assert.deepEqual(view.readStateOf(ENDPOINT), { status: 'failed', message: failure.message });
		assert.deepEqual(view.entriesOf(ENDPOINT), []);
		view.retry(ENDPOINT);
		await until(() => view.readStateOf(ENDPOINT).status === 'ready', 'the retry');
		assert.deepEqual(view.entriesOf(ENDPOINT).map((q) => q.id), ['s1']);
	});

	it('the full app reads at once; nobody signed in, or another account, is a failure that says why', () => {
		const prefs: IPrefsAccessor = { getPref: () => ({ [KEY]: [saved('a1')] }), setPref: () => undefined };
		let owner: string | null = null;
		const view = createLocalSavedQueries(prefs, () => owner);
		assert.deepEqual(view.readStateOf(ENDPOINT), { status: 'failed', message: 'Not signed in to a RocketRide server.' });
		owner = FP_A;
		assert.deepEqual(view.readStateOf(ENDPOINT), { status: 'ready' });
		owner = FP_B;
		assert.equal(view.readStateOf(ENDPOINT).status, 'failed');
		assert.equal((view.readStateOf(ENDPOINT) as { message: string }).message, 'Signed in as a different account: reload the page to see your saved queries.');
	});

	it('the drawer says Loading, or the failure with Retry, instead of "No saved queries yet"', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const panel = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'components', 'SavedQueriesPanel.tsx'), 'utf8');
		assert.match(panel, /const readState = saved\.useReadState\(endpoint\);/);
		assert.match(panel, /readState\.status === 'loading'/);
		assert.match(panel, /readState\.status === 'failed'/);
		assert.match(panel, /onClick=\{\(\) => saved\.retry\(endpoint\)\}>Retry<\/Button>/);
		// "None yet" only once the read has answered.
		assert.ok(panel.indexOf("readState.status === 'loading'") < panel.indexOf('No saved queries yet'));
	});
});

// =============================================================================
// T7 — NEVER ACROSS ACCOUNTS, IN ANY ORDER
// =============================================================================

describe('T7 — saved queries: nothing of one account is served to, kept for, or written for another', () => {
	it('while the next account\'s file is read, the previous account\'s saved queries are never served', async () => {
		const r = await vscodeRig({ [SAVED_QUERIES_PATH]: queriesFile({ [FP_A]: [saved('a1')], [FP_B]: [saved('b1')] }) });
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() === FP_A, 'account A');
			assert.deepEqual((await r.read(FP_A)).queries.map((q) => q.id), ['a1']);

			// B's file is slow to answer.
			const slow = hold(r.engine, ['client.fsStat', 'client.fsReadJson'], queriesFileRequest);
			r.engine.realm.root.accountChanged(USER_B);
			await until(() => r.controller.core.identity.get().fingerprint === FP_B, 'account B');
			await until(() => slow.held() > 0, 'B\'s file to be asked for');
			// A frame of B asks while B's file is still being read: it waits, and is
			// never answered from A's bag.
			const reading = r.read(FP_B);
			await settle();
			await assert.rejects(r.read(FP_A), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale', 'A\'s frame is refused');
			slow.release();
			assert.deepEqual((await reading).queries.map((q) => q.id), ['b1'], 'B is served B\'s, once B\'s file is read');
			assert.equal(getSavedConnectionsStatus(), 'ready');
		} finally {
			r.dispose();
		}
	});

	it('a sign-out forgets at once: nothing is served while nobody is signed in', async () => {
		const r = await vscodeRig({ [SAVED_QUERIES_PATH]: queriesFile({ [FP_A]: [saved('a1')] }) });
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() === FP_A, 'account A');
			assert.deepEqual((await r.read(FP_A)).queries.map((q) => q.id), ['a1']);
			r.engine.realm.root.accountChanged(null);
			await until(() => !r.controller.core.identity.get().known, 'the sign-out');
			assert.equal(r.controller.savedQueries.storage(), 'none');
			await assert.rejects(r.read(FP_A), (error: unknown) => error instanceof ExplorerToolError && (error.kind === 'unavailable' || error.kind === 'stale'));
		} finally {
			r.dispose();
		}
	});

	it('A saves, then B signs in (directly, or after a moment signed out): A\'s save is never written, and B is never served it', async () => {
		for (const viaSignOut of [false, true]) {
			const files: Record<string, unknown> = {};
			const r = await vscodeRig(files);
			try {
				r.engine.realm.root.connect(USER_A);
				r.h.setHostConnection(true);
				await until(() => r.frame.owner() === FP_A, 'account A');
				await fileChecked(r);
				await settle();
				await r.save(FP_A, saved('a-last'));
				if (viaSignOut) {
					r.engine.realm.root.accountChanged(null);
					await until(() => !r.controller.core.identity.get().known, 'the sign-out');
				}
				r.engine.realm.root.accountChanged(USER_B);
				await until(() => r.controller.core.identity.get().fingerprint === FP_B, 'B');
				await new Promise((resolve) => setTimeout(resolve, 1_500));
				const writes = r.engine.requests.filter((q) => q.op === 'client.fsWriteJson' && queriesFileRequest(q.params));
				assert.equal(JSON.stringify(writes).includes('a-last'), false, `no write carries A's save (${viaSignOut ? 'via sign-out' : 'direct'})`);
				assert.deepEqual((await r.read(FP_B)).queries, [], 'B is not served it');
			} finally {
				r.dispose();
			}
		}
	});

	it('A saves, signs out, and A signs in again with the sidebar open: written for A, and only for A', async () => {
		const files: Record<string, unknown> = {};
		const r = await vscodeRig(files);
		let signedOut = false;
		const write = r.engine.script['client.fsWriteJson']!;
		r.engine.script['client.fsWriteJson'] = (params) => {
			if (signedOut) throw new Error('Not authenticated');
			return write(params);
		};
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() === FP_A, 'account A');
			await fileChecked(r);
			await settle();
			await r.save(FP_A, saved('late'));
			signedOut = true;
			r.engine.realm.root.accountChanged(null);
			await until(() => !r.controller.core.identity.get().known, 'the sign-out');
			await new Promise((resolve) => setTimeout(resolve, 1_300));
			assert.deepEqual(writtenIds(files, FP_A), [], 'nothing could be written while signed out');
			signedOut = false;
			r.engine.realm.root.accountChanged(USER_A);
			await until(() => writtenIds(files, FP_A).includes('late'), 'the save, once A is back', 3_000);
			assert.deepEqual(Object.keys((files[SAVED_QUERIES_PATH] as { owners: object }).owners), [FP_A]);
			assert.deepEqual((await r.read(FP_A)).queries.map((q) => q.id), ['late']);
		} finally {
			r.dispose();
		}
	});

	it('a frame bound to A is refused once B is signed in, reading or saving; no owner is refused too', async () => {
		const files: Record<string, unknown> = { [SAVED_QUERIES_PATH]: queriesFile({ [FP_A]: [saved('a1')], [FP_B]: [saved('b1')] }) };
		const r = await vscodeRig(files);
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() === FP_A, 'account A');
			r.engine.realm.root.accountChanged(USER_B);
			await until(() => r.controller.core.identity.get().fingerprint === FP_B && getSavedConnectionsStatus() === 'ready', 'B and B\'s list');
			for (const owner of [FP_A, null]) {
				await assert.rejects(r.read(owner), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
				await assert.rejects(r.save(owner, saved('from-a')), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			}
			assert.deepEqual((await r.read(FP_B)).queries.map((q) => q.id), ['b1'], 'control: B\'s own frame reads B\'s');
			await new Promise((resolve) => setTimeout(resolve, 1_300));
			assert.equal(JSON.stringify(files).includes('from-a'), false);
		} finally {
			r.dispose();
		}
	});

	it('a save that waits for the saved list while the account changes is refused after the lookup and never reaches B\'s file', async () => {
		const files: Record<string, unknown> = {};
		const r = await vscodeRig(files);
		try {
			const slowList = hold(r.engine, ['client.fsReadJson'], (params) => (params as { path?: string }).path === SAVED_PATH);
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() === FP_A, 'account A');
			const saving = r.save(FP_A, saved('from-a'));
			await until(() => slowList.held() > 0, 'A\'s list read');
			r.engine.script['client.fsReadJson'] = engineScript([PIPELINE], [], postgres, files)['client.fsReadJson']!;
			r.engine.realm.root.accountChanged(USER_B);
			await assert.rejects(saving, (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
			await new Promise((resolve) => setTimeout(resolve, 1_300));
			assert.equal(JSON.stringify(files).includes('from-a'), false);
		} finally {
			r.dispose();
		}
	});

	it('an account change clears the frame\'s view of the saved queries (the frame\'s reset)', async () => {
		const r = await vscodeRig({ [SAVED_QUERIES_PATH]: queriesFile({ [FP_A]: [saved('a1')] }) });
		try {
			r.engine.realm.root.connect(USER_A);
			r.h.setHostConnection(true);
			await until(() => r.frame.owner() === FP_A, 'account A');
			r.view.watch(ENDPOINT);
			await until(() => r.view.entriesOf(ENDPOINT).length === 1, 'A\'s query in the view');
			r.engine.realm.root.accountChanged(USER_B);
			await until(() => r.view.entriesOf(ENDPOINT).length === 0, 'the view to forget A\'s');
			// The view's read for A, sent as the revision moved, is refused: wait
			// for that answer so no call is in flight when the controller goes.
			await until(() => r.frame.caller.pending() === 0, 'the view\'s last read to be answered');
		} finally {
			r.dispose();
		}
	});

	it('SqlDevTool resets the frame\'s saved-queries view with its history on an identity reset', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const devTool = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'SqlDevTool.tsx'), 'utf8');
		assert.match(devTool, /onReset: \(\) => \{\s*history\?\.reset\(\);\s*saved\?\.reset\(\);\s*\}/);
		assert.match(devTool, /createRemoteSqlEnv\(mount\.frame\.caller, gates\.ready, mount\.frame\.owner, mount\.history, mount\.saved\)/);
	});
});

// =============================================================================
// THE FULL APP
// =============================================================================

describe('saved queries in the full app: the workspace preferences, through the accessor history uses', () => {
	it('saves under `sql.savedQueries` in the app\'s preferences, for the signed-in account only', async () => {
		resetSavedConnections({ force: true });
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')], postgres));
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
		const values = new Map<string, unknown>();
		const prefs: IPrefsAccessor = { getPref: (key) => values.get(key), setPref: (key, value) => { values.set(key, value); } };
		const env = createLocalSqlEnv(core, true, () => undefined, prefs);
		try {
			// Nobody signed in yet: nothing is saved, and nothing is read.
			values.set(SAVED_QUERIES_PREF, { [KEY]: [saved('stale')] });
			await assert.rejects(env.savedQueries.save(ENDPOINT, saved('early')), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'unavailable');
			assert.deepEqual(values.get(SAVED_QUERIES_PREF), { [KEY]: [saved('stale')] });
			values.delete(SAVED_QUERIES_PREF);

			engine.realm.login(USER);
			await until(() => getSavedConnections().length === 1, 'the saved list');
			await env.savedQueries.save(ENDPOINT, saved('s1'));
			await env.savedQueries.save(ENDPOINT, saved('s2'));
			await env.savedQueries.rename(ENDPOINT, 's1', 'Renamed');
			await env.savedQueries.remove(ENDPOINT, 's2');
			assert.deepEqual(values.get(SAVED_QUERIES_PREF), { [KEY]: [{ ...saved('s1'), name: 'Renamed' }] });
			await assert.rejects(env.savedQueries.rename(ENDPOINT, 'gone', 'x'), (error: unknown) => error instanceof ExplorerToolError && /no longer exists/.test(error.message));
		} finally {
			core.dispose();
		}
	});

	it('pins the account the page\'s preferences were read for: another account signing in without a reload is served nothing and saves nothing (review I2, CE2)', async () => {
		// The shell reads the workspace once per page, so after a switch the
		// preferences still hold the first account's bag.
		const bag = { [KEY]: [saved('a1')] };
		const values = new Map<string, unknown>([[SAVED_QUERIES_PREF, bag]]);
		const prefs: IPrefsAccessor = { getPref: (key) => values.get(key), setPref: (key, value) => { values.set(key, value); } };
		let owner: string | null = FP_A;
		const view = createLocalSavedQueries(prefs, () => owner);
		assert.deepEqual(view.entriesOf(ENDPOINT).map((q) => q.id), ['a1'], 'A reads A\'s');
		owner = FP_B;
		assert.deepEqual(view.entriesOf(ENDPOINT), [], 'B is not served A\'s');
		await assert.rejects(view.save(ENDPOINT, saved('from-b')), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale' && /Reload/.test(error.message));
		await assert.rejects(view.remove(ENDPOINT, 'a1'), (error: unknown) => error instanceof ExplorerToolError && error.kind === 'stale');
		assert.equal(values.get(SAVED_QUERIES_PREF), bag, 'nothing was written for B');
		owner = null;
		assert.deepEqual(view.entriesOf(ENDPOINT), []);
		owner = FP_A;
		assert.deepEqual(view.entriesOf(ENDPOINT).map((q) => q.id), ['a1'], 'A again: A\'s own');
		await view.save(ENDPOINT, saved('a2'));
		assert.deepEqual(view.entriesOf(ENDPOINT).map((q) => q.id), ['a2', 'a1']);
	});

	it('the pin outlives the env being rebuilt (a reconnect): one view per engine core', async () => {
		resetSavedConnections({ force: true });
		const engine = scriptedClientRealm(engineScript([PIPELINE], [taskRow('p1')], postgres));
		const core = createSqlCore({ cm: engine.cm, appId: SQL_APP_ID, mode: 'app', focusTarget: null });
		const prefs: IPrefsAccessor = { getPref: () => undefined, setPref: () => undefined };
		try {
			assert.equal(createLocalSqlEnv(core, true, () => undefined, prefs).savedQueries, createLocalSqlEnv(core, false, () => undefined, prefs).savedQueries);
		} finally {
			core.dispose();
		}
	});

	it('says where each mount keeps them, and that the last window to save wins in a dev tool', () => {
		assert.match(APP_SAVED_QUERIES_NOTICE, /workspace file on the server/);
		assert.match(devToolSavedQueriesNotice('file'), /rocketride\.sql\.queries\.json/);
		assert.match(devToolSavedQueriesNotice('file'), /the last one to save wins/);
		assert.match(devToolSavedQueriesNotice('session'), /this session only/);
		assert.match(devToolSavedQueriesNotice('none'), /Not saved/);
		for (const notice of [APP_SAVED_QUERIES_NOTICE, devToolSavedQueriesNotice('file'), devToolSavedQueriesNotice('session')]) assert.match(notice, /as typed, including literal values/);
	});

	it('a frame\'s env without its own view still reads and saves through the ops', async () => {
		const r = await rig();
		const history = createRemoteHistory({ caller: r.frame.caller, channel: sqlChannel(r.frame.channel), owner: r.frame.owner });
		const env = createRemoteSqlEnv(r.frame.caller, true, r.frame.owner, history);
		try {
			await env.savedQueries.save(ENDPOINT, saved('bare'));
			const answer = await r.frame.caller.callReply('sql.savedQueries', { connId: 'c-pipe', owner: r.frame.owner() }, { timeoutMs: SQL_OP_TIMEOUT_MS['sql.savedQueries'] });
			assert.deepEqual(answer.queries.map((q) => q.id), ['bare']);
		} finally {
			history.dispose();
			r.dispose();
		}
	});
});

describe('saved queries: the README says what the code does', () => {
	it('names the dev tool\'s file, the caps, and that the last window to save wins', async () => {
		const fs = await import('node:fs');
		const path = await import('node:path');
		const { MAX_SAVED_BAG_CHARS, MAX_SAVED_NAME_CHARS, MAX_SAVED_SQL_CHARS } = await import('../src/history/savedQueries');
		const prose = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');
		assert.ok(SAVED_QUERIES_PATH.endsWith('.workspace/rocketride.sql.queries.json'));
		assert.match(prose, /`\.workspace\/rocketride\.sql\.queries\.json` in your user storage on the server/);
		assert.match(prose, /so the last one to save wins\. Saved queries belong to the account that saved them/);
		assert.match(prose, new RegExp(`A connection keeps up to ${MAX_SAVED_QUERIES} saved queries; a saved query holds up to ${MAX_SAVED_SQL_CHARS.toLocaleString('en-US')} characters of statement and ${MAX_SAVED_NAME_CHARS} of name; and all saved queries together stay within ${MAX_SAVED_BAG_CHARS / 1024} KB\\.`));
		assert.match(prose, /\*\*Open\*\* puts the statement into a new query and runs nothing/);
		assert.match(prose, /another account signing in without a reload sees no saved queries and can save none until the page is reloaded/);
		assert.match(prose, /Change saved queries in one window at a time: if two windows change them, the one that saves last overwrites the other's change\./);
	});
});
