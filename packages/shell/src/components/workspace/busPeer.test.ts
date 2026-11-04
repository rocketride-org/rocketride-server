// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// BUS PEER TESTS — the tool peer's lane semantics over a local registry
// =============================================================================

/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRetainedRegistry, localRetainedPort } from '../../ops/retained';
import { announceFramePresence, createSidebarBusPeer, createFrameBusPeer } from './busPeer';
import type { IBusPeerBus } from './busPeer';

/**
 * Drains pending bus delivery. The registry delivers every signal on a
 * setTimeout(0), and handlers may chain further signals — a fixed delay races
 * those chains when the event loop is starved (parallel builder tasks). Each
 * zero-delay hop here yields one FULL loop turn, so ten hops flush any
 * delivery chain regardless of load.
 */
const settle = async (): Promise<void> => {
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
};

/** One realm's bus verbs over a shared local registry + an op recorder. */
function makeBus(registry = createRetainedRegistry()) {
	const port = localRetainedPort(registry);
	const emitted: Array<{ op: string; params: unknown }> = [];
	const bus: IBusPeerBus = {
		publish: port.publish,
		signal: port.signal,
		subscribe: port.subscribe,
		read: port.read,
		emitOp: (op, params) => emitted.push({ op, params }),
	};
	return { bus, registry, emitted };
}

const state = (topic: string, snapshot: unknown) => ({ __rrtool: 'state', topic, snapshot });

test('sidebar state retains at the root; a late frame replays host:connection FIRST, then state', async () => {
	const { bus, registry } = makeBus();
	registry.publish('host:connection', { connected: true });
	const sidebar = createSidebarBusPeer('t1', bus);
	sidebar.post(state('grid', { rows: 3 }));
	sidebar.post(state('filter', { q: 'x' }));
	await settle();

	const frame = createFrameBusPeer('t1', bus);
	const seen: unknown[] = [];
	frame.subscribe((m) => seen.push(m));
	await settle();

	// host:connection state message first, then both retained state topics.
	assert.equal((seen[0] as { topic: string }).topic, 'host:connection');
	const topics = (seen.slice(1) as Array<{ topic: string }>).map((m) => m.topic).sort();
	assert.deepEqual(topics, ['filter', 'grid']);
});

test('a sidebar EVENT with no frame buffers and summons; the frame hello flushes it', async () => {
	const { bus, emitted } = makeBus();
	const sidebar = createSidebarBusPeer('t1', bus);
	sidebar.post({ kind: 'open-table', name: 'users' });
	await settle();
	// No frame: buffered + summoned exactly once.
	assert.deepEqual(emitted, [{ op: 'host.openToolPanel', params: { appId: 't1' } }]);

	const frame = createFrameBusPeer('t1', bus);
	const seen: unknown[] = [];
	frame.subscribe((m) => seen.push(m));
	announceFramePresence('t1', bus); // the mount's HELLO is the flush trigger
	await settle();
	assert.deepEqual(seen.at(-1), { kind: 'open-table', name: 'users' });
});

test('a frame CALL with no mounted sidebar holds and summons the controller', async () => {
	const { bus, emitted } = makeBus();
	// The peer exists (the host arms it for every pinned tool) but no
	// sidebar mount has subscribed — the lazy-mount case.
	const sidebar = createSidebarBusPeer('t1', bus);
	const frame = createFrameBusPeer('t1', bus);
	frame.subscribe(() => {});
	frame.post({ __rrtool: 'call', id: 'c1', op: 'monitor.listTasks', params: {} });
	frame.post({ __rrtool: 'call', id: 'c2', op: 'monitor.listConnections', params: {} });
	await settle();

	// A burst is ONE mount request, not one per call.
	assert.deepEqual(
		emitted.filter((e) => e.op === 'host.mountToolSidebar'),
		[{ op: 'host.mountToolSidebar', params: { appId: 't1' } }],
	);

	// The summoned mount receives everything held, in arrival order.
	const seen: unknown[] = [];
	sidebar.subscribe((m) => seen.push(m));
	await settle();
	assert.deepEqual(
		(seen as Array<{ id?: string }>).filter((m) => m?.id).map((m) => m.id),
		['c1', 'c2'],
	);
});

test('a mounted sidebar never summons; a later unmount summons again', async () => {
	const { bus, emitted } = makeBus();
	const sidebar = createSidebarBusPeer('t1', bus);
	const off = sidebar.subscribe(() => {});
	const frame = createFrameBusPeer('t1', bus);
	frame.subscribe(() => {});
	frame.post({ __rrtool: 'call', id: 'c1', op: 'x', params: {} });
	await settle();
	assert.deepEqual(emitted.filter((e) => e.op === 'host.mountToolSidebar'), [], 'mounted: no summon');

	off();
	frame.post({ __rrtool: 'call', id: 'c2', op: 'x', params: {} });
	await settle();
	assert.equal(emitted.filter((e) => e.op === 'host.mountToolSidebar').length, 1, 'unmounted: summoned again');
});

test('events signal directly once a frame is ready; replies are live-only', async () => {
	const { bus } = makeBus();
	const sidebar = createSidebarBusPeer('t1', bus);
	const frame = createFrameBusPeer('t1', bus);
	const seen: unknown[] = [];
	frame.subscribe((m) => seen.push(m));
	const bye = announceFramePresence('t1', bus);
	await settle();

	sidebar.post({ kind: 'refresh' });
	await settle();
	assert.deepEqual(seen.at(-1), { kind: 'refresh' });

	// BYE re-arms buffering: the next event waits for the next mount.
	bye();
	await settle(); // signals deliver async — let the BYE land first
	sidebar.post({ kind: 'after-bye' });
	await settle();
	assert.deepEqual(seen.at(-1), { kind: 'refresh' }, 'event after BYE is buffered, not delivered');
	announceFramePresence('t1', bus);
	await settle();
	assert.deepEqual(seen.at(-1), { kind: 'after-bye' }, 'the next HELLO flushes it');
});

test('frame non-call payloads retain the LAST one; a remounting sidebar replays it', async () => {
	const { bus } = makeBus();
	const frame = createFrameBusPeer('t1', bus);
	frame.post({ status: 'running' });
	frame.post({ status: 'done' });
	await settle();

	const sidebar = createSidebarBusPeer('t1', bus);
	const seen: unknown[] = [];
	sidebar.subscribe((m) => seen.push(m));
	await settle();
	assert.deepEqual(seen, [{ status: 'done' }]);
});

test('frame CALLS reach a live sidebar and are never retained', async () => {
	const { bus } = makeBus();
	const sidebar = createSidebarBusPeer('t1', bus);
	const seen: unknown[] = [];
	sidebar.subscribe((m) => seen.push(m));
	await settle();

	const frame = createFrameBusPeer('t1', bus);
	frame.subscribe(() => {});
	await settle();
	const call = { __rrtool: 'call', id: 1, op: 'explorer.listDir', params: {} };
	frame.post(call);
	await settle();
	assert.deepEqual(seen.at(-1), call);

	// A remounting sidebar must NOT replay the call.
	const sidebar2 = createSidebarBusPeer('t2-remount-check', bus);
	const replayed: unknown[] = [];
	sidebar2.subscribe((m) => replayed.push(m));
	await settle();
	assert.deepEqual(replayed, []);
});

test('a reborn sidebar peer reads the state map before writing (no clobber)', async () => {
	const { bus, registry } = makeBus();
	const sidebar1 = createSidebarBusPeer('t1', bus);
	sidebar1.post(state('grid', { rows: 3 }));
	await settle();

	// Realm reboot: a fresh peer over the same root publishes ONE topic —
	// the other retained topic must survive.
	const sidebar2 = createSidebarBusPeer('t1', bus);
	sidebar2.post(state('filter', { q: 'y' }));
	await settle();

	const map = registry.read('tool:t1:state') as Record<string, unknown>;
	assert.deepEqual(Object.keys(map).sort(), ['filter', 'grid']);
});

test('host presence topic gates summoning (panel exists → no summon)', async () => {
	const { bus, registry, emitted } = makeBus();
	registry.publish('tool:t1:panels', 1);
	const sidebar = createSidebarBusPeer('t1', bus);
	await settle(); // presence delivery

	sidebar.post({ kind: 'event-while-panel-boots' });
	await settle();
	// The panel exists but no hello yet: buffered, NOT summoned.
	assert.deepEqual(emitted, []);

	const frame = createFrameBusPeer('t1', bus);
	const seen: unknown[] = [];
	frame.subscribe((m) => seen.push(m));
	announceFramePresence('t1', bus); // the hello is still the flush trigger
	await settle();
	assert.deepEqual(seen.at(-1), { kind: 'event-while-panel-boots' });
});
