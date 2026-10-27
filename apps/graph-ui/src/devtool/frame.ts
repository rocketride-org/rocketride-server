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
// GRAPH-UI - DEV-TOOL FRAME (a document frame: no client, everything over ops)
// =============================================================================
//
// A plain function over the frame mount's peer, the host's channel and the
// shell's protocol factories (injected), so it runs under node:test against
// the real shell modules. It holds NO client and no token (R1): it builds the
// REMOTE env every view of the frame uses.
//
//   - Engine calls are ops (devtool/protocol.ts), each with an explicit frame
//     timeout above the controller's own bound (R5) and a deadline; a call made
//     while `host:connection` is false is refused before it is sent (T8).
//   - The run surface keeps its runner, graph session, path search and editor:
//     `session(endpoint)` is a remote IToolSession whose `invoke` maps the
//     graph tools to ops, checks the generation ticket HERE (a ticket is a
//     function and cannot cross), and reads `info()` from the endpoints state.
//   - What the controller owns arrives as retained state (endpoints, schema
//     labels, data versions, the history and user-data revisions, the pending
//     preview). Bulk data is read with ops: history, a connection's full
//     schema view (fetched on first use and again whenever the `schemas`
//     summary says a newer load completed), and label styles and saved
//     queries (devtool/remoteUserData.ts, owned by the frame's account).
//   - Writes are counted by the controller; a write the user stopped waiting
//     for is reported with an op.
//   - Identity (R9): the frame remembers the first fingerprint; a different one
//     closes its document (documents.close) and clears its caches.
//   - The summon (F11): while no controller is ready the frame asks its host to
//     mount one, with the base's reserved non-op event (summon.ts), and says
//     how that stands (`summon`). It re-announces `active` once per readiness
//     nonce, so a summoned controller hears which document this is although
//     the summon took busPeer's retained slot.
//   - The account (F12): what the controller says about the sign-in
//     (`signIn`), so a document can wait for one instead of claiming it is
//     not connected.
//   - Drafts and captions are session-only (no usePrefs on this path).
//   - Every cache (history, schema views, user data) is cleared on an identity
//     reset, so nothing of one account is shown under another.
// =============================================================================

import type { DevToolProps, ToolChannel, ToolControllerFn, ToolOpMap } from 'shell';
import { ExplorerToolError } from 'shared/explorer';
import type { IExplorerEndpoint, IGenerationTicket, IHistoryEntry, IInvokeOptions, IProbeResult, IToolSession } from 'shared/explorer';
import { createSessionGridPersistence } from 'shared/explorer/devtool/gridPersistence';
import { HOST_CONNECTION_TOPIC, createFrameCaller } from 'shared/explorer/devtool/frame';
import type { IFrameCaller } from 'shared/explorer/devtool/frame';
import { createFrameIdentityGuard, followSignIn } from 'shared/explorer/devtool/frameIdentity';
import type { FrameResetReason, IFrameIdentityGuard, SignInState } from 'shared/explorer/devtool/frameIdentity';
import { CONTROLLER_STATE_TOPIC, channelFor } from 'shared/explorer/devtool/realm';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { createControllerSummon } from 'shared/explorer/devtool/summon';
import type { SummonState } from 'shared/explorer/devtool/summon';
import { TOOL } from '../adapters/explorer';
import { DEVTOOL_HISTORY_PRIVACY_NOTE, memoryPrefs } from '../env';
import type { DocTarget, IGraphEnv, IGraphHistory, IKeyed, IReadable } from '../env';
import { asPreview } from '../graph/previews';
import type { ISchemaView } from '../graph/schema';
import { createRemoteUserData } from './remoteUserData';
import { controllerNotReadyError, isNotSent } from './frameText';
import type { IGraphPreview } from '../graph/previews';
import { EVENT, NO_ENDPOINTS, OP, STATE, docKeyFor, field, frameTimeoutFor, routeDocKey, toWire } from './protocol';
import type { DocRoute, GraphOps, HistoryEdit, IActiveEvent, IFrameSchema, IGraphEndpointsState, IGraphHistoryView } from './protocol';

/** What {@link createGraphFrame} needs. NO client and no ConnectionManager: a frame holds none (R1, T2). */
export interface IGraphFrameOptions {
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
	/** Where focus comes from (default: the window; null: none). */
	focusTarget?: { addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void } | null;
	/** The summon's timers (default setTimeout; tests run their own). */
	schedule?: (fn: () => void, ms: number) => () => void;
	/** Told about a failure nobody awaits (a history edit, a refresh the controller refused). */
	onError?: (error: unknown) => void;
}

/** A mounted frame. */
export interface IGraphFrame {
	readonly route: DocRoute;
	readonly channel: ToolChannel;
	readonly caller: IFrameCaller<GraphOps>;
	readonly guard: IFrameIdentityGuard;
	/** The host's `host:connection`: undefined until the host published it (not yet known is not disconnected). */
	readonly connected: IReadable<boolean | undefined>;
	/** The controller's schema summaries (status, labels, failure), as last published. */
	readonly schemas: IReadable<Record<string, IFrameSchema>>;
	/** Full schema views, fetched from the controller on first use and after every newer load (env.schemaView). */
	readonly schemaView: IKeyed<ISchemaView | null>;
	/** Whether a controller is up to carry this frame's calls (its readiness on the reserved topic). */
	readonly controllerReady: IReadable<boolean>;
	/** Where the summon of a missing controller stands: ready, summoning (the quiet grace), or unanswered. */
	readonly summon: IReadable<SummonState>;
	/** What the controller says about the account: pending (nothing yet), nobody, or signed in. */
	readonly signIn: IReadable<SignInState>;
	/** The REMOTE env (rebuild when `connected` changes). */
	env(ready: boolean): IGraphEnv;
	/** Why the frame last cleared its caches, or null. */
	lastReset(): FrameResetReason | null;
	/** Dispose (idempotent): pending calls are dropped as stale. */
	dispose(): void;
}

/** Preview nonces taken in this realm (shared by its frames, so a StrictMode remount never takes one twice). */
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
			listeners.forEach((listener) => listener());
		},
	};
}

/**
 * A session on one connection whose graph tools are controller ops.
 *
 * @param caller - The frame's caller.
 * @param endpoint - The connection.
 * @param info - Its latest `dialect` answer, from the endpoints state.
 * @returns The session.
 */
export function remoteSession(caller: IFrameCaller<GraphOps>, endpoint: IExplorerEndpoint, info: () => Record<string, unknown> | null): IToolSession {
	const key = endpoint.key;
	const send = <K extends keyof GraphOps & string>(op: K, params: Parameters<IFrameCaller<GraphOps>['callReply']>[1], tool: string, ticket: IGenerationTicket | undefined): Promise<unknown> => {
		const stale = (): ExplorerToolError => new ExplorerToolError({ kind: 'stale', tool, message: `The result of ${tool} was dropped: a newer request replaced it.` });
		return caller.callReply(op, params as never, { timeoutMs: frameTimeoutFor(op, info()) }).then(
			(value) => {
				if (ticket !== undefined && !ticket.isCurrent()) throw stale();
				return value;
			},
			(error: unknown) => {
				if (ticket !== undefined && !ticket.isCurrent()) throw stale();
				// Never sent because no controller became ready (no sidebar yet): say so, not the base's op-naming text,
				// and as `unavailable`, since it cannot have run (the write console then never says "may have applied").
				if (isNotSent(error) && !caller.controllerReady()) throw controllerNotReadyError(tool);
				throw error;
			},
		);
	};
	return {
		endpoint,
		info,
		invoke<T = unknown>(tool: string, input: Record<string, unknown> = {}, opts: IInvokeOptions = {}): Promise<T> {
			const ticket = opts.generation;
			switch (tool) {
				case TOOL.readQuery:
					return send(OP.readQuery, toWire({ key, cypher: input.cypher as string, params: (input.params as Record<string, unknown> | undefined) ?? {}, limit: input.limit as number }), tool, ticket) as Promise<T>;
				case TOOL.execute:
					return send(OP.execute, { key, query: input.query as string }, tool, ticket) as Promise<T>;
				case TOOL.getQuery:
					return send(OP.ask, { key, question: input.question as string }, tool, ticket) as Promise<T>;
				default:
					return Promise.reject(new Error(`A Graph Explorer frame cannot call ${tool}: only read_query, execute and get_query cross to the controller.`));
			}
		},
	};
}

/** The empty history view (stable). */
const NO_HISTORY: IGraphHistoryView = { entries: [], recording: true };

/**
 * Read a history view that crossed the channel.
 *
 * @param value - The op's value.
 * @returns The view.
 */
function asHistoryView(value: unknown): IGraphHistoryView {
	const entries = field(value, 'entries');
	return { entries: Array.isArray(entries) ? (entries as IHistoryEntry<'cypher'>[]) : [], recording: field(value, 'recording') !== false };
}

/** The session-only grid layouts every frame of this window shares (shared/explorer/devtool/gridPersistence). */
const SESSION_GRIDS = createSessionGridPersistence();

/**
 * Mount a Graph Explorer document frame.
 *
 * @param opts - See {@link IGraphFrameOptions}.
 * @returns The frame; dispose it in the mount's cleanup.
 */
export function createGraphFrame(opts: IGraphFrameOptions): IGraphFrame {
	const route = routeDocKey(opts.docKey);
	const docKey = typeof opts.docKey === 'string' ? opts.docKey : '';
	const report = (error: unknown): void => opts.onError?.(error);
	const channel = opts.channel ?? channelFor(opts.peer, opts.createToolChannel);
	const caller = createFrameCaller<GraphOps>({ peer: opts.peer, channel, createToolController: opts.createToolController, createToolChannel: opts.createToolChannel, ...(opts.now ? { now: opts.now } : {}) });
	const offs: Array<() => void> = [];
	let disposed = false;
	let resetWhy: FrameResetReason | null = null;

	// ── Mirrors of the controller's retained state ──────────────────────────────────────────────
	const connected = cell<boolean | undefined>(undefined);
	const endpoints = cell<IGraphEndpointsState>(NO_ENDPOINTS);
	const schemas = cell<Record<string, IFrameSchema>>({});
	const versions = cell<Record<string, number>>({});
	const pending = cell<IGraphPreview | null>(null);
	let historyRev = 0;
	offs.push(channel.onState(HOST_CONNECTION_TOPIC, (snapshot) => {
		const value = field(snapshot, 'connected');
		if (typeof value === 'boolean') connected.set(value);
	}));
	// Each controller mount publishes its own readiness nonce. A NEW one is a controller that has never heard this
	// frame: a remounted controller's channel does not get the last frame event replayed (the replay goes to the op
	// server, which drops events), and in VS Code host:connection comes back before the controller has remounted. So
	// the frame says which document it is once per nonce, which is also once at mount when a controller is up.
	const controllerReady = cell(false);
	let announcedTo: string | null = null;
	offs.push(channel.onState(CONTROLLER_STATE_TOPIC, (snapshot) => {
		const ready = field(snapshot, 'ready');
		const nonce = typeof ready === 'string' && ready !== '' ? ready : null;
		controllerReady.set(nonce !== null);
		if (nonce === null || nonce === announcedTo) return;
		announcedTo = nonce;
		sendActive();
	}));
	// F11: summon a missing controller on purpose (one reserved non-op event, never a call), and follow how that stands.
	const summoner = createControllerSummon({ channel, ...(opts.schedule ? { schedule: opts.schedule } : {}) });
	const summon = cell<SummonState>(summoner.state());
	offs.push(summoner.subscribe((state) => summon.set(state)));
	offs.push(() => summoner.dispose());
	// F12: what the controller says about the account (told 'pending' at once).
	const signIn = cell<SignInState>('pending');
	offs.push(followSignIn(channel, (state) => signIn.set(state)));
	offs.push(channel.onState(STATE.endpoints, (snapshot) => {
		if (Array.isArray(field(snapshot, 'endpoints'))) endpoints.set({ ...NO_ENDPOINTS, ...(snapshot as IGraphEndpointsState) });
	}));
	offs.push(channel.onState(STATE.schemas, (snapshot) => {
		if (snapshot !== null && typeof snapshot === 'object') schemas.set(snapshot as Record<string, IFrameSchema>);
	}));
	offs.push(channel.onState(STATE.dataVersions, (snapshot) => {
		if (snapshot !== null && typeof snapshot === 'object') versions.set(snapshot as Record<string, number>);
	}));
	offs.push(channel.onState(STATE.previews, (snapshot) => pending.set(asPreview(field(snapshot, 'pending')))));

	const infoOf = (key: string): Record<string, unknown> | null => {
		const probe = endpoints.get().probes[key];
		return probe?.ok && probe.info !== null && typeof probe.info === 'object' ? probe.info : null;
	};

	// ── History: a revision in state; each connection's list is an op result ────────────────────
	interface IHistorySlot {
		readable: IReadable<IGraphHistoryView>;
		value: IGraphHistoryView;
		listeners: Set<() => void>;
		fetchedRev: number;
		fetching: boolean;
	}
	const historySlots = new Map<string, IHistorySlot>();
	const fetchHistory = (key: string, slot: IHistorySlot): void => {
		if (slot.fetching || slot.fetchedRev === historyRev || connected.get() !== true) return;
		const rev = historyRev;
		slot.fetching = true;
		caller.callReply(OP.historyList, { key }, { timeoutMs: frameTimeoutFor(OP.historyList) }).then(
			(value) => {
				slot.fetching = false;
				if (disposed) return;
				slot.fetchedRev = rev;
				slot.value = asHistoryView(value);
				slot.listeners.forEach((listener) => listener());
				if (rev !== historyRev && slot.listeners.size > 0) fetchHistory(key, slot);
			},
			(error: unknown) => {
				slot.fetching = false;
				report(error);
			},
		);
	};
	const refetchHistory = (): void => {
		for (const [key, slot] of historySlots) if (slot.listeners.size > 0) fetchHistory(key, slot);
	};
	offs.push(channel.onState(STATE.history, (snapshot) => {
		const rev = field(snapshot, 'rev');
		if (typeof rev !== 'number' || rev === historyRev) return;
		historyRev = rev;
		refetchHistory();
	}));
	offs.push(connected.subscribe(() => refetchHistory()));
	const historySlot = (key: string): IHistorySlot => {
		let slot = historySlots.get(key);
		if (!slot) {
			const created: IHistorySlot = {
				value: NO_HISTORY,
				listeners: new Set(),
				fetchedRev: -1,
				fetching: false,
				readable: {
					get: () => created.value,
					subscribe: (listener) => {
						created.listeners.add(listener);
						fetchHistory(key, created);
						return () => {
							created.listeners.delete(listener);
						};
					},
				},
			};
			slot = created;
			historySlots.set(key, slot);
		}
		return slot;
	};
	// A history change resolves on the controller's Reply (it was applied) and rejects with its reason otherwise.
	const edit = (key: string, change: HistoryEdit): Promise<void> =>
		caller.callReply(OP.historyEdit, toWire({ key, edit: change }), { timeoutMs: frameTimeoutFor(OP.historyEdit) }).then(() => undefined);
	const history: IGraphHistory = {
		view: (key) => historySlot(key).readable,
		record: (key, entry) => {
			edit(key, { action: 'record', entry }).catch(report);
		},
		removeEntry: (key, id) => edit(key, { action: 'remove', id }),
		togglePin: (key, id) => edit(key, { action: 'pin', id }),
		setNote: (key, id, note) => edit(key, { action: 'note', id, note }),
		clearForKey: (key) => edit(key, { action: 'clear' }),
		setRecording: (key, on) => edit(key, { action: 'recording', on }),
	};

	// ── Schema views: the full view of a connection is an op result, read when a load completed ──
	interface IViewSlot {
		value: ISchemaView | null;
		/** The `loadedAt` the value answers for (null: never read). */
		readFor: number | null;
		/** The `loadedAt` a read in flight was sent for (null: none). */
		askedFor: number | null;
		/** The newest read sent: only its answer is used. */
		seq: number;
	}
	const viewSlots = new Map<string, IViewSlot>();
	const viewListeners = new Set<() => void>();
	const notifyViews = (): void => viewListeners.forEach((listener) => listener());
	// A connection whose label names did not fit the summaries still crosses with its loadedAt (protocol.ts
	// schemasSnapshot); one missing altogether makes every new summary a reason to read it again.
	let summaries = 0;
	offs.push(schemas.subscribe(() => (summaries += 1)));
	const loadedAtOf = (key: string): number => {
		const loadedAt = schemas.get()[key]?.loadedAt;
		return typeof loadedAt === 'number' ? loadedAt : -summaries;
	};
	const readView = (key: string, slot: IViewSlot): void => {
		const want = loadedAtOf(key);
		if (slot.readFor === want || slot.askedFor === want || connected.get() !== true || disposed) return;
		slot.seq += 1;
		const seq = slot.seq;
		slot.askedFor = want;
		caller.callReply(OP.schemaView, { key }, { timeoutMs: frameTimeoutFor(OP.schemaView) }).then(
			(value) => {
				if (disposed || viewSlots.get(key) !== slot || seq !== slot.seq) return;
				slot.askedFor = null;
				slot.readFor = want;
				slot.value = value !== null && typeof value === 'object' && Array.isArray((value as ISchemaView).labels) ? (value as ISchemaView) : null;
				notifyViews();
			},
			(error: unknown) => {
				if (viewSlots.get(key) !== slot || seq !== slot.seq) return;
				slot.askedFor = null;
				report(error);
			},
		);
	};
	const readViews = (): void => {
		for (const [key, slot] of viewSlots) readView(key, slot);
	};
	const resetSchemaViews = (): void => {
		for (const slot of viewSlots.values()) {
			slot.value = null;
			slot.readFor = null;
			slot.askedFor = null;
			slot.seq += 1;
		}
		notifyViews();
		readViews();
	};
	const schemaView: IKeyed<ISchemaView | null> = {
		get(key) {
			let slot = viewSlots.get(key);
			if (!slot) {
				const created: IViewSlot = { value: null, readFor: null, askedFor: null, seq: 0 };
				slot = created;
				viewSlots.set(key, created);
				// First use: read it, after the render that asked (an op is never sent from inside a render).
				queueMicrotask(() => readView(key, created));
			}
			return slot.value;
		},
		subscribe(listener) {
			viewListeners.add(listener);
			return () => {
				viewListeners.delete(listener);
			};
		},
	};
	offs.push(schemas.subscribe(readViews));
	offs.push(connected.subscribe(readViews));

	// ── User data: styles and saved queries, the frame's account's, over ops ─────────────────────
	// The account comes from the identity guard below, once it exists (nothing asks for it before then).
	let guardRef: IFrameIdentityGuard | null = null;
	const userData = createRemoteUserData({ caller, channel, owner: () => guardRef?.first() ?? null, connected: () => connected.get() === true });
	offs.push(connected.subscribe(() => userData.retry()));
	offs.push(() => userData.dispose());

	// ── Identity (R9): close on a different fingerprint; clear caches on reset ──────────────────
	const guard = createFrameIdentityGuard({
		channel,
		docKey: opts.docKey ?? null,
		...(opts.documents ? { documents: opts.documents } : {}),
		onReset: (reason) => {
			resetWhy = reason;
			for (const slot of historySlots.values()) {
				slot.value = NO_HISTORY;
				slot.fetchedRev = -1;
				slot.listeners.forEach((listener) => listener());
			}
			refetchHistory();
			resetSchemaViews();
			userData.reset();
		},
	});
	guardRef = guard;


	// ── `active` (R8): the fronted document, the fallback while activeDocKey is undefined ───────
	function sendActive(consumed?: string): void {
		if (disposed) return;
		const payload: IActiveEvent = consumed === undefined ? { docKey } : { docKey, consumed };
		channel.sendEvent(EVENT.active, payload);
	}
	const focusTarget = opts.focusTarget !== undefined ? opts.focusTarget : typeof window !== 'undefined' ? window : null;
	const onFocus = (): void => sendActive();
	focusTarget?.addEventListener('focus', onFocus);
	offs.push(() => focusTarget?.removeEventListener('focus', onFocus));

	// ── Previews: take a request once (realm-wide), and tell the controller it was taken ────────
	const visiblePending: IReadable<IGraphPreview | null> = {
		get: () => {
			const value = pending.get();
			return value !== null && !TAKEN.has(value.nonce) ? value : null;
		},
		subscribe: pending.subscribe,
	};
	const takenListeners = new Set<() => void>();
	const previewReadable: IReadable<IGraphPreview | null> = {
		get: visiblePending.get,
		subscribe: (listener) => {
			const off = visiblePending.subscribe(listener);
			takenListeners.add(listener);
			return () => {
				off();
				takenListeners.delete(listener);
			};
		},
	};

	const frameKey = route.kind === 'workbench' || route.kind === 'write' ? route.key : null;
	const activeConnection: IReadable<string | null> = { get: () => frameKey, subscribe: () => () => undefined };
	const keyed = <T>(source: IReadable<Record<string, T>>, fallback: T): IKeyed<T> => ({ get: (key) => source.get()[key] ?? fallback, subscribe: source.subscribe });
	const labelsSource: IReadable<Record<string, readonly string[]>> = {
		get: () => labelCache(schemas.get()),
		subscribe: schemas.subscribe,
	};
	let labelsFor: { from: Record<string, IFrameSchema>; labels: Record<string, readonly string[]> } | null = null;
	function labelCache(from: Record<string, IFrameSchema>): Record<string, readonly string[]> {
		if (labelsFor && labelsFor.from === from) return labelsFor.labels;
		const labels: Record<string, readonly string[]> = {};
		for (const [key, entry] of Object.entries(from)) labels[key] = Array.isArray(entry?.labels) ? entry.labels : [];
		labelsFor = { from, labels };
		return labels;
	}
	const prefs = memoryPrefs();
	const envs = new Map<boolean, IGraphEnv>();

	const openDocument = (target: DocTarget): void => {
		const documents = opts.documents;
		if (!documents) return;
		if (target.kind === 'connections') documents.open('', 'Graph Explorer');
		else documents.open(docKeyFor(target.kind, target.endpoint.key), target.kind === 'write' ? `${target.endpoint.nodeName || 'Graph'} (write)` : target.endpoint.nodeName || 'Graph');
	};

	return {
		route,
		channel,
		caller,
		guard,
		connected,
		schemas,
		schemaView,
		controllerReady,
		summon,
		signIn,
		lastReset: () => resetWhy,
		env(ready) {
			const cached = envs.get(ready);
			if (cached) return cached;
			const env: IGraphEnv = {
				mount: 'frame',
				ready,
				gridPersistence: SESSION_GRIDS,
				endpoints,
				// An automatic refresh (quiet) says nothing when refused: at mount the controller may still be settling its
				// identity, and the endpoints state says what happened.
				refresh: (o) => caller.callReply(OP.refreshEndpoints, o?.reprobe ? { reprobe: true } : {}, { timeoutMs: frameTimeoutFor(OP.refreshEndpoints) }).then(() => undefined, (error: unknown) => {
					if (!o?.quiet) report(error);
				}),
				// Silent, as the full app's probe: a probe that cannot run is "nothing was tested" (testResultText).
				probe: (key) => caller.callReply(OP.probe, { key }, { timeoutMs: frameTimeoutFor(OP.probe) }).then((value) => value as IProbeResult | null, () => null),
				schemaLabels: keyed(labelsSource, [] as readonly string[]),
				schemas: null,
				schemaView,
				loadSchema: (key, o) => caller.callReply(OP.loadSchema, o?.fresh ? { key, fresh: true } : { key }, { timeoutMs: frameTimeoutFor(OP.loadSchema) }).then(() => undefined, report),
				session: (endpoint) => (ready ? remoteSession(caller, endpoint, () => infoOf(endpoint.key)) : null),
				dataVersions: keyed(versions, 0),
				countWrite: (_key, send) => send(),
				markAbandonedWrite: (key) => {
					caller.callReply(OP.writeAbandoned, { key }, { timeoutMs: frameTimeoutFor(OP.writeAbandoned) }).catch(report);
				},
				history,
				previews: {
					pending: previewReadable,
					request: () => undefined,
					consume: (nonce) => {
						if (TAKEN.has(nonce)) return false;
						remember(nonce);
						sendActive(nonce);
						takenListeners.forEach((listener) => listener());
						return true;
					},
				},
				activeConnection,
				openDocument,
				prefs,
				historyPrivacyNote: DEVTOOL_HISTORY_PRIVACY_NOTE,
				userData,
			};
			envs.set(ready, env);
			return env;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of offs.splice(0)) off();
			guard.dispose();
			caller.dispose();
		},
	};
}
