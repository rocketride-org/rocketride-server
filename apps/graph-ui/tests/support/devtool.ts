// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

// =============================================================================
// DEV-TOOL TEST SUPPORT: the controller and frames over the REAL shell modules
// =============================================================================
//
// The bus, the peers, the op lane and the channel are the shell's real modules
// (shared/explorer/devtool/testing.ts, JSON wire ON by default, as VS Code's
// postMessage carries every payload). The realm's ConnectionManager is the
// base's fake VS Code or rocket-ui realm, with its `request` routed to a fake
// engine (the shared library's fakeWorld) and every bus request recorded.
// =============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { makeGraphEndpointStore, makeGraphHistory } from '../../src/adapters/explorer';
import { createGraphController } from '../../src/devtool/controller';
import type { IGraphController, IGraphControllerOptions, IGraphRealm } from '../../src/devtool/controller';
import { createGraphFrame } from '../../src/devtool/frame';
import type { IGraphFrame, IGraphFrameOptions } from '../../src/devtool/frame';
import { GRAPH_APP_ID } from '../../src/devtool/protocol';
import { fakeWorld, row } from 'shared/explorer/connect/testing';
import type { IFakeRow, IFakeWorld, IToolCall } from 'shared/explorer/connect/testing';
import { account, createDevToolHarness, createFakeClientRealm, createFakeSocketlessRealm, settle, shellProtocol, spyPeer } from 'shared/explorer/devtool/testing';
import type { IDevToolHarness, IPeerSpy } from 'shared/explorer/devtool/testing';

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

/** One bus request the code under test made. */
export interface IBusRequest {
	op: string;
	params: unknown;
	timeoutMs: number | undefined;
}

/** A fake engine behind a fake realm. */
export interface IEngineRealm {
	/** The realm's ConnectionManager, with `request` routed to the engine. */
	cm: IGraphRealm & { request(op: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown> };
	/** The engine (task rows, tool behaviour, every tool call). */
	world: IFakeWorld;
	/** Every bus request, in order. */
	requests: IBusRequest[];
	/** The user's files (client.fs*). */
	files: Map<string, unknown>;
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
 * Route a fake realm's bus requests to a fake engine.
 *
 * @param base - The fake realm's manager.
 * @param world - The engine.
 * @returns The engine realm.
 */
function withEngine(base: object, world: IFakeWorld): IEngineRealm {
	const requests: IBusRequest[] = [];
	const files = new Map<string, unknown>();
	const request = async (op: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown> => {
		requests.push({ op, params, timeoutMs: opts?.timeoutMs });
		const p = (params ?? {}) as Record<string, unknown>;
		switch (op) {
			case 'client.getTasks':
				return world.client.getTasks();
			case 'client.listTasks':
				// An engine's task list: what the world's client lists, or an empty page.
				return world.client.listTasks ? world.client.listTasks(p) : { rows: [], total: 0, page: 1, pageSize: 100 };
			case 'client.getTaskPipeline':
				return world.client.getTaskPipeline(p.token as string);
			case 'client.tool':
				return world.client.tool(p as never);
			case 'client.addMonitor':
			case 'client.removeMonitor':
			case 'client.fsMkdir':
				return undefined;
			case 'client.fsStat':
				return { exists: files.has(p.path as string) };
			case 'client.fsReadJson':
				return files.get(p.path as string);
			case 'client.fsWriteJson':
				files.set(p.path as string, p.value);
				return undefined;
			default:
				throw new Error(`No handler serves '${op}'`);
		}
	};
	return { cm: Object.assign(Object.create(null), base, { request }) as IEngineRealm['cm'], world, requests, files };
}

/** A VS Code realm (socketless: the sidebar mounts lazily) with an engine. */
export function vscodeRealm(rows: IFakeRow[] = [graphRow()], behave: IFakeWorld['behave'] = readOnlyNode) {
	const realm = createFakeSocketlessRealm();
	const world = fakeWorld(rows, behave);
	return { realm, ...withEngine(realm.cm, world) };
}

/** A rocket-ui realm (the realm owns the client; every pinned sidebar mounts at boot) with an engine. */
export function rocketRealm(rows: IFakeRow[] = [graphRow()], behave: IFakeWorld['behave'] = readOnlyNode) {
	const realm = createFakeClientRealm();
	const world = fakeWorld(rows, behave);
	return { realm, ...withEngine(realm.cm, world) };
}

/** A documents API that records what was opened and closed. */
export function recordingDocuments() {
	const opened: Array<{ key: string; title: string }> = [];
	const closed: string[] = [];
	return { opened, closed, documents: { open: (key: string, title: string) => { opened.push({ key, title }); }, close: (key: string) => { closed.push(key); } } };
}

/** A mounted controller over the real sidebar peer (spied) and a host channel, as both hosts mount it. */
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
 * peer and channel (both hosts build one channel per peer and keep it while the controller comes and goes).
 *
 * @param cm - The realm.
 * @param over - Controller options to override.
 * @param h - A harness to reuse (default: a fresh one, JSON wire on).
 * @param reuse - A previous mount whose peer spy and host channel to keep.
 * @returns The mount.
 */
export function mountController(cm: IGraphRealm, over: Partial<IGraphControllerOptions> = {}, h: IDevToolHarness = createDevToolHarness(GRAPH_APP_ID), reuse?: IMountedController): IMountedController {
	const spy = reuse?.spy ?? spyPeer(h.sidebarPeer);
	const channel = reuse?.hostChannel ?? shellProtocol.createToolChannel(spy.peer);
	const docs = recordingDocuments();
	const errors: Array<{ where: string; error: unknown }> = [];
	const controller = createGraphController({
		cm,
		peer: spy.peer,
		channel,
		documents: docs.documents,
		createToolChannel: shellProtocol.createToolChannel,
		createToolOpServer: shellProtocol.createToolOpServer,
		focusTarget: null,
		stores: { endpoints: makeGraphEndpointStore({ debounceMs: 0 }), history: makeGraphHistory(0) },
		onError: (error, where) => errors.push({ where, error }),
		...over,
	});
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
		peer,
		channel: shellProtocol.createToolChannel(peer),
		documents: docs.documents,
		docKey,
		createToolController: shellProtocol.createToolController,
		createToolChannel: shellProtocol.createToolChannel,
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
export function signInVsCode(realm: ReturnType<typeof createFakeSocketlessRealm>, userId = 'u1'): void {
	realm.root.connect(account(userId));
}

export { account, settle, shellProtocol };
