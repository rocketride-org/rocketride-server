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
// EXPLORER DEV TOOL — DISCOVERY GATE (no discovery while identity is unknown
// or the controller has not been activated; T6/T7 base)
// =============================================================================

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionManager } from 'shell';
import { createEndpointStore } from '../connect/store';
import { fakeWorld, manualClock, row } from '../connect/testing';
import type { IFakeWorld, IManualClock } from '../connect/testing';
import { identityFromConnectResult } from '../connect/identity';
import { SINGLE_TOOLS_ROLE } from '../types';
import type { IExplorerClient } from '../types';
import { createIdentityTracker } from './identity';
import { createEngineReadiness } from './readiness';
import type { IEngineReadiness } from './readiness';
import { createDevToolDiscovery } from './watch';
import type { IDiscoveryBus } from './watch';
import { account, createFakeClientRealm, createFakeMirroredRealm, settle } from './testing';
import type { IFakeClientRealm } from './testing';

const APP = 'sql-ui';

/** A rocket-ui-style rig: client realm, controller mount, a store over a fake engine. */
interface IRig {
	realm: IFakeClientRealm;
	world: IFakeWorld;
	clock: IManualClock;
	monitors: string[];
	client: IExplorerClient;
	engine: IEngineReadiness;
	discovery: ReturnType<typeof createDevToolDiscovery>;
	/** Tell the readiness what the realm's client and connection are now (what useRealmEngine does on every render). */
	syncEngine: () => void;
	detach: () => void;
	dispose: () => void;
	allowed: () => boolean;
	endpoints: () => number;
}

/**
 * Build the controller-side composition the lanes use: tracker + engine readiness + discovery watch + store.
 *
 * @param opts - `engineStaysDown`: never tell the readiness the realm's client is there (a realm that cannot answer yet).
 * @returns The rig.
 */
function rig(opts: { engineStaysDown?: boolean; present?: boolean } = {}): IRig {
	const realm = createFakeClientRealm();
	const world = fakeWorld([row({ ownerId: 'user-a', teamId: 'team-1' })]);
	const clock = manualClock();
	const monitors: string[] = [];
	const client: IExplorerClient = {
		...world.client,
		addMonitor: async () => { monitors.push('add'); },
		removeMonitor: async () => { monitors.push('remove'); },
	};
	const identity = createIdentityTracker({ cm: realm.cm });
	const engine = createEngineReadiness();
	const syncEngine = (): void => { if (!opts.engineStaysDown) engine.set({ client: realm.cm.getClient(), isConnected: realm.cm.isConnected() }); };
	const offConnected = realm.cm.on('shell:connected', syncEngine);
	const offDisconnected = realm.cm.on('shell:disconnected', syncEngine);
	const discovery = createDevToolDiscovery({ cm: realm.cm, client, identity, engine, focusTarget: null, present: opts.present ?? true });
	const store = createEndpointStore({ providers: new Set(['db_postgres']), roles: SINGLE_TOOLS_ROLE, tools: {}, clock, holdProbes: () => discovery.holdProbes() });
	const detach = store.attach(client, identity.get().identity, discovery.watch);
	return {
		realm,
		world,
		clock,
		monitors,
		client,
		engine,
		discovery,
		syncEngine,
		detach,
		dispose: () => { detach(); discovery.dispose(); offConnected(); offDisconnected(); identity.dispose(); },
		allowed: () => discovery.allowed(),
		endpoints: () => store.getState().endpoints.length,
	};
}

describe('the ConnectionManager satisfies the structural discovery bus', () => {
	it('compiles: a realm ConnectionManager is an IDiscoveryBus', () => {
		const check = (cm: ConnectionManager): IDiscoveryBus => cm;
		assert.equal(typeof check, 'function');
	});
});

describe('createDevToolDiscovery', () => {
	it('DA-R2-04: a controller mounted at host boot issues ZERO tool calls until a user-presence trigger; the first trigger probes once', async () => {
		const r = rig({ present: false });
		r.realm.login(account('user-a', 'org-1', 'team-1'));
		await r.clock.advance(1_000);
		assert.equal(r.world.getTasksCalls, 1, 'discovery (a read of the task list) runs at mount');
		assert.equal(r.endpoints(), 1, 'the endpoint is listed');
		assert.equal(r.world.calls.length, 0, 'but no endpoint is probed: no tool call reaches a pipeline');
		assert.equal(r.discovery.holdProbes(), true);
		r.realm.emit('shell:event', { event: { event: 'apaevt_task', body: { action: 'begin' } } });
		await r.clock.advance(1_000);
		assert.equal(r.world.calls.length, 0, 'task events and focus do not count as presence');

		r.discovery.markUserPresent('op');
		await r.clock.advance(1_000);
		assert.deepEqual(r.world.calls.map((call) => call.tool), ['dialect'], 'the first trigger probes once');
		r.discovery.markUserPresent('user');
		await r.clock.advance(1_000);
		assert.equal(r.world.calls.length, 1, 'a later trigger starts nothing');
		r.dispose();
	});

	it('a null account means no discovery call, whatever wakes the store', async () => {
		const r = rig();
		r.realm.emit('shell:event', { event: { event: 'apaevt_task', body: { action: 'begin' } } });
		await r.clock.advance(1_000);
		assert.equal(r.allowed(), false);
		assert.equal(r.world.getTasksCalls, 0);
		assert.deepEqual(r.monitors, [], 'no engine traffic at all');
		r.dispose();
	});

	it('signed in with the engine ready means exactly one discovery and one monitor (a sidebar mounts only when selected or summoned, so mounting is the activation)', async () => {
		const r = rig();
		r.realm.login(account('user-a', 'org-1', 'team-1'));
		await r.clock.advance(1_000);
		assert.equal(r.world.getTasksCalls, 1);
		assert.equal(r.endpoints(), 1);
		assert.deepEqual(r.monitors, ['add']);
		await r.clock.advance(1_000);
		assert.equal(r.world.getTasksCalls, 1, 'a later selection starts nothing more');
		r.dispose();
		await settle();
		assert.deepEqual(r.monitors, ['add', 'remove']);
	});

	it('signed in but the realm has no client yet (engine waiting) means no discovery and no monitor; the engine becoming ready starts exactly one', async () => {
		const r = rig({ engineStaysDown: true });
		r.realm.login(account('user-a', 'org-1', 'team-1'));
		r.realm.emit('shell:event', { event: { event: 'apaevt_task', body: { action: 'begin' } } });
		await r.clock.advance(1_000);
		assert.equal(r.engine.status(), 'waiting');
		assert.equal(r.allowed(), false);
		assert.equal(r.world.getTasksCalls, 0);
		assert.deepEqual(r.monitors, []);
		r.engine.set({ client: r.realm.cm.getClient(), isConnected: true });
		await r.clock.advance(1_000);
		assert.equal(r.world.getTasksCalls, 1);
		assert.equal(r.endpoints(), 1);
		assert.deepEqual(r.monitors, ['add']);
		r.dispose();
		await settle();
		assert.deepEqual(r.monitors, ['add', 'remove']);
	});

	it('task events wake discovery only while allowed', async () => {
		const r = rig();
		r.realm.login(account('user-a', 'org-1', 'team-1'));
		await r.clock.advance(1_000);
		const after = r.world.getTasksCalls;
		r.realm.emit('shell:event', { event: { event: 'apaevt_task', body: { action: 'end' } } });
		await r.clock.advance(1_000);
		assert.equal(r.world.getTasksCalls, after + 1);
		r.realm.drop();
		r.realm.emit('shell:event', { event: { event: 'apaevt_task', body: { action: 'begin' } } });
		await r.clock.advance(1_000);
		assert.equal(r.world.getTasksCalls, after + 1, 'nothing while the identity is unknown');
		r.dispose();
	});

	it('a drop resets the store; the reconnect rediscovers under the identity it brings', async () => {
		const r = rig();
		r.realm.login(account('user-a', 'org-1', 'team-1'));
		await r.clock.advance(1_000);
		assert.equal(r.endpoints(), 1);
		r.realm.drop();
		await r.clock.advance(1_000);
		assert.equal(r.endpoints(), 0, 'identity unknown resets what the store holds');
		const before = r.world.getTasksCalls;
		r.realm.reconnect(account('user-a', 'org-1', 'team-1'));
		await r.clock.advance(1_000);
		assert.equal(r.world.getTasksCalls, before + 1);
		assert.equal(r.endpoints(), 1);
		r.dispose();
	});

	it('a switch between two KNOWN identities while discovery stays allowed rediscovers for the new one', async () => {
		const r = rig();
		r.realm.login(account('user-a', 'org-1', 'team-1'));
		await r.clock.advance(1_000);
		const before = r.world.getTasksCalls;
		assert.equal(r.endpoints(), 1);
		r.world.rows = [row({ ownerId: 'user-a', teamId: 'team-2' })];
		r.realm.accountUpdate(account('user-a', 'org-1', 'team-2'));
		assert.equal(r.allowed(), true, 'allowed throughout: no false -> true edge');
		await r.clock.advance(1_000);
		assert.equal(r.world.getTasksCalls, before + 1, 'the store was reset for team-2 and asked to discover again');
		assert.equal(r.endpoints(), 1);
		const permissionsOnly = r.world.getTasksCalls;
		r.realm.accountUpdate(account('user-a', 'org-1', 'team-2', { permissions: ['task.data'] }));
		await r.clock.advance(1_000);
		assert.equal(r.world.getTasksCalls, permissionsOnly, 'a hint-only change (same fingerprint) does not rediscover');
		r.dispose();
	});

	it('the identity the store holds follows the tracker', async () => {
		const realm = createFakeMirroredRealm();
		realm.root.connect(account('user-a', 'org-1', 'team-1'));
		await settle();
		const world = fakeWorld([row({ ownerId: 'user-a', teamId: 'team-1' })]);
		const clock = manualClock();
		const identity = createIdentityTracker({ cm: realm.cm });
		const engine = createEngineReadiness({ client: realm.cm.getClient(), isConnected: realm.cm.isConnected() });
		const sync = (): void => engine.set({ client: realm.cm.getClient(), isConnected: realm.cm.isConnected() });
		const offConnected = realm.cm.on('shell:connected', sync);
		const offDisconnected = realm.cm.on('shell:disconnected', sync);
		const discovery = createDevToolDiscovery({ cm: realm.cm, client: world.client, identity, engine, focusTarget: null });
		const seen: Array<string | null> = [];
		const store = createEndpointStore({ providers: new Set(['db_postgres']), roles: SINGLE_TOOLS_ROLE, tools: {}, clock });
		store.attach(world.client, identity.get().identity, (handlers) => discovery.watch({
			...handlers,
			onIdentity: (next) => { seen.push(next?.userId ?? null); handlers.onIdentity(next); },
		}));
		await settle();
		await clock.advance(1_000);
		assert.equal(engine.status(), 'ready');
		assert.equal(world.getTasksCalls, 1, 'mounted + identity known + engine ready: discovery runs');
		realm.root.disconnect();
		await settle();
		realm.root.connect(account('user-b', 'org-1', 'team-1'));
		await settle();
		await clock.advance(1_000);
		assert.deepEqual(seen, ['user-a', null, 'user-b']);
		assert.deepEqual(identityFromConnectResult(account('user-b', 'org-1', 'team-1'))?.userId, 'user-b');
		discovery.dispose();
		offConnected();
		offDisconnected();
		identity.dispose();
	});
});
