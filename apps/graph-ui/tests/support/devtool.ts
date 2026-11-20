// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL TEST SUPPORT: the controller and frames over the REAL shell modules
// =============================================================================
//
// The peers, the op lane and the channel are the shell's real modules
// (shared/explorer/devtool/testing.ts, JSON wire ON by default, as VS Code's
// postMessage carries every payload). The realm's ConnectionManager is the
// base's fake VS Code (mirrored) or rocket-ui realm; its client keeps the
// realm's account answers and serves engine requests from a fake engine (the
// shared library's fakeWorld), every one recorded as `client.<method>`.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { makeGraphHistory } from '../../src/adapters/explorer';
import { createGraphController } from '../../src/devtool/controller';
import type { IGraphController, IGraphControllerOptions, IGraphRealm } from '../../src/devtool/controller';
import { createGraphFrame } from '../../src/devtool/frame';
import type { IGraphFrame, IGraphFrameOptions } from '../../src/devtool/frame';
import { GRAPH_APP_ID } from '../../src/devtool/protocol';
import { fakeWorld, row } from 'shared/explorer/connect/testing';
import type { IFakeRow, IFakeWorld, IToolCall } from 'shared/explorer/connect/testing';
import { createEngineReadiness } from 'shared/explorer/devtool/readiness';
import type { IEngineReadiness } from 'shared/explorer/devtool/readiness';
import type { IRealmClient, RealmClientGetter } from 'shared/explorer/devtool/engineClient';
import { toolTransportTimeoutMs } from 'shared/explorer/devtool/timeouts';
import { account, createDevToolHarness, createFakeClientRealm, createFakeMirroredRealm, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import type { IDevToolHarness, IFakeMirroredRealm, IFakeRealmCm, IPeerSpy } from 'shared/explorer/devtool/testing';

const LIVE = path.resolve(__dirname, '..', 'fixtures', 'v1', 'live');

/** The node's live `dialect` answers. */
export const NEO4J_DIALECT = JSON.parse(fs.readFileSync(path.join(LIVE, 'neo4j_dialect.json'), 'utf8')) as Record<string, unknown>;
/** The same node with direct execution ON (the write console's gate). */
export const NEO4J_WRITABLE = { ...NEO4J_DIALECT, allow_execute: true };
/** A live read_query answer. */
export const NEO4J_GRAPH = JSON.parse(fs.readFileSync(path.join(LIVE, 'neo4j_read_query_graph.json'), 'utf8')) as Record<string, unknown>;
/** A live get_schema answer. */
export const NEO4J_SCHEMA = JSON.parse(fs.readFileSync(path.join(LIVE, 'neo4j_get_schema.json'), 'utf8')) as Record<string, unknown>;

/**
 * A running pipeline with one Neo4j graph node.
 *
 * @param over - Fields to override.
 * @returns The task row.
 */
export function graphRow(over: Partial<IFakeRow> = {}): IFakeRow {
	return row({
		name: 'People',
		pipeline: { project_id: over.pipeline?.project_id ?? 'proj-g', name: 'People', components: [{ id: 'graph_1', provider: 'graph_neo4j', name: 'People graph' }] },
		...over,
	});
}

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
	cm: IGraphRealm & IFakeRealmCm;
	/** The engine (task rows, tool behaviour, every tool call). */
	world: IFakeWorld;
	/** Every engine request, in order. */
	requests: IBusRequest[];
	/** The user's files (client.fs*). */
	files: Map<string, unknown>;
	/** Make this engine read and write the other one's files (two windows of one user). */
	shareFiles(other: { files: Map<string, unknown> }): void;
	/** Runs before every engine request, with its params (hold, delay or fail one). */
	before: { current: ((op: string, params: unknown) => Promise<void> | void) | null };
}

/**
 * The default tool behaviour: a read-only Neo4j node.
 *
 * @param call - The tool call.
 * @returns Its answer.
 */
export function readOnlyNode(call: IToolCall): unknown {
	if (call.tool === 'dialect') return NEO4J_DIALECT;
	if (call.tool === 'get_schema' || call.tool === 'refresh_schema') return NEO4J_SCHEMA;
	if (call.tool === 'read_query' || call.tool === 'execute') return NEO4J_GRAPH;
	if (call.tool === 'get_query') return { query: 'MATCH (n:Person) RETURN n LIMIT 5', valid: true };
	return {};
}

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
	const store = { files: new Map<string, unknown>() };
	const before: IEngineRealm['before'] = { current: null };
	const record = async (op: string, params: unknown, timeoutMs?: number): Promise<void> => {
		requests.push({ op: `client.${op}`, params, timeoutMs });
		await before.current?.(`client.${op}`, params);
	};
	const never = (name: string) => async (): Promise<never> => {
		throw new Error(`the Graph tests never call client.${name}`);
	};
	const engineMethods: Omit<IRealmClient, 'getAccountInfo'> = {
		getTasks: async () => {
			await record('getTasks', {});
			return world.client.getTasks();
		},
		listTasks: async (req) => {
			await record('listTasks', req ?? {});
			// An engine's task list: what the world's client lists, or an empty page.
			return world.client.listTasks ? world.client.listTasks((req ?? {}) as never) : { rows: [], total: 0, page: 1, pageSize: 100 };
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
			return { exists: store.files.has(path) };
		},
		fsReadJson: async (path) => {
			await record('fsReadJson', { path });
			// The engine's file store fails a read of a missing file as 'File not found: …'. The history
			// store confirms a "missing" stat by such a read before it calls the file a first run.
			if (!store.files.has(path)) throw new Error(`File not found: ${path}`);
			return store.files.get(path) as never;
		},
		fsMkdir: async (path) => {
			await record('fsMkdir', { path });
		},
		fsWriteJson: async (path, value) => {
			await record('fsWriteJson', { path, value });
			store.files.set(path, value);
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
	const engine: IEngineRealm = {
		cm,
		world,
		requests,
		get files() {
			return store.files;
		},
		shareFiles(other) {
			store.files = other.files;
		},
		before,
	};
	return engine;
}

/** A VS Code realm (a mirrored realm: the sidebar mounts lazily) with an engine. */
export function vscodeRealm(rows: IFakeRow[] = [graphRow()], behave: IFakeWorld['behave'] = readOnlyNode) {
	const realm = createFakeMirroredRealm();
	const world = fakeWorld(rows, behave);
	return { realm, ...withEngine(realm.cm, world) };
}

/** A rocket-ui realm (the realm owns the client; a sidebar mounts when its tab is first selected) with an engine. */
export function rocketRealm(rows: IFakeRow[] = [graphRow()], behave: IFakeWorld['behave'] = readOnlyNode) {
	const realm = createFakeClientRealm();
	const world = fakeWorld(rows, behave);
	return { realm, ...withEngine(realm.cm, world) };
}

/** What a realm's client is as the engine source sees it. */
type EngineSourceCm = IGraphRealm & { getClient(): unknown; isConnected(): boolean; on(event: string, handler: (payload: never) => void): () => void };

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

/** A documents API that records what was opened and closed. */
export function recordingDocuments() {
	const opened: Array<{ key: string; title: string }> = [];
	const closed: string[] = [];
	return { opened, closed, documents: { open: (key: string, title: string) => { opened.push({ key, title }); }, close: (key: string) => { closed.push(key); } } };
}

/** A mounted controller over the host's channel (spied peer behind it), as both hosts mount it. */
export interface IMountedController {
	h: IDevToolHarness;
	spy: IPeerSpy;
	/** The host's channel (it outlives the controller, as the hosts' per-peer channel does). */
	hostChannel: ReturnType<typeof shellProtocol.createToolChannel>;
	controller: IGraphController;
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
export function mountController(cm: IGraphRealm & EngineSourceCm, over: Partial<IGraphControllerOptions> = {}, h: IDevToolHarness = createDevToolHarness(GRAPH_APP_ID), reuse?: IMountedController): IMountedController {
	const spy = reuse?.spy ?? spyPeer(h.sidebarPeer);
	const channel = reuse?.hostChannel ?? shellProtocol.createToolChannel(spy.peer);
	const docs = recordingDocuments();
	const errors: Array<{ where: string; error: unknown }> = [];
	const source = engineSource(cm);
	const controller = createGraphController({
		cm,
		channel,
		getClient: source.getClient,
		readiness: source.readiness,
		documents: docs.documents,
		createToolOpServer: shellProtocol.createToolOpServer,
		focusTarget: null,
		present: true,
		...(over.stores?.endpoints ? {} : { endpointOptions: { debounceMs: 0 } }),
		stores: { history: makeGraphHistory(0), ...over.stores },
		onError: (error, where) => errors.push({ where, error }),
		...over,
	});
	// The realm's listeners the source added go with the controller (the leak checks count them).
	const dispose = controller.dispose.bind(controller);
	Object.assign(controller, { dispose: () => { source.stop(); dispose(); } });
	return { h, spy, hostChannel: channel, controller, docs, errors };
}

/** Timers a test runs by hand (the frame's summon): `advance(ms)` fires what falls due, in order. */
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
 * Mount a frame as a host does. Its summon runs on timers the test advances by hand (`timers`), so a frame sends no
 * summon unless the test moves time on.
 *
 * @param h - The harness.
 * @param docKey - The frame's docKey.
 * @param over - Frame options to override.
 * @returns The frame, its documents recorder and its summon's timers.
 */
export function mountFrame(h: IDevToolHarness, docKey: string | undefined, over: Partial<IGraphFrameOptions> = {}): { frame: IGraphFrame; docs: ReturnType<typeof recordingDocuments>; errors: unknown[]; timers: IManualTimers } {
	const peer = h.newFramePeer();
	const docs = recordingDocuments();
	const errors: unknown[] = [];
	const timers = manualTimers();
	const frame = createGraphFrame({
		channel: shellProtocol.createToolChannel(peer),
		documents: docs.documents,
		docKey,
		createToolOpClient: shellProtocol.createToolOpClient,
		focusTarget: null,
		schedule: timers.schedule,
		onError: (error) => errors.push(error),
		...over,
	});
	return { frame, docs, errors, timers };
}

/**
 * Wait until a condition holds (bus hops are macrotasks).
 *
 * @param predicate - The condition.
 * @param what - Named in the failure.
 * @param rounds - How many settle rounds to allow.
 */
export async function until(predicate: () => boolean, what: string, rounds = 60): Promise<void> {
	for (let i = 0; i < rounds; i += 1) {
		if (predicate()) return;
		await settle();
	}
	throw new Error(`timed out waiting for ${what}`);
}

/** Sign a VS Code realm in (root connected with this account). */
export function signInVsCode(realm: IFakeMirroredRealm, userId = 'u1'): void {
	realm.root.connect(account(userId));
}

export { account, settle, shellProtocol };
