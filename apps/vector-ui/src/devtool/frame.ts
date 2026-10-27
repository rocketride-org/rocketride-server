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
// VECTOR-UI - DEV-TOOL FRAME (a document frame: no client, everything over ops)
// =============================================================================
//
// A plain function over the frame mount's peer, the host's channel and the
// shell's protocol factories (injected), so it runs under node:test against
// the real shell modules. It holds NO client and no token (R1): it builds the
// REMOTE env every view of the frame uses.
//
//   CALLS     Every view calls tools through a remote role channel
//             (remoteChannel) that maps each tool to its op, with the
//             protocol's frame timeout and a deadline; a generation ticket is
//             checked HERE (it cannot cross), and a call no controller ever
//             took says to open the sidebar. Only the tools channel exists:
//             chat and uploads are not brokered for store tools (R11).
//   OBJECTS   The frame keeps its OWN connection registry: its console
//             controller (directory, trash, chunks, writes and their inline
//             confirmation), selection, tab, scope and staged documents. Two
//             frames never share one, so a confirmation shows in the frame
//             that asked for it. Its Query history is its own too, in memory
//             only.
//   ACROSS    What another frame did arrives as retained state, read
//             idempotently (every publish re-delivers every topic):
//               docVersions     a console relists, refreshes its figures,
//                               probes and redraws its map for another
//                               frame's write; a document reads itself again
//                               for any write
//               queries         a document scores its heat strip against the
//                               console's query text
//               consoleSummary  a document compares with the console's median
//               focus / map     requests, each taken once (a nonce) and
//                               reported taken with the `active` event
//             A console sends its query and median as hints, again to a
//             controller that remounted without them.
//   IDENTITY  The frame remembers the first fingerprint; a different one closes
//             its document (documents.close), clears its own objects (its
//             staged documents and its Query history with them) and forgets
//             its connection in the realm's caches. `host:connection` turning
//             false, or an unknown identity, clears its own objects only
//             (R9), and keeps what the user staged and the Query history: the
//             new objects of the same connection take the staged documents
//             back.
//   SUMMON    While no controller is ready the frame asks its host to mount
//             one with the base's reserved non-op event (F11), and re-announces
//             `active` once per readiness nonce.
// =============================================================================

import type { DevToolProps, ToolChannel, ToolControllerFn, ToolOpMap } from 'shell';
import { ExplorerToolError } from 'shared/explorer';
import type { IExplorerEndpoint, IInvokeOptions, IProbeResult, IRoleChannel } from 'shared/explorer';
import { HOST_CONNECTION_TOPIC, createFrameCaller } from 'shared/explorer/devtool/frame';
import type { IFrameCaller } from 'shared/explorer/devtool/frame';
import { createFrameIdentityGuard, followSignIn } from 'shared/explorer/devtool/frameIdentity';
import type { FrameResetReason, IFrameIdentityGuard, SignInState } from 'shared/explorer/devtool/frameIdentity';
import { CONTROLLER_STATE_TOPIC, channelFor, mountNonce } from 'shared/explorer/devtool/realm';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { createControllerSummon } from 'shared/explorer/devtool/summon';
import type { SummonState } from 'shared/explorer/devtool/summon';
import { probeAwareChannel } from '../adapters/actions';
import { makeConsoleActions } from '../adapters/consoleActions';
import { createConnectionRegistry } from '../adapters/connections';
import { sessionQueryHistory } from '../adapters/queryHistory';
import type { IConnectionEntry, IConnectionLink, IConnectionRegistry } from '../adapters/connections';
import { announcer, connectionCaches } from '../adapters/explorer';
import type { ConsoleActions, HighlightSource, VectorKey } from '../contract/types';
import { DEVTOOL_CHAT_NOTE, DEVTOOL_DEGRADED, DEVTOOL_HISTORY_NOTE, DEVTOOL_UPLOADS_NOTE, NO_CHANNELS, devToolConsoleModel } from '../env';
import type { IReadable, IVectorEndpointsState, IVectorEnv } from '../env';
import { consoleUri, documentTitle, documentUri } from '../vector/addresses';
import { consoleNodes } from '../vector/consoleModel';
import { medianChunks } from '../vector/health';
import { unstage } from '../vector/staged';
import type { IStagedSet } from '../vector/staged';
import { controllerNotReadyError, isNotSent } from './frameText';
import { EVENT, NO_ENDPOINTS, OP, STATE, TOOL_OP, WRITE_OPS, field, frameTimeoutFor, routeDocKey, toWire } from './protocol';
import type { DocRoute, IActiveEvent, IConsoleSummary, IDocVersion, IFocusRequest, IMapRequest, IQueryHint, VectorOps } from './protocol';

/** Where the frame learns whether its document is visible (default: the page's `document.visibilityState`). */
export interface IVisibilitySource {
	visible(): boolean;
	subscribe(listener: () => void): () => void;
}

/** What {@link createVectorFrame} needs. NO client and no ConnectionManager: a frame holds none (R1, T2). */
export interface IVectorFrameOptions {
	/** The frame mount's peer. */
	peer: DevToolPeer;
	/** The host's channel for this mount, when it gave one. */
	channel?: ToolChannel;
	/** The host's documents API. */
	documents?: DevToolProps['documents'];
	/** The frame's docKey. */
	docKey?: string | null;
	/** The shell's createToolController (injected). */
	createToolController: <O extends ToolOpMap>(peer: DevToolPeer) => ToolControllerFn<O>;
	/** The shell's createToolChannel (injected). */
	createToolChannel: (peer: DevToolPeer) => ToolChannel;
	/** The clock (deadlines). */
	now?: () => number;
	/** Timers (the summon, the hint debounce); returns a cancel. Default setTimeout. */
	schedule?: (fn: () => void, ms: number) => () => void;
	/** How long the console's hints wait for the next change before they are sent (default 250 ms; 0: at once). */
	hintDelayMs?: number;
	/** Where focus comes from (default: the window; null: none). */
	focusTarget?: { addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void } | null;
	/** Whether the document is visible (default: the page's visibility; null: always visible). */
	visibility?: IVisibilitySource | null;
	/** Told about a failure nobody awaits (a refresh, a relay the controller refused). */
	onError?: (error: unknown) => void;
}

/** What a document frame is told. */
export interface IDocumentBinding {
	/**
	 * A press opened or fronted this document (its arrival, taken once): take the focus when nothing shown has it, and
	 * show the chunk when one is named (null: none).
	 */
	focus(chunkId: number | null): void;
	/** A write ran on the connection (any frame's): read the document again. */
	version(version: IDocVersion): void;
}

/** A mounted frame. */
export interface IVectorFrame {
	readonly route: DocRoute;
	/** This frame's nonce: the origin of its writes. */
	readonly origin: string;
	readonly channel: ToolChannel;
	readonly caller: IFrameCaller<VectorOps>;
	readonly guard: IFrameIdentityGuard;
	/** This frame's own connection objects. */
	readonly connections: IConnectionRegistry;
	/** The host's `host:connection`: undefined until the host published it (not yet known is not disconnected). */
	readonly connected: IReadable<boolean | undefined>;
	/** Whether a controller is up to carry this frame's calls. */
	readonly controllerReady: IReadable<boolean>;
	/** Where the summon of a missing controller stands. */
	readonly summon: IReadable<SummonState>;
	/** What the controller says about the account. */
	readonly signIn: IReadable<SignInState>;
	/** The controller's endpoints snapshot. */
	readonly endpoints: IReadable<IVectorEndpointsState>;
	/** The last write per connection. */
	readonly docVersions: IReadable<Record<string, IDocVersion>>;
	/** The consoles' query texts per connection. */
	readonly queries: IReadable<Record<string, IQueryHint>>;
	/** The consoles' medians per connection. */
	readonly summaries: IReadable<Record<string, IConsoleSummary>>;
	/** Whether this document is visible (a hidden one polls nothing). */
	readonly visible: IReadable<boolean>;
	/** The REMOTE env (rebuild when `connected` changes). */
	env(ready: boolean): IVectorEnv;
	/**
	 * A console's side: hints out, other frames' writes and map requests in. `arrived` is told when a map request (a
	 * document's Show on map, which fronts this frame) is taken: a press's arrival. Returns the unbind.
	 */
	bindConsole(entry: IConnectionEntry, on?: { arrived?(): void }): () => void;
	/** A document's side: the console's query in, focus requests and writes in. Returns the unbind. */
	bindDocument(entry: IConnectionEntry, objectId: string, on: IDocumentBinding): () => void;
	/** The actions a document frame's view uses: the map and the chat land in the connection's console frame. */
	documentActions(entry: IConnectionEntry, announce?: (text: string) => void): ConsoleActions;
	/** Why the frame last cleared its caches, or null. */
	lastReset(): FrameResetReason | null;
	/** Dispose (idempotent): pending calls are dropped as stale. */
	dispose(): void;
}

/** Request nonces taken in this realm (shared by its frames, so a StrictMode remount never takes one twice). */
const TAKEN = new Set<string>();
const MAX_TAKEN = 200;

/**
 * Remember a taken nonce (bounded).
 *
 * @param nonce - The nonce.
 */
function remember(nonce: string): void {
	TAKEN.add(nonce);
	if (TAKEN.size > MAX_TAKEN) TAKEN.delete(TAKEN.values().next().value as string);
}

/**
 * A readable over a value the caller replaces.
 *
 * @param initial - The first value.
 * @returns The readable and its setter.
 */
function cell<T>(initial: T): IReadable<T> & { set(next: T): void } {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		set(next) {
			if (Object.is(next, value)) return;
			value = next;
			for (const listener of [...listeners]) listener();
		},
	};
}

/**
 * A keyed map read off a state snapshot (anything else reads as empty).
 *
 * @param snapshot - The snapshot.
 * @returns The map.
 */
function asMap<T>(snapshot: unknown): Record<string, T> {
	return snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot) ? (snapshot as Record<string, T>) : {};
}

/** The page's visibility. */
const PAGE_VISIBILITY: IVisibilitySource | null =
	typeof document === 'undefined'
		? null
		: {
				visible: () => document.visibilityState !== 'hidden',
				subscribe: (listener) => {
					document.addEventListener('visibilitychange', listener);
					return () => document.removeEventListener('visibilitychange', listener);
				},
			};

/**
 * A role channel on one connection whose tool calls are controller ops (the frame's only way to the store).
 *
 * @param caller - The frame's caller.
 * @param endpoint - The connection (or a getter for its live record).
 * @param info - Its latest `dialect` answer, from the endpoints state (the frame's timeouts derive from it).
 * @param origin - The frame's nonce (its writes carry it).
 * @returns The channel.
 */
export function remoteChannel(caller: Pick<IFrameCaller<VectorOps>, 'callReply' | 'controllerReady'>, endpoint: IExplorerEndpoint | (() => IExplorerEndpoint), info: () => Record<string, unknown> | null, origin: string): IRoleChannel {
	const current = typeof endpoint === 'function' ? endpoint : (): IExplorerEndpoint => endpoint;
	return {
		role: 'tools',
		bound: true,
		sendFiles: () => Promise.reject(new ExplorerToolError({ kind: 'upgrade', tool: 'sendFiles', message: DEVTOOL_UPLOADS_NOTE })),
		ask: () => Promise.reject(new ExplorerToolError({ kind: 'upgrade', tool: 'chat', message: DEVTOOL_CHAT_NOTE })),
		invoke<T = unknown>(tool: string, input: Record<string, unknown> = {}, opts: IInvokeOptions = {}): Promise<T> {
			const live = current();
			const op = TOOL_OP[tool];
			if (op === undefined) return Promise.reject(new ExplorerToolError({ kind: 'upgrade', tool, message: `${tool} is not available in the dev-tool mount.` }));
			// The controller names the node itself (the embedding node for embed, the store node otherwise): a call aimed
			// at any other node is a programming error, never sent.
			const target = tool === 'embed' ? consoleNodes(live).embed : live.nodeId;
			if (opts.nodeId !== undefined && opts.nodeId !== target) return Promise.reject(new ExplorerToolError({ kind: 'invalid', tool, message: `${tool} goes to the node the connection names, not to ${String(opts.nodeId)}.` }));
			const ticket = opts.generation;
			const stale = (): ExplorerToolError => new ExplorerToolError({ kind: 'stale', tool, message: `The result of ${tool} was dropped: a newer request replaced it.` });
			const params = WRITE_OPS.has(op) ? { key: live.key, input: toWire(input), origin } : { key: live.key, input: toWire(input) };
			let sent: Promise<unknown>;
			try {
				sent = caller.callReply(op, params as never, { timeoutMs: frameTimeoutFor(op, info()) });
			} catch (error) {
				return Promise.reject(error);
			}
			return sent.then(
				(value) => {
					if (ticket !== undefined && !ticket.isCurrent()) throw stale();
					return value as T;
				},
				(error: unknown) => {
					if (ticket !== undefined && !ticket.isCurrent()) throw stale();
					// Never sent because no controller became ready (no sidebar yet): say so, as `unavailable` (it cannot
					// have run), not the base's op-naming text.
					if (isNotSent(error) && !caller.controllerReady()) throw controllerNotReadyError(tool);
					throw error;
				},
			);
		},
	};
}

/**
 * Mount a Vector Explorer document frame.
 *
 * @param opts - See {@link IVectorFrameOptions}.
 * @returns The frame; dispose it in the mount's cleanup.
 */
export function createVectorFrame(opts: IVectorFrameOptions): IVectorFrame {
	const route = routeDocKey(opts.docKey);
	const docKey = typeof opts.docKey === 'string' ? opts.docKey : '';
	const frameKey = route.kind === 'console' || route.kind === 'document' ? route.key : null;
	const origin = mountNonce();
	const report = (error: unknown): void => opts.onError?.(error);
	const schedule =
		opts.schedule ??
		((fn: () => void, ms: number): (() => void) => {
			const handle = setTimeout(fn, ms);
			return () => clearTimeout(handle);
		});
	const hintDelay = opts.hintDelayMs ?? 250;
	const channel = opts.channel ?? channelFor(opts.peer, opts.createToolChannel);
	const caller = createFrameCaller<VectorOps>({ peer: opts.peer, channel, createToolController: opts.createToolController, createToolChannel: opts.createToolChannel, ...(opts.now ? { now: opts.now } : {}) });
	const registry = createConnectionRegistry();
	// The Query tab's history: memory only, emptied on a change of identity.
	const queryHistory = sessionQueryHistory(DEVTOOL_HISTORY_NOTE);
	// What the user staged, held across a reset that keeps the identity, until the connection's new objects take it.
	const carried = new Map<string, IStagedSet>();
	const offs: Array<() => void> = [];
	let disposed = false;
	let resetWhy: FrameResetReason | null = null;

	// ── This frame's own state, declared before ANY subscription ─────────────────────────────────
	// A host's channel replays each retained topic SYNCHRONOUSLY inside onState (the ToolChannel contract). A frame opened
	// while the controller is already ready therefore hears `ready`, the maps and the identity while this function is
	// still running, and those handlers read this state (flushHints, the offers, the identity reset). A `let` declared
	// below the subscription that reaches it would throw ("Cannot access … before initialization") and take the whole
	// host down. So every variable a handler can reach is declared here, first.
	// The controller mount this frame last announced itself to (its readiness nonce).
	let announcedTo: string | null = null;
	// The console's hints: its query text and its median, and what was last sent of each (per controller).
	let myQuery: { key: string; nonce: string; text: string | null } | null = null;
	let mySummary: { key: string; median: number | null } | null = null;
	let sentQuery = '';
	let sentSummary = '';
	let hintTimer: (() => void) | null = null;
	// Requests for this frame: who takes them, and the last one an event brought.
	let focusListener: ((chunkId: number | null) => void) | null = null;
	let mapListener: ((request: { keys: VectorKey[]; source: HighlightSource }) => void) | null = null;
	let eventFocus: IFocusRequest | null = null;
	let eventMap: (IMapRequest & { docKey: string }) | null = null;

	// ── Mirrors of the host's and the controller's retained state ───────────────────────────────
	const connected = cell<boolean | undefined>(undefined);
	const endpoints = cell<IVectorEndpointsState>(NO_ENDPOINTS);
	const versions = cell<Record<string, IDocVersion>>({});
	const queries = cell<Record<string, IQueryHint>>({});
	const summaries = cell<Record<string, IConsoleSummary>>({});
	const focus = cell<Record<string, IFocusRequest>>({});
	const maps = cell<Record<string, IMapRequest>>({});
	offs.push(channel.onState(HOST_CONNECTION_TOPIC, (snapshot) => {
		const value = field(snapshot, 'connected');
		if (typeof value === 'boolean') connected.set(value);
	}));
	// Each controller mount publishes its own readiness nonce. A NEW one is a controller that has never heard this frame
	// (the replay of the last frame event goes to its op server, which drops events), so the frame says which document
	// it is, and sends its hints again, once per nonce.
	const controllerReady = cell(false);
	offs.push(channel.onState(CONTROLLER_STATE_TOPIC, (snapshot) => {
		const ready = field(snapshot, 'ready');
		const nonce = typeof ready === 'string' && ready !== '' ? ready : null;
		controllerReady.set(nonce !== null);
		if (nonce === null || nonce === announcedTo) return;
		announcedTo = nonce;
		sendActive();
		flushHints();
	}));
	offs.push(channel.onState(STATE.endpoints, (snapshot) => {
		if (Array.isArray(field(snapshot, 'endpoints'))) endpoints.set({ ...NO_ENDPOINTS, ...(snapshot as IVectorEndpointsState) });
	}));
	offs.push(channel.onState(STATE.docVersions, (snapshot) => versions.set(asMap<IDocVersion>(snapshot))));
	offs.push(channel.onState(STATE.queries, (snapshot) => queries.set(asMap<IQueryHint>(snapshot))));
	offs.push(channel.onState(STATE.consoleSummary, (snapshot) => summaries.set(asMap<IConsoleSummary>(snapshot))));
	offs.push(channel.onState(STATE.focusRequests, (snapshot) => focus.set(asMap<IFocusRequest>(snapshot))));
	offs.push(channel.onState(STATE.mapRequests, (snapshot) => maps.set(asMap<IMapRequest>(snapshot))));

	// F11: summon a missing controller on purpose (one reserved non-op event, never a call), and follow how that stands.
	const summoner = createControllerSummon({ channel, schedule });
	const summon = cell<SummonState>(summoner.state());
	offs.push(summoner.subscribe((state) => summon.set(state)));
	offs.push(() => summoner.dispose());
	// F12: what the controller says about the account (told 'pending' at once).
	const signIn = cell<SignInState>('pending');
	offs.push(followSignIn(channel, (state) => signIn.set(state)));

	// Visibility: a hidden document polls nothing (its console's quick stats and paging pause).
	const source = opts.visibility !== undefined ? opts.visibility : PAGE_VISIBILITY;
	const visible = cell(source ? source.visible() : true);
	if (source) offs.push(source.subscribe(() => visible.set(source.visible())));

	// ── docVersions: every write that ran on a connection, by the controller mount that counted it ──
	// A change of a connection's (epoch, version) is a write to read again, never a "greater" version: a remounted
	// controller counts again from 1 under a new epoch, and the map it publishes first does not hold the connection,
	// which forgets what was seen. So neither a stale replay of the previous mount's map (the JSON wire re-delivers
	// every topic with the new readiness nonce) nor the new mount's first version is mistaken for the other.
	const stampOf = (version: IDocVersion): string => `${typeof version.epoch === 'string' ? version.epoch : ''}#${version.version}`;
	const followVersions = (key: string, onWrite: (version: IDocVersion) => void): (() => void) => {
		const first = versions.get()[key];
		let seen: string | undefined = first ? stampOf(first) : undefined;
		return versions.subscribe(() => {
			const version = versions.get()[key];
			if (!version) {
				seen = undefined;
				return;
			}
			const stamp = stampOf(version);
			if (stamp === seen) return;
			seen = stamp;
			onWrite(version);
		});
	};

	const infoOf = (key: string): Record<string, unknown> | null => {
		const probe = endpoints.get().probes[key];
		return probe?.ok && probe.info !== null && typeof probe.info === 'object' ? probe.info : null;
	};

	// ── `active` (R8): the fronted document, and the request nonces it took ─────────────────────
	function sendActive(consumed?: string[]): void {
		if (disposed) return;
		const payload: IActiveEvent = consumed === undefined ? { docKey } : { docKey, consumed };
		channel.sendEvent(EVENT.active, payload);
	}
	const focusTarget = opts.focusTarget !== undefined ? opts.focusTarget : typeof window !== 'undefined' ? window : null;
	const onFocus = (): void => sendActive();
	focusTarget?.addEventListener('focus', onFocus);
	offs.push(() => focusTarget?.removeEventListener('focus', onFocus));

	// ── The console's hints: its query text and its median, each sent once per controller ───────
	function flushHints(): void {
		if (disposed || announcedTo === null || !controllerReady.get()) return;
		if (myQuery !== null && queries.get()[myQuery.key]?.nonce !== myQuery.nonce) {
			const mark = `${announcedTo}|${myQuery.nonce}`;
			if (sentQuery !== mark) {
				sentQuery = mark;
				channel.sendEvent(EVENT.queryChanged, { key: myQuery.key, nonce: myQuery.nonce, text: myQuery.text });
			}
		}
		if (mySummary !== null && summaries.get()[mySummary.key]?.medianChunks !== mySummary.median) {
			const mark = `${announcedTo}|${mySummary.median}`;
			if (sentSummary !== mark) {
				sentSummary = mark;
				channel.sendEvent(EVENT.consoleSummary, { key: mySummary.key, medianChunks: mySummary.median });
			}
		}
	}
	const scheduleHints = (): void => {
		if (hintDelay <= 0) {
			flushHints();
			return;
		}
		hintTimer?.();
		hintTimer = schedule(() => {
			hintTimer = null;
			flushHints();
		}, hintDelay);
	};
	offs.push(() => hintTimer?.());
	// The controller published its maps: a hint it does not hold (it remounted) is sent again (once per controller).
	offs.push(queries.subscribe(() => flushHints()));
	offs.push(summaries.subscribe(() => flushHints()));

	// ── Requests for this frame, each taken once (realm-wide) and reported taken ────────────────
	const offerFocus = (): void => {
		if (focusListener === null || route.kind !== 'document') return;
		for (const request of [focus.get()[route.key], eventFocus]) {
			if (!request || request.docKey !== docKey || TAKEN.has(request.nonce)) continue;
			remember(request.nonce);
			focusListener(request.chunkId);
			sendActive([request.nonce]);
		}
	};
	const offerMap = (): void => {
		if (mapListener === null || route.kind !== 'console') return;
		const fromEvent = eventMap !== null && eventMap.docKey === docKey ? eventMap : null;
		for (const request of [maps.get()[route.key], fromEvent]) {
			if (!request || TAKEN.has(request.nonce) || !Array.isArray(request.keys)) continue;
			remember(request.nonce);
			mapListener({ keys: request.keys.map((k) => [k[0], k[1]] as VectorKey), source: request.source });
			sendActive([request.nonce]);
		}
	};
	offs.push(focus.subscribe(offerFocus));
	offs.push(maps.subscribe(offerMap));
	offs.push(channel.onEvent(EVENT.focusChunk, (payload) => {
		const nonce = field(payload, 'nonce');
		const target = field(payload, 'docKey');
		const chunkId = field(payload, 'chunkId');
		if (typeof nonce !== 'string' || typeof target !== 'string' || !(chunkId === null || Number.isInteger(chunkId))) return;
		eventFocus = { nonce, docKey: target, chunkId: chunkId as number | null };
		offerFocus();
	}));
	offs.push(channel.onEvent(EVENT.showOnMap, (payload) => {
		const nonce = field(payload, 'nonce');
		const target = field(payload, 'docKey');
		const keys = field(payload, 'keys');
		const source = field(payload, 'source');
		if (typeof nonce !== 'string' || typeof target !== 'string' || !Array.isArray(keys) || typeof source !== 'string') return;
		eventMap = { nonce, docKey: target, keys: keys as VectorKey[], source: source as HighlightSource };
		offerMap();
	}));

	// ── Identity (R9): close on a different fingerprint; clear caches on every reset ────────────
	const guard = createFrameIdentityGuard({
		channel,
		docKey: opts.docKey ?? null,
		...(opts.documents ? { documents: opts.documents } : {}),
		onReset: (reason) => {
			resetWhy = reason;
			// This frame's own objects only. In rocket-ui the realm may also run the full app and other documents,
			// whose objects and caches are theirs: the full app keeps a connection's saved views and filters, chat
			// and uploads across a reconnect. Only another identity forgets the frame's connection in the realm's
			// per-connection caches (the full app then clears everything anyway).
			if (reason === 'identity') {
				carried.clear();
				queryHistory.forget();
			} else {
				for (const entry of registry.entries()) if (entry.staged.get().size > 0) carried.set(entry.key, entry.staged.get());
			}
			registry.clear();
			if (reason === 'identity' && frameKey !== null) connectionCaches.forgetKey(frameKey);
			myQuery = null;
			mySummary = null;
		},
	});

	// ── Remote channels: one per connection, over the live endpoint record ──────────────────────
	const channels = new Map<string, IRoleChannel>();
	// Whether the store answered its last probe (the controller's state, mirrored here).
	const probedOn = (key: string): boolean => endpoints.get().probes[key]?.ok === true;
	const channelOf = (endpoint: IExplorerEndpoint): IRoleChannel => {
		let made = channels.get(endpoint.key);
		if (!made) {
			let last = endpoint;
			const live = (): IExplorerEndpoint => {
				last = endpoints.get().endpoints.find((candidate) => candidate.key === endpoint.key) ?? last;
				return last;
			};
			// A call refused for want of a probe that answered says so, never "update the node" (probeAware).
			made = probeAwareChannel(remoteChannel(caller, live, () => infoOf(endpoint.key), origin), () => probedOn(endpoint.key));
			channels.set(endpoint.key, made);
		}
		return made;
	};
	const probe = (key: string): Promise<IProbeResult | null> => caller.callReply(OP.probe, { key }, { timeoutMs: frameTimeoutFor(OP.probe, infoOf(key)) }).then((value) => value, () => null);
	const link: IConnectionLink = {
		session: (endpoint) => channelOf(endpoint),
		reprobe: (key) => probe(key).then(() => undefined),
		probed: probedOn,
	};
	const openConsole = (endpoint: IExplorerEndpoint): void => {
		opts.documents?.open(consoleUri(endpoint.key), endpoint.nodeName || 'Vector store');
	};
	const openDocument = (endpoint: IExplorerEndpoint, objectId: string, path: string | null, chunkId?: number): void => {
		const target = documentUri(endpoint.key, objectId);
		opts.documents?.open(target, documentTitle(objectId, path));
		// The press's arrival (and its chunk, if any): the document frame may not exist yet, so it waits for it as retained
		// state, taken once and dropped after FOCUS_MAX_AGE_MS. A frame nobody pressed for (restored at load) gets none.
		caller.callReply(OP.requestFocus, { key: endpoint.key, docKey: target, chunkId: chunkId ?? null }, { timeoutMs: frameTimeoutFor(OP.requestFocus) }).catch(report);
	};
	const activeConnection: IReadable<string | null> = { get: () => frameKey, subscribe: () => () => undefined };
	const envs = new Map<boolean, IVectorEnv>();

	return {
		route,
		origin,
		channel,
		caller,
		guard,
		connections: registry,
		connected,
		controllerReady,
		summon,
		signIn,
		endpoints,
		docVersions: versions,
		queries,
		summaries,
		visible,
		lastReset: () => resetWhy,
		env(ready) {
			const cached = envs.get(ready);
			if (cached) return cached;
			const env: IVectorEnv = {
				kind: 'remote',
				ready,
				endpoints,
				// An automatic refresh (quiet) says nothing when refused: at mount the controller may still be settling its
				// identity, and the endpoints state says what happened.
				refresh: (o) =>
					caller.callReply(OP.refresh, o?.reprobe ? { reprobe: true } : {}, { timeoutMs: frameTimeoutFor(OP.refresh) }).then(
						() => undefined,
						(error: unknown) => {
							if (!o?.quiet) report(error);
						},
					),
				// Silent, as the full app's probe: a probe that cannot run is "nothing was tested" (testResultText).
				probe,
				session: (endpoint) => (ready ? channelOf(endpoint) : null),
				channels: (endpoint) => (ready ? { tools: channelOf(endpoint), chat: null, ingest: null } : NO_CHANNELS),
				connection: (endpoint, limits) => {
					const made = registry.entry(endpoint, ready ? link : null, limits);
					const staged = carried.get(endpoint.key);
					if (staged !== undefined) {
						carried.delete(endpoint.key);
						if (made.staged.get().size === 0) made.staged.set(staged);
					}
					return made;
				},
				existingConnection: (key) => registry.existing(key),
				consoleModel: devToolConsoleModel,
				openConsole,
				openDocument,
				activeConnection,
				degraded: DEVTOOL_DEGRADED,
				queryHistory,
			};
			envs.set(ready, env);
			return env;
		},
		bindConsole(entry, on) {
			const key = entry.key;
			const unbind: Array<() => void> = [];
			// Hints out: the query the console shows on its map (the document frames' heat strip), and its median.
			const onSelection = (): void => {
				const state = entry.selection.getState();
				if (state.connectionKey !== key) return;
				if (myQuery !== null && myQuery.key === key && myQuery.text === state.query) return;
				if (myQuery === null && state.query === null) return;
				myQuery = { key, nonce: mountNonce(), text: state.query };
				scheduleHints();
			};
			let rows: unknown = null;
			const onConsole = (): void => {
				const listed = entry.controller.getState().directory.rows;
				if (listed === rows) return;
				rows = listed;
				if (listed.length === 0 && mySummary === null) return;
				const median = medianChunks(listed);
				if (mySummary !== null && mySummary.key === key && mySummary.median === median) return;
				mySummary = { key, median };
				scheduleHints();
			};
			unbind.push(entry.selection.subscribe(onSelection));
			unbind.push(entry.controller.subscribe(onConsole));
			onSelection();
			onConsole();
			// Another frame's write: what this console shows may have changed. Its own write already refreshed it.
			unbind.push(followVersions(key, (version) => {
				if (version.origin === origin) return;
				// A console that has not opened (its store has not answered as a vector store yet) lists nothing now: it
				// lists the store as it is when it opens.
				if (entry.opened) entry.controller.documentsChanged();
				entry.writes.set(entry.writes.get() + 1);
				const gone = Array.isArray(version.gone) ? version.gone : [];
				for (const id of gone) entry.selection.forgetDocument(id);
				// A document another frame moved or deleted is no longer this console's to stage.
				entry.staged.set(unstage(entry.staged.get(), gone));
			}));
			// Keys a document frame asked to see on the map: highlighted here, on the Map tab.
			const listener = (request: { keys: VectorKey[]; source: HighlightSource }): void => {
				entry.selection.setHighlight({ source: request.source, keys: request.keys });
				entry.tab.set('map');
				// The press that asked (in a document frame) fronts this one: it takes the focus if nothing shown has it.
				on?.arrived?.();
			};
			mapListener = listener;
			offerMap();
			unbind.push(() => {
				if (mapListener === listener) mapListener = null;
			});
			return () => {
				for (const off of unbind.splice(0)) off();
			};
		},
		bindDocument(entry, objectId, on) {
			const key = entry.key;
			const unbind: Array<() => void> = [];
			// A document frame never shows the directory: its controller lists nothing (it confirms and sends writes only).
			entry.controller.setVisible(false);
			const onQueries = (): void => {
				const hint = queries.get()[key];
				const text = hint && typeof hint.text === 'string' ? hint.text : null;
				if (entry.selection.getState().query !== text) entry.selection.setQuery(text);
			};
			unbind.push(queries.subscribe(onQueries));
			onQueries();
			unbind.push(followVersions(key, (version) => on.version(version)));
			const listener = (chunkId: number | null): void => {
				if (chunkId !== null) entry.selection.focusChunk([objectId, chunkId]);
				on.focus(chunkId);
			};
			focusListener = listener;
			offerFocus();
			unbind.push(() => {
				if (focusListener === listener) focusListener = null;
			});
			return () => {
				for (const off of unbind.splice(0)) off();
			};
		},
		documentActions(entry, announce = (text) => announcer.announce(text)) {
			const endpoint = (): IExplorerEndpoint => entry.ctx.endpoint;
			// The console is another frame with its own objects: a document frame neither stages (its Move to trash confirms
			// here, D9), nor switches the console's tabs, nor hands it a query (D9b), so those actions are left out.
			const { stageRemove: _stageRemove, openTab: _openTab, useAsQuery: _useAsQuery, ...base } = makeConsoleActions(entry, {
				openDocument: (id, chunkId) => openDocument(endpoint(), id, null, chunkId),
				showConsole: () => openConsole(endpoint()),
				announce,
			});
			return {
				...base,
				// The map is the console's: front the console, then hand it the keys (at most project_keys_max of them).
				showOnMap: (keys, source) => {
					openConsole(endpoint());
					const max = entry.ctx.limits.project_keys_max;
					const sent = keys.slice(0, max).map((k) => [k[0], k[1]] as VectorKey);
					if (keys.length > max) announce(`Showing the first ${max.toLocaleString('en-US')} of ${keys.length.toLocaleString('en-US')} chunks on the map.`);
					if (sent.length === 0) return;
					caller.callReply(OP.showOnMap, { key: entry.key, keys: sent, source }, { timeoutMs: frameTimeoutFor(OP.showOnMap) }).catch(report);
				},
			};
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of offs.splice(0)) off();
			guard.dispose();
			registry.clear();
			carried.clear();
			caller.dispose();
		},
	};
}
