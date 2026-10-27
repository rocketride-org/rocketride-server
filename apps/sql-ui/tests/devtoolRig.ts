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
// TEST SUPPORT — a SQL dev tool mounted as the hosts mount it
// =============================================================================
//
// A controller (sqlController.ts) on a sidebar peer with a host channel, and
// one frame (sqlFrame.ts + its remote history + the REMOTE SqlEnv), over the
// shell's REAL busPeer, toolOps, toolChannel and retained registry (the
// dev-tool library's harness) with the JSON wire on; the engine behind the
// controller answers from a script (realm.ts). Not a test file.
// =============================================================================

import type { IToolOpServer, ToolControllerFn, ToolOpMap } from 'shell';
import { createDevToolHarness, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import type { IDevToolHarness, IFakeClientRealm, IPeerSpy } from 'shared/explorer/devtool/testing';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { SQL_APP_ID } from '../src/appId';
import { resetSavedConnections } from '../src/connect';
import type { DirectConnection, PipelineBoundConnection, SavedSqlConnection } from '../src/connect';
import { attachSqlController } from '../src/sqlController';
import type { SqlControllerMount } from '../src/sqlController';
import { attachSqlFrame, sqlChannel } from '../src/sqlFrame';
import type { SqlFrameMount, SqlToolProtocol } from '../src/sqlFrame';
import { createRemoteSqlEnv } from '../src/sqlEnv';
import type { SqlEnv } from '../src/sqlEnv';
import { createRemoteHistory } from '../src/history/remoteHistory';
import type { RemoteHistory } from '../src/history/remoteHistory';
import { taskRow } from './support';
import type { IFakeTaskRow } from './support';
import { USER, engineScript, scriptedClientRealm } from './realm';
import type { IScriptedRealm } from './realm';

export const PIPELINE: PipelineBoundConnection = { id: 'c-pipe', mode: 'pipeline', name: 'Orders', projectId: 'p1', pipelineName: 'Pipeline A', source: 's1', nodeId: 'db_1', provider: 'db_postgres' };
export const DIRECT: DirectConnection = { id: 'c-direct', mode: 'direct', name: 'Scratch', provider: 'db_mysql', config: { host: 'db.internal' } };

/**
 * A tool answer for each tool, like a postgres node.
 *
 * @param params - The client.tool params.
 * @returns The answer.
 */
export function postgres(params: { tool: string }): unknown {
	switch (params.tool) {
		case 'execute': return { rows: [{ id: 1, name: 'a' }, { id: 2, name: null }], affected_rows: 0 };
		case 'get_schema': return { database: 'shop', tables: { orders: { columns: [{ column: 'id', type: 'INT' }] } } };
		case 'refresh_schema': return { database: 'shop', tables: {} };
		// The transaction tools an apply runs; the session id must never reach a frame.
		case 'begin': return { session_id: 'tx_sentinel_1' };
		case 'commit':
		case 'rollback': return { ok: true };
		case 'get_sql': return { sql: 'SELECT * FROM orders', valid: true };
		default: return { dialect: 'postgres' };
	}
}

/** Timers a test runs by hand. */
export interface IManualTimers {
	/** A scheduler to hand to code under test. */
	schedule(fn: () => void, ms: number): () => void;
	/** Fire what falls due within `ms`, in order. */
	advance(ms: number): void;
}

/**
 * Timers a test runs by hand: `advance(ms)` fires what falls due, in order.
 *
 * @returns The timers.
 */
export function manualTimers(): IManualTimers {
	let now = 0;
	const due: Array<{ at: number; fn: () => void; live: boolean }> = [];
	return {
		schedule(fn, ms) {
			const entry = { at: now + ms, fn, live: true };
			due.push(entry);
			return () => { entry.live = false; };
		},
		advance(ms) {
			const until = now + ms;
			for (;;) {
				const next = due.filter((entry) => entry.live && entry.at <= until).sort((a, b) => a.at - b.at)[0];
				if (!next) break;
				next.live = false;
				now = next.at;
				next.fn();
			}
			now = until;
		},
	};
}

/** A controller, a frame on it, and everything recorded. */
export interface IRig {
	h: IDevToolHarness;
	engine: IScriptedRealm<IFakeClientRealm>;
	spy: IPeerSpy;
	protocol: SqlToolProtocol;
	mount: SqlControllerMount;
	frame: SqlFrameMount;
	env: SqlEnv;
	history: RemoteHistory;
	docs: { opened: Array<[string, string]>; closed: string[] };
	frameCalls: Array<{ op: string; timeoutMs: number | undefined }>;
	servers: { created: number; disposed: number };
	/** The frame's summon timers (manual: a summon goes out only when a test advances them). */
	timers: IManualTimers;
	/** Remount the controller (the old one must be disposed first). */
	remount(): SqlControllerMount;
	dispose(): void;
}

/**
 * Mount a controller (as the hosts do: a host channel on the sidebar peer,
 * then the controller in an effect) and one frame on a connection document.
 *
 * @param opts - The engine's saved list, tasks and tool answers; whether to sign in; `onRefused` hears every call the controller's deadline guard refused; `bareGate` hands the controller a bus without `getClient`, whose realm the activation gate cannot classify (a VS Code webview mounted while its root is down), so the gate waits for an explicit signal.
 * @returns The rig.
 */
export async function rig(opts: { saved?: SavedSqlConnection[]; rows?: IFakeTaskRow[]; tool?: (params: { tool: string; input?: Record<string, unknown> }) => unknown; login?: boolean; activate?: boolean; now?: () => number; docKey?: string; files?: Record<string, unknown>; bareGate?: boolean; onRefused?: (error: unknown) => void; listed?: Record<string, unknown>[] } = {}): Promise<IRig> {
	resetSavedConnections({ force: true });
	const h = createDevToolHarness(SQL_APP_ID, { json: true });
	const engine = scriptedClientRealm(engineScript(opts.saved ?? [PIPELINE, DIRECT], opts.rows ?? [taskRow('p1')], opts.tool ?? postgres, opts.files ?? {}, opts.listed ?? []));
	const spy = spyPeer(h.sidebarPeer);
	const hostChannel = shellProtocol.createToolChannel(spy.peer);
	const docs = { opened: [] as Array<[string, string]>, closed: [] as string[] };
	const documents = { open: (key: string, title: string) => { docs.opened.push([key, title]); }, close: (key: string) => { docs.closed.push(key); } };
	const frameCalls: Array<{ op: string; timeoutMs: number | undefined }> = [];
	const servers = { created: 0, disposed: 0 };
	const protocol: SqlToolProtocol = {
		createToolChannel: shellProtocol.createToolChannel,
		createToolController: <O extends ToolOpMap>(peer: DevToolPeer): ToolControllerFn<O> => {
			const fn = shellProtocol.createToolController<O>(peer);
			return ((op: keyof O & string, params: never, callOpts?: { timeoutMs?: number }) => {
				frameCalls.push({ op, timeoutMs: callOpts?.timeoutMs });
				return fn(op, params, callOpts);
			}) as ToolControllerFn<O>;
		},
		createToolOpServer: <O extends ToolOpMap>(peer: DevToolPeer): IToolOpServer<O> => {
			servers.created += 1;
			const server = shellProtocol.createToolOpServer<O>(peer);
			return { serve: (op, handler) => server.serve(op, handler), dispose: () => { servers.disposed += 1; server.dispose(); } };
		},
	};
	const cm = opts.bareGate
		? new Proxy(engine.cm, { get: (target, prop) => (prop === 'getClient' ? undefined : Reflect.get(target, prop, target)) })
		: engine.cm;
	const controllerOpts = { peer: spy.peer, channel: hostChannel, documents, cm, protocol, focusTarget: null, ...(opts.now ? { now: opts.now } : {}), ...(opts.onRefused ? { onRefused: opts.onRefused } : {}) };
	let mount = attachSqlController(controllerOpts);
	if (opts.login !== false) engine.realm.login(USER);
	// The user selected the tool's sidebar (rocket-ui's shell:toolSidebarActivated):
	// before that the controller reads nothing from the engine (R7).
	if (opts.activate !== false) engine.realm.activate(SQL_APP_ID);
	h.setHostConnection(true);
	// The frame's summon runs on manual timers, so no summon reaches the wire unless a test advances them.
	const timers = manualTimers();
	const frame = attachSqlFrame({ peer: h.newFramePeer(), docKey: opts.docKey ?? 'c-pipe', documents, protocol, summonSchedule: timers.schedule, ...(opts.now ? { now: opts.now } : {}) });
	const history = createRemoteHistory({ caller: frame.caller, channel: sqlChannel(frame.channel), owner: frame.owner });
	const env = createRemoteSqlEnv(frame.caller, true, frame.owner, history);
	await settle();
	const rigged: IRig = {
		h, engine, spy, protocol, mount, frame, env, history, docs, frameCalls, servers, timers,
		remount: () => {
			mount = attachSqlController(controllerOpts);
			rigged.mount = mount;
			return mount;
		},
		dispose: () => {
			history.dispose();
			frame.dispose();
			mount.dispose();
		},
	};
	return rigged;
}

/**
 * The ops the controller's engine received for one tool.
 *
 * @param engine - The scripted realm.
 * @param tool - The tool name.
 * @returns Those `client.tool` requests.
 */
export function toolRequests(engine: IScriptedRealm<IFakeClientRealm>, tool: string) {
	return engine.requests.filter((request) => request.op === 'client.tool' && (request.params as { tool: string }).tool === tool);
}

