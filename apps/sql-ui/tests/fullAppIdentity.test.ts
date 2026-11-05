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
// FULL APP — ANOTHER ACCOUNT SIGNS IN WITHOUT A RELOAD
// =============================================================================
//
// The shell keeps ONE in-memory preferences bag per app: read from the
// signed-in account's file once per page (packages/shell workspaceStore:
// `diskLoaded` is never reset, a partition is read once), and written WHOLE
// through whoever is signed in at write time, on any key's change. So after
// account A, then B, every key A left in the bag rides B's first write into
// B's file. `shellModel` below is that bag, plus the file each account's
// writes land in.
//
// The first case is the devil's advocate's counterexample (DA-R1 I1),
// ported: the same steps over the full app's real seams, asserting what the
// README says. The rest pin the full app's wiring to ONE pin per page.
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { IDataGridPersistence } from 'shell';
import { ExplorerToolError } from 'shared/explorer/errors';
import type { IPrefsAccessor } from 'shared/explorer/history/types';
import { createLocalSavedQueries } from '../src/history/localSavedQueries';
import { SAVED_QUERIES_PREF } from '../src/history/savedQueries';
import type { SavedQuery } from '../src/history/savedQueries';
import { attachPrefs, createSqlHistoryStore, historyAccess, pinHistory } from '../src/history/historyStore';
import type { HistoryEntry } from '../src/history/types';
import { ANOTHER_ACCOUNT_HISTORY, createWorkspacePin, pinnedGrids, pinnedPrefs } from '../src/history/workspacePin';
import { LOCAL_HISTORY, createLocalSqlEnv } from '../src/localEnv';
import type { SqlCore } from '../src/sqlCore';

/** The pipeline key: project:source:node, the same for every account on that project. */
const KEY = 'p1:s1:db_1';
const ENDPOINT = { key: KEY, connId: 'c1', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', nodeName: 'Orders', provider: 'db_postgres', running: true };
const FP_A = 'uA|org-1|team-1';
const FP_B = 'uB|org-1|team-1';

/** Longer than the history store's 300 ms write debounce. */
const wait = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A finished statement, as the runner records it. */
const run = (id: string, sql: string): HistoryEntry => ({ id, sql, at: 1, ms: 1, outcome: 'affected', kind: 'write', affected: 1 });

/** A saved query with a fixed id. */
const saved = (id: string, name: string, sql: string): SavedQuery => ({ id, name, sql, at: 1 });

/**
 * The shell's preferences for the SQL app, as the workspace store keeps them:
 * one bag read once per page, written whole into the file of whoever is
 * signed in when a key changes.
 *
 * @param owner - Who is signed in at first.
 * @returns The bag's accessor, the files written so far, and who is signed in.
 */
function shellModel(owner: string | null): { prefs: IPrefsAccessor; bag: Map<string, unknown>; files: Map<string, string>; signIn(next: string | null): void; owner(): string | null } {
	const bag = new Map<string, unknown>();
	const files = new Map<string, string>();
	let now = owner;
	return {
		bag,
		files,
		prefs: {
			getPref: (key) => bag.get(key),
			setPref: (key, value) => {
				bag.set(key, value);
				if (now !== null) files.set(now, JSON.stringify(Object.fromEntries(bag)));
			},
		},
		signIn: (next) => { now = next; },
		owner: () => now,
	};
}

/**
 * A full-app engine core as far as the env reads it: who is signed in.
 *
 * @param owner - Who is signed in now.
 * @returns The core.
 */
function coreFor(owner: () => string | null): SqlCore {
	return { identity: { get: () => (owner() === null ? { known: false } : { known: true, fingerprint: owner() }) } } as unknown as SqlCore;
}

describe('full app: A, then B without a reload (DA-R1 I1)', () => {
	it('B is served none of A\'s history or saved queries, nothing is written while B is signed in, and B\'s file never holds A\'s', async () => {
		const shell = shellModel(FP_A);
		const pin = createWorkspacePin();

		// A saves a query and runs a statement.
		const savedQueries = createLocalSavedQueries(shell.prefs, shell.owner, pin);
		await savedQueries.save(ENDPOINT, saved('a1', 'A payroll', "SELECT ssn FROM people WHERE name = 'Alice'"));
		const store = createSqlHistoryStore();
		const history = pinHistory(store, pin);
		let detach = history.attachPrefs(shell.prefs, FP_A);
		store.runs.emitRun(KEY, run('h1', "UPDATE people SET salary = 1 WHERE name = 'Alice'"));
		await wait();
		assert.match(shell.files.get(FP_A) ?? '', /A payroll/, 'A\'s own writes land in A\'s file');

		// B signs in without a reload: the bridge attaches again under B.
		shell.signIn(FP_B);
		const filesBefore = new Map(shell.files);
		detach();
		detach = history.attachPrefs(shell.prefs, FP_B);
		assert.equal(history.access(), 'another');
		assert.deepEqual(store.getHistory(KEY), [], 'B is never shown A\'s history');
		assert.deepEqual(savedQueries.entriesOf(ENDPOINT), [], 'B is never shown A\'s saved queries');

		// B runs a statement, and tries to save a query.
		store.runs.emitRun(KEY, run('h2', 'SELECT 1'));
		await assert.rejects(savedQueries.save(ENDPOINT, saved('b1', 'B query', 'SELECT 2')), (error: unknown) => error instanceof ExplorerToolError && /different account/.test(error.message));
		await wait();
		assert.equal(shell.files.has(FP_B), false, 'nothing was written while B is signed in');
		assert.deepEqual(shell.files, filesBefore);

		// B reloads: the shell reads B's own file, which none of A's data reached.
		const reloaded = new Map(Object.entries(JSON.parse(shell.files.get(FP_B) ?? '{}') as Record<string, unknown>));
		const afterReload = createLocalSavedQueries({ getPref: (key) => reloaded.get(key), setPref: () => undefined }, () => FP_B, createWorkspacePin());
		assert.deepEqual(afterReload.entriesOf(ENDPOINT), []);
		detach();
	});

	it('A, back again before a reload, is served A\'s own history and can save again', async () => {
		const shell = shellModel(FP_A);
		const pin = createWorkspacePin();
		const store = createSqlHistoryStore();
		const history = pinHistory(store, pin);
		let detach = history.attachPrefs(shell.prefs, FP_A);
		store.runs.emitRun(KEY, run('h1', 'SELECT a'));
		await wait();
		shell.signIn(FP_B);
		detach();
		detach = history.attachPrefs(shell.prefs, FP_B);
		store.runs.emitRun(KEY, run('h2', 'SELECT b'));
		shell.signIn(FP_A);
		detach();
		detach = history.attachPrefs(shell.prefs, FP_A);
		assert.equal(history.access(), 'owner');
		assert.deepEqual(store.getHistory(KEY).map((e) => e.id), ['h1'], 'A\'s own, and nothing B ran');
		detach();
	});

	it('signed out, nothing is read or written either', () => {
		const shell = shellModel(null);
		shell.bag.set(SAVED_QUERIES_PREF, { [KEY]: [saved('x', 'X', 'SELECT 1')] });
		const pin = createWorkspacePin();
		const store = createSqlHistoryStore();
		const history = pinHistory(store, pin);
		const detach = history.attachPrefs(shell.prefs, null);
		assert.equal(history.access(), 'nobody');
		assert.equal(pinnedPrefs(pin, shell.prefs, shell.owner).getPref(SAVED_QUERIES_PREF), undefined);
		detach();
	});
});

describe('full app: one pin per page, over every preference SQL Explorer reads or writes', () => {
	it('the first account seen binds; nobody and another account read nothing and write nothing', () => {
		const pin = createWorkspacePin();
		assert.equal(pin.access(null), 'nobody', 'nobody binds nothing');
		assert.equal(pin.access(FP_A), 'owner');
		assert.equal(pin.access(FP_B), 'another');
		assert.equal(pin.access(FP_A), 'owner', 'the first account back is served its own bag');
	});

	it('pinnedPrefs and pinnedGrids pass through for the pinned account only', () => {
		const shell = shellModel(FP_A);
		const pin = createWorkspacePin();
		const prefs = pinnedPrefs(pin, shell.prefs, shell.owner);
		const layouts = new Map<string, unknown>();
		const writes: string[] = [];
		const inner: IDataGridPersistence = {
			read: (id, type) => layouts.get(`${id}/${type}`) ?? false,
			write: (id, type, data) => { writes.push(`write ${id}/${type}`); layouts.set(`${id}/${type}`, data); },
			clear: (id) => { writes.push(`clear ${id}`); },
		};
		const grids = pinnedGrids(pin, inner, shell.owner);
		prefs.setPref('k', 1);
		grids.write('t', 'sort', [1]);
		assert.equal(prefs.getPref('k'), 1);
		assert.deepEqual(grids.read('t', 'sort'), [1]);
		shell.signIn(FP_B);
		assert.equal(prefs.getPref('k'), undefined, 'B reads none of A\'s switches');
		assert.equal(grids.read('t', 'sort'), false, 'or A\'s layouts');
		prefs.setPref('k', 2);
		grids.write('t', 'sort', [2]);
		grids.clear('t');
		assert.equal(shell.bag.get('k'), 1, 'and writes nothing');
		assert.deepEqual(writes, ['write t/sort']);
	});

	it('the full app\'s history bridge, history API and env all answer to the same page-wide pin', async () => {
		const shell = shellModel(FP_A);
		const env = createLocalSqlEnv(coreFor(shell.owner), true, () => undefined, shell.prefs);
		let detach = attachPrefs(shell.prefs, FP_A);
		LOCAL_HISTORY.record(ENDPOINT, run('h1', 'SELECT a'));
		await env.savedQueries.save(ENDPOINT, saved('a1', 'A payroll', 'SELECT ssn FROM people'));
		env.prefs.setPref('sql.someSwitch', true);
		await wait();
		assert.equal(historyAccess(), 'owner');
		const written = shell.files.get(FP_A) ?? '';
		assert.match(written, /SELECT a/);
		assert.match(written, /A payroll/);

		// B signs in without a reload; a new engine core (the app switched away
		// and back) must not start a new pin.
		shell.signIn(FP_B);
		detach();
		detach = attachPrefs(shell.prefs, FP_B);
		const remounted = createLocalSqlEnv(coreFor(shell.owner), true, () => undefined, shell.prefs);
		assert.equal(historyAccess(), 'another');
		LOCAL_HISTORY.record(ENDPOINT, run('h2', 'SELECT b'));
		LOCAL_HISTORY.setRecording(ENDPOINT, false);
		LOCAL_HISTORY.clearForKey(ENDPOINT);
		await assert.rejects(remounted.savedQueries.save(ENDPOINT, saved('b1', 'B', 'SELECT 2')));
		await assert.rejects(env.savedQueries.save(ENDPOINT, saved('b2', 'B', 'SELECT 3')));
		assert.equal(remounted.prefs.getPref('sql.someSwitch'), undefined);
		remounted.prefs.setPref('sql.someSwitch', false);
		await wait();
		assert.equal(shell.files.has(FP_B), false, 'nothing SQL Explorer did was written for B');
		assert.equal(ANOTHER_ACCOUNT_HISTORY, 'Signed in as a different account: reload the page to see your history.');
		detach();
	});
});

describe('full app: the drawers neither show nor save anything for another account', () => {
	const source = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', 'src', rel), 'utf8');

	it('the History drawer shows the refusal, turns its switches off, and keeps its width unsaved', () => {
		const panel = source('components/HistoryPanel.tsx');
		assert.match(panel, /const refusal = history\.useRefusal\(\);/);
		assert.match(panel, /persistKey=\{refusal === null \? 'sqlHistoryWidth' : undefined\}/);
		assert.match(panel, /disabled=\{refusal !== null\}/);
	});

	it('the Saved drawer keeps its width unsaved while it cannot read', () => {
		const panel = source('components/SavedQueriesPanel.tsx');
		assert.match(panel, /persistKey=\{readState\.status === 'failed' \? undefined : 'sqlSavedQueriesWidth'\}/);
	});

	it('a dev-tool frame never refuses: its controller keeps one file per account', () => {
		assert.match(source('history/remoteHistory.ts'), /useRefusal: \(\) => null/);
	});
});

describe('full app identity: the README says what the code does (DA-R1 I1)', () => {
	const prose = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8').replace(/\s+/g, ' ');

	it('states the condition instead of "never"', () => {
		assert.doesNotMatch(prose, /one account's statements never reach another's file/);
		assert.match(prose, /after another account signs in without a reload the app shows that account no history, records none of its statements, and saves nothing to the workspace preferences \(no history, saved query, grid layout or drawer width\) until the page is reloaded\./);
		assert.match(prose, new RegExp(`The History drawer says \`${ANOTHER_ACCOUNT_HISTORY.replace(/[.:]/g, '\\$&')}\``));
		// The shell writes the bag it holds on every app switch
		// (workspaceStore switchApp -> writeAppNow), not only on a setting (DA-R2 N1).
		assert.match(prose, /A write the shell itself makes in that time, such as switching to another app or changing the theme, still writes the preferences it holds, the first account's history and saved queries among them, into the signed-in account's file, so reload the page before working as another account\./);
		assert.match(prose, /- \*\*Accounts in the full app\.\*\* A write the shell makes itself, such as switching to another app or changing the theme, can still copy the previous account's history and saved queries into a new account's file until you reload/);
		assert.match(prose, /As a dev tool, each account has its own section of the file, so one account's saved queries are never shown to or written for another\./);
	});
});
