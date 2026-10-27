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
// VECTOR-UI - DEV-TOOL CONTROLLER (the sidebar mount: the tool's one engine connection)
// =============================================================================
//
// A plain function over injected parts (the realm's ConnectionManager as a
// structural type, the peer, the host's channel and the shell's protocol
// factories), so it runs under node:test against the real shell modules. The
// React mount (VectorDevToolSidebar.tsx) calls it in an effect and disposes it
// in the cleanup (R6).
//
// What it owns (R1): its OWN endpoint store (token vault, discovery, probes,
// task watch) over the bus-backed client; the identity tracker, the
// activation gate and the discovery watch; the version, query, summary and
// request maps the frames share; and every op handler.
//
//   QUIET (R7)  At mount it publishes retained state only: no event, no call,
//               no document, no engine request. Discovery waits for identity
//               AND activation (devtool/watch.ts).
//   CALLS       Each tool op names its connection by KEY; the controller
//               resolves the endpoint and the node (the embedding node for
//               `embed`, the store node otherwise), asks its session for the
//               protocol's wait (protocol.ts waitFor) and answers the raw
//               value. A failure ENVELOPE is a value (the frame unwraps it
//               with its code); only what the session throws is a Reply error.
//               A call that arrives before discovery listed and probed its
//               connection (held across a remount) waits for it, inside its
//               own deadline.
//   GATES (T10) The three writes re-check the write gate HERE (the console
//               model's `writes` on this store's own record and probe, and a
//               ready endpoint), whatever the frame believed, send one batch
//               once (never retried), and bump `docVersions` for every write
//               that ran or may have run (a timeout).
//   IDENTITY    A different identity (or none) resets the endpoint store (the
//               watch) and clears every map the frames of the previous one
//               left; frames close themselves on the published fingerprint (R9).
//   SIZES (T11) Results are op results, each under its cap (RESULT_TOO_LARGE
//               above it); retained snapshots are cut by the protocol and kept
//               by the base guard under 64 KiB each and 128 KiB together.
// =============================================================================

import type { DevToolProps, IToolOpServer, ToolChannel } from 'shell';
import { ExplorerToolError, createActiveKeyStore } from 'shared/explorer';
import type { IEndpointStore, IExplorerClient, IExplorerEndpoint, IProbeResult } from 'shared/explorer';
import { createActivationGate } from 'shared/explorer/devtool/activation';
import type { IActivationBus, IActivationGate } from 'shared/explorer/devtool/activation';
import { getBusExplorerClient } from 'shared/explorer/devtool/busClient';
import type { IExplorerBus } from 'shared/explorer/devtool/busClient';
import { attachController } from 'shared/explorer/devtool/controller';
import type { RequiredControllerHandlers } from 'shared/explorer/devtool/controller';
import { readDeadline } from 'shared/explorer/devtool/deadline';
import { publishIdentityState } from 'shared/explorer/devtool/frameIdentity';
import { createIdentityTracker } from 'shared/explorer/devtool/identity';
import type { IIdentityBus, IIdentityTracker } from 'shared/explorer/devtool/identity';
import { mountNonce } from 'shared/explorer/devtool/realm';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { replyOk } from 'shared/explorer/devtool/reply';
import { guardRetainedState, jsonByteLength } from 'shared/explorer/devtool/state';
import type { IOversizeInfo } from 'shared/explorer/devtool/state';
import { createDevToolDiscovery } from 'shared/explorer/devtool/watch';
import type { IDevToolDiscovery, IDiscoveryBus, IFocusTarget } from 'shared/explorer/devtool/watch';
import { makeVectorEndpointStore } from '../adapters/explorer';
import { createConnectionRegistry } from '../adapters/connections';
import type { HighlightSource, IVectorLimits, VectorKey } from '../contract/types';
import type { IReadable, IVectorEnv } from '../env';
import { createLocalVectorEnv } from '../localEnv';
import { consoleUri, documentTitle, documentUri, endpointKeyFromUri } from '../vector/addresses';
import { buildConsoleModel, consoleNodes, toolsSourceIsTools } from '../vector/consoleModel';
import { DEFAULT_LIMITS, readDeleteResult, readDialect, readTrashResult } from '../vector/results';
import { CODE_SENTENCES } from '../vector/wording';
import { vectorCardView } from '../vector/connections';
import {
	EVENT,
	FOCUS_MAX_AGE_MS,
	FOCUS_STATE_BYTES,
	HIGHLIGHT_SOURCES,
	MAP_STATE_BYTES,
	OP,
	OP_TOOL,
	QUERIES_STATE_BYTES,
	QUERY_TEXT_MAX,
	RESULT_CAPS,
	RESULT_TOO_LARGE,
	STATE,
	SUMMARY_STATE_BYTES,
	VECTOR_APP_ID,
	VERSIONS_STATE_BYTES,
	endpointsSnapshot,
	field,
	keyedSnapshot,
	routeDocKey,
	versionsSnapshot,
	waitFor,
} from './protocol';
import type { DocWriteAction, IConsoleSummary, IDocVersion, IFocusRequest, IMapRequest, IQueryHint, ReadOp, ToolOp, VectorOps, WriteOp } from './protocol';

/** What the controller needs from its realm's ConnectionManager (structural; tests pass the base's fake realms). */
export type IVectorRealm = IIdentityBus & IActivationBus & IDiscoveryBus & IExplorerBus;

/** Said when a frame asks for a write the controller cannot vouch for (nothing was sent). */
export const WRITE_REFUSED_TEXT = 'Documents cannot be removed or restored through this connection right now. Nothing was sent.';

/** Said when a call names a connection discovery does not list. */
export const NOT_LISTED_TEXT = 'This connection is not listed any more. Refresh the connections.';

/** Said when a call names a connection while nothing has been discovered yet (not signed in, or discovery still running). */
export const NOT_DISCOVERED_TEXT = 'The connections have not been discovered yet, so nothing was sent. Try again in a moment.';

/** Said when a call that waited for discovery has too little of its time left to run (it was not sent). */
export const TOO_LATE_TEXT = 'The request waited for the connections to be discovered and has too little of its time left to run. Nothing was sent; try again.';

/** The least time a call is started with (a shorter one could only time out). */
const MIN_CALL_MS = 1_000;

/** What a write's answer is cut to when it is over its cap: the fields a frame reads (vector/results.ts). */
const WRITE_ANSWER_FIELDS = ['success', 'code', 'error', 'retry_after_s', 'object_ids', 'not_found', 'kept_live', 'matched_chunks', 'removed_chunks', 'deleted_count'] as const;

/** How many connections' query hints and summaries are kept (the most recently changed). */
const MAX_HINT_KEYS = 32;

/** A call that waits for discovery stops this long before its own deadline (so its answer still arrives in time). */
const LISTING_WAIT_MARGIN_MS = 1_000;

/** What {@link createVectorController} needs. */
export interface IVectorControllerOptions {
	/** The realm's ConnectionManager. */
	cm: IVectorRealm;
	/** The sidebar mount's peer. */
	peer: DevToolPeer;
	/** The host's channel (both hosts pass one). */
	channel?: ToolChannel;
	/** The host's documents API (opened only on a user action). */
	documents?: DevToolProps['documents'];
	/** The sidebar's activeDocKey prop at mount. */
	activeDocKey?: string | null;
	/** The shell's createToolChannel (injected). */
	createToolChannel: (peer: DevToolPeer) => ToolChannel;
	/** The shell's createToolOpServer (injected). */
	createToolOpServer: (peer: DevToolPeer) => IToolOpServer<VectorOps>;
	/** The tool's app id (default rocketride.vector). */
	appId?: string;
	/** The clock (deadlines). */
	now?: () => number;
	/** Timers (request expiry); returns a cancel. Default setTimeout. */
	schedule?: (fn: () => void, ms: number) => () => void;
	/** Where focus comes from (null in tests). */
	focusTarget?: IFocusTarget | null;
	/** Replace the endpoint store (tests). */
	store?: IEndpointStore;
	/** Replace result caps (tests). */
	resultCaps?: Partial<Record<ToolOp, number>>;
	/** Replace session waits (tests). */
	waits?: Partial<Record<ToolOp, number>>;
	/** Told about refused calls and oversize state. */
	onError?: (error: unknown, where: string) => void;
}

/** A mounted controller. */
export interface IVectorController {
	readonly channel: ToolChannel;
	readonly store: IEndpointStore;
	readonly client: IExplorerClient;
	readonly identity: IIdentityTracker;
	readonly activation: IActivationGate;
	readonly discovery: IDevToolDiscovery;
	/** The connection the fronted document belongs to. */
	readonly activeConnection: IReadable<string | null>;
	/** Feed every new activeDocKey prop value. */
	noteActiveDocKey(key: string | null | undefined): void;
	/** The LOCAL env the sidebar's view uses (rebuild it when the realm's connection flag changes). */
	env(ready: boolean): IVectorEnv;
	/** Dispose everything (idempotent). */
	dispose(): void;
}

/**
 * Whether a value is a chunk key: `[objectId, chunkId]`.
 *
 * @param value - Anything.
 * @returns True for a non-empty string and a whole number of zero or more.
 */
function isVectorKey(value: unknown): value is VectorKey {
	return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && value[0] !== '' && Number.isInteger(value[1]) && (value[1] as number) >= 0;
}

/**
 * Mount the Vector Explorer controller.
 *
 * @param opts - See {@link IVectorControllerOptions}.
 * @returns The controller; dispose it in the mount's cleanup.
 */
export function createVectorController(opts: IVectorControllerOptions): IVectorController {
	const { cm, peer } = opts;
	const appId = opts.appId ?? VECTOR_APP_ID;
	const now = opts.now ?? Date.now;
	const schedule =
		opts.schedule ??
		((fn: () => void, ms: number): (() => void) => {
			const handle = setTimeout(fn, ms);
			return () => clearTimeout(handle);
		});
	const report = (error: unknown, where: string): void => opts.onError?.(error, where);
	const client = getBusExplorerClient(cm);
	const store = opts.store ?? makeVectorEndpointStore();
	const identity = createIdentityTracker({ cm });
	const activation = createActivationGate({ appId, cm, ...(opts.activeDocKey !== undefined ? { activeDocKey: opts.activeDocKey } : {}) });
	const discovery = createDevToolDiscovery({ cm, client, identity, activation, ...(opts.focusTarget !== undefined ? { focusTarget: opts.focusTarget } : {}) });
	const offs: Array<() => void> = [];
	const cancels = new Set<() => void>();
	let disposed = false;

	// ── The fronted document: the host's activeDocKey, else the frames' `active` event (R8) ─────
	let hostActive: string | null | undefined = opts.activeDocKey;
	let eventActive: string | null = null;
	const active = createActiveKeyStore();
	const syncActive = (): void => {
		const docKey = typeof hostActive === 'string' ? hostActive : hostActive === null ? null : eventActive;
		active.set(docKey ? endpointKeyFromUri(docKey) : null);
	};
	syncActive();

	// ── What the frames share: kept in insertion order, oldest first (the snapshots keep the newest) ─────
	const versions = new Map<string, IDocVersion>();
	const queries = new Map<string, IQueryHint>();
	const summaries = new Map<string, IConsoleSummary>();
	const focus = new Map<string, IFocusRequest>();
	const maps = new Map<string, IMapRequest>();
	/** Put an entry at the newest end. */
	const touch = <T>(map: Map<string, T>, key: string, value: T, max = Number.POSITIVE_INFINITY): void => {
		map.delete(key);
		map.set(key, value);
		while (map.size > max) map.delete(map.keys().next().value as string);
	};

	// ── Helpers: params, endpoints, limits, sizes ───────────────────────────────────────────────
	const invalid = (tool: string, message: string): ExplorerToolError => new ExplorerToolError({ kind: 'invalid', tool, message });
	const keyOf = (params: unknown, op: string): string => {
		const key = field(params, 'key');
		if (typeof key !== 'string' || key === '') throw invalid(op, `${op} needs a connection key.`);
		return key;
	};
	const inputOf = (params: unknown, op: string): Record<string, unknown> => {
		const input = field(params, 'input');
		if (input === null || typeof input !== 'object' || Array.isArray(input)) throw invalid(op, `${op} needs the tool's input as an object.`);
		return input as Record<string, unknown>;
	};
	const probeOf = (key: string): IProbeResult | undefined => store.getState().probes[key];
	const infoOf = (key: string): Record<string, unknown> | null => {
		const probe = probeOf(key);
		return probe?.ok && probe.info !== null && typeof probe.info === 'object' ? probe.info : null;
	};
	const limitsOf = (key: string): IVectorLimits => readDialect(infoOf(key))?.limits ?? DEFAULT_LIMITS;
	const waitOf = (op: ToolOp, key: string): number => opts.waits?.[op] ?? waitFor(op, infoOf(key));
	const sized = <T>(result: T, op: ToolOp, tool: string): T => {
		const cap = opts.resultCaps?.[op] ?? RESULT_CAPS[op];
		const bytes = jsonByteLength(result);
		if (bytes > cap) {
			const kb = (n: number): string => `${Math.ceil(n / 1024).toLocaleString('en-US')} KB`;
			throw new ExplorerToolError({ kind: 'invalid', code: RESULT_TOO_LARGE, tool, message: `The answer of ${tool} is ${kb(bytes)}, too large to send to this window (the limit is ${kb(cap)}). Ask for fewer points, rows or keys.` });
		}
		return result;
	};

	// A call for a connection this controller has not listed and probed yet (one held across a remount reaches a fresh
	// store) waits for the discovery under way, inside its own deadline; one discovery does not list is refused.
	const listed = (key: string): IExplorerEndpoint | undefined => store.getState().endpoints.find((candidate) => candidate.key === key);
	const settled = (key: string): IExplorerEndpoint | null => {
		const endpoint = listed(key);
		return endpoint && endpoint.state !== 'probing' ? endpoint : null;
	};
	const pending = (key: string): boolean => {
		const status = store.getState().status;
		return status === 'idle' || status === 'loading' || listed(key)?.state === 'probing';
	};
	const endpointFor = (key: string, tool: string, params: unknown): Promise<IExplorerEndpoint> => {
		const ready = settled(key);
		if (ready) return Promise.resolve(ready);
		if (!pending(key)) return Promise.reject(new ExplorerToolError({ kind: 'unavailable', tool, message: NOT_LISTED_TEXT }));
		const deadline = readDeadline(params) ?? now();
		return new Promise<IExplorerEndpoint>((resolve, reject) => {
			let done = false;
			const finish = (outcome: IExplorerEndpoint | null): void => {
				if (done) return;
				done = true;
				off();
				cancel();
				cancels.delete(stop);
				if (outcome) resolve(outcome);
				else reject(new ExplorerToolError({ kind: 'unavailable', tool, message: pending(key) ? NOT_DISCOVERED_TEXT : NOT_LISTED_TEXT }));
			};
			const off = store.subscribe(() => {
				const endpoint = settled(key);
				if (endpoint) finish(endpoint);
				else if (!pending(key)) finish(null);
			});
			const cancel = schedule(() => finish(settled(key)), Math.max(0, deadline - now() - LISTING_WAIT_MARGIN_MS));
			const stop = (): void => finish(null);
			cancels.add(stop);
		});
	};
	// What is left of a call's deadline once it may run (after a wait for discovery), less the margin its answer needs
	// to reach the frame before the frame gives up.
	const timeLeft = (params: unknown): number => (readDeadline(params) ?? now()) - now() - LISTING_WAIT_MARGIN_MS;
	const nodeFor = (op: ToolOp, endpoint: IExplorerEndpoint, tool: string): string => {
		if (op !== OP.embed) return endpoint.nodeId;
		const embed = consoleNodes(endpoint).embed;
		if (embed === null) throw invalid(tool, 'This connection has no embedding node its source reaches, so a text cannot be embedded.');
		return embed;
	};

	// ── Argument caps (T11): refused before anything is sent ────────────────────────────────────
	const checkRead = (op: ReadOp, input: Record<string, unknown>, limits: IVectorLimits, tool: string): void => {
		const count = (name: string): number | null => (Array.isArray(input[name]) ? (input[name] as unknown[]).length : null);
		switch (op) {
			case OP.embed: {
				const texts = input.texts;
				if (!Array.isArray(texts) || texts.length === 0 || texts.length > 8 || !texts.every((t) => typeof t === 'string')) throw invalid(tool, 'embed takes 1 to 8 texts.');
				return;
			}
			case OP.neighbors: {
				const scope = count('scope_keys');
				if (scope !== null && scope > limits.scope_keys_max) throw invalid(tool, `A neighbour search takes at most ${limits.scope_keys_max.toLocaleString('en-US')} scope keys.`);
				return;
			}
			case OP.similarityMatrix: {
				const keys = count('keys');
				const max = limits.matrix_keys_max ?? DEFAULT_LIMITS.matrix_keys_max ?? 100;
				if (keys === null || keys > max) throw invalid(tool, `A similarity matrix takes at most ${max.toLocaleString('en-US')} keys.`);
				return;
			}
			case OP.list: {
				const limit = input.limit;
				if (typeof limit === 'number' && limit > limits.documents_page) throw invalid(tool, `A document page holds at most ${limits.documents_page.toLocaleString('en-US')} documents.`);
				return;
			}
			case OP.chunks: {
				const limit = input.limit;
				if (typeof limit === 'number' && limit > limits.chunks_page) throw invalid(tool, `A chunk page holds at most ${limits.chunks_page.toLocaleString('en-US')} chunks.`);
				return;
			}
			default:
				return;
		}
	};
	const idsOf = (input: Record<string, unknown>, limits: IVectorLimits, tool: string): string[] => {
		const ids = input.object_ids;
		if (!Array.isArray(ids) || ids.length === 0 || ids.length > limits.write_ids_max || !ids.every((id) => typeof id === 'string' && id !== '')) {
			throw invalid(tool, `A write takes 1 to ${limits.write_ids_max.toLocaleString('en-US')} document ids.`);
		}
		return [...(ids as string[])];
	};

	// ── The write gate (T10): the console model's `writes`, on this controller's own record and probe ──────
	const writeRefusal = (endpoint: IExplorerEndpoint, tool: string): ExplorerToolError | null => {
		const probe = probeOf(endpoint.key);
		if (endpoint.state !== 'ready') return new ExplorerToolError({ kind: 'unavailable', tool, message: vectorCardView(endpoint, probe).blocked ?? WRITE_REFUSED_TEXT });
		const writes = buildConsoleModel(endpoint, probe, null).writes;
		if (writes.enabled) return null;
		const anchored = endpoint.readOnly !== true && Boolean(endpoint.roles.tools);
		const dialect = probe?.ok ? readDialect(probe.info) : null;
		if (anchored && !toolsSourceIsTools(endpoint)) return new ExplorerToolError({ kind: 'store', code: 'WRITES_SOURCE', tool, message: CODE_SENTENCES.WRITES_SOURCE });
		if (anchored && dialect !== null && !dialect.allow_writes) return new ExplorerToolError({ kind: 'store', code: 'WRITES_DISABLED', tool, message: CODE_SENTENCES.WRITES_DISABLED });
		return new ExplorerToolError({ kind: 'unavailable', tool, message: writes.reason ?? WRITE_REFUSED_TEXT });
	};

	// ── docVersions: every write that ran (or may have) moves its connection's version ──────────
	// This mount's own epoch: a remounted controller counts again from 1, so a frame tells its versions from the
	// previous mount's by the epoch, never by the number alone.
	const epoch = mountNonce();
	const bump = (key: string, action: DocWriteAction, gone: string[], origin: string): void => {
		const version = (versions.get(key)?.version ?? 0) + 1;
		touch(versions, key, { version, epoch, action, gone, origin });
		publishVersions();
	};
	const goneOf = (op: WriteOp, raw: unknown, ids: readonly string[]): string[] => {
		if (raw === null || typeof raw !== 'object' || (raw as { success?: unknown }).success === false) return [];
		if (op === OP.trash) return readTrashResult(raw as Record<string, unknown>).moved;
		if (op === OP.deletePermanently) return readDeleteResult(raw as Record<string, unknown>, ids).removed.map((r) => r.objectId);
		return [];
	};

	// A write's answer within its cap: as it came, else cut to the fields a frame reads; null when even that is over.
	const writeAnswer = (op: WriteOp, raw: unknown): unknown => {
		const cap = opts.resultCaps?.[op] ?? RESULT_CAPS[op];
		if (jsonByteLength(raw) <= cap) return raw;
		if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
		const cut: Record<string, unknown> = {};
		for (const name of WRITE_ANSWER_FIELDS) if (name in (raw as Record<string, unknown>)) cut[name] = (raw as Record<string, unknown>)[name];
		return jsonByteLength(cut) <= cap ? cut : null;
	};

	// ── Op handlers: each answers a Reply (attachController wraps escaping failures) ────────────
	const read = (op: ReadOp) => async (params: unknown) => {
		const key = keyOf(params, op);
		const tool = OP_TOOL[op];
		const input = inputOf(params, op);
		const endpoint = await endpointFor(key, tool, params);
		checkRead(op, input, limitsOf(key), tool);
		// Never past the frame's deadline: a call that waited for discovery gets what is left of it.
		const left = timeLeft(params);
		if (left < MIN_CALL_MS) throw new ExplorerToolError({ kind: 'unavailable', tool, message: TOO_LATE_TEXT });
		const wait = Math.min(waitOf(op, key), left);
		const raw = await store.session(client, endpoint).invoke<unknown>(tool, input, { nodeId: nodeFor(op, endpoint, tool), timeoutMs: wait });
		return replyOk(sized(raw, op, tool));
	};
	const write = (op: WriteOp) => async (params: unknown) => {
		const key = keyOf(params, op);
		const tool = OP_TOOL[op];
		const input = inputOf(params, op);
		const endpoint = await endpointFor(key, tool, params);
		const ids = idsOf(input, limitsOf(key), tool);
		const refusal = writeRefusal(endpoint, tool);
		if (refusal) throw refusal;
		const deletedOnly = op === OP.deletePermanently && input.deleted_only === true;
		const action: DocWriteAction = op === OP.trash ? 'trash' : op === OP.restore ? 'restore' : deletedOnly ? 'empty' : 'delete';
		const origin = typeof field(params, 'origin') === 'string' ? (field(params, 'origin') as string) : '';
		// Never past the frame's deadline: a write that waited for discovery gets what is left of it (its answer, or the
		// session's "stopped waiting", reaches the frame before the frame gives up), and one with too little left is
		// not started at all.
		const left = timeLeft(params);
		if (left < MIN_CALL_MS) throw new ExplorerToolError({ kind: 'unavailable', tool, message: TOO_LATE_TEXT });
		const wait = Math.min(waitOf(op, key), left);
		// Only what the write takes is sent: never a field a frame added.
		const clean: Record<string, unknown> = { object_ids: ids, ...(deletedOnly ? { deleted_only: true } : {}) };
		let raw: unknown;
		try {
			raw = await store.session(client, endpoint).invoke<unknown>(tool, clean, { nodeId: endpoint.nodeId, timeoutMs: wait, idempotent: false });
		} catch (error) {
			// A write the session stopped waiting for may still run: every frame of the connection refetches, the one that
			// asked included (it heard a failure and ran no batch, so it relists only for a bump that names no frame).
			if (error instanceof ExplorerToolError && error.kind === 'timeout') bump(key, action, [], '');
			throw error;
		}
		// The write ran: its answer always reaches the frame. Over the cap it is cut to the fields a frame reads; only one
		// still over the cap is refused, and then the bump names no frame, so the one that asked relists too.
		const gone = goneOf(op, raw, ids);
		const answer = writeAnswer(op, raw);
		bump(key, action, gone, answer === null ? '' : origin);
		if (answer === null) return replyOk(sized(raw, op, tool));
		return replyOk(answer);
	};
	const expire = (map: Map<string, { nonce: string }>, key: string, nonce: string, publishMap: () => void): void => {
		const cancel = schedule(() => {
			cancels.delete(cancel);
			if (map.get(key)?.nonce !== nonce) return;
			map.delete(key);
			publishMap();
		}, FOCUS_MAX_AGE_MS);
		cancels.add(cancel);
	};

	// Every op has a handler (RequiredControllerHandlers): a frame never meets "No handler serves".
	const handlers: RequiredControllerHandlers<VectorOps> = {
		[OP.refresh]: (params) => {
			if (!discovery.allowed()) throw new ExplorerToolError({ kind: 'unavailable', tool: OP.refresh, message: 'Not signed in to a server yet, so nothing was discovered.' });
			void store.refresh(client, { reprobe: field(params, 'reprobe') === true });
			return replyOk(null);
		},
		[OP.probe]: async (params) => replyOk(await store.probe(client, keyOf(params, OP.probe))),
		[OP.stats]: read(OP.stats),
		[OP.list]: read(OP.list),
		[OP.chunks]: read(OP.chunks),
		[OP.sample]: read(OP.sample),
		[OP.project]: read(OP.project),
		[OP.neighbors]: read(OP.neighbors),
		[OP.search]: read(OP.search),
		[OP.embed]: read(OP.embed),
		[OP.recommend]: read(OP.recommend),
		[OP.similarityMatrix]: read(OP.similarityMatrix),
		[OP.trash]: write(OP.trash),
		[OP.restore]: write(OP.restore),
		[OP.deletePermanently]: write(OP.deletePermanently),
		// A call the peer held while no controller was mounted is handed over SYNCHRONOUSLY inside attachController
		// (below), before `attached`, the retained-state channel, `publish` and `shownKeys` exist. These two relays reach all
		// of them, so they answer from the next microtask, when the controller is whole. Every other handler reaches only
		// what is declared above attachController before its first await (`refresh`: the store and discovery).
		[OP.requestFocus]: async (params) => {
			await Promise.resolve();
			const key = keyOf(params, OP.requestFocus);
			const docKey = field(params, 'docKey');
			const chunkId = field(params, 'chunkId');
			const route = routeDocKey(typeof docKey === 'string' ? docKey : null);
			if (route.kind !== 'document' || route.key !== key) throw invalid(OP.requestFocus, 'A focus names one of this connection\'s documents.');
			if (!Number.isInteger(chunkId) || (chunkId as number) < 0) throw invalid(OP.requestFocus, 'A focus names a chunk by its number.');
			const nonce = mountNonce();
			touch(focus, key, { nonce, docKey: docKey as string, chunkId: chunkId as number });
			publishFocus();
			attached.channel.sendEvent(EVENT.focusChunk, { docKey, chunkId, nonce });
			expire(focus, key, nonce, publishFocus);
			return replyOk(null);
		},
		[OP.showOnMap]: async (params) => {
			await Promise.resolve();
			const key = keyOf(params, OP.showOnMap);
			const keys = field(params, 'keys');
			const source = field(params, 'source');
			const max = limitsOf(key).project_keys_max;
			if (!Array.isArray(keys) || keys.length === 0 || keys.length > max || !keys.every(isVectorKey)) throw invalid(OP.showOnMap, `The map shows 1 to ${max.toLocaleString('en-US')} keys at a time.`);
			if (typeof source !== 'string' || !HIGHLIGHT_SOURCES.has(source)) throw invalid(OP.showOnMap, 'Unknown highlight source.');
			const nonce = mountNonce();
			const copy = (keys as VectorKey[]).map((k) => [k[0], k[1]] as VectorKey);
			touch(maps, key, { nonce, keys: copy, source: source as HighlightSource });
			publishMaps();
			attached.channel.sendEvent(EVENT.showOnMap, { docKey: consoleUri(key), keys: copy, source, nonce });
			expire(maps, key, nonce, publishMaps);
			return replyOk(null);
		},
	};

	// ── The channel first, then the ONE op server (attachController, R6) ────────────────────────
	const attached = attachController<VectorOps>({
		peer,
		...(opts.channel ? { channel: opts.channel } : {}),
		createToolChannel: opts.createToolChannel,
		createToolOpServer: opts.createToolOpServer,
		handlers,
		now,
		onFirstOp: () => activation.open('op'),
		onRefused: (error) => report(error, 'refused'),
	});

	// The guard DEGRADES an oversize snapshot through `shrink` (the protocol's own cuts at the budget the guard leaves,
	// so `omitted` stays true; never the generic `truncated` marker), and keeps the whole map under its total budget.
	const shrink = (topic: string, snapshot: unknown, info: IOversizeInfo): unknown => {
		if (topic === STATE.endpoints) return endpointsSnapshot(store.getState(), info.budgetBytes);
		if (topic === STATE.docVersions) return versionsSnapshot(versions, shownKeys, info.budgetBytes);
		if (topic === STATE.queries) return keyedSnapshot(queries, shownKeys, info.budgetBytes);
		if (topic === STATE.consoleSummary) return keyedSnapshot(summaries, shownKeys, info.budgetBytes);
		if (topic === STATE.focusRequests) return keyedSnapshot(focus, shownKeys, info.budgetBytes);
		if (topic === STATE.mapRequests) return keyedSnapshot(maps, shownKeys, info.budgetBytes);
		return snapshot;
	};
	let withheld = false;
	const channel = guardRetainedState(attached.channel, {
		shrink,
		onOversize: (error) => {
			if (error.outcome === 'withheld') withheld = true;
			report(error, 'state');
		},
	});

	// ── Retained state: published at mount (allowed, R7) and on every change ────────────────────
	const published = new Map<string, string>();
	const publish = (topic: string, snapshot: unknown): void => {
		if (disposed) return;
		const text = JSON.stringify(snapshot);
		if (published.get(topic) === text) return;
		withheld = false;
		channel.publishState(topic, snapshot);
		if (!withheld) published.set(topic, text);
	};
	let shownKeys: ReadonlySet<string> = new Set();
	const publishEndpoints = (): void => {
		const snapshot = endpointsSnapshot(store.getState());
		shownKeys = new Set(snapshot.endpoints.map((endpoint) => endpoint.key));
		publish(STATE.endpoints, snapshot);
	};
	function publishVersions(): void {
		publish(STATE.docVersions, versionsSnapshot(versions, shownKeys, VERSIONS_STATE_BYTES));
	}
	const publishQueries = (): void => publish(STATE.queries, keyedSnapshot(queries, shownKeys, QUERIES_STATE_BYTES));
	const publishSummaries = (): void => publish(STATE.consoleSummary, keyedSnapshot(summaries, shownKeys, SUMMARY_STATE_BYTES));
	function publishFocus(): void {
		publish(STATE.focusRequests, keyedSnapshot(focus, shownKeys, FOCUS_STATE_BYTES));
	}
	function publishMaps(): void {
		publish(STATE.mapRequests, keyedSnapshot(maps, shownKeys, MAP_STATE_BYTES));
	}
	const publishAll = (): void => {
		publishEndpoints();
		publishVersions();
		publishQueries();
		publishSummaries();
		publishFocus();
		publishMaps();
	};
	offs.push(store.subscribe(publishEndpoints));
	publishAll();
	offs.push(publishIdentityState(channel, identity));

	// ── Frame events: idempotent hints only (a replay or a second delivery changes nothing) ─────
	offs.push(attached.channel.onEvent(EVENT.active, (payload) => {
		const docKey = field(payload, 'docKey');
		const consumed = field(payload, 'consumed');
		if (Array.isArray(consumed)) {
			const taken = new Set(consumed.filter((nonce): nonce is string => typeof nonce === 'string'));
			for (const [map, publishMap] of [[focus, publishFocus], [maps, publishMaps]] as const) {
				let changed = false;
				for (const [key, request] of [...map]) {
					if (!taken.has(request.nonce)) continue;
					map.delete(key);
					changed = true;
				}
				if (changed) publishMap();
			}
		}
		if (typeof docKey === 'string') {
			eventActive = docKey;
			syncActive();
		}
	}));
	offs.push(attached.channel.onEvent(EVENT.queryChanged, (payload) => {
		const key = field(payload, 'key');
		const nonce = field(payload, 'nonce');
		const text = field(payload, 'text');
		if (typeof key !== 'string' || key === '' || typeof nonce !== 'string' || nonce === '' || !(typeof text === 'string' || text === null)) return;
		if (queries.get(key)?.nonce === nonce) return;
		touch(queries, key, { nonce, text: typeof text === 'string' ? text.slice(0, QUERY_TEXT_MAX) : null }, MAX_HINT_KEYS);
		publishQueries();
	}));
	offs.push(attached.channel.onEvent(EVENT.consoleSummary, (payload) => {
		const key = field(payload, 'key');
		const median = field(payload, 'medianChunks');
		if (typeof key !== 'string' || key === '' || !(median === null || (typeof median === 'number' && Number.isFinite(median) && median >= 0))) return;
		if (summaries.has(key) && summaries.get(key)?.medianChunks === median) return;
		touch(summaries, key, { medianChunks: median as number | null }, MAX_HINT_KEYS);
		publishSummaries();
	}));

	// ── Discovery: the store follows identity, activation, task events and focus ────────────────
	offs.push(store.attach(client, identity.get().identity, discovery.watch));

	// ── Identity: what the previous one's frames left goes ──────────────────────────────────────
	let fingerprint = identity.get().known ? identity.get().fingerprint : null;
	offs.push(identity.subscribe((snapshot) => {
		const next = snapshot.known ? snapshot.fingerprint : null;
		if (next === fingerprint) return;
		fingerprint = next;
		for (const map of [versions, queries, summaries, focus, maps]) map.clear();
		publishAll();
	}));

	// ── The sidebar's own env (LOCAL, over this controller's store and client) ──────────────────
	const registry = createConnectionRegistry();
	const activeConnection: IReadable<string | null> = { get: active.get, subscribe: active.subscribe };
	let lastEnv: { ready: boolean; env: IVectorEnv } | null = null;

	return {
		channel: attached.channel,
		store,
		client,
		identity,
		activation,
		discovery,
		activeConnection,
		noteActiveDocKey(key) {
			hostActive = key;
			activation.noteActiveDocKey(key);
			syncActive();
		},
		env(ready) {
			if (lastEnv && lastEnv.ready === ready) return lastEnv.env;
			const env = createLocalVectorEnv({
				ready,
				client,
				store,
				registry,
				activeConnection,
				// Documents open on a click only (R7), which is also the user activating the tool.
				openConsole: (endpoint) => {
					activation.open('user');
					opts.documents?.open(consoleUri(endpoint.key), endpoint.nodeName || 'Vector store');
				},
				openDocument: (endpoint, objectId, path) => {
					activation.open('user');
					opts.documents?.open(documentUri(endpoint.key, objectId), documentTitle(objectId, path));
				},
				refresh: (o) => {
					// A refresh asked for in the sidebar; an automatic one (quiet) is not the user activating the tool.
					if (!o?.quiet) activation.open('user');
					return discovery.allowed() ? store.refresh(client, { reprobe: o?.reprobe === true }) : Promise.resolve();
				},
			});
			lastEnv = { ready, env };
			return env;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of offs.splice(0)) off();
			for (const cancel of [...cancels]) cancel();
			cancels.clear();
			registry.clear();
			discovery.dispose();
			activation.dispose();
			attached.dispose();
			identity.dispose();
		},
	};
}
