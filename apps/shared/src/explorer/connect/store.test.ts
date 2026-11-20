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
// EXPLORER ENDPOINT STORE — probing, refresh discipline, identity, isolation
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ASK_TIMEOUT_MS, DEFAULT_START_WATCH_MS, createEndpointStore } from './store';
import type { EndpointWatch, IEndpointStore, IWatchHandlers } from './store';
import { CONFIG_SENTINEL, codedError, fakeWorld, manualClock, projectRows, ragComponents, row } from './testing';
import type { IFakeRow, IFakeWorld, IManualClock, IToolCall } from './testing';
import { READ_ONLY_DETAIL, controlledByTools } from './discovery';
import { SINGLE_TOOLS_ROLE, VECTOR_ROLES } from '../types';
import type { IExplorerIdentity, IRoleSpec, ISendFile } from '../types';
import { createGeneration } from '../generation';
import { identityFingerprint, identityFromConnectResult } from './identity';
import { ExplorerToolError } from '../errors';
import { checkRowEnvelope } from '../checks';

const DB = new Set(['db_postgres']);

/** A multi-role spec whose tools role is REQUIRED (no providers, no read-only anchors). */
const TOOLS_REQUIRED: IRoleSpec = {
	roles: {
		ingest: { sources: ['ingest_1'], required: false },
		chat: { sources: ['chat_1'], required: false },
		tools: { sources: ['tools_1'], required: true },
	},
	toolsRole: 'tools',
};
const NEO4J_INFO = { dialect: 'neo4j', engine: { name: 'Neo4j', version: '5.26.31' }, capabilities: { read_query: true }, limits: { statement_timeout_ms: 30000 } };

/** A watch that records its handlers so a test can fire task events, focus and identity changes by hand. */
interface IWatchProbe {
	watch: EndpointWatch;
	handlers: IWatchHandlers | null;
	subscribed: number;
	unsubscribed: number;
}

/**
 * Create a watch probe.
 *
 * @returns The probe.
 */
function watchProbe(): IWatchProbe {
	const probe: IWatchProbe = {
		handlers: null,
		subscribed: 0,
		unsubscribed: 0,
		watch: (handlers) => {
			probe.handlers = handlers;
			probe.subscribed += 1;
			return () => { probe.unsubscribed += 1; probe.handlers = null; };
		},
	};
	return probe;
}

/** What `make` returns. */
interface IRig {
	store: IEndpointStore;
	world: IFakeWorld;
	clock: IManualClock;
}

/**
 * Build a store over a fake world and a manual clock.
 *
 * @param rows - Initial rows.
 * @param behave - Tool behaviour (default: `dialect` answers a neo4j node).
 * @param over - Store option overrides.
 * @returns The rig.
 */
function make(rows = [row()], behave?: IFakeWorld['behave'], over: Partial<Parameters<typeof createEndpointStore>[0]> = {}): IRig {
	const clock = manualClock();
	const world = fakeWorld(rows, behave ?? ((call) => (call.tool === 'dialect' ? NEO4J_INFO : { columns: [], rows: [], row_limit: 1000, truncated: false })));
	const store = createEndpointStore({
		providers: DB,
		roles: SINGLE_TOOLS_ROLE,
		tools: { read_query: { idempotent: true, check: checkRowEnvelope, capability: 'read_query' } },
		clock,
		...over,
	});
	return { store, world, clock };
}

/**
 * Count the dialect probes a world received.
 *
 * @param world - The world.
 * @returns How many `dialect` calls it saw.
 */
function probes(world: IFakeWorld): number {
	return world.calls.filter((c) => c.tool === 'dialect').length;
}

// =============================================================================
// REFRESH + PROBE
// =============================================================================

describe('refresh — discover once, probe each endpoint once', () => {
	it('discovers, probes dialect, and publishes ready endpoints with the node\'s answer', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		const state = store.getState();
		assert.equal(state.status, 'ready');
		assert.equal(state.endpoints.length, 1);
		assert.equal(state.endpoints[0]!.state, 'ready');
		assert.equal(state.endpoints[0]!.running, true);
		const probe = state.probes[state.endpoints[0]!.key]!;
		assert.equal(probe.ok, true);
		assert.equal(probe.dialect, 'neo4j');
		assert.deepEqual(probe.info, NEO4J_INFO);
		assert.ok(state.refreshedAt > 0);
	});

	it('does NOT probe an endpoint again on later refreshes while it stays ready', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		await store.refresh(world.client);
		await store.refresh(world.client);
		assert.equal(probes(world), 1);
		assert.equal(world.getTasksCalls, 3);
	});

	it('re-probes everything on request (a restart) and probes a NEW endpoint without touching the old one', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		await store.refresh(world.client, { reprobe: true });
		assert.equal(probes(world), 2);
		world.rows.push(row({ source: 'tools_2', pipeline: { project_id: 'p2', components: [{ id: 'db_2', provider: 'db_postgres' }] } }));
		await store.refresh(world.client);
		assert.equal(probes(world), 3);
		assert.deepEqual(store.getState().endpoints.map((e) => e.state), ['ready', 'ready']);
	});

	it('retries a FAILED probe on the next refresh (only successes are cached)', async () => {
		let fail = true;
		const { store, world } = make([row()], (call) => {
			if (call.tool !== 'dialect') return {};
			if (fail) throw new Error('node not wired');
			return NEO4J_INFO;
		});
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'unreachable');
		assert.match(store.getState().endpoints[0]!.stateDetail ?? '', /node not wired/);
		fail = false;
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'ready');
		assert.equal(probes(world), 2);
	});

	it('does not re-probe an unreachable endpoint on refreshes nobody asked for (focus, task events)', async () => {
		// Each probe is a tool call, and a tool call that reaches the task counts
		// as activity for its idle timeout: re-probing on every focus would keep
		// a pipeline with a broken node alive for as long as the app is open.
		const { store, world, clock } = make([row()], (call) => {
			if (call.tool === 'dialect') throw new Error('node not wired');
			return {};
		});
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'unreachable');
		assert.equal(probes(world), 1);

		for (let i = 0; i < 3; i += 1) {
			await clock.advance(6_000);
			watch.handlers!.onFocus();
			await clock.advance(300);
			watch.handlers!.onTaskEvent({ reprobe: false });
			await clock.advance(300);
		}
		assert.ok(world.getTasksCalls >= 4, `discovery still ran (${world.getTasksCalls})`);
		assert.equal(probes(world), 1, 'background refreshes must not re-probe');
		const endpoint = store.getState().endpoints[0]!;
		assert.equal(endpoint.state, 'unreachable');
		assert.match(endpoint.stateDetail ?? '', /node not wired/);
		assert.equal(store.getState().probes[endpoint.key]?.ok, false);

		// An explicit refresh, a restart event and Test connection still re-probe.
		await store.refresh(world.client);
		assert.equal(probes(world), 2);
		watch.handlers!.onTaskEvent({ reprobe: true });
		await clock.advance(300);
		assert.equal(probes(world), 3);
		await store.probe(world.client, endpoint.key);
		assert.equal(probes(world), 4);
		detach();
	});

	it('still re-probes, on any refresh, an endpoint whose probe said its task was not running', async () => {
		let stopped = true;
		const { store, world, clock } = make([row()], (call) => {
			if (call.tool !== 'dialect') return {};
			if (stopped) throw codedError('Task was stopped', 'TASK_STOPPED');
			return NEO4J_INFO;
		});
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'stopped');
		stopped = false;
		watch.handlers!.onTaskEvent({ reprobe: false });
		await clock.advance(300);
		assert.equal(store.getState().endpoints[0]!.state, 'ready');
		assert.equal(probes(world), 2);
		detach();
	});

	it('bounds probe concurrency and isolates a failing probe from the rest', async () => {
		const rows = Array.from({ length: 10 }, (_, i) => row({ source: `s${i}`, pipeline: { project_id: `p${i}`, components: [{ id: 'db_1', provider: 'db_postgres' }] } }));
		const { store, world } = make(rows, async (call) => {
			if (call.tool !== 'dialect') return {};
			await new Promise((resolve) => setImmediate(resolve));
			if (call.token === rows[3]!.token) throw new Error('only this one is broken');
			return NEO4J_INFO;
		}, { concurrency: 3 });
		await store.refresh(world.client);
		assert.ok(world.inFlight.peak <= 3, `peak ${world.inFlight.peak}`);
		const states = store.getState().endpoints.map((e) => e.state);
		assert.equal(states.filter((s) => s === 'ready').length, 9);
		assert.equal(states.filter((s) => s === 'unreachable').length, 1);
	});

	it('shows `inaccessible` when the probe fails and the identity says the caller cannot call that team', async () => {
		const identity: IExplorerIdentity = { userId: 'u1', orgId: 'o', devTeam: 't', teamPermissions: { 'team-1': ['task.monitor'] } };
		const deploy = row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' });
		const { store, world } = make([deploy], (call) => { if (call.tool === 'dialect') throw new Error("Permission 'task.data' denied for this task"); return {}; });
		const detach = store.attach(world.client, identity);
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'inaccessible');
		detach();
	});

	it('shows `unreachable` (not inaccessible) for the same failure when the identity cannot tell', async () => {
		const deploy = row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-9' });
		const { store, world } = make([deploy], (call) => { if (call.tool === 'dialect') throw new Error('denied or broken'); return {}; });
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'unreachable');
	});

	it('reads a TASK_* code from the SDK as `stopped`, not `unreachable`', async () => {
		const { store, world } = make([row()], (call) => { if (call.tool === 'dialect') throw codedError('Task was stopped', 'TASK_STOPPED'); return {}; });
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'stopped');
	});

	it('surfaces a getTasks failure as status `error` and keeps what was already discovered', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		world.getTasksImpl = async () => { throw new Error('connection lost'); };
		await store.refresh(world.client);
		const state = store.getState();
		assert.equal(state.status, 'error');
		assert.equal(state.error, 'connection lost');
		assert.equal(state.endpoints.length, 1);
		assert.equal(state.endpoints[0]!.state, 'ready');
	});

	it('gives up on a discovery that never answers, reports it, and lets the next refresh run', async () => {
		const { store, world, clock } = make();
		world.getTasksImpl = () => new Promise(() => undefined);
		let settled = false;
		void store.refresh(world.client).then(() => { settled = true; });
		await clock.advance(29_000);
		assert.equal(settled, false);
		assert.equal(store.getState().status, 'loading');
		await clock.advance(1_000);
		assert.equal(settled, true, 'the refresh ends at the discovery timeout');
		const state = store.getState();
		assert.equal(state.status, 'error');
		assert.match(state.error ?? '', /did not answer within 30 s/);

		// The landing's Refresh works again, and a fresh answer lands.
		world.getTasksImpl = undefined;
		await store.refresh(world.client);
		assert.equal(store.getState().status, 'ready');
		assert.equal(store.getState().endpoints.length, 1);
	});

	it('drops a discovery answer that arrives after its timeout', async () => {
		const { store, world, clock } = make();
		let answerLate: ((rows: Array<Record<string, unknown>>) => void) | undefined;
		world.getTasksImpl = () => new Promise((resolve) => { answerLate = resolve; });
		void store.refresh(world.client);
		await clock.advance(30_000);
		assert.equal(store.getState().status, 'error');
		answerLate?.(world.rows.map((r) => ({ ...r })) as unknown as Array<Record<string, unknown>>);
		await clock.settle();
		assert.equal(store.getState().status, 'error');
		assert.deepEqual(store.getState().endpoints, []);
	});

	it('uses the dialect probe once per endpoint even for a custom probe function', async () => {
		let calls = 0;
		const { store, world } = make([row()], undefined, { probe: async () => { calls += 1; return { ok: true, info: { dialect: 'custom' }, dialect: 'custom' }; } });
		await store.refresh(world.client);
		await store.refresh(world.client);
		assert.equal(calls, 1);
		assert.equal(store.getState().probes[store.getState().endpoints[0]!.key]!.dialect, 'custom');
	});
});

// =============================================================================
// STOPPED / RESTARTED ENDPOINTS
// =============================================================================

describe('refresh — a vanished endpoint is stopped, a returning one is probed again', () => {
	it('keeps a vanished endpoint as `stopped`, with no probe in the snapshot', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		world.rows.length = 0;
		await store.refresh(world.client);
		const after = store.getState().endpoints[0]!;
		assert.equal(after.key, endpoint.key);
		assert.equal(after.state, 'stopped');
		assert.equal(after.running, false);
		assert.match(after.stateDetail ?? '', /no longer running/);
		assert.equal(store.getState().probes[endpoint.key], undefined);
	});

	it('still sends a call on a vanished endpoint with its last token, so a restarting task answers once it runs', async () => {
		// Discovery lists RUNNING tasks only, so a task that is restarting
		// vanishes from it. The server holds a call made meanwhile until the task
		// runs again; refusing the call locally would fail it instead.
		let releaseRead: ((value: unknown) => void) | undefined;
		const { store, world } = make([row()], (call) => {
			if (call.tool === 'dialect') return NEO4J_INFO;
			return new Promise((resolve) => { releaseRead = resolve; });
		});
		await store.refresh(world.client);
		const token = world.calls[0]!.token;
		world.rows.length = 0;
		await store.refresh(world.client);
		const vanished = store.getState().endpoints[0]!;
		assert.equal(vanished.state, 'stopped');

		const pending = store.session(world.client, vanished).invoke('read_query', { cypher: 'RETURN 1' });
		await new Promise((resolve) => setImmediate(resolve));
		const sent = world.calls.filter((c) => c.tool === 'read_query');
		assert.equal(sent.length, 1, 'the call reached the server instead of failing locally');
		assert.equal(sent[0]!.token, token);
		releaseRead?.({ columns: ['n'], rows: [[1]], row_limit: 1000, truncated: false });
		assert.deepEqual(await pending, { columns: ['n'], rows: [[1]], row_limit: 1000, truncated: false });
	});

	it('surfaces the server\'s answer for a task that is really gone, and never repeats the call', async () => {
		const { store, world } = make([row()], (call) => {
			if (call.tool === 'dialect') return NEO4J_INFO;
			throw codedError('Your pipeline is not running', 'TASK_NOT_REGISTERED');
		});
		await store.refresh(world.client);
		world.rows.length = 0;
		await store.refresh(world.client);
		const error = await store.session(world.client, store.getState().endpoints[0]!).invoke('read_query', { cypher: 'RETURN 1' }).catch((e: unknown) => e);
		assert.ok(error instanceof ExplorerToolError);
		assert.equal(error.code, 'TASK_NOT_REGISTERED');
		assert.equal(world.calls.filter((c) => c.tool === 'read_query').length, 1);
	});

	it('lets a read on a vanished endpoint whose task was just stopped wait out the retry window, then surfaces TASK_STOPPED', async () => {
		// A task the user stopped stays registered for a few minutes and answers
		// TASK_STOPPED. A read then gets the one bounded re-discovery (about once
		// a second, up to the retry window) and fails with the server's code; the
		// call itself is sent once.
		const { store, world, clock } = make([row()], (call) => {
			if (call.tool === 'dialect') return NEO4J_INFO;
			throw codedError('Task was stopped', 'TASK_STOPPED');
		});
		await store.refresh(world.client);
		world.rows.length = 0;
		await store.refresh(world.client);
		const vanished = store.getState().endpoints[0]!;
		assert.equal(vanished.state, 'stopped');
		const discoveriesBefore = world.getTasksCalls;

		let outcome: unknown;
		let settled = false;
		const pending = store.session(world.client, vanished).invoke('read_query', { cypher: 'RETURN 1' })
			.then(() => 'ok', (error: unknown) => { outcome = error; return 'failed'; })
			.finally(() => { settled = true; });
		await clock.advance(5_000);
		assert.equal(settled, false, 'the read waits while the store looks for the endpoint again');
		await clock.advance(11_000);
		assert.equal(await pending, 'failed');
		assert.equal((outcome as ExplorerToolError).code, 'TASK_STOPPED');
		assert.equal(world.calls.filter((c) => c.tool === 'read_query').length, 1);
		const polls = world.getTasksCalls - discoveriesBefore;
		assert.ok(polls >= 10 && polls <= 16, `re-discovered about once a second within the window, saw ${polls}`);
	});

	it('probes it again when it reappears (the Stopped badge goes away)', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		const saved = world.rows.slice();
		world.rows.length = 0;
		await store.refresh(world.client);
		world.rows.push(...saved);
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'ready');
		assert.equal(probes(world), 2);
	});

	it('Test connection on a vanished endpoint sends nothing and answers null; the next listing probes it, even on a focus', async () => {
		// The drawer reads null as "not tested: the pipeline is not running". A
		// dialect call sent to a restarting task could time out, and its failure
		// must not turn the card into a sticky Unreachable that background
		// refreshes no longer re-probe.
		let dialectFails = false;
		const { store, world, clock } = make([row()], (call) => {
			if (call.tool === 'dialect') {
				if (dialectFails) throw new Error('dialect timed out after 15 s');
				return NEO4J_INFO;
			}
			return { columns: ['n'], rows: [[1]], row_limit: 1000, truncated: false };
		});
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		const key = store.getState().endpoints[0]!.key;
		const saved = world.rows.slice();
		world.rows.length = 0;
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'stopped');

		dialectFails = true;
		const sentBefore = probes(world);
		assert.equal(await store.probe(world.client, key), null, 'nothing was tested: the pipeline is not listed');
		assert.equal(probes(world), sentBefore, 'no dialect call is sent for an endpoint discovery no longer lists');
		assert.equal(store.getState().endpoints[0]!.state, 'stopped');

		// The restart completes; the next refresh is one nobody asked for.
		dialectFails = false;
		world.rows.push(...saved);
		await clock.advance(6_000);
		watch.handlers!.onFocus();
		await clock.advance(400);
		assert.equal(probes(world), sentBefore + 1, 'the listed-again endpoint is probed on a background refresh');
		assert.equal(store.getState().endpoints[0]!.state, 'ready');
		const answer = await store.session(world.client, store.getState().endpoints[0]!).invoke('read_query', { cypher: 'RETURN 1' });
		assert.deepEqual(answer, { columns: ['n'], rows: [[1]], row_limit: 1000, truncated: false });
		assert.equal(world.calls.filter((c) => c.tool === 'read_query').length, 1, 'the capability-gated call was sent, not refused as upgrade');
		detach();
	});

	it('does not apply a failed probe answer that arrives after its endpoint left the list', async () => {
		// Test connection started while the card was Ready; the pipeline restarts
		// before the node answers, and the answer is a failure.
		let held: { reject: (error: Error) => void } | undefined;
		let hold = false;
		const { store, world, clock } = make([row()], (call) => {
			if (call.tool !== 'dialect') return { columns: [], rows: [], row_limit: 1000, truncated: false };
			if (!hold) return NEO4J_INFO;
			return new Promise((_resolve, reject) => { held = { reject }; });
		});
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		const key = store.getState().endpoints[0]!.key;

		hold = true;
		const pending = store.probe(world.client, key);
		const saved = world.rows.slice();
		world.rows.length = 0;
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'stopped');
		held!.reject(new Error('dialect timed out after 15 s'));
		assert.equal(await pending, null, 'the answer no longer describes a listed endpoint');
		assert.equal(store.getState().endpoints[0]!.state, 'stopped', 'never a sticky Unreachable for a pipeline that left the list');
		assert.equal(store.getState().probes[key], undefined);

		hold = false;
		world.rows.push(...saved);
		const sentBefore = probes(world);
		await clock.advance(6_000);
		watch.handlers!.onFocus();
		await clock.advance(400);
		assert.equal(probes(world), sentBefore + 1);
		assert.equal(store.getState().endpoints[0]!.state, 'ready');
		detach();
	});

	it('does not mark a vanished endpoint ready from a late good answer, but keeps that answer for its calls', async () => {
		let held: { resolve: (value: unknown) => void } | undefined;
		let hold = false;
		const { store, world } = make([row()], (call) => {
			if (call.tool !== 'dialect') return { columns: ['n'], rows: [[1]], row_limit: 1000, truncated: false };
			if (!hold) return NEO4J_INFO;
			return new Promise((resolve) => { held = { resolve }; });
		});
		await store.refresh(world.client);
		const key = store.getState().endpoints[0]!.key;

		hold = true;
		const pending = store.probe(world.client, key);
		world.rows.length = 0;
		await store.refresh(world.client);
		held!.resolve(NEO4J_INFO);
		assert.equal(await pending, null);
		const vanished = store.getState().endpoints[0]!;
		assert.equal(vanished.state, 'stopped', 'a pipeline discovery does not list is never shown ready');
		assert.equal(store.getState().probes[key], undefined);
		// The node's answer still serves the session's capability check while the task restarts.
		await store.session(world.client, vanished).invoke('read_query', { cypher: 'RETURN 1' });
		assert.equal(world.calls.filter((c) => c.tool === 'read_query').length, 1);
	});

	it('marks a stopped endpoint only once and keeps it across further refreshes', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		world.rows.length = 0;
		await store.refresh(world.client);
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints.length, 1);
		assert.equal(store.getState().endpoints[0]!.state, 'stopped');
	});

	it('a multi-role connection missing its REQUIRED tools source is listed stopped with no probe', async () => {
		const vec = (source: string) => row({ source, pipeline: { project_id: 'vp', components: [{ id: 'v_1', provider: 'rocketride_vector' }] } });
		const { store, world } = make([vec('ingest_1'), vec('chat_1')], undefined, { providers: new Set(['rocketride_vector']), roles: TOOLS_REQUIRED });
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'stopped');
		assert.equal(probes(world), 0);
		// No token was ever known for it, so a call is refused locally.
		const error = await store.session(world.client, store.getState().endpoints[0]!).invoke('dialect', {}).catch((e: unknown) => e);
		assert.equal((error as ExplorerToolError).kind, 'unavailable');
		assert.equal(world.calls.length, 0);
	});
});

// =============================================================================
// REFRESH DISCIPLINE
// =============================================================================

describe('refresh discipline — coalescing, debounce, focus, cleanup', () => {
	it('coalesces any number of concurrent refreshes into the one running plus exactly ONE follow-up', async () => {
		let release: (() => void) | undefined;
		const { store, world } = make();
		let first = true;
		world.getTasksImpl = async () => {
			if (first) {
				first = false;
				await new Promise<void>((resolve) => { release = resolve; });
			}
			return world.rows.map((r) => ({ ...r })) as unknown as Array<Record<string, unknown>>;
		};
		const calls = (): number => world.getTasksCalls;
		const a = store.refresh(world.client);
		const b = store.refresh(world.client);
		const c = store.refresh(world.client, { reprobe: true });
		const d = store.refresh(world.client);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls(), 1);
		release?.();
		await Promise.all([a, b, c, d]);
		await new Promise((resolve) => setImmediate(resolve));
		// One discovery that was blocked, then exactly one follow-up (carrying the re-probe) — not four.
		assert.equal(calls(), 2);
		assert.equal(probes(world), 2);
	});

	it('never lets an older refresh overwrite a newer one: the final snapshot reflects the latest rows', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		world.rows.push(row({ source: 'tools_2', pipeline: { project_id: 'p2', components: [{ id: 'db_2', provider: 'db_postgres' }] } }));
		const refreshing = store.refresh(world.client);
		world.rows.length = 0;
		await refreshing;
		await store.refresh(world.client);
		assert.deepEqual(store.getState().endpoints.map((e) => e.state), ['stopped', 'stopped']);
	});

	it('coalesces a burst of task events into ONE refresh after the quiet period', async () => {
		const { store, world, clock } = make();
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		for (let i = 0; i < 5; i += 1) watch.handlers!.onTaskEvent({ reprobe: false });
		assert.equal(world.getTasksCalls, 0);
		await clock.advance(299);
		assert.equal(world.getTasksCalls, 0);
		await clock.advance(1);
		assert.equal(world.getTasksCalls, 1);
		detach();
	});

	it('asks for a re-probe when any event in the burst was a restart', async () => {
		const { store, world, clock } = make();
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		assert.equal(probes(world), 1);
		watch.handlers!.onTaskEvent({ reprobe: false });
		watch.handlers!.onTaskEvent({ reprobe: true });
		await clock.advance(300);
		assert.equal(probes(world), 2);
		detach();
	});

	it('rate-limits focus refreshes and skips one that follows a refresh closely', async () => {
		const { store, world, clock } = make();
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		assert.equal(world.getTasksCalls, 1);
		watch.handlers!.onFocus();
		await clock.advance(1_000);
		assert.equal(world.getTasksCalls, 1);
		await clock.advance(5_000);
		watch.handlers!.onFocus();
		await clock.advance(300);
		assert.equal(world.getTasksCalls, 2);
		detach();
	});

	it('refreshes after a reconnect (events were missed), with a re-probe', async () => {
		const { store, world, clock } = make();
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		watch.handlers!.onReconnect();
		await clock.advance(300);
		assert.equal(world.getTasksCalls, 2);
		assert.equal(probes(world), 2);
		detach();
	});

	it('cleans up: detaching unsubscribes, cancels the pending refresh, and later events do nothing', async () => {
		const { store, world, clock } = make();
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		const handlers = watch.handlers!;
		handlers.onTaskEvent({ reprobe: false });
		assert.equal(clock.pending(), 1);
		detach();
		assert.equal(watch.unsubscribed, 1);
		assert.equal(clock.pending(), 0);
		handlers.onTaskEvent({ reprobe: false });
		await clock.advance(1_000);
		// The stale handler may re-arm a timer, but the detached store's client is gone from the watch.
		assert.equal(watch.subscribed, 1);
	});
});

// =============================================================================
// A STARTED TASK IS LOOKED FOR UNTIL IT RUNS
// =============================================================================

describe('a task that starts is looked for until discovery lists it (its start event comes before it runs)', () => {
	const VX_INFO = { dialect: 'qdrant', capabilities: { remove: true }, limits: { statement_timeout_ms: 30000 } };
	const INGEST = { projectId: 'vp', source: 'ingest_1' };
	const NEW_TASK = { projectId: 'p-new', source: 'tools_1' };

	/**
	 * A Vector store over a fake world.
	 *
	 * @param rows - Task rows.
	 * @returns The rig.
	 */
	function makeVx(rows: IFakeRow[]): IRig {
		return make(rows, (call) => (call.tool === 'dialect' ? VX_INFO : { success: true }), {
			providers: new Set(['qdrant']),
			roles: VECTOR_ROLES,
			nodeFilter: controlledByTools,
			tools: { stats: { idempotent: true } },
		});
	}

	/**
	 * Count the discoveries a store starts: every refresh publishes `loading`
	 * once before its one task listing, follow-ups included.
	 *
	 * @param store - The store.
	 * @returns A function answering how many discoveries have started so far.
	 */
	function discoveries(store: IEndpointStore): () => number {
		let started = 0;
		let last = store.getState().status;
		store.subscribe(() => {
			const now = store.getState().status;
			if (now === 'loading' && last !== 'loading') started += 1;
			last = now;
		});
		return () => started;
	}

	it('gives an open connection its ingest source back after that source restarts, with no further event and no refresh', async () => {
		const rows = projectRows(['ingest_1', 'chat_1', 'tools_1']);
		const ingestRow = rows.find((r) => r.source === 'ingest_1')!;
		const { store, world, clock } = makeVx(rows);
		const looked = discoveries(store);
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		const endpoint = (): ReturnType<IEndpointStore['getState']>['endpoints'][number] => store.getState().endpoints[0]!;
		assert.deepEqual(endpoint().roles.ingest, { source: 'ingest_1' });

		// ingest_1 stops: its `end` event, and discovery no longer lists it.
		world.rows.splice(world.rows.indexOf(ingestRow), 1);
		watch.handlers!.onTaskEvent({ reprobe: false, ended: INGEST });
		await clock.advance(300);
		assert.equal(endpoint().roles.ingest, null);
		assert.equal(store.channel(world.client, endpoint(), 'ingest').bound, false);

		// It starts again. Its `begin` event arrives while it is still loading,
		// so the debounced discovery does not list it yet.
		watch.handlers!.onTaskEvent({ reprobe: false, started: INGEST });
		await clock.advance(300);
		assert.equal(endpoint().roles.ingest, null);
		const whileLoading = looked();

		// Nothing announces the moment it runs: the store looks again by itself.
		await clock.advance(5_000);
		assert.ok(looked() > whileLoading, 'the store looked again without an event');
		world.rows.push(ingestRow);
		await clock.advance(15_000);
		assert.deepEqual(endpoint().roles.ingest, { source: 'ingest_1' });
		assert.deepEqual(endpoint().missingRoles, []);
		assert.equal(endpoint().state, 'ready');
		assert.equal(store.channel(world.client, endpoint(), 'ingest').bound, true);
		// Those looks are background refreshes: the ready node was not called again.
		assert.equal(probes(world), 1);

		// Found: it stops looking.
		const whenFound = looked();
		await clock.advance(600_000);
		assert.equal(looked(), whenFound);
		assert.equal(clock.pending(), 0);
		detach();
	});

	it('looks after 1, 2, 4 and 8 s, then every 15 s, and gives up after the start window', async () => {
		const { store, world, clock } = make();
		const looked = discoveries(store);
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		watch.handlers!.onTaskEvent({ reprobe: false, started: NEW_TASK });
		await clock.advance(300);
		assert.equal(looked(), 2);
		const looks: number[] = [];
		for (const step of [1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
			await clock.advance(step - 1);
			looks.push(looked());
			await clock.advance(1);
			looks.push(looked());
		}
		assert.deepEqual(looks, [2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8]);
		await clock.advance(DEFAULT_START_WATCH_MS);
		const atGiveUp = looked();
		assert.ok(atGiveUp <= 8 + Math.ceil(DEFAULT_START_WATCH_MS / 15_000), `bounded looks (${atGiveUp})`);
		assert.equal(clock.pending(), 0);
		await clock.advance(600_000);
		assert.equal(looked(), atGiveUp);
		detach();
	});

	it('starts the steps over on a new start event', async () => {
		const { store, world, clock } = make();
		const looked = discoveries(store);
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		watch.handlers!.onTaskEvent({ reprobe: false, started: NEW_TASK });
		await clock.advance(300 + 1_000 + 2_000 + 4_000 + 8_000);
		const before = looked();
		// The next look was 15 s away; another start brings it back to 1 s after its own discovery.
		watch.handlers!.onTaskEvent({ reprobe: false, started: { projectId: 'p-other', source: 'tools_1' } });
		await clock.advance(300);
		assert.equal(looked(), before + 1);
		await clock.advance(1_000);
		assert.equal(looked(), before + 2);
		detach();
	});

	it('does not keep looking after an event that names no started task', async () => {
		const { store, world, clock } = make();
		const looked = discoveries(store);
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		watch.handlers!.onTaskEvent({ reprobe: false });
		watch.handlers!.onTaskEvent({ reprobe: false, ended: NEW_TASK });
		await clock.advance(600_000);
		assert.equal(looked(), 2);
		assert.equal(clock.pending(), 0);
		detach();
	});

	it('stops looking when the started task ends, when the store detaches, and on reset', async () => {
		const { store, world, clock } = make();
		const looked = discoveries(store);
		const watch = watchProbe();
		let detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);

		watch.handlers!.onTaskEvent({ reprobe: false, started: NEW_TASK });
		await clock.advance(1_300);
		watch.handlers!.onTaskEvent({ reprobe: false, ended: NEW_TASK });
		await clock.advance(300);
		const afterEnd = looked();
		await clock.advance(600_000);
		assert.equal(looked(), afterEnd);

		watch.handlers!.onTaskEvent({ reprobe: false, started: NEW_TASK });
		await clock.advance(300);
		detach();
		assert.equal(clock.pending(), 0);
		const afterDetach = looked();
		await clock.advance(600_000);
		assert.equal(looked(), afterDetach);

		detach = store.attach(world.client, null, watch.watch);
		watch.handlers!.onTaskEvent({ reprobe: false, started: NEW_TASK });
		await clock.advance(300);
		store.reset();
		assert.equal(clock.pending(), 0);
		const afterReset = looked();
		await clock.advance(600_000);
		assert.equal(looked(), afterReset);
		detach();
	});

	it('keeps looking after a failed discovery, within the same window', async () => {
		const { store, world, clock } = make();
		const looked = discoveries(store);
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		// The listing fails: the fake cannot read its rows.
		const rows = world.rows;
		world.rows = undefined as unknown as IFakeRow[];
		watch.handlers!.onTaskEvent({ reprobe: false, started: NEW_TASK });
		await clock.advance(300);
		assert.equal(store.getState().status, 'error');
		world.rows = rows;
		world.rows.push(row({ source: 'tools_1', pipeline: { project_id: 'p-new', components: [{ id: 'db_9', provider: 'db_postgres' }] } }));
		await clock.advance(1_000);
		assert.equal(store.getState().status, 'ready');
		assert.deepEqual(store.getState().endpoints.map((e) => e.projectId).sort(), ['p-new', 'proj-1']);
		const whenFound = looked();
		await clock.advance(600_000);
		assert.equal(looked(), whenFound);
		detach();
	});
});

// =============================================================================
// IDENTITY + TOKENS
// =============================================================================

describe('identity changes and sign-out reset everything', () => {
	const alice: IExplorerIdentity = { userId: 'u1', orgId: 'org-A', devTeam: 'dev-A' };

	it('clears endpoints, probes, tokens and sessions when the ORGANIZATION changes', async () => {
		const { store, world } = make();
		const watch = watchProbe();
		store.attach(world.client, alice, watch.watch);
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		const session = store.session(world.client, endpoint);
		assert.equal(store.getState().endpoints.length, 1);

		watch.handlers!.onIdentity({ ...alice, orgId: 'org-B' });
		const state = store.getState();
		assert.equal(state.status, 'idle');
		assert.deepEqual(state.endpoints, []);
		assert.deepEqual(state.probes, {});
		// The old session can no longer call: its token is gone.
		const error = await session.invoke('dialect', {}).catch((e: unknown) => e);
		assert.equal((error as ExplorerToolError).kind, 'unavailable');
	});

	it('resets on sign-out and on a different user or team, but NOT on a permissions-only change or the same identity', async () => {
		const { store, world } = make();
		const watch = watchProbe();
		store.attach(world.client, alice, watch.watch);
		await store.refresh(world.client);

		watch.handlers!.onIdentity({ ...alice, teamPermissions: { x: ['task.data'] } });
		assert.equal(store.getState().endpoints.length, 1);
		watch.handlers!.onIdentity({ ...alice });
		assert.equal(store.getState().endpoints.length, 1);

		watch.handlers!.onIdentity({ ...alice, devTeam: 'dev-B' });
		assert.equal(store.getState().endpoints.length, 0);

		await store.refresh(world.client);
		assert.equal(store.getState().endpoints.length, 1);
		watch.handlers!.onIdentity({ ...alice, devTeam: 'dev-B', userId: 'u2' });
		assert.equal(store.getState().endpoints.length, 0);

		await store.refresh(world.client);
		watch.handlers!.onIdentity(null);
		assert.equal(store.getState().endpoints.length, 0);
		assert.equal(store.getState().status, 'idle');
	});

	it('after a switch to another organization, does not list the caller\'s own runs from the previous one again', async () => {
		// The server keeps a user's own runs visible across an org switch and
		// hands back their tokens; the store must not offer them to the new org.
		const inA = row({ teamId: 'team-a', pipeline: { project_id: 'pa', name: 'In A', components: [{ id: 'db_1', provider: 'db_postgres' }] } });
		const inB = row({ teamId: 'team-b', source: 'tools_2', pipeline: { project_id: 'pb', name: 'In B', components: [{ id: 'db_1', provider: 'db_postgres' }] } });
		const { store, world } = make([inA]);
		const watch = watchProbe();
		store.attach(world.client, { userId: 'u1', orgId: 'org-A', devTeam: 'team-a', teamPermissions: { 'team-a': ['task.data'] } }, watch.watch);
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints.length, 1);

		world.rows.push(inB);
		watch.handlers!.onIdentity({ userId: 'u1', orgId: 'org-B', devTeam: 'team-b', teamPermissions: { 'team-b': ['task.data'] } });
		await store.refresh(world.client);
		assert.deepEqual(store.getState().endpoints.map((endpoint) => endpoint.teamId), ['team-b']);
		const text = JSON.stringify(store.getState());
		assert.equal(text.includes('In A'), false);
	});

	it('resets when re-attached under another identity', async () => {
		const { store, world } = make();
		const detach = store.attach(world.client, alice);
		await store.refresh(world.client);
		detach();
		store.attach(world.client, { ...alice, orgId: 'org-B' });
		assert.equal(store.getState().endpoints.length, 0);
	});

	it('drops a probe that was in flight when the store was reset: it must not describe the next session, even with an identical token', async () => {
		let releaseOld: (() => void) | undefined;
		let dialectCalls = 0;
		const { store, world } = make([row()], (call) => {
			if (call.tool !== 'dialect') return {};
			dialectCalls += 1;
			// The FIRST probe (the old session's) blocks; later ones answer at once with a different engine.
			if (dialectCalls === 1) return new Promise((resolve) => { releaseOld = () => resolve({ dialect: 'old-session' }); });
			return { dialect: 'new-session' };
		});
		const watch = watchProbe();
		store.attach(world.client, alice, watch.watch);
		const oldRefresh = store.refresh(world.client);
		for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(dialectCalls, 1);

		// A new organization, then the SAME task discovered again (same token, same key).
		watch.handlers!.onIdentity({ ...alice, orgId: 'org-B' });
		assert.deepEqual(store.getState().endpoints, []);
		await store.refresh(world.client);
		const key = store.getState().endpoints[0]!.key;
		assert.equal(store.getState().probes[key]?.dialect, 'new-session');

		releaseOld?.();
		await oldRefresh;
		for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
		assert.equal(store.getState().probes[key]?.dialect, 'new-session');
	});

	it('a refresh overtaken by a reset leaves the next identity\'s refresh in flight, and its one follow-up, alone', async () => {
		const { store, world, clock } = make([row()]);
		const answers: (() => void)[] = [];
		world.getTasksImpl = () => new Promise((resolve) => { answers.push(() => resolve(world.rows.map((r) => ({ ...r })) as unknown as Record<string, unknown>[])); });
		const watch = watchProbe();
		store.attach(world.client, alice, watch.watch);

		const oldRefresh = store.refresh(world.client);
		await clock.settle();
		watch.handlers!.onIdentity({ ...alice, orgId: 'org-B' });
		const newRefresh = store.refresh(world.client);
		await clock.settle();
		// A trigger while the new identity's discovery runs: ONE follow-up.
		void store.refresh(world.client);
		assert.equal(world.getTasksCalls, 2);

		// The old discovery lands (it was dropped by the reset) ...
		answers[0]!();
		await oldRefresh;
		await clock.settle();
		// ... and must not have cleared the new refresh: this trigger still coalesces.
		void store.refresh(world.client);
		assert.equal(world.getTasksCalls, 2, 'a trigger during the new discovery started a second, concurrent one');

		answers[1]!();
		await clock.settle();
		assert.equal(world.getTasksCalls, 3, 'the follow-up queued during the new discovery was lost');
		answers[2]!();
		await newRefresh;
		await clock.settle();
		assert.equal(world.getTasksCalls, 3);
		assert.equal(store.getState().status, 'ready');
		assert.equal(store.getState().endpoints.length, 1);
	});

	it('a probe overtaken by a reset does not clear the next identity\'s probe of the same endpoint', async () => {
		const releases: (() => void)[] = [];
		let dialectCalls = 0;
		const { store, world, clock } = make([row()], (call) => {
			if (call.tool !== 'dialect') return {};
			dialectCalls += 1;
			return new Promise((resolve) => { releases.push(() => resolve(NEO4J_INFO)); });
		});
		const watch = watchProbe();
		store.attach(world.client, alice, watch.watch);
		const oldRefresh = store.refresh(world.client);
		await clock.settle();
		assert.equal(dialectCalls, 1);

		watch.handlers!.onIdentity({ ...alice, orgId: 'org-B' });
		const newRefresh = store.refresh(world.client);
		await clock.settle();
		assert.equal(dialectCalls, 2);

		// The old probe settles: dropped, and it must leave the new probe's marker in place.
		releases[0]!();
		await oldRefresh;
		await clock.settle();
		const key = store.getState().endpoints[0]!.key;
		const duplicate = store.probe(world.client, key);
		await clock.settle();
		assert.equal(dialectCalls, 2, 'a second probe of the endpoint was sent while one was running');

		releases.slice(1).forEach((release) => release());
		assert.equal(await duplicate, null);
		await newRefresh;
		assert.equal(store.getState().endpoints[0]!.state, 'ready');
	});

	it('NEVER lets a token reach the snapshot, its keys, probes or a serialised copy', async () => {
		const { store, world } = make([row(), row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' })]);
		await store.refresh(world.client);
		const text = JSON.stringify(store.getState());
		for (const r of world.rows) assert.equal(text.includes(r.token), false);
		assert.equal(text.includes('tk_sentinel'), false);
		const session = store.session(world.client, store.getState().endpoints[0]!);
		assert.equal(JSON.stringify(session).includes('tk_sentinel'), false);
		assert.equal(JSON.stringify(session.endpoint).includes('tk_sentinel'), false);
	});

	it('reads identity out of a ConnectResult without the token and with the fingerprint fields', () => {
		const connect = { userToken: 'rr_SECRET', userId: 'u1', devTeam: 'dev-A', organization: { id: 'org-A', permissions: ['x'], teams: [{ id: 't1', permissions: ['task.data'] }, { id: 7 }] } };
		const identity = identityFromConnectResult(connect);
		assert.deepEqual(identity, { userId: 'u1', orgId: 'org-A', devTeam: 'dev-A', orgPermissions: ['x'], teamPermissions: { t1: ['task.data'] } });
		assert.equal(JSON.stringify(identity).includes('rr_SECRET'), false);
		assert.equal(identityFingerprint(identity), 'u1|org-A|dev-A');
		assert.equal(identityFromConnectResult(null), null);
		assert.equal(identityFromConnectResult({ userId: '' }), null);
		assert.equal(identityFingerprint(null), null);
	});
});

// =============================================================================
// SESSIONS + REBIND (end to end through the store)
// =============================================================================

describe('sessions through the store', () => {
	it('retries an idempotent read once when the task restarts (TASK_STOPPED) and comes back with the SAME token', async () => {
		let attempts = 0;
		const { store, world, clock } = make([row()], (call: IToolCall) => {
			if (call.tool === 'dialect') return NEO4J_INFO;
			attempts += 1;
			if (attempts === 1) throw codedError('Task was stopped', 'TASK_STOPPED');
			return { columns: ['n'], rows: [[1]], row_limit: 1000, truncated: false };
		});
		await store.refresh(world.client);
		const session = store.session(world.client, store.getState().endpoints[0]!);
		const result = session.invoke('read_query', { cypher: 'RETURN 1' });
		await clock.advance(0);
		assert.deepEqual(await result, { columns: ['n'], rows: [[1]], row_limit: 1000, truncated: false });
		assert.equal(attempts, 2);
		const tokens = world.calls.filter((c) => c.tool === 'read_query').map((c) => c.token);
		assert.equal(tokens[0], tokens[1]);
		// The endpoint's ownership is unchanged by the rebind.
		assert.equal(store.getState().endpoints[0]!.ownerId, 'u1');
	});

	it('gives up after the bounded window when the endpoint never comes back, surfacing the original error', async () => {
		const { store, world, clock } = make([row()], (call: IToolCall) => {
			if (call.tool === 'dialect') return NEO4J_INFO;
			throw codedError('Task was stopped', 'TASK_STOPPED');
		});
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		const session = store.session(world.client, endpoint);
		world.rows.length = 0;
		let outcome: unknown;
		const pending = session.invoke('read_query', { cypher: 'RETURN 1' }).then(() => 'ok', (error: unknown) => { outcome = error; return 'failed'; });
		await clock.advance(16_000);
		assert.equal(await pending, 'failed');
		assert.equal((outcome as ExplorerToolError).code, 'TASK_STOPPED');
		assert.equal(world.calls.filter((c) => c.tool === 'read_query').length, 1);
	});

	it('reuses one session per endpoint and client, and builds a new one for a new client', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		assert.equal(store.session(world.client, endpoint), store.session(world.client, endpoint));
		const other = fakeWorld([row()]);
		assert.notEqual(store.session(other.client, endpoint), store.session(world.client, endpoint));
	});

	it('refuses read_query locally on a node whose probe lacks the capability', async () => {
		const { store, world } = make([row()], (call) => (call.tool === 'dialect' ? { dialect: 'neo4j' } : {}));
		await store.refresh(world.client);
		const session = store.session(world.client, store.getState().endpoints[0]!);
		const error = await session.invoke('read_query', { cypher: 'RETURN 1' }).catch((e: unknown) => e);
		assert.equal((error as ExplorerToolError).kind, 'upgrade');
		assert.equal(world.calls.filter((c) => c.tool === 'read_query').length, 0);
	});

	it('probe() re-checks one endpoint on demand and returns null for an unknown one', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		const key = store.getState().endpoints[0]!.key;
		const result = await store.probe(world.client, key);
		assert.equal(result?.ok, true);
		assert.equal(probes(world), 2);
		assert.equal(await store.probe(world.client, 'nope'), null);
	});
});

// =============================================================================
// FACTORY ISOLATION
// =============================================================================

describe('factory isolation — SQL, Graph and a mocked Vector store side by side', () => {
	it('keeps each store\'s endpoints, probes, vault and reset separate', async () => {
		const clock = manualClock();
		const world = fakeWorld([
			row(),
			row({ source: 'tools_1', pipeline: { project_id: 'g', components: [{ id: 'g_1', provider: 'graph_neo4j' }] }, name: 'Graph' }),
			row({ source: 'tools_1', pipeline: { project_id: 'v', components: [{ id: 'v_1', provider: 'rocketride_vector' }] }, name: 'Vector' }),
		], (call) => (call.tool === 'dialect' ? NEO4J_INFO : {}));
		const sql = createEndpointStore({ providers: DB, roles: SINGLE_TOOLS_ROLE, tools: {}, clock });
		const graph = createEndpointStore({ providers: new Set(['graph_neo4j']), roles: SINGLE_TOOLS_ROLE, tools: {}, clock });
		const vector = createEndpointStore({ providers: new Set(['rocketride_vector']), roles: VECTOR_ROLES, tools: {}, clock });
		await Promise.all([sql.refresh(world.client), graph.refresh(world.client), vector.refresh(world.client)]);
		assert.deepEqual(sql.getState().endpoints.map((e) => e.provider), ['db_postgres']);
		assert.deepEqual(graph.getState().endpoints.map((e) => e.provider), ['graph_neo4j']);
		assert.deepEqual(vector.getState().endpoints.map((e) => e.provider), ['rocketride_vector']);

		graph.reset();
		assert.equal(graph.getState().endpoints.length, 0);
		assert.equal(sql.getState().endpoints.length, 1);
		assert.equal(vector.getState().endpoints.length, 1);
		// The SQL store's session still holds a working token; the reset Graph store's would not.
		const sqlSession = sql.session(world.client, sql.getState().endpoints[0]!);
		await sqlSession.invoke('dialect', {});
	});

	it('notifies only its own subscribers', async () => {
		const a = make();
		const b = make();
		let aHits = 0;
		let bHits = 0;
		a.store.subscribe(() => { aHits += 1; });
		b.store.subscribe(() => { bHits += 1; });
		await a.store.refresh(a.world.client);
		assert.ok(aHits > 0);
		assert.equal(bHits, 0);
	});
});

// =============================================================================
// MULTI-ROLE CONNECTIONS (Vector Explorer): role vault, read-only anchors, channels
// =============================================================================

describe('multi-role connections — role tokens, read-only anchors and role channels', () => {
	const VX_INFO = { dialect: 'qdrant', capabilities: { remove: true }, limits: { statement_timeout_ms: 30000 } };
	const FILE = (name: string): ISendFile => ({ file: { name, size: 3 } as unknown as File, objinfo: { name } });

	/**
	 * A Vector store over a fake world.
	 *
	 * @param rows - Task rows.
	 * @param behave - Tool behaviour (default: dialect answers a qdrant node).
	 * @param over - Store option overrides.
	 * @returns The rig.
	 */
	function makeVx(rows: IFakeRow[], behave?: IFakeWorld['behave'], over: Partial<Parameters<typeof createEndpointStore>[0]> = {}): IRig {
		return make(rows, behave ?? ((call) => (call.tool === 'dialect' ? VX_INFO : { success: true })), {
			providers: new Set(['qdrant']),
			roles: VECTOR_ROLES,
			nodeFilter: controlledByTools,
			tools: { stats: { idempotent: true }, embed: {} },
			...over,
		});
	}

	/**
	 * The token a row set gives a source.
	 *
	 * @param rows - The rows.
	 * @param source - The source id.
	 * @returns Its token.
	 */
	const tokenOf = (rows: IFakeRow[], source: string): string => rows.find((r) => r.source === source)!.token;

	it('lists only the nodes the Tools source controls (nodeFilter): store_2 never becomes a card', async () => {
		const { store, world } = makeVx(projectRows(['ingest_1', 'chat_1', 'tools_1']));
		await store.refresh(world.client);
		const { endpoints } = store.getState();
		assert.deepEqual(endpoints.map((e) => e.nodeId), ['store_1']);
		assert.equal(endpoints[0]!.state, 'ready');
		assert.equal(endpoints[0]!.readOnly, false);
		assert.equal(endpoints[0]!.anchorRole, 'tools');
		assert.equal(endpoints[0]!.stateDetail, undefined);
	});

	it('calls each role on ITS OWN token: tools invoke, chat ask, ingest upload', async () => {
		const rows = projectRows(['ingest_1', 'chat_1', 'tools_1']);
		const { store, world } = makeVx(rows);
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		const tools = store.channel(world.client, endpoint, 'tools');
		const chat = store.channel(world.client, endpoint, 'chat');
		const ingest = store.channel(world.client, endpoint, 'ingest');
		assert.deepEqual([tools.role, tools.bound, chat.bound, ingest.bound], ['tools', true, true, true]);

		assert.deepEqual(await tools.invoke('embed', { texts: ['q'] }, { nodeId: 'embed_1' }), { success: true });
		const last = world.calls[world.calls.length - 1]!;
		assert.deepEqual({ token: last.token, tool: last.tool, nodeId: last.nodeId }, { token: tokenOf(rows, 'tools_1'), tool: 'embed', nodeId: 'embed_1' });

		const streamed: string[] = [];
		const sse = async (type: string): Promise<void> => { streamed.push(type); };
		world.chatBehave = async (call) => {
			await call.onSSE?.('token', { text: 'a' });
			return { answers: ['[fake] answer'] };
		};
		assert.deepEqual(await chat.ask({ text: 'hello' }, { onSSE: sse }), { answers: ['[fake] answer'] });
		assert.deepEqual(world.chats.map((c) => ({ token: c.token, question: c.question })), [{ token: tokenOf(rows, 'chat_1'), question: { text: 'hello' } }]);
		// Stream events of the pending question reach the app's callback.
		assert.deepEqual(streamed, ['token']);

		const results = await ingest.sendFiles([FILE('a.pdf'), FILE('b.md')], { maxConcurrent: 2 });
		assert.deepEqual(world.uploads.map((u) => ({ token: u.token, files: u.files.map((f) => f.file.name), maxConcurrent: u.maxConcurrent })), [{ token: tokenOf(rows, 'ingest_1'), files: ['a.pdf', 'b.md'], maxConcurrent: 2 }]);
		assert.deepEqual(results.map((r) => [r.action, r.filepath]), [['complete', 'a.pdf'], ['complete', 'b.md']]);
	});

	it('copies each upload result into a plain record, one per file in order, and reports a missing one as an error', async () => {
		const { store, world } = makeVx(projectRows(['ingest_1', 'tools_1']));
		await store.refresh(world.client);
		const original = { action: 'complete', filepath: 'a.pdf', bytes_sent: 3, file_size: 3, upload_time: 0.1 };
		world.uploadBehave = () => [original, undefined];
		const results = await store.channel(world.client, store.getState().endpoints[0]!, 'ingest').sendFiles([FILE('a.pdf'), FILE('b.md')]);
		assert.deepEqual(results[0], original);
		assert.notEqual(results[0], original);
		assert.equal(results[1]!.action, 'error');
		assert.equal(results[1]!.filepath, 'b.md');
		assert.equal(typeof results[1]!.error, 'string');
		// A non-array answer is malformed, not silently empty.
		world.uploadBehave = () => ({ nope: true });
		const bad = await store.channel(world.client, store.getState().endpoints[0]!, 'ingest').sendFiles([FILE('a.pdf')]).catch((e: unknown) => e);
		assert.equal((bad as ExplorerToolError).kind, 'malformed');
	});

	it('refuses a missing role (not running, or not in the spec) as `unavailable` and sends nothing', async () => {
		const { store, world } = makeVx(projectRows(['chat_1', 'tools_1']));
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		const ingest = store.channel(world.client, endpoint, 'ingest');
		assert.equal(ingest.bound, false);
		const upload = await ingest.sendFiles([FILE('a.pdf')]).catch((e: unknown) => e);
		assert.ok(upload instanceof ExplorerToolError);
		assert.equal(upload.kind, 'unavailable');
		assert.match(upload.message, /ingest/);
		const unknown = store.channel(world.client, endpoint, 'nope');
		assert.equal(unknown.bound, false);
		for (const call of [unknown.ask('q'), unknown.invoke('stats', {}, { nodeId: 'store_1' }), unknown.sendFiles([])]) {
			assert.equal(((await call.catch((e: unknown) => e)) as ExplorerToolError).kind, 'unavailable');
		}
		assert.equal(world.uploads.length + world.chats.length, 0);
		assert.equal(world.calls.filter((c) => c.tool !== 'dialect').length, 0);
	});

	it('reads the role token at call time: a channel made while ingest was down works once it runs', async () => {
		const rows = projectRows(['chat_1', 'tools_1']);
		const { store, world } = makeVx(rows);
		await store.refresh(world.client);
		const ingest = store.channel(world.client, store.getState().endpoints[0]!, 'ingest');
		assert.equal(ingest.bound, false);
		world.rows.push(...projectRows(['ingest_1']));
		await store.refresh(world.client);
		// Same key while ingest_1 came up: the open connection is the same one.
		assert.equal(store.getState().endpoints.length, 1);
		assert.equal(ingest.bound, true);
		await ingest.sendFiles([FILE('a.pdf')]);
		assert.equal(world.uploads[0]!.token, world.rows[2]!.token);
	});

	it('NEVER retries anything on a channel, even an idempotent tool on the transient code', async () => {
		const { store, world } = makeVx(projectRows(['ingest_1', 'chat_1', 'tools_1']), (call) => {
			if (call.tool === 'dialect') return VX_INFO;
			throw codedError('Task was stopped', 'TASK_STOPPED');
		});
		await store.refresh(world.client);
		const before = store.getState();
		const endpoint = before.endpoints[0]!;
		world.chatBehave = () => { throw codedError('Task was stopped', 'TASK_STOPPED'); };
		world.uploadBehave = () => { throw codedError('Task was stopped', 'TASK_STOPPED'); };
		const errors = [
			await store.channel(world.client, endpoint, 'tools').invoke('stats', {}, { nodeId: 'store_1' }).catch((e: unknown) => e),
			await store.channel(world.client, endpoint, 'chat').ask('q').catch((e: unknown) => e),
			await store.channel(world.client, endpoint, 'ingest').sendFiles([FILE('a.pdf')]).catch((e: unknown) => e),
		] as ExplorerToolError[];
		assert.deepEqual(errors.map((e) => [e.kind, e.code]), [['raised', 'TASK_STOPPED'], ['raised', 'TASK_STOPPED'], ['raised', 'TASK_STOPPED']]);
		assert.equal(world.calls.filter((c) => c.tool === 'stats').length, 1);
		assert.equal(world.chats.length, 1);
		assert.equal(world.uploads.length, 1);
		// No re-discovery was started to look for a restart: the snapshot never changed.
		assert.equal(store.getState(), before);
	});

	it('requires opts.nodeId on a channel invoke', async () => {
		const { store, world } = makeVx(projectRows(['tools_1']));
		await store.refresh(world.client);
		const tools = store.channel(world.client, store.getState().endpoints[0]!, 'tools');
		const error = await tools.invoke('stats', {}).catch((e: unknown) => e);
		assert.equal((error as ExplorerToolError).kind, 'malformed');
		assert.equal(world.calls.filter((c) => c.tool === 'stats').length, 0);
	});

	it('bounds ask() by its own timeout and drops an answer whose generation expired', async () => {
		const { store, world, clock } = makeVx(projectRows(['chat_1', 'tools_1']));
		await store.refresh(world.client);
		const chat = store.channel(world.client, store.getState().endpoints[0]!, 'chat');
		world.chatBehave = () => new Promise(() => undefined);
		const pending = chat.ask('slow', { timeoutMs: 5_000 }).catch((e: unknown) => e);
		await clock.advance(5_000);
		const timeout = (await pending) as ExplorerToolError;
		assert.equal(timeout.kind, 'timeout');
		assert.equal(clock.pending(), 0);

		world.chatBehave = () => ({ answers: ['late'] });
		const generation = createGeneration();
		const ticket = generation.next();
		generation.invalidate();
		const stale = (await chat.ask('q', { generation: ticket }).catch((e: unknown) => e)) as ExplorerToolError;
		assert.equal(stale.kind, 'stale');

		world.chatBehave = () => 'not an object';
		assert.equal(((await chat.ask('q').catch((e: unknown) => e)) as ExplorerToolError).kind, 'malformed');

		// A client that throws before returning a promise still fails as one error class.
		const throwing = { ...world.client, chat: () => { throw new Error('Question cannot be empty'); } };
		const early = (await store.channel(throwing, store.getState().endpoints[0]!, 'chat').ask(null).catch((e: unknown) => e)) as ExplorerToolError;
		assert.ok(early instanceof ExplorerToolError);
		assert.equal(early.kind, 'raised');
		assert.equal(early.message, 'Question cannot be empty');
	});

	it('refuses as `upgrade` when the client cannot upload or chat, before sending anything', async () => {
		const { store, world } = makeVx(projectRows(['ingest_1', 'chat_1', 'tools_1']));
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		const bare = { ...world.client, sendFiles: undefined, chat: undefined };
		assert.equal(((await store.channel(bare, endpoint, 'ingest').sendFiles([FILE('a')]).catch((e: unknown) => e)) as ExplorerToolError).kind, 'upgrade');
		assert.equal(((await store.channel(bare, endpoint, 'chat').ask('q').catch((e: unknown) => e)) as ExplorerToolError).kind, 'upgrade');
	});

	it('keeps role tokens for a vanished endpoint, so a restarting source still answers', async () => {
		const rows = projectRows(['chat_1', 'tools_1']);
		const { store, world } = makeVx(rows);
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		const chatToken = tokenOf(rows, 'chat_1');
		world.rows.length = 0;
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'stopped');
		const chat = store.channel(world.client, endpoint, 'chat');
		assert.equal(chat.bound, true);
		await chat.ask('still there?');
		assert.equal(world.chats[0]!.token, chatToken);
	});

	it('clears role tokens when a required role is not running (the stopped path) and on reset', async () => {
		const rows = projectRows(['chat_1', 'tools_1']);
		const { store, world } = makeVx(rows, undefined, { roles: TOOLS_REQUIRED });
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		assert.equal(store.channel(world.client, endpoint, 'chat').bound, true);
		// tools_1 stops: discovery reports the connection stopped (required role missing).
		world.rows.splice(world.rows.findIndex((r) => r.source === 'tools_1'), 1);
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.state, 'stopped');
		const chat = store.channel(world.client, endpoint, 'chat');
		assert.equal(chat.bound, false);
		assert.equal(((await chat.ask('q').catch((e: unknown) => e)) as ExplorerToolError).kind, 'unavailable');

		const fresh = makeVx(projectRows(['chat_1', 'tools_1']));
		await fresh.store.refresh(fresh.world.client);
		const kept = fresh.store.getState().endpoints[0]!;
		fresh.store.reset();
		const after = fresh.store.channel(fresh.world.client, kept, 'tools');
		assert.equal(after.bound, false);
		assert.equal(((await after.invoke('stats', {}, { nodeId: 'store_1' }).catch((e: unknown) => e)) as ExplorerToolError).kind, 'unavailable');
		assert.equal(world.chats.length + fresh.world.chats.length, 0);
	});

	it('NEVER lets a role token or a component config reach the snapshot, a channel or a serialised copy', async () => {
		const rows = projectRows(['ingest_1', 'chat_1', 'tools_1']);
		const { store, world } = makeVx(rows);
		await store.refresh(world.client);
		const text = JSON.stringify(store.getState());
		for (const r of rows) assert.equal(text.includes(r.token), false);
		assert.equal(text.includes('tk_sentinel'), false);
		assert.equal(text.includes(CONFIG_SENTINEL), false);
		const endpoint = store.getState().endpoints[0]!;
		for (const role of ['ingest', 'chat', 'tools']) {
			assert.equal(JSON.stringify(store.channel(world.client, endpoint, role)).includes('tk_sentinel'), false);
		}
	});

	it('opens the stock RAG shape read-only on its chat token, and keeps the read-only detail once ready', async () => {
		const rows = projectRows(['webhook_1', 'chat_1'], ragComponents());
		const { store, world } = makeVx(rows);
		await store.refresh(world.client);
		const [endpoint] = store.getState().endpoints;
		assert.equal(endpoint!.nodeId, 'store_1');
		assert.equal(endpoint!.state, 'ready');
		assert.equal(endpoint!.readOnly, true);
		assert.equal(endpoint!.anchorRole, 'chat');
		assert.equal(endpoint!.stateDetail, READ_ONLY_DETAIL);
		// The probe and the session ride on the anchor (chat) token.
		const dialect = world.calls.filter((c) => c.tool === 'dialect');
		assert.deepEqual(dialect.map((c) => c.token), [tokenOf(rows, 'chat_1')]);
		await store.session(world.client, endpoint!).invoke('stats', {});
		assert.equal(world.calls[world.calls.length - 1]!.token, tokenOf(rows, 'chat_1'));
		// No Tools source: the tools channel is not bound.
		assert.equal(store.channel(world.client, endpoint!, 'tools').bound, false);
		// Test connection keeps the detail; a later refresh keeps it too.
		await store.probe(world.client, endpoint!.key);
		assert.equal(store.getState().endpoints[0]!.stateDetail, READ_ONLY_DETAIL);
		await store.refresh(world.client);
		assert.equal(store.getState().endpoints[0]!.stateDetail, READ_ONLY_DETAIL);
	});

	/** A stock RAG pipeline (no Tools component) with a second store its chat source does not reach. */
	const ragWithArchive = () => ragComponents().concat([{ id: 'store_9', provider: 'qdrant', name: 'Archive' }]);
	/** The engine's answer for a node outside the calling source's pipeline. */
	const unreachableArchive: IFakeWorld['behave'] = (call) => {
		if (call.nodeId === 'store_9') throw new Error('Node "store_9" not found in pipeline');
		return VX_INFO;
	};

	it('classifies a read-only card whose node the anchor source cannot reach as stopped, naming the role', async () => {
		const rows = projectRows(['webhook_1', 'chat_1'], ragWithArchive());
		const { store, world } = makeVx(rows, unreachableArchive);
		await store.refresh(world.client);
		const byNode = Object.fromEntries(store.getState().endpoints.map((e) => [e.nodeId, e]));
		assert.equal(byNode.store_1!.state, 'ready');
		assert.equal(byNode.store_9!.state, 'stopped');
		assert.equal(byNode.store_9!.stateDetail, 'Not reachable from the chat source');
		// The same answer on a callable (tools-anchored) card stays `unreachable`.
		const tools = makeVx(projectRows(['tools_1']), () => { throw new Error("Component 'store_1' not found in pipeline"); });
		await tools.store.refresh(tools.world.client);
		assert.equal(tools.store.getState().endpoints[0]!.state, 'unreachable');
	});

	it('does not re-probe a Not reachable read-only card on refreshes nobody asked for; does when asked', async () => {
		const rows = projectRows(['webhook_1', 'chat_1'], ragWithArchive());
		const { store, world, clock } = makeVx(rows, unreachableArchive);
		const archiveProbes = (): number => world.calls.filter((c) => c.tool === 'dialect' && c.nodeId === 'store_9').length;
		const watch = watchProbe();
		const detach = store.attach(world.client, null, watch.watch);
		await store.refresh(world.client);
		assert.equal(archiveProbes(), 1);
		const firstDiscovery = store.getState().refreshedAt;
		for (let i = 0; i < 3; i += 1) {
			await clock.advance(6_000);
			watch.handlers!.onFocus();
			await clock.advance(300);
			watch.handlers!.onTaskEvent({ reprobe: false });
			await clock.advance(300);
		}
		assert.ok(store.getState().refreshedAt > firstDiscovery, 'the background refreshes did run discovery');
		assert.equal(archiveProbes(), 1, 'background refreshes must not re-probe');
		const archive = store.getState().endpoints.find((e) => e.nodeId === 'store_9')!;
		assert.equal(archive.state, 'stopped');
		assert.equal(archive.stateDetail, 'Not reachable from the chat source');
		// An explicit refresh, a restart event and Test connection still re-probe.
		await store.refresh(world.client);
		assert.equal(archiveProbes(), 2);
		watch.handlers!.onTaskEvent({ reprobe: true });
		await clock.advance(300);
		assert.equal(archiveProbes(), 3);
		await store.probe(world.client, archive.key);
		assert.equal(archiveProbes(), 4);
		detach();
	});

	it('lists only store_1 while the Tools source is stopped: read-only on the chat token, under the callable card\'s key', async () => {
		const rows = projectRows(['ingest_1', 'chat_1', 'tools_1']);
		const { store, world } = makeVx(rows);
		await store.refresh(world.client);
		const callable = store.getState().endpoints[0]!;
		world.rows.splice(world.rows.findIndex((r) => r.source === 'tools_1'), 1);
		await store.refresh(world.client);
		const { endpoints } = store.getState();
		assert.deepEqual(endpoints.map((e) => e.nodeId), ['store_1']);
		assert.equal(endpoints[0]!.key, callable.key);
		assert.equal(endpoints[0]!.readOnly, true);
		assert.equal(endpoints[0]!.anchorRole, 'chat');
		assert.equal(store.channel(world.client, endpoints[0]!, 'tools').bound, false);
	});

	it('drops stream events of a question that timed out, was replaced, or already settled', async () => {
		const { store, world, clock } = makeVx(projectRows(['chat_1', 'tools_1']));
		await store.refresh(world.client);
		const chat = store.channel(world.client, store.getState().endpoints[0]!, 'chat');
		const streamed: string[] = [];
		const onSSE = async (type: string): Promise<void> => { streamed.push(type); };
		let finish: (answer: unknown) => void = () => undefined;
		world.chatBehave = () => new Promise((resolve) => { finish = resolve; });
		const emit = async (type: string): Promise<void> => { await world.chats[world.chats.length - 1]!.onSSE?.(type, {}); };

		// Timed out: events after the timeout are dropped.
		const timedOut = chat.ask('slow', { onSSE, timeoutMs: 5_000 }).catch((e: unknown) => e);
		await emit('before-timeout');
		await clock.advance(5_000);
		assert.equal(((await timedOut) as ExplorerToolError).kind, 'timeout');
		await emit('after-timeout');
		assert.deepEqual(streamed, ['before-timeout']);

		// Replaced: events after the generation expired are dropped.
		const generation = createGeneration();
		const replaced = chat.ask('old', { onSSE, generation: generation.next() }).catch((e: unknown) => e);
		await emit('current');
		generation.invalidate();
		await emit('after-invalidate');
		finish({ answers: ['late'] });
		assert.equal(((await replaced) as ExplorerToolError).kind, 'stale');
		assert.deepEqual(streamed, ['before-timeout', 'current']);

		// Settled: nothing is delivered once the answer came back.
		const answered = chat.ask('q', { onSSE });
		finish({ answers: ['done'] });
		await answered;
		await emit('after-answer');
		assert.deepEqual(streamed, ['before-timeout', 'current']);
	});

	it('bounds ask() by DEFAULT_ASK_TIMEOUT_MS when no timeout is given; null waits without a bound', async () => {
		assert.equal(DEFAULT_ASK_TIMEOUT_MS, 120_000);
		const { store, world, clock } = makeVx(projectRows(['chat_1', 'tools_1']));
		await store.refresh(world.client);
		const chat = store.channel(world.client, store.getState().endpoints[0]!, 'chat');
		world.chatBehave = () => new Promise(() => undefined);
		const bounded: { outcome: unknown } = { outcome: 'pending' };
		void chat.ask('slow').catch((e: unknown) => { bounded.outcome = e; });
		await clock.advance(DEFAULT_ASK_TIMEOUT_MS - 1);
		assert.equal(String(bounded.outcome), 'pending');
		await clock.advance(1);
		assert.equal((bounded.outcome as ExplorerToolError).kind, 'timeout');
		assert.equal(clock.pending(), 0);

		const unbounded: { outcome: unknown } = { outcome: 'pending' };
		void chat.ask('slow', { timeoutMs: null }).catch((e: unknown) => { unbounded.outcome = e; });
		await clock.settle();
		assert.equal(clock.pending(), 0, 'no timer for an explicit opt-out');
		await clock.advance(10 * DEFAULT_ASK_TIMEOUT_MS);
		assert.equal(unbounded.outcome, 'pending');
	});

	it('hands out one channel per endpoint, role and client, until reset', async () => {
		const { store, world } = makeVx(projectRows(['chat_1', 'tools_1']));
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		const chat = store.channel(world.client, endpoint, 'chat');
		assert.equal(store.channel(world.client, { ...endpoint }, 'chat'), chat);
		assert.notEqual(store.channel(world.client, endpoint, 'tools'), chat);
		const other = { ...world.client };
		assert.notEqual(store.channel(other, endpoint, 'chat'), chat);
		store.reset();
		assert.notEqual(store.channel(world.client, endpoint, 'chat'), chat);
	});

	it('gives single-role (SQL, Graph) stores a tools channel too, on the endpoint\'s token', async () => {
		const { store, world } = make();
		await store.refresh(world.client);
		const endpoint = store.getState().endpoints[0]!;
		const tools = store.channel(world.client, endpoint, 'tools');
		assert.equal(tools.bound, true);
		await tools.invoke('dialect', {}, { nodeId: 'db_1' });
		assert.equal(world.calls[world.calls.length - 1]!.token, world.rows[0]!.token);
	});
});

// =============================================================================
// SQL AND GRAPH SNAPSHOTS (byte-identical to the single-role library)
// =============================================================================

describe('single-role (SQL, Graph) snapshots stay byte-identical', () => {
	/**
	 * The serialised snapshot of a single-role store after one refresh over a
	 * fixed world. The expected strings were produced by the library before
	 * multi-role connections existed; a change here changes what SQL and Graph
	 * Explorer persist and show.
	 *
	 * @param providers - The app's providers.
	 * @param dialect - What every probe answers.
	 * @returns The snapshot as JSON.
	 */
	async function snapshot(providers: string[], dialect: string): Promise<string> {
		const rows = [
			row(),
			row({ runKind: 'deploy', ownerKind: 'team', ownerId: 'team-1' }),
			row({ source: 'tools_2', name: 'Graph B', pipeline: { project_id: 'g', components: [{ id: 'g_1', provider: 'graph_neo4j', name: 'Neo4j' }, { id: 'db_2', provider: 'db_postgres' }] } }),
		];
		const world = fakeWorld(rows, (call) => (call.tool === 'dialect' ? { dialect } : {}));
		const store = createEndpointStore({ providers: new Set(providers), roles: SINGLE_TOOLS_ROLE, tools: {}, clock: manualClock() });
		await store.refresh(world.client);
		return JSON.stringify(store.getState());
	}

	it('SQL Explorer', async () => {
		assert.equal(await snapshot(['db_postgres'], 'sql'), '{"status":"ready","endpoints":[{"key":"k1|dev|user|u1|team-1|g|tools=tools_2|db_2","legacyKey":"g:tools_2:db_2","projectId":"g","pipelineName":"Graph B","runKind":"dev","ownerKind":"user","ownerId":"u1","teamId":"team-1","roles":{"tools":{"source":"tools_2"}},"missingRoles":[],"source":"tools_2","nodeId":"db_2","nodeName":"db_2","provider":"db_postgres","state":"ready","running":true},{"key":"k1|deploy|team|team-1|team-1|proj-1|tools=tools_1|db_1","legacyKey":null,"projectId":"proj-1","pipelineName":"Pipeline A","runKind":"deploy","ownerKind":"team","ownerId":"team-1","teamId":"team-1","roles":{"tools":{"source":"tools_1"}},"missingRoles":[],"source":"tools_1","nodeId":"db_1","nodeName":"Orders DB","provider":"db_postgres","state":"ready","running":true},{"key":"k1|dev|user|u1|team-1|proj-1|tools=tools_1|db_1","legacyKey":"proj-1:tools_1:db_1","projectId":"proj-1","pipelineName":"Pipeline A","runKind":"dev","ownerKind":"user","ownerId":"u1","teamId":"team-1","roles":{"tools":{"source":"tools_1"}},"missingRoles":[],"source":"tools_1","nodeId":"db_1","nodeName":"Orders DB","provider":"db_postgres","state":"ready","running":true}],"probes":{"k1|dev|user|u1|team-1|g|tools=tools_2|db_2":{"ok":true,"info":{"dialect":"sql"},"dialect":"sql"},"k1|deploy|team|team-1|team-1|proj-1|tools=tools_1|db_1":{"ok":true,"info":{"dialect":"sql"},"dialect":"sql"},"k1|dev|user|u1|team-1|proj-1|tools=tools_1|db_1":{"ok":true,"info":{"dialect":"sql"},"dialect":"sql"}},"error":null,"refreshedAt":1000000}');
	});

	it('Graph Explorer', async () => {
		assert.equal(await snapshot(['graph_neo4j'], 'graph'), '{"status":"ready","endpoints":[{"key":"k1|dev|user|u1|team-1|g|tools=tools_2|g_1","legacyKey":"g:tools_2:g_1","projectId":"g","pipelineName":"Graph B","runKind":"dev","ownerKind":"user","ownerId":"u1","teamId":"team-1","roles":{"tools":{"source":"tools_2"}},"missingRoles":[],"source":"tools_2","nodeId":"g_1","nodeName":"Neo4j","provider":"graph_neo4j","state":"ready","running":true}],"probes":{"k1|dev|user|u1|team-1|g|tools=tools_2|g_1":{"ok":true,"info":{"dialect":"graph"},"dialect":"graph"}},"error":null,"refreshedAt":1000000}');
	});
});
