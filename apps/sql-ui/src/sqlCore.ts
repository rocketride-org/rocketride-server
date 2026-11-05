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
// SQL — ENGINE CORE (what lies beneath SqlEnv where the engine connection is)
// =============================================================================
//
// One core per owner of the engine connection: the full app's mount (`app:`),
// or the dev tool's CONTROLLER (the sidebar mount). Frames never hold one
// (R1); they reach it through ops (sqlBridge.ts). It is built on the shared
// Explorer library:
//
//   client      the library's IExplorerClient over the realm's own
//               RocketRideClient (shared/explorer/devtool/engineClient: a
//               getter, never a captured client), every request bounded by
//               an explicit deadline;
//   identity    the dev-tool identity tracker: it fails closed, and NOTHING is
//               discovered while it cannot vouch for anyone;
//   readiness   discovery and the saved-list read wait for the identity to be
//               known AND the realm's engine to be ready (devtool/readiness.ts,
//               devtool/watch.ts). There is no activation gate: a dev-tool
//               controller's mount is its activation, since both hosts build
//               a tool's sidebar only when it is selected or a frame summons
//               it. Endpoint probes (tool calls) are held until a person is
//               present (`discovery.markUserPresent`);
//   endpoints   SQL Explorer's endpoint store (connect/endpoints.ts): owner-
//               aware discovery, one probe per endpoint, the task-token vault,
//               the sessions (tokens come ONLY from that vault);
//   the saved-connection list, read from the user's store once the identity
//               is known, read again for each new identity, forgotten when
//               it becomes unknown.
//
// RESOLUTION (a saved connection -> the running endpoint it names). A saved
// connection is named by its id, never by an endpoint or a key from outside:
//
//   pipeline   the discovered endpoint whose `legacyKey` equals
//              `endpointKeyForConnection(record)`. The store sets a legacyKey
//              only on development runs (keys.ts legacyKeyFromKey), so a
//              team deployment never matches. The caller's OWN run is
//              preferred, then the best state. Discovery is identity-filtered.
//   direct     `client.use` starts or reattaches the connection's temporary
//              tool pipeline (explicit timeout), then discovery finds it by
//              its legacyKey `sqlconn-<id>:tools_1:<provider>_1`. A direct
//              pipeline that idled out (its endpoint shows `stopped` or is
//              gone) is started again before the next call.
//
// A connection that resolves to nothing fails with an ExplorerToolError of
// kind `unavailable` (the controller answers it as Reply data). Every wait
// here is bounded (sqlTimeouts.ts), so a frame's timeout can be derived
// from them.
// =============================================================================

import { ExplorerToolError } from 'shared/explorer/errors';
import type { IEndpointStore, IStoreClock } from 'shared/explorer/connect/store';
import type { IExplorerClient, IExplorerEndpoint } from 'shared/explorer/types';
import { createExplorerAdmin, createExplorerClient, createPrefsFs } from 'shared/explorer/devtool/engineClient';
import type { IPrefsFs, IRealmClient, RealmClientGetter } from 'shared/explorer/devtool/engineClient';
import type { IEngineReadiness } from 'shared/explorer/devtool/readiness';
import { createIdentityTracker } from 'shared/explorer/devtool/identity';
import type { IIdentityBus, IIdentitySnapshot, IIdentityTracker } from 'shared/explorer/devtool/identity';
import { createDevToolDiscovery } from 'shared/explorer/devtool/watch';
import type { IDevToolDiscovery, IDiscoveryBus, IFocusTarget } from 'shared/explorer/devtool/watch';
import { isPlainObject } from 'shared/explorer/checks';
import {
	DATABASE_PROVIDERS,
	createSqlEndpoints,
	createSqlSession,
	deleteSavedConnection,
	directProjectId,
	directUseOptions,
	endpointForConnection,
	endpointKeyForConnection,
	getSavedConnection,
	getSavedConnectionsLoadProblem,
	getSavedConnectionsStatus,
	isDirectEndpointKey,
	loadSavedConnections,
	ownSavedConnections,
	resetSavedConnections,
	subscribeSavedConnections,
	TOOLS_SOURCE_ID,
	toDialect,
	upsertSavedConnection,
} from './connect';
import type { DirectConnection, SavedConnectionsFs, SavedSqlConnection, SqlDialect, SqlEndpoint, SqlSession } from './connect';
import {
	DISCOVERY_WAIT_MS,
	TEARDOWN_POLL_MS,
	TEARDOWN_WAIT_MS,
	ENV_KEYS_TIMEOUT_MS,
	FS_TIMEOUT_MS,
	LIST_WAIT_MS,
	RELEASE_STEP_TIMEOUT_MS,
	SERVICE_TIMEOUT_MS,
	USE_TIMEOUT_MS,
	VALIDATE_TIMEOUT_MS,
} from './sqlTimeouts';

// =============================================================================
// TYPES
// =============================================================================

/** What the core needs from a realm's ConnectionManager (structural): identity events and the server event stream. */
export type SqlCoreBus = IIdentityBus & IDiscoveryBus;

/** What a session's caller may ask besides the session itself. */
export interface SessionContext {
	/**
	 * The node's dialect: the store's probe when it succeeded, else the
	 * session's last answer, else one bounded `dialect` call. 'unknown' when
	 * none answers, or the answer is not a dialect the app models.
	 */
	dialect(): Promise<SqlDialect>;
}

/** What {@link createSqlCore} needs. */
export interface SqlCoreOptions {
	/** The realm's ConnectionManager (identity events and the server event stream). */
	cm: SqlCoreBus;
	/** The realm's client right now, or null (`useEngineSource().getClient`): read again on every call. */
	getClient: RealmClientGetter<IRealmClient>;
	/** The realm's engine readiness (`useEngineSource().readiness`). */
	engine: IEngineReadiness;
	/**
	 * `app`: the full app, where a person is present from the start (probes
	 * are not held); `devtool`: a controller, whose probes wait until a
	 * person is present (an op arrives, or the sidebar is used).
	 */
	mode: 'app' | 'devtool';
	/** Where focus comes from (default: the window; null: none). */
	focusTarget?: IFocusTarget | null;
	/** The endpoint store's clock (tests). */
	clock?: IStoreClock;
}

/** The engine core. */
export interface SqlCore {
	/** The realm's engine client (one adapter per core). */
	readonly client: IExplorerClient;
	/** The user-store calls over the same getter (saved connections, history files, saved queries). */
	readonly fs: IPrefsFs;
	/** The identity tracker. */
	readonly identity: IIdentityTracker;
	/** The discovery gate and watch. */
	readonly discovery: IDevToolDiscovery;
	/**
	 * Run `fn` once the identity is known AND the realm's engine is ready (at
	 * once when it already is): the moment a controller may read its files.
	 *
	 * @returns Cancel (idempotent).
	 */
	whenAllowed(fn: () => void): () => void;
	/** SQL Explorer's endpoint store (owner of every task token). */
	readonly endpoints: IEndpointStore;
	/**
	 * Resolve a saved connection to its running endpoint (direct mode starts
	 * or reattaches its temp pipeline).
	 *
	 * @param connId - The connection.
	 * @param holder - Who is opening it (a frame): one holder however often it resolves again. Omitted: a holder of its own.
	 * @returns The token-free description, carrying `connId`.
	 * @throws ExplorerToolError `invalid` (no such connection) or `unavailable` (not signed in, not running).
	 */
	resolve(connId: string, holder?: string): Promise<SqlEndpoint>;
	/**
	 * The endpoint key a saved connection's history and schema are kept under
	 * (`endpointKeyForConnection(record)`), once the list is read; no engine call.
	 */
	keyOf(connId: string): Promise<string>;
	/** A session whose every call resolves its connection first (`endpoint.connId` is required). */
	sessionFor(endpoint: SqlEndpoint): SqlSession;
	/**
	 * Run calls on a connection's session (resolving it first). `ctx.dialect()`
	 * is the dialect the node answered, which the controller's own write
	 * checks classify with: the store's probe when it succeeded, else the
	 * session's last answer, else one bounded `dialect` call; 'unknown' only
	 * when none answers (or the answer is not one the app models).
	 */
	withSession<T>(connId: string, fn: (session: SqlSession, ctx: SessionContext) => Promise<T>, tool?: string): Promise<T>;
	/**
	 * Stop a direct connection's temp pipeline, best effort (a no-op for a
	 * pipeline connection).
	 *
	 * @param connId - The connection.
	 * @param key - The endpoint key the caller opened. When the connection's
	 *   key is no longer this one (it was edited: another provider), its
	 *   pipeline was replaced by the one the edit started, under the same
	 *   project id: nothing is stopped (the idle TTL reaps any orphan).
	 */
	release(connId: string, key?: string, holder?: string): Promise<void>;
	/** The New Connection picker's list: discovered endpoints a pipeline connection can be saved for. */
	pickable(): Promise<SqlEndpoint[]>;
	/** One service definition (the direct path's config schema). */
	getService(provider: string): Promise<unknown>;
	/** Server-side validation of a single-component pipeline payload. */
	validate(pipeline: Record<string, unknown>): Promise<unknown>;
	/** Environment-variable names (the config form's `${}` autocomplete). */
	envKeys(): Promise<string[]>;
	/**
	 * One saved connection, once the list is read for the signed-in identity.
	 *
	 * @param connId - The connection id.
	 * @returns The record, or null when there is no such connection.
	 * @throws ExplorerToolError `unavailable` (not signed in, list unreadable).
	 */
	connection(connId: string): Promise<SavedSqlConnection | null>;
	/**
	 * Insert or replace a saved connection, once the list is read for the
	 * signed-in identity (never queued onto someone else's list).
	 *
	 * @param connection - The record.
	 * @param stillAllowed - Throws when the change is no longer allowed; run after every wait, right before the list changes (default: the account signed in at the call is still signed in).
	 * @throws ExplorerToolError `invalid` (not a usable record) or `unavailable` (not signed in, list unreadable).
	 */
	saveConnection(connection: SavedSqlConnection, stillAllowed?: () => void): Promise<void>;
	/**
	 * Delete a saved connection; a direct one's temp pipeline is stopped first, best effort.
	 *
	 * @param connId - The connection id.
	 * @param stillAllowed - Throws when the change is no longer allowed; run after every wait (default: the account signed in at the call is still signed in).
	 */
	deleteConnection(connId: string, stillAllowed?: () => void): Promise<void>;
	/** Stop everything the core follows (idempotent). */
	dispose(): void;
}

// =============================================================================
// HELPERS
// =============================================================================

/** How preferable an endpoint state is when two runs share a legacyKey. */
const STATE_RANK: Record<IExplorerEndpoint['state'], number> = { ready: 0, probing: 1, unreachable: 2, inaccessible: 3, stopped: 4 };

/**
 * The token-free description the app and its frames use for a discovered endpoint.
 *
 * @param endpoint - A discovered endpoint with a legacyKey.
 * @returns The description (key = legacyKey).
 */
function pickerEntry(endpoint: IExplorerEndpoint): SqlEndpoint {
	return {
		key: endpoint.legacyKey as string,
		projectId: endpoint.projectId,
		pipelineName: endpoint.pipelineName,
		source: endpoint.source,
		nodeId: endpoint.nodeId,
		nodeName: endpoint.nodeName,
		provider: endpoint.provider,
		running: endpoint.running,
	};
}

/**
 * Settle with `work`, or after `ms` (whichever comes first).
 *
 * @param work - The promise.
 * @param ms - The bound.
 * @returns When either happened (never rejects).
 */
function bounded(work: Promise<unknown>, ms: number): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		work.then(
			() => { clearTimeout(timer); resolve(); },
			() => { clearTimeout(timer); resolve(); },
		);
	});
}

/**
 * Check a saved-connection record that arrived from outside (a frame's
 * save): the shape the file holds, and a provider this app serves (a direct
 * record is started with `client.use`, so it must name a database node).
 *
 * @param value - The record.
 * @returns The record.
 * @throws ExplorerToolError `invalid` naming what is wrong.
 */
export function checkSavedConnection(value: unknown): SavedSqlConnection {
	const fail = (why: string): never => { throw new ExplorerToolError({ kind: 'invalid', tool: 'saveConnection', message: `The connection was not saved: ${why}.` }); };
	if (!isPlainObject(value)) return fail('it is not a connection record');
	const text = (field: string): string => {
		const field_ = value[field];
		return typeof field_ === 'string' && field_ !== '' ? field_ : fail(`'${field}' is missing`);
	};
	text('id');
	if (typeof value.name !== 'string') fail("'name' is missing");
	const provider = text('provider');
	if (!DATABASE_PROVIDERS.has(provider)) fail(`'${provider}' is not a database node this app opens`);
	if (value.mode === 'pipeline') {
		for (const field of ['projectId', 'pipelineName', 'source', 'nodeId']) text(field);
	} else if (value.mode === 'direct') {
		if (!isPlainObject(value.config)) fail("'config' is missing");
	} else {
		fail("'mode' must be 'pipeline' or 'direct'");
	}
	return value as unknown as SavedSqlConnection;
}

/**
 * An `unavailable` failure (nothing was sent to a node).
 *
 * @param tool - What was being done.
 * @param message - The sentence.
 * @returns The error.
 */
function unavailable(tool: string, message: string): ExplorerToolError {
	return new ExplorerToolError({ kind: 'unavailable', tool, message });
}

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Create the engine core for one owner.
 *
 * @param opts - See {@link SqlCoreOptions}.
 * @returns The core; dispose it with its owner.
 */
export function createSqlCore(opts: SqlCoreOptions): SqlCore {
	const { cm, getClient } = opts;
	const client = createExplorerClient(getClient);
	const fs = createPrefsFs(getClient, FS_TIMEOUT_MS);
	// Write-like admin calls (`use`, `terminate`) are sent once, never retried:
	// a deadline that expires leaves the request running ("not cancelled, may
	// still complete"), so a retry could start a second pipeline.
	const admin = createExplorerAdmin(getClient, {
		use: USE_TIMEOUT_MS,
		getTaskToken: RELEASE_STEP_TIMEOUT_MS,
		terminate: RELEASE_STEP_TIMEOUT_MS,
		getService: SERVICE_TIMEOUT_MS,
		validate: VALIDATE_TIMEOUT_MS,
		getEnvironmentKeys: ENV_KEYS_TIMEOUT_MS,
	});
	const identity = createIdentityTracker({ cm });
	const discovery = createDevToolDiscovery({
		cm,
		client,
		identity,
		engine: opts.engine,
		present: opts.mode === 'app',
		...(opts.focusTarget !== undefined ? { focusTarget: opts.focusTarget } : {}),
	});
	const endpoints = createSqlEndpoints({ holdProbes: () => discovery.holdProbes(), ...(opts.clock ? { clock: opts.clock } : {}) });
	const detachStore = endpoints.attach(client, identity.get().identity, discovery.watch);
	let disposed = false;

	// ── The saved-connection list, per identity ──────────────────────────────

	const listFs: SavedConnectionsFs = fs;
	/**
	 * Run `fn` once the discovery gate allows it (the identity is known AND the
	 * realm's engine is ready), at once when it already does.
	 *
	 * @param fn - What to run.
	 * @returns Cancel (idempotent).
	 */
	const whenAllowed = (fn: () => void): (() => void) => {
		let done = false;
		const run = (): void => {
			if (done || !discovery.allowed()) return;
			done = true;
			fn();
		};
		const off = discovery.subscribe(run);
		run();
		return () => { done = true; off(); };
	};
	/** The owner whose list read has been started (by the readiness gate). */
	let loadedFor: string | null = null;
	/** The owner whose failed load has been tried once more (one retry, from `listReady`). */
	let retriedFor: string | null = null;
	// This realm owns the list for the core's lifetime: a replica snapshot
	// (a frame in the same realm) never overwrites it.
	const releaseList = ownSavedConnections();
	let listOwner: string | null = null;
	let offLoadWhenActive: (() => void) | null = null;
	const followIdentity = (snapshot: IIdentitySnapshot): void => {
		const owner = snapshot.known ? snapshot.fingerprint : null;
		if (owner === listOwner) return;
		listOwner = owner;
		loadedFor = null;
		retriedFor = null;
		// The list is per user: a new identity (or none) must not see the last one's.
		resetSavedConnections({ force: true });
		offLoadWhenActive?.();
		offLoadWhenActive = null;
		if (owner === null) return;
		// Read only once the identity is known and the engine is ready. A
		// dev-tool controller's mount is its activation (the hosts mount only a
		// selected or summoned sidebar).
		offLoadWhenActive = whenAllowed(() => {
			if (disposed || listOwner !== owner) return;
			loadedFor = owner;
			void loadSavedConnections(listFs);
		});
	};
	followIdentity(identity.get());
	const offIdentity = identity.subscribe(followIdentity);

	// ── Resolution ───────────────────────────────────────────────────────────

	const requireIdentity = (tool: string): void => {
		if (!identity.get().known) throw unavailable(tool, 'Not signed in to a RocketRide server, so nothing was sent.');
	};

	/**
	 * A check, made now, that the account signed in later is still this one
	 * (a change to the saved list must land in the list of the account it was
	 * asked for, even when the account changes while the list is read).
	 *
	 * @param tool - What is being done (named in errors).
	 * @returns The check: it throws `unavailable` (signed out) or `stale` (another account).
	 */
	const sameAccount = (tool: string): (() => void) => {
		const askedBy = identity.get().known ? identity.get().fingerprint : null;
		return () => {
			const now = identity.get().known ? identity.get().fingerprint : null;
			if (now === null) throw unavailable(tool, 'Not signed in to a RocketRide server, so nothing was changed.');
			if (now !== askedBy) throw new ExplorerToolError({ kind: 'stale', tool, message: 'The signed-in account changed, so nothing was changed.' });
		};
	};

	/**
	 * Wait (bounded) until the saved-connection list is read for the signed-in identity.
	 *
	 * @param tool - What is being done (named in errors).
	 */
	const listReady = async (tool: string): Promise<void> => {
		requireIdentity(tool);
		/** The list is `idle`, its first read was tried and failed, and nothing is reading it. */
		const failed = (): boolean => getSavedConnectionsStatus() === 'idle' && listOwner !== null && loadedFor === listOwner && discovery.allowed();
		/**
		 * A load that failed leaves the list `idle` and nothing else would try
		 * again until the identity changes: one retry, from here, per owner.
		 */
		const retry = (): void => {
			if (failed() && retriedFor !== listOwner) {
				retriedFor = listOwner;
				void loadSavedConnections(listFs);
			}
		};
		retry();
		if (getSavedConnectionsStatus() !== 'ready' && !(failed() && retriedFor === listOwner)) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(done, LIST_WAIT_MS);
				const off = subscribeSavedConnections(() => {
					retry();
					// Ready, or the retry too has failed: no point waiting out the bound.
					if (getSavedConnectionsStatus() === 'ready' || (failed() && retriedFor === listOwner)) done();
				});
				function done(): void {
					clearTimeout(timer);
					off();
					resolve();
				}
			});
		}
		if (getSavedConnectionsStatus() !== 'ready') throw unavailable(tool, getSavedConnectionsLoadProblem() ?? 'Your saved connections could not be read from the server yet. Try again.');
	};

	/**
	 * The saved connection, once the list has been read.
	 *
	 * @param connId - The connection id.
	 * @param tool - What is being done (named in errors).
	 * @returns The record.
	 */
	const recordOf = async (connId: string, tool: string): Promise<SavedSqlConnection> => {
		await listReady(tool);
		const record = getSavedConnection(connId);
		if (!record) throw new ExplorerToolError({ kind: 'invalid', tool, message: `There is no saved connection '${connId}'.` });
		return record;
	};

	/**
	 * The discovered endpoint a saved connection names: among the
	 * identity-filtered endpoints whose legacy key matches, the caller's own
	 * development run first, then the best state.
	 *
	 * @param legacyKey - `endpointKeyForConnection(record)`.
	 * @returns The endpoint, or undefined.
	 */
	const match = (legacyKey: string): IExplorerEndpoint | undefined => {
		const me = identity.get().identity?.userId ?? null;
		const ownRank = (endpoint: IExplorerEndpoint): number => (me !== null && endpoint.runKind === 'dev' && endpoint.ownerKind === 'user' && endpoint.ownerId === me ? 0 : 1);
		return endpoints.getState().endpoints
			.filter((endpoint) => endpoint.legacyKey === legacyKey)
			.sort((a, b) => ownRank(a) - ownRank(b) || STATE_RANK[a.state] - STATE_RANK[b.state])[0];
	};

	/**
	 * Open holders per direct endpoint key, each with the sequence number of
	 * its latest resolve. A named holder (a frame) is one entry however often
	 * it resolves again; an anonymous resolve (the full app) is an entry of its
	 * own, which an anonymous keyed release takes back oldest first.
	 */
	const holders = new Map<string, Map<string, number>>();
	/** Counts resolves and releases, so a release can tell a resolve that came after it. */
	let holderSeq = 0;
	/** Per direct project: what runs one at a time (a teardown, a start, a look at what is running). */
	const locks = new Map<string, Promise<unknown>>();

	/**
	 * Run `fn` after everything queued before it for this direct project: a
	 * close that is tearing the pipeline down and a new open never overlap.
	 *
	 * @param projectId - The temporary pipeline's project id.
	 * @param fn - What to run.
	 * @returns What `fn` answers.
	 */
	const underLock = <T,>(projectId: string, fn: () => Promise<T>): Promise<T> => {
		const run = (locks.get(projectId) ?? Promise.resolve()).then(fn, fn);
		const tail = run.then(() => undefined, () => undefined);
		locks.set(projectId, tail);
		void tail.then(() => { if (locks.get(projectId) === tail) locks.delete(projectId); });
		return run;
	};
	/** Starts in flight per direct project: concurrent resolutions share one `use`. */
	const starting = new Map<string, Promise<void>>();

	/**
	 * Start (or reattach to) a direct connection's temporary pipeline, once
	 * for every resolution that asks while the start is in flight. `use` is
	 * sent once and never retried: an expired deadline leaves it running.
	 *
	 * @param record - The direct connection.
	 */
	const startDirect = (record: DirectConnection): Promise<void> => {
		const projectId = directProjectId(record);
		let pending = starting.get(projectId);
		if (pending === undefined) {
			pending = (async () => {
				try {
					await admin.use(directUseOptions(record) as Parameters<typeof admin.use>[0]);
				} finally {
					starting.delete(projectId);
				}
			})();
			starting.set(projectId, pending);
		}
		return pending;
	};

	/** Tokens of direct pipelines that were terminated and may not be gone yet, by project id. */
	const dying = new Map<string, string>();

	/**
	 * Wait (bounded) until a terminated pipeline's token no longer resolves.
	 *
	 * @param projectId - The temporary pipeline's project id.
	 * @param token - The terminated task's token.
	 */
	const awaitTeardown = async (projectId: string, token: string): Promise<void> => {
		const until = Date.now() + TEARDOWN_WAIT_MS;
		while (Date.now() < until) {
			let now: string | undefined;
			try {
				now = await admin.getTaskToken({ projectId, source: TOOLS_SOURCE_ID });
			} catch {
				return;
			}
			if (now !== token) return;
			await new Promise<void>((resolve) => { setTimeout(resolve, TEARDOWN_POLL_MS); });
		}
	};

	/**
	 * Stop a direct connection's pipeline, best effort (the 15-minute idle TTL
	 * reaps whatever a failure leaves behind). Each step is sent once.
	 *
	 * @param record - The direct connection.
	 */
	const terminateDirect = async (record: DirectConnection): Promise<void> => {
		try {
			const projectId = directProjectId(record);
			const token = await admin.getTaskToken({ projectId, source: TOOLS_SOURCE_ID });
			// A document that opened while the token was being looked up holds the
			// pipeline now: it is never terminated under a holder.
			if ((holders.get(endpointKeyForConnection(record))?.size ?? 0) > 0) return;
			if (typeof token === 'string' && token !== '') {
				// The engine tears a task down asynchronously: its token can still
				// resolve for a moment after `terminate` answers. Remember it, so a
				// resolution that comes straight after waits for the teardown and
				// starts a fresh pipeline instead of reusing the dying one.
				dying.set(projectId, token);
				await admin.terminate(token);
			}
		} catch {
			// Best effort.
		}
	};

	/** Run a discovery now (only while it is allowed), bounded. */
	const rediscover = async (tool: string): Promise<void> => {
		requireIdentity(tool);
		// A call is an explicit request: a person is present (the controller
		// already said so for the op itself).
		discovery.markUserPresent('op');
		await bounded(endpoints.refresh(client), DISCOVERY_WAIT_MS);
	};

	/**
	 * Find the running endpoint of a saved connection, starting a direct
	 * connection's pipeline when it is not running.
	 *
	 * @param record - The saved connection.
	 * @param tool - What is being done.
	 * @returns The endpoint.
	 */
	const locate = (record: SavedSqlConnection, tool: string): Promise<IExplorerEndpoint> => (
		// A direct connection's pipeline is started and stopped by this core, one
		// step at a time: a start waits for a teardown in progress.
		record.mode === 'direct' ? underLock(directProjectId(record), () => locateNow(record, tool)) : locateNow(record, tool)
	);

	const locateNow = async (record: SavedSqlConnection, tool: string): Promise<IExplorerEndpoint> => {
		const legacyKey = endpointKeyForConnection(record);
		let found = match(legacyKey);
		if (record.mode === 'direct') {
			// Just terminated (a release, then straight away a new resolution): the
			// task may still look running to discovery and to `getTaskToken`. Wait
			// for it to go, and do not trust what discovery last showed.
			const projectId = directProjectId(record);
			const token = dying.get(projectId);
			if (token !== undefined) {
				dying.delete(projectId);
				await awaitTeardown(projectId, token);
				found = undefined;
			}
		}
		const running = (endpoint: IExplorerEndpoint | undefined): boolean => endpoint !== undefined && endpoint.state !== 'stopped';
		if (!running(found)) {
			if (record.mode === 'direct') {
				requireIdentity(tool);
				await startDirect(record);
			}
			await rediscover(tool);
			found = match(legacyKey);
		}
		if (found === undefined) {
			throw unavailable(tool, record.mode === 'direct'
				? `The connection '${record.name}' started, but its pipeline was not found running. Try again.`
				: `The pipeline '${record.pipelineName}' is not running in your workspace. Start it and try again.`);
		}
		if (found.state === 'stopped') {
			throw unavailable(tool, found.stateDetail ?? `The pipeline '${found.pipelineName}' is not running. Start it and try again.`);
		}
		return found;
	};

	const withSession = async <T,>(connId: string, fn: (session: SqlSession, ctx: SessionContext) => Promise<T>, tool = 'connection'): Promise<T> => {
		const record = await recordOf(connId, tool);
		const endpoint = await locate(record, tool);
		const shared = endpoints.session(client, endpoint);
		const session = createSqlSession(shared, endpointForConnection(record));
		const dialect = async (): Promise<SqlDialect> => {
			// The store's probe, when it succeeded.
			const probe = endpoints.getState().probes[endpoint.key];
			if (probe?.ok) return toDialect(probe.dialect);
			// The session's last answer (kept while the endpoint re-probes).
			const kept = shared.info();
			if (kept !== null && typeof kept.dialect === 'string') return toDialect(kept.dialect);
			// Neither: ask the node once. Bounded by the session's own wait
			// (DIALECT_WAIT_MS, 15 s): inside it the shared session may rebind
			// and re-send once after a TASK_STOPPED refusal (the tool is
			// idempotent), so this can be up to two or three sends in all, never
			// longer than that one wait (toolCallBudgetMs(DIALECT_WAIT_MS) on the
			// bus, which the frame's `sql.execute` budget includes). No answer:
			// unknown.
			try {
				return await session.dialect();
			} catch {
				return 'unknown';
			}
		};
		return fn(session, { dialect });
	};

	const sessionFor = (endpoint: SqlEndpoint): SqlSession => {
		const connId = endpoint.connId;
		if (typeof connId !== 'string' || connId === '') {
			throw new TypeError(`sessionFor: the endpoint '${endpoint.key}' carries no connection id.`);
		}
		return {
			endpoint,
			execute: (sql, options) => withSession(connId, (session) => session.execute(sql, options), 'execute'),
			getSchema: (table) => withSession(connId, (session) => session.getSchema(table), 'get_schema'),
			refreshSchema: () => withSession(connId, (session) => session.refreshSchema(), 'refresh_schema'),
			dialect: () => withSession(connId, (session) => session.dialect(), 'dialect'),
		};
	};

	return {
		client,
		fs,
		identity,
		discovery,
		whenAllowed,
		endpoints,
		async resolve(connId, holder) {
			// Claim the holder BEFORE the first wait, when the record is already
			// known: a remount's cleanup release lands while this resolve is still
			// waiting, and must see this holder (else it stops the pipeline).
			const early = getSavedConnection(connId);
			const holderId = holder ?? `anon-${holderSeq + 1}`;
			let claimed: string | null = null;
			let added = false;
			const claim = (record: SavedSqlConnection): void => {
				const key = record.mode === 'direct' ? endpointKeyForConnection(record) : null;
				if (key === claimed) return;
				unclaim();
				if (key !== null) {
					const mine = holders.get(key) ?? new Map<string, number>();
					added = !mine.has(holderId);
					mine.set(holderId, ++holderSeq);
					holders.set(key, mine);
				}
				claimed = key;
			};
			const unclaim = (): void => {
				if (claimed === null) return;
				const mine = holders.get(claimed);
				// Only a holder this resolution added is taken back (a frame that
				// already held it, and failed to resolve again, still holds it).
				if (mine !== undefined && added) {
					mine.delete(holderId);
					if (mine.size === 0) holders.delete(claimed);
				}
				claimed = null;
			};
			if (early !== undefined && identity.get().known) claim(early);
			try {
				const record = await recordOf(connId, 'resolve');
				claim(record);
				const found = await locate(record, 'resolve');
				const endpoint = endpointForConnection(record);
				// A pipeline connection is shown by its running pipeline's current
				// name, not the one frozen into the record when it was saved; the
				// key and everything else stay the record's.
				return record.mode === 'pipeline' ? { ...endpoint, pipelineName: found.pipelineName } : endpoint;
			} catch (error) {
				// Nothing opened: this resolution holds nothing.
				unclaim();
				throw error;
			}
		},
		keyOf: async (connId) => endpointKeyForConnection(await recordOf(connId, 'history')),
		sessionFor,
		withSession: (connId, fn, tool) => withSession(connId, fn, tool),
		async release(connId, key, holder) {
			// Read before the first await: a delete that follows a release in the
			// same turn must not hide the record from it.
			const record = getSavedConnection(connId);
			if (record?.mode !== 'direct' || !identity.get().known) return;
			// Released by the key the caller opened: after an edit the project's
			// pipeline is the edited connection's, and must not be stopped.
			if (key !== undefined && key !== endpointKeyForConnection(record)) return;
			const endpointKey = endpointKeyForConnection(record);
			const at = ++holderSeq;
			// The decision and the teardown run after anything queued before them
			// for this connection, and re-read the holders: a resolve that arrived
			// after this release (another frame, or this one again) keeps the
			// pipeline, and a pipeline with a holder is never terminated.
			await underLock(directProjectId(record), async () => {
				const mine = holders.get(endpointKey);
				if (key !== undefined) {
					// A keyed release gives up its own holder, unless the same frame
					// resolved again after releasing. One holder per frame, so the
					// last real close stops the pipeline.
					if (mine !== undefined) {
						if (holder !== undefined) {
							if ((mine.get(holder) ?? 0) <= at) mine.delete(holder);
						} else {
							const oldest = [...mine.keys()].find((id) => id.startsWith('anon-'));
							if (oldest !== undefined) mine.delete(oldest);
						}
						if (mine.size === 0) holders.delete(endpointKey);
					}
					if ((holders.get(endpointKey)?.size ?? 0) > 0) return;
				} else if (mine !== undefined && [...mine.values()].some((seq) => seq > at)) {
					// An unkeyed release (the full app's last document, a delete) stops
					// what the connection runs now, but not for a resolve that came after it.
					return;
				}
				holders.delete(endpointKey);
				await terminateDirect(record);
			});
		},
		async pickable() {
			await rediscover('discover');
			return endpoints.getState().endpoints
				// A direct connection's temporary pipeline is this app's own plumbing,
				// not a user pipeline: offering it would let a pipeline connection
				// alias a direct endpoint.
				.filter((endpoint) => endpoint.legacyKey !== null && endpoint.state !== 'stopped' && !isDirectEndpointKey(endpoint.projectId))
				.map(pickerEntry);
		},
		getService: (provider) => admin.getService(provider),
		validate: (pipeline) => admin.validate({ pipeline }),
		async saveConnection(connection, stillAllowed = sameAccount('saveConnection')) {
			const record = checkSavedConnection(connection);
			await listReady('saveConnection');
			stillAllowed();
			upsertSavedConnection(record);
		},
		async deleteConnection(connId, stillAllowed = sameAccount('deleteConnection')) {
			await listReady('deleteConnection');
			stillAllowed();
			// An id the list does not hold changes nothing (and writes nothing).
			if (getSavedConnection(connId) === undefined) return;
			await this.release(connId);
			stillAllowed();
			deleteSavedConnection(connId);
		},
		async connection(connId) {
			await listReady('connection');
			return getSavedConnection(connId) ?? null;
		},
		async envKeys() {
			const keys = await admin.getEnvironmentKeys();
			return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			offIdentity();
			offLoadWhenActive?.();
			releaseList();
			detachStore();
			discovery.dispose();
			identity.dispose();
		},
	};
}
