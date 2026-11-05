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
import { createEndpointStore } from './store';
import type { EndpointWatch, IEndpointStore, IWatchHandlers } from './store';
import { codedError, fakeWorld, manualClock, row } from './testing';
import type { IFakeWorld, IManualClock, IToolCall } from './testing';
import { SINGLE_TOOLS_ROLE, VECTOR_ROLES } from '../types';
import type { IExplorerIdentity } from '../types';
import { identityFingerprint, identityFromConnectResult } from './identity';
import { ExplorerToolError } from '../errors';
import { checkRowEnvelope } from '../checks';

const DB = new Set(['db_postgres']);
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

	it('a vector connection missing its tools source is listed stopped with no probe', async () => {
		const vec = (source: string) => row({ source, pipeline: { project_id: 'vp', components: [{ id: 'v_1', provider: 'rocketride_vector' }] } });
		const { store, world } = make([vec('ingest_1'), vec('chat_1')], undefined, { providers: new Set(['rocketride_vector']), roles: VECTOR_ROLES });
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
