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
// EXPLORER CONNECT — ENDPOINT STORE (shared discovery state for App + Sidebar)
// =============================================================================
//
// One store per app, made by createEndpointStore and owned by that app. The
// shell mounts an app's App and Sidebar as SIBLINGS, so they cannot share
// React context; this external store is the state both sides subscribe to.
//
// WHAT IT OWNS
//   - the discovered endpoints (token-free, JSON-safe);
//   - the ONE probe result per endpoint (the node's `dialect` answer);
//   - the task-token VAULT: a Map inside this closure, the only place a token
//     lives. Endpoints, probes, snapshots, sessions and keys never contain one,
//     so nothing the store hands out can leak one into a preference, a URL, a
//     log, a copied JSON or a document payload;
//   - the ROLE VAULT beside it: every running role's token of a multi-role
//     connection (Vector's ingest, chat and tools sources). Set by each
//     discovery, cleared with the endpoint's token on the stopped path and on
//     reset, kept for a vanished endpoint; never in any snapshot;
//   - the sessions it opens (`session(client, endpoint)`), which read the
//     token from the vault at call time and never keep it, and the ROLE
//     CHANNELS (`channel(client, endpoint, role)`), which call one role through
//     that role's own token, read from the role vault at call time. Nothing on
//     a channel is ever retried: an upload or a question sent twice would be
//     ingested or answered twice.
//
// READ-ONLY CONNECTIONS
//   A multi-role connection whose tools role is not running is anchored on a
//   read-only role (the spec's `readOnlyAnchors`): its token is that role's,
//   so the probe and the session ride on it, and the endpoint keeps the
//   detail "Read-only: no Tools source is running" while it is ready. A probe
//   of such a card that fails with "not found in pipeline" means the anchor
//   source cannot reach that node: the card is `stopped`, "Not reachable from
//   the <role> source". Like a probe that failed at the node, that answer is
//   kept on refreshes nobody asked for (see "WHEN IT PROBES AGAIN").
//
// A VANISHED ENDPOINT KEEPS ITS TOKEN
//   Discovery lists RUNNING tasks only, so a task that is restarting vanishes
//   from it exactly like one that was stopped. The endpoint is shown `stopped`,
//   but its token (and the node's last `dialect` answer, which the session needs
//   for its capability check and budget) stay until the endpoint is discovered
//   again or the store is reset. A call made meanwhile is still SENT, and that
//   is its first send, not a retry. The server holds it until a restarting
//   task is running again. A task stopped within the last few minutes is still
//   registered and answers TASK_STOPPED, so an idempotent call first gets the
//   session's one bounded re-discovery (up to its retry window, 15 s by
//   default) and then fails with that code; a task that is no longer
//   registered answers TASK_NOT_REGISTERED at once. A call is refused locally
//   (`unavailable`) only for an endpoint whose latest discovery row carried no
//   token or reported it `stopped` (a required role not running): its token is
//   dropped then.
//
// WHEN IT REFRESHES
//   explicitly (`refresh`), on task events (debounced), and on window focus
//   (debounced and rate-limited) — never on an open-ended timer. Concurrent
//   refreshes coalesce: while one is running, any number of triggers produce
//   exactly ONE follow-up. A newer refresh's result is never overwritten by an
//   older one.
//
//   A STARTED TASK IS LOOKED FOR. The engine announces a task's start (`begin`,
//   `restart`) while the task is still loading, and discovery lists running
//   tasks only, so the refresh that event asks for usually comes too early;
//   nothing announces the moment the task runs. While attached, the store
//   therefore remembers each task a start event named (project id and source)
//   and looks again 1, 2, 4 and 8 s after the previous look, then every 15 s,
//   until a discovery lists it, its `end` event arrives, or
//   `startWatchMs` (default 5 min) has passed since its start event; a new
//   start event begins the steps again. Detach and reset forget them. A look
//   is a background refresh: discovery only, plus the probe of an endpoint
//   that is new or came back, so a task nobody uses is not kept awake by it.
//
// WHEN IT PROBES AGAIN
//   A probe is a tool call, and a tool call that reaches a task counts as
//   activity for that task's idle timeout. So an endpoint whose last probe
//   failed AT THE NODE (`unreachable`, `inaccessible`) is probed again only
//   when somebody asked: an explicit `refresh`, a restart or reconnect
//   (`reprobe`), `probe` (Test connection), or a changed token. A refresh
//   nobody asked for (focus, an ordinary task event, a rebind) keeps its last
//   answer. A read-only card whose node the anchor source cannot reach is kept
//   the same way: that answer, too, came from the task. An endpoint whose
//   probe said its task is not running is cheap to
//   ask again (the server refuses before the task) and is probed on any refresh.
//   An endpoint that vanished from discovery is not probed at all: `probe`
//   sends nothing and answers null, and an answer to a probe that was in
//   flight when it vanished is not applied (the card stays `stopped`). It is
//   probed when a discovery lists it again, on any refresh.
//
// WHEN IT FORGETS
//   `reset()` — on sign-out and on a change of user, organization or team —
//   clears endpoints, probes, tokens and sessions and expires every in-flight
//   probe, so a previous session's connections cannot bleed into the next.
// =============================================================================

import { ExplorerToolError, readErrorCode, readErrorMessage } from '../errors';
import { checkObject, isPlainObject } from '../checks';
import type { IGenerationTicket } from '../generation';
import type { IExplorerClient, IExplorerEndpoint, IExplorerIdentity, IProbeResult, IRoleSpec, ISendFile, ITaskRef } from '../types';
import { READ_ONLY_DETAIL, discoverToolEndpoints, mapWithConcurrency } from './discovery';
import type { IDiscoveredEndpoint, NodeFilter } from './discovery';
import { identityFingerprint } from './identity';
import { DEFAULT_TOOL_TIMEOUTS, createToolSession } from './session';
import type { IInvokeOptions, IToolSession, IToolSessionOptions } from './session';

// =============================================================================
// TYPES
// =============================================================================

/** Discovery lifecycle of the endpoint list. */
export type EndpointStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The store's snapshot shape consumed by React. Replaced (never mutated) on every change. */
export interface IEndpointState {
	/** Discovery lifecycle state. */
	status: EndpointStatus;
	/** The endpoints, sorted (pipeline name, node id, key); `stopped` ones are kept so an open workbench can say so. */
	endpoints: IExplorerEndpoint[];
	/** The one probe result per endpoint key (absent until the probe answered or failed). */
	probes: Readonly<Record<string, IProbeResult>>;
	/** Failure detail when status is 'error' (previously discovered endpoints stay visible). */
	error: string | null;
	/** Epoch ms of the last completed discovery (0 = never). */
	refreshedAt: number;
}

/** What a task lifecycle event tells the store. */
export interface ITaskEventInfo {
	/** Re-check endpoints that did not change identity (a restart). */
	reprobe: boolean;
	/** The task a `begin` or `restart` announced, when the event names it: look for it until it runs. */
	started?: ITaskRef;
	/** The task an `end` announced, when the event names it: stop looking for it. */
	ended?: ITaskRef;
}

/** What woke the store up. */
export interface IWatchHandlers {
	/** A task event arrived (see {@link ITaskEventInfo}). */
	onTaskEvent(info: ITaskEventInfo): void;
	/** The window regained focus. */
	onFocus(): void;
	/** The identity changed or was cleared (sign-out). */
	onIdentity(identity: IExplorerIdentity | null): void;
	/** The connection came back after a drop (events were missed). */
	onReconnect(): void;
}

/** Subscribes to whatever wakes the store; returns the unsubscribe function. */
export type EndpointWatch = (handlers: IWatchHandlers) => () => void;

/** Timer and clock seams (injected for tests). */
export interface IStoreClock {
	/** Epoch ms. */
	now(): number;
	/** Schedule a callback. */
	setTimer(fn: () => void, ms: number): unknown;
	/** Cancel a timer. */
	clearTimer(handle: unknown): void;
}

/** What distinguishes one app's endpoint store. */
export interface IEndpointStoreOptions {
	/** Component provider ids that are tool nodes for this app. */
	providers: ReadonlySet<string>;
	/** The role map a connection is made of. */
	roles: IRoleSpec;
	/** Per-tool specs for the sessions this store opens (and for the probe's `dialect` call). */
	tools: IToolSessionOptions['tools'];
	/** Other session options (budgets, retry rule). */
	session?: Omit<IToolSessionOptions, 'tools'>;
	/** The one-per-endpoint probe (default: the `dialect` tool). */
	probe?: (session: IToolSession) => Promise<IProbeResult>;
	/**
	 * While this returns true, a refresh lists endpoints (discovery reads only)
	 * but sends NO probe: a probe is a tool call, and a tool call that reaches a
	 * task keeps it alive. An endpoint left unprobed stays `probing` and is
	 * probed by the first refresh made after this returns false. Default: never held.
	 */
	holdProbes?: () => boolean;
	/** Maximum concurrent probes and pipeline fallbacks (default 4). */
	concurrency?: number;
	/** Task events are coalesced into one refresh after this quiet period (default 300 ms). */
	debounceMs?: number;
	/** A focus-triggered refresh is skipped within this long of the last one (default 5 s). */
	focusMinIntervalMs?: number;
	/**
	 * How long one discovery may take before the refresh gives up and reports
	 * status `error` (default 30 s). Without a bound, a server that never
	 * answers would keep the refresh, and every refresh coalesced into it,
	 * waiting forever.
	 */
	discoveryTimeoutMs?: number;
	/**
	 * How long after a start event the store keeps looking for the started
	 * task (default {@link DEFAULT_START_WATCH_MS}; see "WHEN IT REFRESHES").
	 */
	startWatchMs?: number;
	/** Clock and timers (default: real). */
	clock?: IStoreClock;
	/**
	 * Which matching components of a group become endpoints (default: all);
	 * passed to discovery (see `IDiscoveryOptions.nodeFilter`).
	 */
	nodeFilter?: NodeFilter;
}

/**
 * How long `IRoleChannel.ask` waits for an answer when the caller names no
 * timeout (120 s, Vector Explorer's chat wait). Pass `timeoutMs: null` to wait
 * without a bound.
 */
export const DEFAULT_ASK_TIMEOUT_MS = 120_000;

/**
 * How long the store keeps looking for a task after its start event (5 min):
 * longer than a first start that loads an embedding model (about 90 s on a
 * laptop), short enough that a start it can never see costs a bounded number
 * of task listings.
 */
export const DEFAULT_START_WATCH_MS = 300_000;

/** The waits between looks for a started task; the last one repeats. */
const START_LOOK_STEPS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

/**
 * One role of a multi-role connection (Vector Explorer: ingest, chat, tools),
 * called through that role's own task token, which never leaves the store and
 * is read at call time. Nothing on a channel is retried. Every failure is an
 * {@link ExplorerToolError}: `unavailable` when the store holds no token for
 * the role (not running, not in the spec, stopped, or after a reset), `upgrade`
 * when the client cannot upload or chat, `raised` for what the SDK threw (with
 * its `code`), `malformed`, `timeout` and `stale` as for sessions.
 */
export interface IRoleChannel {
	/** The role name. */
	readonly role: string;
	/** Whether the store holds a token for the role right now (a running source fills it, or filled it before the pipeline vanished). */
	readonly bound: boolean;
	/**
	 * Upload files through the role's data lane (`client.sendFiles`). Resolves
	 * with one plain record per file, in order: a copy of the SDK's upload
	 * result, or `{ action: 'error', filepath, error }` when none came back.
	 * Not bounded by a client timeout, by design: a large upload legitimately
	 * takes long, and the SDK reports its progress through its own events.
	 */
	sendFiles(files: ISendFile[], opts?: { maxConcurrent?: number }): Promise<Array<Record<string, unknown>>>;
	/**
	 * Ask the role's source a question (`client.chat`). `timeoutMs` bounds the
	 * wait (default {@link DEFAULT_ASK_TIMEOUT_MS}; `null` waits without a
	 * bound); an expired `generation` drops the answer as `stale`. Stream
	 * events reach `onSSE` only while the question is pending and its
	 * generation is current: those of a question that timed out, was replaced
	 * or already settled are dropped.
	 */
	ask(question: unknown, opts?: { onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>; timeoutMs?: number | null; generation?: IGenerationTicket }): Promise<Record<string, unknown>>;
	/** Call a node tool through the role's token; `opts.nodeId` is required. Same checks and budgets as a session, never retried. */
	invoke<T = unknown>(tool: string, input?: Record<string, unknown>, opts?: IInvokeOptions): Promise<T>;
}

/** One app's endpoint store. */
export interface IEndpointStore {
	/** The current snapshot (stable until the next change). */
	getState(): IEndpointState;
	/** Subscribe to changes (useSyncExternalStore-compatible). */
	subscribe(listener: () => void): () => void;
	/**
	 * Discover (and probe) now. Concurrent calls coalesce: one runs, and a call
	 * made while it runs causes exactly one follow-up. This is the refresh a
	 * person asked for, so endpoints whose last probe failed are probed again
	 * (the store's own background refreshes do not; see "WHEN IT PROBES AGAIN").
	 */
	refresh(client: IExplorerClient, opts?: { reprobe?: boolean }): Promise<void>;
	/**
	 * Probe one endpoint again now (the drawer's "Test connection").
	 *
	 * @returns The result, or null when nothing was tested: the endpoint is
	 *   unknown, has no token, is no longer listed by discovery (its pipeline
	 *   stopped or is restarting; nothing is sent), or a check of it is already
	 *   running. Also null when the pipeline left the list or the store was
	 *   reset before the node answered: that answer is not applied.
	 */
	probe(client: IExplorerClient, endpointKey: string): Promise<IProbeResult | null>;
	/**
	 * Start reacting to task events, focus and identity changes. Returns the
	 * detach function (also cancels pending timers).
	 */
	attach(client: IExplorerClient, identity: IExplorerIdentity | null, watch?: EndpointWatch): () => void;
	/** Forget everything (sign-out, user/org/team change). */
	reset(): void;
	/** Open a session on an endpoint. The token never leaves the store. */
	session(client: IExplorerClient, endpoint: IExplorerEndpoint): IToolSession;
	/**
	 * A channel on one role of an endpoint's connection. Its calls reject with
	 * `ExplorerToolError{kind:'unavailable'}` while the role is not bound; the
	 * token is read at call time, so a channel made before the role's source
	 * started works once it runs. The same channel is handed out for the same
	 * endpoint key, role and client until `reset()`, so it may be kept for the
	 * life of a card (and is stable as a React dependency).
	 */
	channel(client: IExplorerClient, endpoint: IExplorerEndpoint, role: string): IRoleChannel;
}

// =============================================================================
// DEFAULT PROBE
// =============================================================================

/**
 * The default probe: one `dialect` call.
 *
 * @param session - A session on the endpoint (the store opens it with retry off).
 * @returns The result; failures come back as `ok: false`, never thrown.
 */
async function dialectProbe(session: IToolSession): Promise<IProbeResult> {
	try {
		const info = await session.invoke<Record<string, unknown>>('dialect', {}, { retry: false });
		return { ok: true, info, dialect: typeof info.dialect === 'string' ? info.dialect : null };
	} catch (error) {
		if (error instanceof ExplorerToolError) {
			return { ok: false, info: null, dialect: null, error: { kind: error.kind, message: error.message, ...(error.code ? { code: error.code } : {}) } };
		}
		return { ok: false, info: null, dialect: null, error: { kind: 'raised', message: error instanceof Error ? error.message : String(error) } };
	}
}

/** Codes that mean "this task is not running" (not "the node is broken"). */
const NOT_RUNNING_CODES: ReadonlySet<string> = new Set(['TASK_NOT_REGISTERED', 'TASK_COMPLETED', 'TASK_STOPPED']);

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create an endpoint store.
 *
 * @param options - Providers, role map, tool specs and tuning.
 * @returns The store.
 */
export function createEndpointStore(options: IEndpointStoreOptions): IEndpointStore {
	const concurrency = options.concurrency ?? 4;
	const debounceMs = options.debounceMs ?? 300;
	const focusMinIntervalMs = options.focusMinIntervalMs ?? 5_000;
	const discoveryTimeoutMs = options.discoveryTimeoutMs ?? 30_000;
	const startWatchMs = options.startWatchMs ?? DEFAULT_START_WATCH_MS;
	const clock: IStoreClock = options.clock ?? {
		now: () => Date.now(),
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	const probeFn = options.probe ?? dialectProbe;
	// Shared defaults for the probe's own `dialect` call, overridable per app.
	const tools: IToolSessionOptions['tools'] = {
		dialect: { idempotent: true, check: checkObject, timeoutMs: DEFAULT_TOOL_TIMEOUTS.dialect },
		...options.tools,
	};
	const sessionOptions: IToolSessionOptions = { ...(options.session ?? {}), tools };

	// ── State ─────────────────────────────────────────────────────────────────

	let state: IEndpointState = { status: 'idle', endpoints: [], probes: {}, error: null, refreshedAt: 0 };
	const listeners = new Set<() => void>();

	/** THE VAULT: the only place a task token lives. */
	const vault = new Map<string, string>();
	/** THE ROLE VAULT: endpoint key -> role -> that role's task token (running roles only). */
	const roleVault = new Map<string, Readonly<Record<string, string>>>();
	/** Whether the identity could tell a caller may invoke tools (hint, per endpoint key). */
	const callHints = new Map<string, boolean | undefined>();
	/** Sessions already opened, by endpoint key and client. */
	const sessions = new Map<string, { client: IExplorerClient; session: IToolSession }>();
	/** Role channels already handed out: endpoint key -> role -> the channel and its client. */
	const channels = new Map<string, Map<string, { client: IExplorerClient; channel: IRoleChannel }>>();
	/**
	 * The last good `dialect` answer of an endpoint that vanished from discovery
	 * while its token is kept (see "A VANISHED ENDPOINT KEEPS ITS TOKEN"). Read by
	 * sessions only; never published. A good answer to a probe that was in flight
	 * when the endpoint vanished replaces it. Cleared when a probe of the listed
	 * endpoint reports again, when it is discovered without a usable token, and
	 * on reset.
	 */
	const keptInfo = new Map<string, Record<string, unknown>>();
	/**
	 * Keys listed only because they vanished from the latest discovery. Such an
	 * endpoint is not probed: `probe` sends nothing for it, and a probe answer
	 * that arrives after it vanished is not applied (see "WHEN IT PROBES AGAIN").
	 */
	const vanished = new Set<string>();

	/** Bumped by reset(): anything in flight that started before it is dropped on arrival. */
	let resetCount = 0;
	/** Endpoint keys with a probe running, so a second refresh never starts a duplicate. */
	const probing = new Set<string>();
	let identityFingerprintNow: string | null = null;
	let identityNow: IExplorerIdentity | null = null;

	let inFlight: Promise<void> | null = null;
	let followUp: { reprobe: boolean; background: boolean } | null = null;
	let debounceTimer: unknown = null;
	let pendingDebounce: { client: IExplorerClient; reprobe: boolean } | null = null;
	let lastRefreshStartedAt = 0;
	let attachedClient: IExplorerClient | null = null;
	/**
	 * Tasks a start event named that no discovery has listed yet: task ref key
	 * -> give up at (epoch ms). See "A STARTED TASK IS LOOKED FOR".
	 */
	const awaitingStart = new Map<string, number>();
	let startLookTimer: unknown = null;
	/** Index into START_LOOK_STEPS_MS of the next wait. */
	let startLookStep = 0;

	/**
	 * Replace the snapshot and notify.
	 *
	 * @param next - The new snapshot.
	 */
	function setState(next: IEndpointState): void {
		state = next;
		listeners.forEach((listener) => listener());
	}

	/**
	 * Sort endpoints the way the landing grid shows them.
	 *
	 * @param endpoints - The endpoints.
	 * @returns A new sorted array.
	 */
	function sorted(endpoints: IExplorerEndpoint[]): IExplorerEndpoint[] {
		return [...endpoints].sort((a, b) => a.pipelineName.localeCompare(b.pipelineName) || a.nodeId.localeCompare(b.nodeId) || a.key.localeCompare(b.key));
	}

	/**
	 * Replace one endpoint's fields (state, detail) and publish.
	 *
	 * @param key - The endpoint key.
	 * @param patch - Fields to change.
	 * @param probe - The probe result to record (undefined leaves it alone, null removes it).
	 */
	function patchEndpoint(key: string, patch: Partial<IExplorerEndpoint>, probe?: IProbeResult | null): void {
		const index = state.endpoints.findIndex((endpoint) => endpoint.key === key);
		if (index < 0) return;
		const endpoints = state.endpoints.slice();
		const next: IExplorerEndpoint = { ...(endpoints[index] as IExplorerEndpoint), ...patch };
		if (patch.stateDetail === undefined && 'stateDetail' in patch) delete next.stateDetail;
		next.running = next.state === 'probing' || next.state === 'ready';
		endpoints[index] = next;
		let probes = state.probes;
		if (probe !== undefined) {
			const copy: Record<string, IProbeResult> = { ...probes };
			if (probe === null) delete copy[key];
			else copy[key] = probe;
			probes = copy;
		}
		setState({ ...state, endpoints, probes });
	}

	// ── Probing ───────────────────────────────────────────────────────────────

	/**
	 * Open a session whose retry is off, for a probe.
	 *
	 * @param client - The client.
	 * @param endpoint - The endpoint.
	 * @returns The session.
	 */
	function probeSession(client: IExplorerClient, endpoint: IExplorerEndpoint): IToolSession {
		return createToolSession(client, endpoint, sessionDeps(client, endpoint), sessionOptions);
	}

	/**
	 * Whether a failed probe of a read-only card says the anchor source cannot
	 * reach the node. The engine raises this as a plain error with no code
	 * (packages/ai/src/ai/modules/data/data_conn.py, `Node "<id>" not found in
	 * pipeline`), so its text is the only signal; a change of that wording
	 * turns these cards `unreachable` instead.
	 *
	 * @param endpoint - The endpoint.
	 * @param result - What its probe returned.
	 * @returns True when the node is not reachable from the anchor source.
	 */
	function notReachableFromAnchor(endpoint: IExplorerEndpoint, result: IProbeResult | undefined): boolean {
		return endpoint.readOnly === true && result !== undefined && !result.ok && result.error !== undefined && /not found in pipeline/i.test(result.error.message);
	}

	/**
	 * Decide an endpoint's state from a probe result.
	 *
	 * @param endpoint - The endpoint.
	 * @param result - What the probe returned.
	 * @returns The state and a safe explanation.
	 */
	function classify(endpoint: IExplorerEndpoint, result: IProbeResult): { state: IExplorerEndpoint['state']; detail?: string } {
		if (result.ok) return endpoint.readOnly === true ? { state: 'ready', detail: READ_ONLY_DETAIL } : { state: 'ready' };
		const error = result.error;
		if (notReachableFromAnchor(endpoint, result)) {
			// The anchor source cannot reach this node (a read-only card can list a store it does not feed).
			return { state: 'stopped', detail: `Not reachable from the ${endpoint.anchorRole ?? 'anchor'} source` };
		}
		if (error !== undefined && error.code !== undefined && NOT_RUNNING_CODES.has(error.code)) {
			return { state: 'stopped', detail: 'The task is not running (it may be restarting). It will be checked again when it starts.' };
		}
		if (error !== undefined && error.kind === 'unavailable') return { state: 'stopped', detail: error.message };
		if (callHints.get(endpoint.key) === false) {
			return { state: 'inaccessible', detail: 'Your role cannot call this deployment (it needs task.data; you can see it with task.monitor).' };
		}
		return { state: 'unreachable', detail: error?.message };
	}

	/**
	 * Probe one endpoint and publish the outcome, unless the store was reset or
	 * the endpoint's token changed meanwhile (a stale probe must not describe a
	 * different task).
	 *
	 * @param client - The client.
	 * @param endpoint - The endpoint.
	 * @returns The result, or null when it was dropped.
	 */
	async function runProbe(client: IExplorerClient, endpoint: IExplorerEndpoint): Promise<IProbeResult | null> {
		if (probing.has(endpoint.key)) return null;
		probing.add(endpoint.key);
		const startedReset = resetCount;
		const tokenAtStart = vault.get(endpoint.key);
		try {
			const result = await probeFn(probeSession(client, endpoint)).catch((error: unknown): IProbeResult => ({
				ok: false, info: null, dialect: null, error: { kind: 'raised', message: error instanceof Error ? error.message : String(error) },
			}));
			if (epochAfterReset(startedReset) || vault.get(endpoint.key) !== tokenAtStart) return null;
			if (vanished.has(endpoint.key)) {
				// The pipeline left the list while the node answered. The card stays
				// `stopped` and is probed when discovery lists it again; a good answer
				// from the same token still serves the session meanwhile.
				if (result.ok && isPlainObject(result.info)) keptInfo.set(endpoint.key, result.info);
				return null;
			}
			keptInfo.delete(endpoint.key);
			const outcome = classify(endpoint, result);
			patchEndpoint(endpoint.key, { state: outcome.state, stateDetail: outcome.detail }, result);
			return result;
		} finally {
			// reset() already cleared the marker; one there now belongs to a probe
			// the next identity started, which this one must not unmark.
			if (!epochAfterReset(startedReset)) probing.delete(endpoint.key);
		}
	}

	/**
	 * Whether a reset happened since a probe began.
	 *
	 * @param startedAt - The reset counter when it began.
	 * @returns True if the store was reset in between.
	 */
	function epochAfterReset(startedAt: number): boolean {
		return startedAt !== resetCount;
	}

	// ── Sessions ──────────────────────────────────────────────────────────────

	/**
	 * What a session needs from this store.
	 *
	 * @param client - The client.
	 * @param endpoint - The endpoint.
	 * @returns The seams.
	 */
	function sessionDeps(client: IExplorerClient, endpoint: IExplorerEndpoint) {
		return {
			token: () => vault.get(endpoint.key),
			info: () => {
				const probe = state.probes[endpoint.key];
				return probe?.ok ? probe.info : keptInfo.get(endpoint.key) ?? null;
			},
			rebind: (deadlineAt: number) => rebind(client, endpoint.key, deadlineAt),
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		};
	}

	/**
	 * Re-discover until the SAME endpoint key is running again, or give up.
	 *
	 * @param client - The client.
	 * @param key - The endpoint key that must come back.
	 * @param deadlineAt - Give up at this epoch ms.
	 * @returns True when the endpoint is running again (the vault holds its current token).
	 */
	async function rebind(client: IExplorerClient, key: string, deadlineAt: number): Promise<boolean> {
		const pollMs = options.session?.retry?.pollMs ?? 1_000;
		for (;;) {
			await refresh(client, { awaitProbes: false, background: true });
			const endpoint = state.endpoints.find((candidate) => candidate.key === key);
			if (endpoint !== undefined && endpoint.state !== 'stopped' && vault.has(key)) return true;
			if (clock.now() + pollMs > deadlineAt) return false;
			await new Promise<void>((resolve) => { clock.setTimer(resolve, pollMs); });
		}
	}

	function session(client: IExplorerClient, endpoint: IExplorerEndpoint): IToolSession {
		const cached = sessions.get(endpoint.key);
		if (cached && cached.client === client) return cached.session;
		const created = createToolSession(client, endpoint, sessionDeps(client, endpoint), sessionOptions);
		sessions.set(endpoint.key, { client, session: created });
		return created;
	}

	// ── Role channels ─────────────────────────────────────────────────────────

	function channel(client: IExplorerClient, endpoint: IExplorerEndpoint, role: string): IRoleChannel {
		let byRole = channels.get(endpoint.key);
		const cached = byRole?.get(role);
		if (cached && cached.client === client) return cached.channel;
		const created = createChannel(client, endpoint, role);
		if (byRole === undefined) {
			byRole = new Map();
			channels.set(endpoint.key, byRole);
		}
		byRole.set(role, { client, channel: created });
		return created;
	}

	/**
	 * Build a role channel (see {@link IRoleChannel}).
	 *
	 * @param client - The client.
	 * @param endpoint - The endpoint.
	 * @param role - The role.
	 * @returns The channel.
	 */
	function createChannel(client: IExplorerClient, endpoint: IExplorerEndpoint, role: string): IRoleChannel {
		const known = Object.prototype.hasOwnProperty.call(options.roles.roles, role);
		/**
		 * The role's token now, or undefined.
		 *
		 * @returns The token.
		 */
		const roleToken = (): string | undefined => {
			const token = known ? roleVault.get(endpoint.key)?.[role] : undefined;
			return typeof token === 'string' && token !== '' ? token : undefined;
		};
		/**
		 * The role's token, or the `unavailable` error that says why there is none.
		 *
		 * @param tool - The operation, for the error.
		 * @returns The token.
		 */
		const requireToken = (tool: string): string => {
			const token = roleToken();
			if (token !== undefined) return token;
			const message = known
				? `No running ${role} source for pipeline '${endpoint.pipelineName}'. Start it and retry.`
				: `This connection has no '${role}' role.`;
			throw new ExplorerToolError({ kind: 'unavailable', tool, message });
		};
		/**
		 * Map anything the client threw onto the one error class (never retried).
		 *
		 * @param tool - The operation.
		 * @param error - What was thrown.
		 * @returns The error.
		 */
		const raised = (tool: string, error: unknown): ExplorerToolError => (error instanceof ExplorerToolError
			? error
			: new ExplorerToolError({ kind: 'raised', tool, message: readErrorMessage(error), code: readErrorCode(error) }));

		// Tool calls: a session over the role's token with no rebind seam (so no retry).
		const roleSession = createToolSession(client, endpoint, {
			token: roleToken,
			info: sessionDeps(client, endpoint).info,
			now: clock.now,
			setTimer: clock.setTimer,
			clearTimer: clock.clearTimer,
		}, sessionOptions);

		async function sendFiles(files: ISendFile[], opts: { maxConcurrent?: number } = {}): Promise<Array<Record<string, unknown>>> {
			const tool = 'sendFiles';
			const token = requireToken(tool);
			if (typeof client.sendFiles !== 'function') {
				throw new ExplorerToolError({ kind: 'upgrade', tool, message: 'This client cannot upload files.' });
			}
			if (!Array.isArray(files)) throw new ExplorerToolError({ kind: 'malformed', tool, message: 'sendFiles needs a list of files' });
			let results: unknown;
			try {
				results = await client.sendFiles(files, token, opts.maxConcurrent);
			} catch (error) {
				throw raised(tool, error);
			}
			if (!Array.isArray(results)) throw new ExplorerToolError({ kind: 'malformed', tool, message: 'The upload answered with something other than a list of results.' });
			// The SDK's UPLOAD_RESULT has no index signature: copy each into a plain record.
			return files.map((sent, index) => {
				const result: unknown = results[index];
				if (isPlainObject(result)) return { ...result };
				return { action: 'error', filepath: sent?.file?.name ?? '', error: 'No upload result came back for this file.' };
			});
		}

		async function ask(question: unknown, opts: { onSSE?: (type: string, data: Record<string, unknown>) => Promise<void>; timeoutMs?: number | null; generation?: IGenerationTicket } = {}): Promise<Record<string, unknown>> {
			const tool = 'chat';
			const token = requireToken(tool);
			if (typeof client.chat !== 'function') {
				throw new ExplorerToolError({ kind: 'upgrade', tool, message: 'This client cannot ask questions.' });
			}
			const ticket = opts.generation;
			const dropIfStale = (): void => {
				if (ticket !== undefined && !ticket.isCurrent()) {
					throw new ExplorerToolError({ kind: 'stale', tool, message: 'The answer was dropped: a newer question replaced it.' });
				}
			};
			const waitMs = opts.timeoutMs === undefined ? DEFAULT_ASK_TIMEOUT_MS : opts.timeoutMs;
			// Stream events count only while this question is pending and current:
			// nothing can cancel it, so a dropped question's stream is dropped here.
			let pending = true;
			const appSSE = opts.onSSE;
			const onSSE = appSSE === undefined ? undefined : async (type: string, data: Record<string, unknown>): Promise<void> => {
				if (!pending || (ticket !== undefined && !ticket.isCurrent())) return;
				await appSSE(type, data);
			};
			let value: unknown;
			try {
				const call = client.chat({ token, question, ...(onSSE !== undefined ? { onSSE } : {}) });
				value = waitMs === null ? await call : await new Promise<unknown>((resolve, reject) => {
					const timer = clock.setTimer(() => {
						pending = false;
						call.catch(() => undefined);
						reject(new ExplorerToolError({
							kind: 'timeout',
							tool,
							message: `Stopped waiting for the answer after ${Math.round(waitMs / 1000)} s. The pipeline may still be answering; there is no way to cancel it from here.`,
						}));
					}, waitMs);
					call.then(
						(answer) => { clock.clearTimer(timer); resolve(answer); },
						(error: unknown) => { clock.clearTimer(timer); reject(error); },
					);
				});
			} catch (error) {
				dropIfStale();
				throw raised(tool, error);
			} finally {
				pending = false;
			}
			dropIfStale();
			if (!isPlainObject(value)) throw new ExplorerToolError({ kind: 'malformed', tool, message: 'The chat answer is not an object.' });
			return value;
		}

		async function invoke<T = unknown>(tool: string, input: Record<string, unknown> = {}, opts: IInvokeOptions = {}): Promise<T> {
			if (typeof opts.nodeId !== 'string' || opts.nodeId === '') {
				throw new ExplorerToolError({ kind: 'malformed', tool, message: `${tool} on the ${role} channel needs the target node id` });
			}
			requireToken(tool);
			return roleSession.invoke<T>(tool, input, { ...opts, retry: false });
		}

		return {
			role,
			get bound(): boolean {
				return roleToken() !== undefined;
			},
			sendFiles,
			ask,
			invoke,
		};
	}

	// ── Refresh ───────────────────────────────────────────────────────────────

	/**
	 * Fold a fresh discovery into the store.
	 *
	 * Endpoints that disappeared are KEPT, marked `stopped` (the badge a
	 * workbench needs), with their token and last good `dialect` answer kept
	 * for calls (a restarting task vanishes too); endpoints that reappeared or
	 * are new get probed; endpoints already ready keep their probe unless
	 * `reprobe` is set; endpoints whose last probe failed are probed again.
	 *
	 * @param found - What discovery returned.
	 * @param reprobe - Re-check endpoints that were already ready.
	 * @param background - Nobody asked for this refresh: keep the answer of an
	 *   endpoint whose probe failed at the node (see "WHEN IT PROBES AGAIN").
	 * @returns The endpoints that need a probe.
	 */
	function merge(found: IDiscoveredEndpoint[], reprobe: boolean, background: boolean): IExplorerEndpoint[] {
		const previous = new Map(state.endpoints.map((endpoint) => [endpoint.key, endpoint]));
		const next: IExplorerEndpoint[] = [];
		const probes: Record<string, IProbeResult> = { ...state.probes };
		const toProbe: IExplorerEndpoint[] = [];
		const live = new Set<string>();

		for (const { endpoint, token, callHint, roleTokens } of found) {
			live.add(endpoint.key);
			vanished.delete(endpoint.key);
			callHints.set(endpoint.key, callHint);
			const before = previous.get(endpoint.key);
			const tokenChanged = vault.get(endpoint.key) !== (token ?? undefined);
			if (token !== null) vault.set(endpoint.key, token);
			else {
				vault.delete(endpoint.key);
				keptInfo.delete(endpoint.key);
			}
			roleVault.set(endpoint.key, { ...roleTokens });

			if (endpoint.state === 'stopped') {
				// A required role is not running: nothing to probe, nothing to call.
				vault.delete(endpoint.key);
				roleVault.delete(endpoint.key);
				keptInfo.delete(endpoint.key);
				delete probes[endpoint.key];
				next.push(endpoint);
				continue;
			}
			const wasReady = before !== undefined && before.state === 'ready' && probes[endpoint.key]?.ok === true;
			if (wasReady && !reprobe && !tokenChanged) {
				// Probed once, unchanged: keep the result, take any fresher descriptive fields.
				next.push({ ...endpoint, state: 'ready', running: true });
				continue;
			}
			const lastProbe = probes[endpoint.key];
			const failedAtNode = before !== undefined && lastProbe?.ok === false
				&& (before.state === 'unreachable' || before.state === 'inaccessible' || (before.state === 'stopped' && notReachableFromAnchor(before, lastProbe)));
			if (failedAtNode && background && !reprobe && !tokenChanged) {
				// Nobody asked: keep the last answer rather than call the node again.
				const kept: IExplorerEndpoint = { ...endpoint, state: before.state, running: false };
				if (before.stateDetail !== undefined) kept.stateDetail = before.stateDetail;
				next.push(kept);
				continue;
			}
			delete probes[endpoint.key];
			next.push(endpoint);
			toProbe.push(endpoint);
		}

		for (const [key, endpoint] of previous) {
			if (live.has(key)) continue;
			vanished.add(key);
			// The token stays in the vault (see "A VANISHED ENDPOINT KEEPS ITS
			// TOKEN"), with the node's last good answer for the session.
			const lastProbe = probes[key];
			if (vault.has(key) && lastProbe?.ok === true && isPlainObject(lastProbe.info)) keptInfo.set(key, lastProbe.info);
			callHints.delete(key);
			delete probes[key];
			next.push(endpoint.state === 'stopped' ? endpoint : { ...endpoint, state: 'stopped', running: false, stateDetail: 'This pipeline is no longer running.' });
		}

		setState({ ...state, endpoints: sorted(next), probes });
		return toProbe;
	}

	/**
	 * Run discovery, bounded by the discovery timeout. A late answer (or late
	 * failure) after the timeout is dropped.
	 *
	 * @param client - The client.
	 * @returns What discovery found, and the tasks it saw running (token-free).
	 */
	function boundedDiscovery(client: IExplorerClient): Promise<{ found: IDiscoveredEndpoint[]; running: readonly ITaskRef[] }> {
		let running: readonly ITaskRef[] = [];
		const discovery = discoverToolEndpoints(client, {
			providers: options.providers,
			roles: options.roles,
			identity: identityNow,
			concurrency,
			...(options.nodeFilter !== undefined ? { nodeFilter: options.nodeFilter } : {}),
			onRunning: (tasks) => { running = tasks; },
		});
		return new Promise((resolve, reject) => {
			const timer = clock.setTimer(() => {
				discovery.catch(() => undefined);
				reject(new Error(`The server did not answer within ${Math.round(discoveryTimeoutMs / 1000)} s with the list of running pipelines. Refresh to try again.`));
			}, discoveryTimeoutMs);
			discovery.then(
				(found) => { clock.clearTimer(timer); resolve({ found, running }); },
				(error: unknown) => { clock.clearTimer(timer); reject(error); },
			);
		});
	}

	async function refresh(client: IExplorerClient, opts: { reprobe?: boolean; awaitProbes?: boolean; background?: boolean } = {}): Promise<void> {
		if (inFlight !== null) {
			// Coalesce: any number of triggers while one runs cause ONE follow-up,
			// which counts as asked for when any of them was.
			followUp = {
				reprobe: (followUp?.reprobe ?? false) || opts.reprobe === true,
				background: (followUp?.background ?? true) && opts.background === true,
			};
			return inFlight;
		}
		const startedEpoch = resetCount;
		lastRefreshStartedAt = clock.now();
		setState({ ...state, status: 'loading', error: null });

		const run = (async (): Promise<void> => {
			try {
				const { found, running } = await boundedDiscovery(client);
				if (epochAfterReset(startedEpoch)) return;
				const toProbe = merge(found, opts.reprobe === true, opts.background === true);
				setState({ ...state, status: 'ready', error: null, refreshedAt: clock.now() });
				noteRunning(running);
				const probes = options.holdProbes?.() === true
					? Promise.resolve([])
					: mapWithConcurrency(toProbe, concurrency, (endpoint) => runProbe(client, endpoint));
				// A re-discovery done to rebind a restarted endpoint must not wait on
				// the probes it started; everything else resolves with final states.
				if (opts.awaitProbes === false) void probes;
				else await probes;
			} catch (error) {
				if (epochAfterReset(startedEpoch)) return;
				setState({ ...state, status: 'error', error: error instanceof Error ? error.message : String(error) });
				// A failed listing says nothing about a started task: keep looking, within its window.
				noteRunning([]);
			}
		})();
		inFlight = run;
		try {
			await run;
		} finally {
			// After a reset, `inFlight` may already be a refresh the next identity
			// started; only this run's own marker is cleared.
			if (inFlight === run) inFlight = null;
		}
		// reset() dropped this run's follow-up already. A follow-up queued since
		// belongs to the next identity's refresh, which runs it: leave it alone.
		if (epochAfterReset(startedEpoch)) return;
		if (followUp !== null) {
			const next = followUp;
			followUp = null;
			await refresh(client, next);
		}
	}

	async function probe(client: IExplorerClient, endpointKey: string): Promise<IProbeResult | null> {
		const endpoint = state.endpoints.find((candidate) => candidate.key === endpointKey);
		if (endpoint === undefined || vanished.has(endpointKey) || !vault.has(endpointKey)) return null;
		patchEndpoint(endpointKey, { state: 'probing', stateDetail: endpoint.readOnly === true ? READ_ONLY_DETAIL : undefined }, null);
		return runProbe(client, endpoint);
	}

	// ── Triggers ──────────────────────────────────────────────────────────────

	/** Cancel a pending debounced refresh. */
	function cancelDebounce(): void {
		if (debounceTimer !== null) {
			clock.clearTimer(debounceTimer);
			debounceTimer = null;
		}
		pendingDebounce = null;
	}

	/**
	 * Queue a refresh after a quiet period; triggers inside the period merge.
	 *
	 * @param client - The client.
	 * @param reprobe - Whether this trigger asks for a re-probe.
	 */
	function scheduleRefresh(client: IExplorerClient, reprobe: boolean): void {
		pendingDebounce = { client, reprobe: (pendingDebounce?.reprobe ?? false) || reprobe };
		if (debounceTimer !== null) return;
		debounceTimer = clock.setTimer(() => {
			debounceTimer = null;
			const job = pendingDebounce;
			pendingDebounce = null;
			if (job !== null) void refresh(job.client, { reprobe: job.reprobe, background: true });
		}, debounceMs);
	}

	// ── Started tasks ─────────────────────────────────────────────────────────

	/**
	 * The map key of a task ref.
	 *
	 * @param ref - The task.
	 * @returns Its key.
	 */
	function taskKey(ref: ITaskRef): string {
		return JSON.stringify([ref.projectId, ref.source]);
	}

	/** Cancel the next look, if one is scheduled. */
	function cancelStartLook(): void {
		if (startLookTimer !== null) {
			clock.clearTimer(startLookTimer);
			startLookTimer = null;
		}
	}

	/** Forget every started task and stop looking. */
	function forgetStarts(): void {
		cancelStartLook();
		awaitingStart.clear();
		startLookStep = 0;
	}

	/**
	 * Remember a task a start event named, and begin the steps again.
	 *
	 * @param ref - The task.
	 */
	function awaitStart(ref: ITaskRef): void {
		awaitingStart.set(taskKey(ref), clock.now() + startWatchMs);
		// The refresh the event asks for looks first; the next look is 1 s after it.
		cancelStartLook();
		startLookStep = 0;
	}

	/**
	 * Stop looking for a task its end event named.
	 *
	 * @param ref - The task.
	 */
	function endStart(ref: ITaskRef): void {
		awaitingStart.delete(taskKey(ref));
		if (awaitingStart.size === 0) forgetStarts();
	}

	/**
	 * After a discovery: forget the started tasks it listed and those whose
	 * window passed, and schedule the next look for the rest.
	 *
	 * @param running - The tasks the discovery saw running (empty when it failed).
	 */
	function noteRunning(running: readonly ITaskRef[]): void {
		if (awaitingStart.size === 0) return;
		for (const ref of running) awaitingStart.delete(taskKey(ref));
		const now = clock.now();
		for (const [key, until] of awaitingStart) {
			if (until <= now) awaitingStart.delete(key);
		}
		if (awaitingStart.size === 0) {
			forgetStarts();
			return;
		}
		const client = attachedClient;
		if (client === null || startLookTimer !== null) return;
		const wait = START_LOOK_STEPS_MS[Math.min(startLookStep, START_LOOK_STEPS_MS.length - 1)]!;
		startLookStep += 1;
		startLookTimer = clock.setTimer(() => {
			startLookTimer = null;
			if (attachedClient !== client || awaitingStart.size === 0) return;
			void refresh(client, { background: true });
		}, wait);
	}

	function reset(): void {
		resetCount += 1;
		probing.clear();
		cancelDebounce();
		forgetStarts();
		vault.clear();
		roleVault.clear();
		keptInfo.clear();
		vanished.clear();
		callHints.clear();
		sessions.clear();
		channels.clear();
		inFlight = null;
		followUp = null;
		lastRefreshStartedAt = 0;
		setState({ status: 'idle', endpoints: [], probes: {}, error: null, refreshedAt: 0 });
	}

	function attach(client: IExplorerClient, identity: IExplorerIdentity | null, watch?: EndpointWatch): () => void {
		attachedClient = client;
		/**
		 * Apply an identity: a different one (or none) means everything cached
		 * belongs to somebody else, so it is all forgotten.
		 *
		 * @param next - The identity now in force.
		 */
		const applyIdentity = (next: IExplorerIdentity | null): void => {
			const fingerprint = identityFingerprint(next);
			const changed = fingerprint !== identityFingerprintNow;
			identityNow = next;
			if (changed) {
				const hadState = identityFingerprintNow !== null || state.endpoints.length > 0 || vault.size > 0;
				identityFingerprintNow = fingerprint;
				if (hadState) reset();
			}
		};
		applyIdentity(identity);

		const unwatch = watch?.({
			onTaskEvent: ({ reprobe, started, ended }) => {
				if (ended !== undefined) endStart(ended);
				if (started !== undefined && attachedClient === client) awaitStart(started);
				scheduleRefresh(client, reprobe);
			},
			onFocus: () => {
				if (clock.now() - lastRefreshStartedAt < focusMinIntervalMs) return;
				scheduleRefresh(client, false);
			},
			onIdentity: (next) => {
				applyIdentity(next);
			},
			onReconnect: () => scheduleRefresh(client, true),
		});

		return () => {
			unwatch?.();
			cancelDebounce();
			if (attachedClient === client) {
				attachedClient = null;
				forgetStarts();
			}
		};
	}

	return {
		getState: () => state,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		refresh,
		probe,
		attach,
		reset,
		session,
		channel,
	};
}

/** Type guard used by apps that hold an unknown probe info. */
export function probeInfo(probe: IProbeResult | undefined): Record<string, unknown> | null {
	return probe !== undefined && probe.ok && isPlainObject(probe.info) ? probe.info : null;
}
