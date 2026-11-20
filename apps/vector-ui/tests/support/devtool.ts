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
// base's fake VS Code (mirrored) or rocket-ui realm; its client keeps the realm's
// own account answers and serves the engine requests from a fake engine
// (vectorWorld), as the realm's RocketRideClient does in production. Every engine
// request is recorded under the name it had on the bus (`client.<method>`).
// `listTasks` answers an empty page unless the world lists tasks itself.
// =============================================================================

import { createVectorController } from '../../src/devtool/controller';
import type { IVectorController, IVectorControllerOptions, IVectorRealm } from '../../src/devtool/controller';
import { VECTOR_APP_ID } from '../../src/devtool/protocol';
import type { IFakeRow, IFakeWorld } from 'shared/explorer/connect/testing';
import type { IRealmClient, RealmClientGetter } from 'shared/explorer/devtool/engineClient';
import { createEngineReadiness } from 'shared/explorer/devtool/readiness';
import type { IEngineReadiness } from 'shared/explorer/devtool/readiness';
import { toolTransportTimeoutMs } from 'shared/explorer/devtool/timeouts';
import { account, createDevToolHarness, createFakeClientRealm, createFakeMirroredRealm, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import type { IDevToolHarness, IFakeMirroredRealm, IFakeRealmCm, IPeerSpy } from 'shared/explorer/devtool/testing';
import { announceFramePresence } from '../../../../packages/shell/src/components/workspace/busPeer';
import { vectorRows, vectorWorld } from './vectorWorld';
import type { ToolBehaviour } from './vectorWorld';

/** One request the code under test made to the realm's engine client. */
export interface IBusRequest {
	/** `client.<method>`: the name the request had when it rode the bus (kept so one vocabulary reads the same everywhere). */
	op: string;
	params: unknown;
	/** The bus timeout a realm proxy would ask for (`tool`: the SDK timeout plus PROXY_BUS_SLACK_MS); undefined otherwise. */
	timeoutMs: number | undefined;
}

/** A fake engine behind a fake realm. */
export interface IEngineRealm {
	/** The realm's ConnectionManager; its `getClient()` is a realm client that also answers engine requests from the engine. */
	cm: IVectorRealm & IFakeRealmCm;
	/** The engine (task rows, tool behaviour, every tool call). */
	world: IFakeWorld;
	/** Every engine request, in order. */
	requests: IBusRequest[];
	/** Runs before every engine request (hold, delay or fail one). */
	before: { current: ((op: string) => Promise<void> | void) | null };
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
 * Give a fake realm an engine: its client keeps the realm's own account answers (the identity tracker reads them) and
 * serves the engine requests from a fake world, as the realm's RocketRideClient does in production.
 *
 * @param base - The fake realm's manager.
 * @param world - The engine.
 * @returns The engine realm.
 */
function withEngine(base: IFakeRealmCm, world: IFakeWorld): IEngineRealm {
	const requests: IBusRequest[] = [];
	const before: IEngineRealm['before'] = { current: null };
	const record = async (op: string, params: unknown, timeoutMs?: number): Promise<void> => {
		requests.push({ op: `client.${op}`, params, timeoutMs });
		await before.current?.(`client.${op}`);
	};
	const never = (name: string) => async (): Promise<never> => {
		throw new Error(`the Vector tests never call client.${name}`);
	};
	const files = new Map<string, unknown>();
	const engineMethods: Omit<IRealmClient, 'getAccountInfo'> = {
		getTasks: async () => {
			await record('getTasks', {});
			return world.client.getTasks();
		},
		listTasks: async (req) => {
			await record('listTasks', req ?? {});
			return world.client.listTasks ? world.client.listTasks((req ?? {}) as never) : EMPTY_TASK_PAGE;
		},
		getTaskPipeline: async (token) => {
			await record('getTaskPipeline', { token });
			return world.client.getTaskPipeline(token);
		},
		tool: async (options) => {
			await record('tool', options, toolTransportTimeoutMs(options.timeout));
			return world.client.tool(options as never) as never;
		},
		addMonitor: async (key, types) => {
			await record('addMonitor', { key, types });
		},
		removeMonitor: async (key, types) => {
			await record('removeMonitor', { key, types });
		},
		fsStat: async (path) => {
			await record('fsStat', { path });
			return { exists: files.has(path) };
		},
		fsReadJson: async (path) => {
			await record('fsReadJson', { path });
			return files.get(path) as never;
		},
		fsMkdir: async (path) => {
			await record('fsMkdir', { path });
		},
		fsWriteJson: async (path, value) => {
			await record('fsWriteJson', { path, value });
			files.set(path, value);
		},
		use: never('use'),
		getTaskToken: never('getTaskToken'),
		terminate: never('terminate'),
		getService: never('getService'),
		validate: never('validate'),
		account: { getEnvironmentKeys: never('account.getEnvironmentKeys') },
	};
	const cm = Object.assign(Object.create(null), base, {
		// The realm's own client when it has one: its account answers, plus the engine requests.
		getClient: () => {
			const own = base.getClient() as { getAccountInfo(): unknown; isAuthenticated(): boolean } | null;
			return own === null || own === undefined
				? null
				: Object.assign(Object.create(null), engineMethods, { getAccountInfo: () => own.getAccountInfo(), isAuthenticated: () => own.isAuthenticated() });
		},
	}) as IEngineRealm['cm'];
	return { cm, world, requests, before };
}

/**
 * A VS Code realm (a mirrored realm: the sidebar mounts lazily) with an engine.
 *
 * @param over - Per-tool answers that replace the defaults.
 * @param rows - The task rows.
 * @returns The realm and its engine.
 */
export function vscodeRealm(over: Partial<Record<string, ToolBehaviour>> = {}, rows: IFakeRow[] = vectorRows()) {
	const realm = createFakeMirroredRealm();
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

/** What a realm's client is as the engine source sees it. */
type EngineSourceCm = IVectorRealm & { getClient(): unknown; isConnected(): boolean; on(event: string, handler: (payload: never) => void): () => void };

/** The shell events after which a realm's client or connection may have changed. */
const READINESS_EVENTS = ['shell:connected', 'shell:disconnected', 'shell:statusChange', 'shell:login', 'shell:logout', 'shell:accountUpdate'] as const;

/**
 * What `useEngineSource()` does in production, without React: a getter over the realm's current client and a readiness
 * store kept current from the realm's own events.
 *
 * @param cm - The realm.
 * @returns The getter, the readiness and the unsubscribe.
 */
export function engineSource(cm: EngineSourceCm): { getClient: RealmClientGetter<IRealmClient>; readiness: IEngineReadiness; stop(): void } {
	const facts = (): { client: unknown; isConnected: boolean } => ({ client: cm.getClient() ?? null, isConnected: cm.isConnected() });
	const readiness = createEngineReadiness(facts());
	const offs = READINESS_EVENTS.map((event) => cm.on(event, () => readiness.set(facts())));
	return { getClient: () => (cm.getClient() as IRealmClient | null) ?? null, readiness, stop: () => offs.forEach((off) => off()) };
}

/**
 * What a host does when a frame mounts (DevToolMount's effect): HELLO to the sidebar peer, which flips it to direct
 * event delivery and flushes what it buffered. A frame that has not been announced hears no controller event.
 *
 * @param h - The harness.
 * @returns Cleanup (says BYE).
 */
export function announceFrame(h: IDevToolHarness): () => void {
	return announceFramePresence(h.appId, h.bus);
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
 * peer and channel (both hosts build one channel per peer and keep it while the controller comes and goes). A person
 * is present by default (`present: true`); pass `present: false` for a pinned tool's boot mount.
 *
 * @param cm - The realm.
 * @param over - Controller options to override.
 * @param h - A harness to reuse (default: a fresh one, JSON wire on).
 * @param reuse - A previous mount whose peer spy and host channel to keep.
 * @returns The mount.
 */
export function mountController(cm: EngineSourceCm, over: Partial<IVectorControllerOptions> = {}, h: IDevToolHarness = createDevToolHarness(VECTOR_APP_ID), reuse?: IMountedController): IMountedController {
	const spy = reuse?.spy ?? spyPeer(h.sidebarPeer);
	const channel = reuse?.hostChannel ?? shellProtocol.createToolChannel(spy.peer);
	const docs = recordingDocuments();
	const errors: Array<{ where: string; error: unknown }> = [];
	const source = engineSource(cm);
	const controller = track(createVectorController({
		cm,
		channel,
		getClient: source.getClient,
		readiness: source.readiness,
		documents: docs.documents,
		createToolOpServer: shellProtocol.createToolOpServer,
		focusTarget: null,
		present: true,
		...(over.store ? {} : { endpointOptions: { debounceMs: 0 } }),
		onError: (error, where) => errors.push({ where, error }),
		...over,
	}));
	// The realm's listeners the source added go with the controller (the leak checks count them).
	const dispose = controller.dispose.bind(controller);
	Object.assign(controller, { dispose: () => { source.stop(); dispose(); } });
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
export function signInVsCode(realm: IFakeMirroredRealm, userId = 'u1'): void {
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
