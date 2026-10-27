// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL TEST SUPPORT: the controller over the REAL shell modules
// =============================================================================
//
// The bus, the peers, the op lane and the channel are the shell's real modules
// (shared/explorer/devtool/testing.ts, JSON wire ON by default, as VS Code's
// postMessage carries every payload). The realm's ConnectionManager is the
// base's fake VS Code or rocket-ui realm, with its `request` routed to a fake
// engine (vectorWorld) and every bus request recorded. `client.listTasks`
// answers an empty page unless the world lists tasks itself.
// =============================================================================

import { makeVectorEndpointStore } from '../../src/adapters/explorer';
import { createVectorController } from '../../src/devtool/controller';
import type { IVectorController, IVectorControllerOptions, IVectorRealm } from '../../src/devtool/controller';
import { VECTOR_APP_ID } from '../../src/devtool/protocol';
import type { IFakeRow, IFakeWorld } from 'shared/explorer/connect/testing';
import { account, createDevToolHarness, createFakeClientRealm, createFakeSocketlessRealm, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import type { IDevToolHarness, IPeerSpy } from 'shared/explorer/devtool/testing';
import { vectorRows, vectorWorld } from './vectorWorld';
import type { ToolBehaviour } from './vectorWorld';

/** One bus request the code under test made. */
export interface IBusRequest {
	op: string;
	params: unknown;
	timeoutMs: number | undefined;
}

/** A fake engine behind a fake realm. */
export interface IEngineRealm {
	/** The realm's ConnectionManager, with `request` routed to the engine. */
	cm: IVectorRealm & { request(op: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown> };
	/** The engine (task rows, tool behaviour, every tool call). */
	world: IFakeWorld;
	/** Every bus request, in order. */
	requests: IBusRequest[];
}

/** Everything a test mounted, disposed after each test (so a failing test leaves no timer keeping the run alive). */
const mounted: Array<{ dispose(): void }> = [];

/**
 * Keep a disposable for {@link disposeAll}.
 *
 * @param disposable - A controller, a frame, a caller.
 * @returns It.
 */
export function track<T extends { dispose(): void }>(disposable: T): T {
	mounted.push(disposable);
	return disposable;
}

/** Dispose everything tracked (idempotent disposals), for `afterEach`. */
export function disposeAll(): void {
	for (const disposable of mounted.splice(0).reverse()) {
		try {
			disposable.dispose();
		} catch {
			// A disposal that throws must not keep the others alive.
		}
	}
}

/** The empty page an engine's task list answers when the world lists nothing. */
export const EMPTY_TASK_PAGE = { rows: [], total: 0, page: 1, pageSize: 100 };

/**
 * Route a fake realm's bus requests to a fake engine.
 *
 * @param base - The fake realm's manager.
 * @param world - The engine.
 * @returns The engine realm.
 */
function withEngine(base: object, world: IFakeWorld): IEngineRealm {
	const requests: IBusRequest[] = [];
	const request = async (op: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown> => {
		requests.push({ op, params, timeoutMs: opts?.timeoutMs });
		const p = (params ?? {}) as Record<string, unknown>;
		switch (op) {
			case 'client.getTasks':
				return world.client.getTasks();
			case 'client.listTasks':
				return world.client.listTasks ? world.client.listTasks(p) : EMPTY_TASK_PAGE;
			case 'client.getTaskPipeline':
				return world.client.getTaskPipeline(p.token as string);
			case 'client.tool':
				return world.client.tool(p as never);
			case 'client.addMonitor':
			case 'client.removeMonitor':
				return undefined;
			default:
				throw new Error(`No handler serves '${op}'`);
		}
	};
	return { cm: Object.assign(Object.create(null), base, { request }) as IEngineRealm['cm'], world, requests };
}

/**
 * A VS Code realm (socketless: the sidebar mounts lazily) with an engine.
 *
 * @param over - Per-tool answers that replace the defaults.
 * @param rows - The task rows.
 * @returns The realm and its engine.
 */
export function vscodeRealm(over: Partial<Record<string, ToolBehaviour>> = {}, rows: IFakeRow[] = vectorRows()) {
	const realm = createFakeSocketlessRealm();
	return { realm, ...withEngine(realm.cm, vectorWorld(over, rows)) };
}

/**
 * A rocket-ui realm (the realm owns the client) with an engine.
 *
 * @param over - Per-tool answers that replace the defaults.
 * @param rows - The task rows.
 * @returns The realm and its engine.
 */
export function rocketRealm(over: Partial<Record<string, ToolBehaviour>> = {}, rows: IFakeRow[] = vectorRows()) {
	const realm = createFakeClientRealm();
	return { realm, ...withEngine(realm.cm, vectorWorld(over, rows)) };
}

/** A documents API that records what was opened and closed. */
export function recordingDocuments() {
	const opened: Array<{ key: string; title: string }> = [];
	const closed: string[] = [];
	return {
		opened,
		closed,
		documents: {
			open: (key: string, title: string) => {
				opened.push({ key, title });
			},
			close: (key: string) => {
				closed.push(key);
			},
		},
	};
}

/** A mounted controller over the real sidebar peer (spied) and a host channel, as both hosts mount it. */
export interface IMountedController {
	h: IDevToolHarness;
	spy: IPeerSpy;
	/** The host's channel (it outlives the controller, as the hosts' per-peer channel does). */
	hostChannel: ReturnType<typeof shellProtocol.createToolChannel>;
	controller: IVectorController;
	docs: ReturnType<typeof recordingDocuments>;
	errors: Array<{ where: string; error: unknown }>;
}

/**
 * Mount the controller as a host does: the host's channel first, then the controller. A REMOUNT reuses the host's
 * peer and channel (both hosts build one channel per peer and keep it while the controller comes and goes).
 *
 * @param cm - The realm.
 * @param over - Controller options to override.
 * @param h - A harness to reuse (default: a fresh one, JSON wire on).
 * @param reuse - A previous mount whose peer spy and host channel to keep.
 * @returns The mount.
 */
export function mountController(cm: IVectorRealm, over: Partial<IVectorControllerOptions> = {}, h: IDevToolHarness = createDevToolHarness(VECTOR_APP_ID), reuse?: IMountedController): IMountedController {
	const spy = reuse?.spy ?? spyPeer(h.sidebarPeer);
	const channel = reuse?.hostChannel ?? shellProtocol.createToolChannel(spy.peer);
	const docs = recordingDocuments();
	const errors: Array<{ where: string; error: unknown }> = [];
	const controller = track(createVectorController({
		cm,
		peer: spy.peer,
		channel,
		documents: docs.documents,
		createToolChannel: shellProtocol.createToolChannel,
		createToolOpServer: shellProtocol.createToolOpServer,
		focusTarget: null,
		store: makeVectorEndpointStore({ debounceMs: 0 }),
		onError: (error, where) => errors.push({ where, error }),
		...over,
	}));
	return { h, spy, hostChannel: channel, controller, docs, errors };
}

/** Timers a test runs by hand (a frame's summon): `advance(ms)` fires what falls due, in order. */
export interface IManualTimers {
	/** The scheduler to inject (returns a cancel). */
	schedule(fn: () => void, ms: number): () => void;
	/** Move time on, firing every timer that falls due. */
	advance(ms: number): void;
	/** How many timers are still scheduled. */
	pending(): number;
}

/**
 * Timers that fire only when the test advances them.
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
			return () => {
				entry.live = false;
			};
		},
		advance(ms) {
			const end = now + ms;
			for (;;) {
				const next = due.filter((entry) => entry.live && entry.at <= end).sort((a, b) => a.at - b.at)[0];
				if (!next) break;
				next.live = false;
				now = next.at;
				next.fn();
			}
			now = end;
		},
		pending: () => due.filter((entry) => entry.live).length,
	};
}

/**
 * Wait until a condition holds (bus hops are macrotasks).
 *
 * @param predicate - The condition.
 * @param what - Named in the failure.
 * @param rounds - How many settle rounds to allow.
 */
export async function until(predicate: () => boolean, what: string, rounds = 80): Promise<void> {
	for (let i = 0; i < rounds; i += 1) {
		if (predicate()) return;
		await settle();
	}
	throw new Error(`timed out waiting for ${what}`);
}

/**
 * Sign a VS Code realm in (the root connected with this account).
 *
 * @param realm - The realm.
 * @param userId - The user.
 */
export function signInVsCode(realm: ReturnType<typeof createFakeSocketlessRealm>, userId = 'u1'): void {
	realm.root.connect(account(userId));
}

/**
 * The posts a sidebar made that are not retained state (events and calls).
 *
 * @param posts - Everything the spied sidebar peer posted.
 * @returns The non-state posts.
 */
export function nonStatePosts(posts: unknown[]): unknown[] {
	return posts.filter((post) => (post as { __rrtool?: string })?.__rrtool !== 'state');
}

/**
 * The whole retained state map as the sidebar peer last republished it (busPeer republishes ALL topics on every
 * publish, which is why the total is capped).
 *
 * @param h - The harness.
 * @returns The map: topic -> state message.
 */
export function latestStateMap(h: IDevToolHarness): Record<string, { __rrtool?: string; topic?: string; snapshot?: unknown }> {
	for (let i = h.wire.length - 1; i >= 0; i -= 1) {
		const entry = h.wire[i];
		if (entry.transient || entry.value === null || typeof entry.value !== 'object') continue;
		const values = Object.values(entry.value as Record<string, { __rrtool?: string }>);
		if (values.length > 0 && values.every((m) => m?.__rrtool === 'state')) return entry.value as Record<string, { snapshot?: unknown }>;
	}
	throw new Error('no retained state map was published');
}

/**
 * Every state snapshot the sidebar published, in order.
 *
 * @param h - The harness.
 * @returns The snapshots, with their topics.
 */
export function publishedStates(h: IDevToolHarness): Array<{ topic: string; snapshot: unknown }> {
	const out: Array<{ topic: string; snapshot: unknown }> = [];
	for (const entry of h.wire) {
		if (entry.transient || entry.value === null || typeof entry.value !== 'object') continue;
		for (const message of Object.values(entry.value as Record<string, unknown>)) {
			const m = message as { __rrtool?: string; topic?: string; snapshot?: unknown };
			if (m?.__rrtool === 'state' && typeof m.topic === 'string') out.push({ topic: m.topic, snapshot: m.snapshot });
		}
	}
	return out;
}

export { account, settle, shellProtocol };
