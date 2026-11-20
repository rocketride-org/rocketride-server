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
// in for a ConnectionManager's identity and connection events. The realm's
// CLIENT is a scripted stand-in: each method answers from a script keyed by
// the wire op it used to be (`client.getTasks`, `client.use`, ...), and every
// call is recorded with its params, so a test can check what the engine core
// sends. Like the real realm client it throws while the realm is not
// connected, and it is `null` before a mirrored realm's first status. Not a
// test file (the runner only collects *.test.ts).
// =============================================================================

import { account, createFakeClientRealm, createFakeMirroredRealm } from 'shared/explorer/devtool/testing';
import type { IFakeClientRealm, IFakeMirroredRealm } from 'shared/explorer/devtool/testing';
import { createEngineReadiness } from 'shared/explorer/devtool/readiness';
import type { IEngineReadiness } from 'shared/explorer/devtool/readiness';
import type { IRealmClient, RealmClientGetter } from 'shared/explorer/devtool/engineClient';
import type { SqlCoreBus } from '../src/sqlCore';
import type { SavedSqlConnection } from '../src/connect';
import type { IFakeTaskRow } from './support';

/** One engine request the code under test made. */
export interface IRequest {
	/** The op wire name (`client.<method>`). */
	op: string;
	/** Its params, in the shape the old bus op carried. */
	params: unknown;
	/** Always undefined now (deadlines are the library's, not a per-request bus timeout); kept for readability of older assertions. */
	timeoutMs: number | undefined;
}

/** A script: what each op answers (throw to fail it). */
export type BusScript = Record<string, (params: unknown) => unknown>;

/** What a core or a controller is given (`SqlCoreBus`, `getClient`, `engine`). */
export interface IEngineSource {
	/** The realm's manager (identity and server events). */
	cm: SqlCoreBus;
	/** The realm's client right now. */
	getClient: RealmClientGetter<IRealmClient>;
	/** The realm's engine readiness, kept in step with the realm's connection. */
	engine: IEngineReadiness;
}

/** A realm with a scripted engine. */
export interface IScriptedRealm<R> extends IEngineSource {
	/** The fake realm (identity and connection events). */
	realm: R;
	/** The scripted client. */
	client: IRealmClient;
	/** The `{ cm, getClient, engine }` a core is built from. */
	source: IEngineSource;
	/** Every request, in order. */
	requests: IRequest[];
	/** The script (mutable: a test may change an answer mid-way). */
	script: BusScript;
	/** The ops requested, in order. */
	ops(): string[];
}

/**
 * Wrap a fake realm's manager with a scripted client and a readiness store.
 *
 * @param realm - The fake realm.
 * @param cm - Its manager.
 * @param script - What each op answers.
 * @returns The scripted realm.
 */
function scripted<R>(realm: R, cm: IFakeManager, script: BusScript): IScriptedRealm<R> {
	const requests: IRequest[] = [];
	const call = async (op: string, params: unknown): Promise<unknown> => {
		requests.push({ op, params, timeoutMs: undefined });
		// As the real realm client does: nothing is answered while the realm is down.
		if (!cm.isConnected()) throw new Error('Not connected to server');
		const answer = script[op];
		if (!answer) throw new Error(`No scripted answer for ${op}`);
		return answer(params);
	};
	const client = {
		getTasks: () => call('client.getTasks', {}),
		listTasks: (req?: unknown) => call('client.listTasks', req ?? {}),
		getTaskPipeline: (token: string) => call('client.getTaskPipeline', { token }),
		tool: (options: unknown) => call('client.tool', options),
		addMonitor: (key: unknown, types: unknown) => call('client.addMonitor', { key, types }),
		removeMonitor: (key: unknown, types: unknown) => call('client.removeMonitor', { key, types }),
		fsStat: (path: string) => call('client.fsStat', { path }),
		fsReadJson: (path: string) => call('client.fsReadJson', { path }),
		fsMkdir: (path: string) => call('client.fsMkdir', { path }),
		fsWriteJson: (path: string, value: unknown) => call('client.fsWriteJson', { path, value }),
		use: (options: unknown) => call('client.use', options),
		getTaskToken: (options: unknown) => call('client.getTaskToken', options),
		terminate: (token: string) => call('client.terminate', { token }),
		getService: (service: string) => call('client.getService', { service }),
		validate: (options: unknown) => call('client.validate', options),
		account: { getEnvironmentKeys: () => call('client.getEnvironmentKeys', {}) },
	} as unknown as IRealmClient;
	// A mirrored realm has no client until its first status mirror.
	const getClient: RealmClientGetter<IRealmClient> = () => (cm.getClient() === null || cm.getClient() === undefined ? null : client);
	const engine = createEngineReadiness({ client: getClient(), isConnected: cm.isConnected() });
	const sync = (): void => engine.set({ client: getClient(), isConnected: cm.isConnected() });
	for (const event of ['shell:connected', 'shell:disconnected', 'shell:statusChange', 'shell:login', 'shell:logout'] as const) cm.on(event, sync);
	const scriptedCm = cm as unknown as SqlCoreBus;
	const source: IEngineSource = { cm: scriptedCm, getClient, engine };
	return { realm, cm: scriptedCm, getClient, engine, client, source, requests, script, ops: () => requests.map((request) => request.op) };
}

/** The manager surface the fakes offer. */
type IFakeManager = IFakeClientRealm['cm'];

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
 * A VS Code-style (mirrored) realm with a scripted engine.
 *
 * @param script - What each op answers.
 * @returns The scripted realm.
 */
export function scriptedMirroredRealm(script: BusScript): IScriptedRealm<IFakeMirroredRealm> {
	const realm = createFakeMirroredRealm();
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
