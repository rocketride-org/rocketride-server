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
// TEST SUPPORT — a realm whose engine answers from a script
// =============================================================================
//
// The dev-tool library's fake realms (shared/explorer/devtool/testing) stand
// in for a ConnectionManager's identity, connection and activation events.
// Their `request` refuses everything; these helpers replace it with a script
// per bus op, and record every request with the timeout it named, so a test
// can check what the engine core sends and how long it waits. Not a test
// file (the runner only collects *.test.ts).
// =============================================================================

import { account, createFakeClientRealm, createFakeSocketlessRealm } from 'shared/explorer/devtool/testing';
import type { IFakeClientRealm, IFakeSocketlessRealm } from 'shared/explorer/devtool/testing';
import type { SqlCoreBus } from '../src/sqlCore';
import type { SavedSqlConnection } from '../src/connect';
import type { IFakeTaskRow } from './support';

/** One bus request the code under test made. */
export interface IRequest {
	/** The op wire name. */
	op: string;
	/** Its params. */
	params: unknown;
	/** The bus timeout it named (undefined: none, which the 120 s default would fill). */
	timeoutMs: number | undefined;
}

/** A script: what each bus op answers (throw to fail it). */
export type BusScript = Record<string, (params: unknown) => unknown>;

/** A realm with a scripted engine. */
export interface IScriptedRealm<R> {
	/** The fake realm (identity, connection and activation events). */
	realm: R;
	/** Its ConnectionManager with the scripted `request`. */
	cm: SqlCoreBus;
	/** Every request, in order. */
	requests: IRequest[];
	/** The script (mutable: a test may change an answer mid-way). */
	script: BusScript;
	/** The ops requested, in order. */
	ops(): string[];
}

/**
 * Wrap a fake realm's manager with a scripted `request`.
 *
 * @param realm - The fake realm.
 * @param cm - Its manager.
 * @param script - What each op answers.
 * @returns The scripted realm.
 */
function scripted<R>(realm: R, cm: object, script: BusScript): IScriptedRealm<R> {
	const requests: IRequest[] = [];
	const scriptedCm = {
		...cm,
		request: async (op: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown> => {
			requests.push({ op, params, timeoutMs: opts?.timeoutMs });
			// As the real host does: nothing is answered while the realm is down.
			const live = (cm as { isConnected?: () => boolean }).isConnected;
			if (typeof live === 'function' && !live()) throw new Error('Not connected to server');
			const answer = script[op];
			if (!answer) throw new Error(`No scripted answer for ${op}`);
			return answer(params);
		},
	} as unknown as SqlCoreBus;
	return { realm, cm: scriptedCm, requests, script, ops: () => requests.map((request) => request.op) };
}

/**
 * A rocket-ui-style realm (it owns the client) with a scripted engine.
 *
 * @param script - What each op answers.
 * @returns The scripted realm.
 */
export function scriptedClientRealm(script: BusScript): IScriptedRealm<IFakeClientRealm> {
	const realm = createFakeClientRealm();
	return scripted(realm, realm.cm, script);
}

/**
 * A VS Code-style (socketless) realm with a scripted engine.
 *
 * @param script - What each op answers.
 * @returns The scripted realm.
 */
export function scriptedSocketlessRealm(script: BusScript): IScriptedRealm<IFakeSocketlessRealm> {
	const realm = createFakeSocketlessRealm();
	return scripted(realm, realm.cm, script);
}

/** The signed-in user the suites use. */
export const USER = account('u1', 'org-1', 'team-1');

/** The saved-connection file (scope-less: the user's store). */
export const SAVED_PATH = '.workspace/rocketride.sql.json';

/**
 * A script for an engine with these saved connections and running tasks.
 *
 * @param saved - The saved-connection file's contents.
 * @param rows - What `client.getTasks` lists (read at call time: mutate it to change the answer).
 * @param tool - What `client.tool` answers.
 * @param files - Other files in the user's store, by path (mutable: writes land here).
 * @param listed - What `client.listTasks` lists, as the server's rows (default none, so names
 *   fall back to getTasks's; a test of the readable names scripts them).
 * @returns The script.
 */
export function engineScript(saved: SavedSqlConnection[], rows: IFakeTaskRow[], tool: (params: { token: string; tool: string; input?: Record<string, unknown>; timeout?: number }) => unknown = () => ({ dialect: 'postgres' }), files: Record<string, unknown> = {}, listed: Record<string, unknown>[] = []): BusScript {
	const read = (path: string): unknown => (path === SAVED_PATH ? saved : files[path]);
	return {
		'client.fsMkdir': () => ({}),
		'client.fsStat': (params) => ({ exists: read((params as { path: string }).path) !== undefined }),
		'client.fsReadJson': (params) => {
			const value = read((params as { path: string }).path);
			if (value === undefined) throw new Error('File not found');
			return JSON.parse(JSON.stringify(value)) as unknown;
		},
		'client.fsWriteJson': (params) => {
			const { path, value } = params as { path: string; value: unknown };
			if (path !== SAVED_PATH) files[path] = JSON.parse(JSON.stringify(value)) as unknown;
			return {};
		},
		'client.getTasks': () => rows.map((row) => ({ ...row })),
		'client.listTasks': () => ({ rows: listed.map((row) => ({ ...row })), total: listed.length, page: 1, pageSize: 100 }),
		'client.getTaskPipeline': () => undefined,
		'client.tool': (params) => tool(params as { token: string; tool: string }),
		'client.addMonitor': () => ({}),
		'client.removeMonitor': () => ({}),
	};
}

/**
 * Wait until a condition holds (or fail after a bound).
 *
 * @param check - The condition.
 * @param what - Named in the failure.
 * @param ms - The bound.
 */
export async function until(check: () => boolean, what: string, ms = 2_000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
		await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
	}
}
