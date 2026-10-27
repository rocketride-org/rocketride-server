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
//   client      the library's IExplorerClient over the shell bus
//               (shared/explorer/devtool/busClient), every request with an
//               explicit timeout;
//   identity    the dev-tool identity tracker: it fails closed, and NOTHING is
//               discovered while it cannot vouch for anyone;
//   activation  the full app opens it at once; a dev-tool controller's
//               mount opens it, since both hosts build a tool's sidebar only
//               when it is selected or a frame summons it (#2625 9bd5d931f;
//               shared/explorer/devtool/activation.ts);
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
import { busRequest, getBusExplorerClient } from 'shared/explorer/devtool/busClient';
import type { IExplorerBus } from 'shared/explorer/devtool/busClient';
import { createIdentityTracker } from 'shared/explorer/devtool/identity';
import type { IIdentityBus, IIdentitySnapshot, IIdentityTracker } from 'shared/explorer/devtool/identity';
import { createActivationGate } from 'shared/explorer/devtool/activation';
import type { IActivationBus, IActivationGate } from 'shared/explorer/devtool/activation';
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
	getSavedConnectionsStatus,
	loadSavedConnections,
	ownSavedConnections,
	resetSavedConnections,
	subscribeSavedConnections,
	TOOLS_SOURCE_ID,
	toDialect,
	upsertSavedConnection,
} from './connect';
import { transactionsUnavailable } from './connect/session';
import type { SavedConnectionsFs, SavedSqlConnection, SqlApplyResult, SqlApplyStatement, SqlDialect, SqlEndpoint, SqlSession } from './connect';
import { isSafetyLevel } from './connect/savedConnections';
import type { SafetyLevel } from './connect/savedConnections';
import { gateApplyStatements } from './sql/gate';
import type { ConnectionStatusSource } from './connectionStatus';
import {
	DISCOVERY_WAIT_MS,
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

/** What the core needs from a realm's ConnectionManager (structural). */
export type SqlCoreBus = IExplorerBus & IIdentityBus & IActivationBus & IDiscoveryBus;

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
	/** The realm's ConnectionManager. */
	cm: SqlCoreBus;
	/** This tool's app id (the activation gate listens for it). */
	appId: string;
	/**
	 * `app`: the full app, which owns the window and discovers at once;
	 * `devtool`: a dev-tool controller, which waits to be activated (R7).
	 */
	mode: 'app' | 'devtool';
	/** The sidebar's `activeDocKey` at mount (devtool). */
	activeDocKey?: string | null;
	/** Where focus comes from (default: the window; null: none). */
	focusTarget?: IFocusTarget | null;
	/** The endpoint store's clock (tests). */
	clock?: IStoreClock;
}

/** The engine core. */
export interface SqlCore {
	/** The bus client (one per realm). */
	readonly client: IExplorerClient;
	/** The identity tracker. */
	readonly identity: IIdentityTracker;
	/** The activation gate. */
	readonly activation: IActivationGate;
	/** The discovery gate and watch. */
	readonly discovery: IDevToolDiscovery;
	/** SQL Explorer's endpoint store (owner of every task token). */
	readonly endpoints: IEndpointStore;
	/**
	 * Resolve a saved connection to its running endpoint (direct mode starts
	 * or reattaches its temp pipeline).
	 *
	 * @returns The token-free description, carrying `connId`.
	 * @throws ExplorerToolError `invalid` (no such connection) or `unavailable` (not signed in, not running).
	 */
	resolve(connId: string): Promise<SqlEndpoint>;
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
	 * Apply app-written statements on a connection (both mounts come here:
	 * the controller's `sql.applyBatch` and the full app's session). The
	 * whole list is checked first with the node's dialect
	 * (sql/gate.ts gateApplyStatements: one statement per entry, no
	 * transaction control, and no transaction on an unknown dialect); a
	 * ClickHouse session undoes nothing, so an atomic apply there is refused
	 * as `transactions-unavailable` before anything is sent. The session id
	 * never leaves this realm.
	 *
	 * @param connId - The connection.
	 * @param statements - The statements, in order.
	 * @param atomic - Run them as one transaction where the engine has one.
	 * @param stillAllowed - Throws when the apply is no longer allowed; run once the connection is resolved, right before anything is sent (default: nothing to check).
	 * @returns What ran (a failure once statements are sent is data).
	 * @throws ExplorerToolError `invalid` (the list was refused), `unavailable`, `transactions-unavailable`, or `begin`'s refusal: nothing was applied.
	 */
	applyBatch(connId: string, statements: SqlApplyStatement[], atomic: boolean, stillAllowed?: () => void): Promise<SqlApplyResult>;
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
	release(connId: string, key?: string): Promise<void>;
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
	 * Set one saved connection's safety level on the record the list holds,
	 * keeping the rest of it (the config, secrets included) as stored. A level
	 * already set writes nothing.
	 *
	 * @param connId - The connection id.
	 * @param safety - The level.
	 * @param stillAllowed - As for {@link SqlCore.saveConnection}.
	 * @throws ExplorerToolError `invalid` (an unknown level or connection) or `unavailable`.
	 */
	setConnectionSafety(connId: string, safety: SafetyLevel, stillAllowed?: () => void): Promise<void>;
	/**
	 * Delete a saved connection; a direct one's temp pipeline is stopped first, best effort.
	 *
	 * @param connId - The connection id.
	 * @param stillAllowed - Throws when the change is no longer allowed; run after every wait (default: the account signed in at the call is still signed in).
	 */
	deleteConnection(connId: string, stillAllowed?: () => void): Promise<void>;
	/** Stop everything the core follows (idempotent). */
	dispose(): void;
	/**
	 * What the sidebar's status words are made from (connectionStatus.ts):
	 * the discovered endpoints, null until the first discovery finished, and
	 * the last failure opening each connection, until it next opens. Read from
	 * memory: nothing is sent, and an account change forgets the failures.
	 */
	statusSource(): ConnectionStatusSource;
	/** Follow {@link SqlCore.statusSource} (the current one at once); returns unsubscribe. */
	subscribeStatus(cb: (source: ConnectionStatusSource) => void): () => void;
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
 * record is started with `client.use`, so it must name a database node). A
 * safety level, when the record names one, must be a known level: an unknown
 * one is refused rather than stored and later read as the default.
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
	if (value.safety !== undefined && !isSafetyLevel(value.safety)) fail("'safety' must be 'off', 'risky' or 'every'");
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
	const { cm, appId } = opts;
	const client = getBusExplorerClient(cm);
	const identity = createIdentityTracker({ cm });
	const activation = createActivationGate({ appId, cm, activeDocKey: opts.activeDocKey ?? null });
	if (opts.mode === 'app') activation.open('user');
	const discovery = createDevToolDiscovery({
		cm,
		client,
		identity,
		activation,
		...(opts.focusTarget !== undefined ? { focusTarget: opts.focusTarget } : {}),
	});
	const endpoints = createSqlEndpoints(opts.clock ? { clock: opts.clock } : {});
	const detachStore = endpoints.attach(client, identity.get().identity, discovery.watch);
	let disposed = false;

	// ── Open failures, for the sidebar's status (per identity) ──────────────

	/**
	 * The last failure opening each connection, by id: until it next opens, or
	 * a later discovery shows its run up (the cause was fixed elsewhere).
	 */
	let openErrors: Record<string, string> = {};
	/** The discovery each failure was recorded after (`refreshedAt`). */
	const failedAfter = new Map<string, number>();
	/**
	 * Failures that only say a pipeline connection's pipeline is not running:
	 * its row says Stopped from discovery already, so they are not recorded
	 * as failures to reach it.
	 */
	const notRunning = new WeakSet<object>();
	const statusListeners = new Set<() => void>();
	const statusChanged = (): void => statusListeners.forEach((listener) => listener());
	/**
	 * Note how opening a connection ended, for the account that asked, and
	 * only while it is still the one signed in (an open that outlived its
	 * account says nothing to the next one).
	 *
	 * @param askedBy - The fingerprint signed in when the open began (null: nobody).
	 * @param connId - The connection.
	 * @param error - What it failed with, or null when it opened.
	 */
	const noteOpen = (askedBy: string | null, connId: string, error: unknown): void => {
		const now = identity.get();
		if (askedBy === null || !now.known || now.fingerprint !== askedBy) return;
		if (error === null) {
			if (!(connId in openErrors)) return;
			const { [connId]: _opened, ...rest } = openErrors;
			openErrors = rest;
			failedAfter.delete(connId);
		} else {
			openErrors = { ...openErrors, [connId]: error instanceof Error ? error.message : String(error) };
			failedAfter.set(connId, endpoints.getState().refreshedAt);
		}
		statusChanged();
	};

	/**
	 * Forget a failure once a discovery made after it shows the connection's
	 * run ready or being probed: whatever stopped it from opening is gone.
	 */
	const forgetRecovered = (): void => {
		if (failedAfter.size === 0) return;
		const state = endpoints.getState();
		const live = new Set(state.endpoints.filter((endpoint) => endpoint.state === 'ready' || endpoint.state === 'probing').map((endpoint) => endpoint.legacyKey));
		let next = openErrors;
		for (const [connId, after] of failedAfter) {
			const record = getSavedConnection(connId);
			if (state.refreshedAt <= after || record === undefined || !live.has(endpointKeyForConnection(record))) continue;
			const { [connId]: _recovered, ...rest } = next;
			next = rest;
			failedAfter.delete(connId);
		}
		if (next === openErrors) return;
		openErrors = next;
		statusChanged();
	};
	const offRecovered = endpoints.subscribe(forgetRecovered);

	// ── The saved-connection list, per identity ──────────────────────────────

	const fs: SavedConnectionsFs = {
		fsMkdir: (path) => busRequest(cm, 'client.fsMkdir', { path }, FS_TIMEOUT_MS),
		fsReadJson: (path) => busRequest(cm, 'client.fsReadJson', { path }, FS_TIMEOUT_MS),
		fsWriteJson: (path, value) => busRequest(cm, 'client.fsWriteJson', { path, value }, FS_TIMEOUT_MS),
	};
	// This realm owns the list for the core's lifetime: a replica snapshot
	// (a frame in the same realm) never overwrites it.
	const releaseList = ownSavedConnections();
	let listOwner: string | null = null;
	let offLoadWhenActive: (() => void) | null = null;
	const followIdentity = (snapshot: IIdentitySnapshot): void => {
		const owner = snapshot.known ? snapshot.fingerprint : null;
		if (owner === listOwner) return;
		listOwner = owner;
		// The list is per user: a new identity (or none) must not see the last one's.
		resetSavedConnections({ force: true });
		// So are the failures opening its connections.
		failedAfter.clear();
		if (Object.keys(openErrors).length > 0) {
			openErrors = {};
			statusChanged();
		}
		offLoadWhenActive?.();
		offLoadWhenActive = null;
		if (owner === null) return;
		// Read only once the tool is activated (R7). A dev-tool controller's
		// mount is its activation (the hosts mount only a selected or summoned
		// sidebar); the full app opens its gate at once.
		offLoadWhenActive = activation.subscribe(() => {
			if (!disposed && listOwner === owner) void loadSavedConnections(fs);
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
		if (getSavedConnectionsStatus() !== 'ready') {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(done, LIST_WAIT_MS);
				const off = subscribeSavedConnections(() => { if (getSavedConnectionsStatus() === 'ready') done(); });
				function done(): void {
					clearTimeout(timer);
					off();
					resolve();
				}
			});
		}
		if (getSavedConnectionsStatus() !== 'ready') throw unavailable(tool, 'Your saved connections could not be read from the server yet. Try again.');
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

	/** Run a discovery now (only while it is allowed), bounded. */
	const rediscover = async (tool: string): Promise<void> => {
		requireIdentity(tool);
		// A call is an explicit request: it opens the gate (the controller already
		// did so for the op itself).
		activation.open('op');
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
	const locate = async (record: SavedSqlConnection, tool: string): Promise<IExplorerEndpoint> => {
		const legacyKey = endpointKeyForConnection(record);
		let found = match(legacyKey);
		const running = (endpoint: IExplorerEndpoint | undefined): boolean => endpoint !== undefined && endpoint.state !== 'stopped';
		if (!running(found)) {
			if (record.mode === 'direct') {
				requireIdentity(tool);
				await busRequest(cm, 'client.use', directUseOptions(record), USE_TIMEOUT_MS);
			}
			await rediscover(tool);
			found = match(legacyKey);
		}
		if (found === undefined || found.state === 'stopped') {
			const error = found === undefined
				? unavailable(tool, record.mode === 'direct'
					? `The connection '${record.name}' started, but its pipeline was not found running. Try again.`
					: `The pipeline '${record.pipelineName}' is not running in your workspace. Start it and try again.`)
				: unavailable(tool, found.stateDetail ?? `The pipeline '${found.pipelineName}' is not running. Start it and try again.`);
			// A pipeline that is simply not running is Stopped, not unreachable.
			// (A direct connection's pipeline is the app's to start, so it not
			// running after a start is a failure.)
			if (record.mode === 'pipeline') notRunning.add(error);
			throw error;
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

	const applyBatch = (connId: string, statements: SqlApplyStatement[], atomic: boolean, stillAllowed: () => void = () => undefined): Promise<SqlApplyResult> => withSession(connId, async (session, ctx) => {
		const dialect = await ctx.dialect();
		stillAllowed();
		const refusal = gateApplyStatements(statements.map((statement) => statement.sql), dialect, atomic);
		if (refusal !== null) throw new ExplorerToolError({ kind: 'invalid', tool: 'apply', message: refusal });
		// A ClickHouse `begin` reserves a connection but opens no transaction
		// (the node's `_sessionsAreTransactions`): an atomic apply there sends
		// nothing, and the caller asks the user before sending `atomic: false`.
		if (atomic && dialect === 'clickhouse') throw transactionsUnavailable('apply', 'ClickHouse has no transactions, so nothing was applied.');
		return session.applyBatch(statements, { atomic });
	}, 'apply');
	const statusSource = (): ConnectionStatusSource => {
		const state = endpoints.getState();
		return { discovered: state.refreshedAt > 0 ? state.endpoints : null, openErrors };
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
			applyBatch: (statements, options) => applyBatch(connId, statements, options.atomic),
			getSql: (question) => withSession(connId, (session) => session.getSql(question), 'get_sql'),
		};
	};

	return {
		client,
		identity,
		activation,
		discovery,
		endpoints,
		async resolve(connId) {
			const askedBy = identity.get().known ? identity.get().fingerprint : null;
			try {
				const record = await recordOf(connId, 'resolve');
				const found = await locate(record, 'resolve');
				const endpoint = endpointForConnection(record);
				noteOpen(askedBy, connId, null);
				// A pipeline connection is shown by its running pipeline's current
				// name, not the one frozen into the record when it was saved; the
				// key and everything else stay the record's.
				return record.mode === 'pipeline' ? { ...endpoint, pipelineName: found.pipelineName } : endpoint;
			} catch (error) {
				// The sidebar's row says Unreachable, with this text, until it opens
				// or discovery shows it up; a pipeline that is not running says
				// Stopped instead (and an older failure no longer stands).
				noteOpen(askedBy, connId, error instanceof Error && notRunning.has(error) ? null : error);
				throw error;
			}
		},
		keyOf: async (connId) => endpointKeyForConnection(await recordOf(connId, 'history')),
		sessionFor,
		withSession: (connId, fn, tool) => withSession(connId, fn, tool),
		applyBatch,
		async release(connId, key) {
			// Read before the first await: a delete that follows a release in the
			// same turn must not hide the record from it.
			const record = getSavedConnection(connId);
			if (record?.mode !== 'direct' || !identity.get().known) return;
			// Released by the key the caller opened: after an edit the project's
			// pipeline is the edited connection's, and must not be stopped.
			if (key !== undefined && key !== endpointKeyForConnection(record)) return;
			const projectId = directProjectId(record);
			try {
				const token = await busRequest(cm, 'client.getTaskToken', { projectId, source: TOOLS_SOURCE_ID }, RELEASE_STEP_TIMEOUT_MS);
				if (typeof token === 'string' && token !== '') await busRequest(cm, 'client.terminate', { token }, RELEASE_STEP_TIMEOUT_MS);
			} catch {
				// Best effort: the 15-minute idle TTL reaps whatever this leaves behind.
			}
		},
		async pickable() {
			await rediscover('discover');
			return endpoints.getState().endpoints
				.filter((endpoint) => endpoint.legacyKey !== null && endpoint.state !== 'stopped')
				.map(pickerEntry);
		},
		getService: (provider) => busRequest(cm, 'client.getService', { service: provider }, SERVICE_TIMEOUT_MS),
		validate: (pipeline) => busRequest(cm, 'client.validate', { pipeline }, VALIDATE_TIMEOUT_MS),
		async saveConnection(connection, stillAllowed = sameAccount('saveConnection')) {
			const record = checkSavedConnection(connection);
			await listReady('saveConnection');
			stillAllowed();
			upsertSavedConnection(record);
		},
		async setConnectionSafety(connId, safety, stillAllowed = sameAccount('setConnectionSafety')) {
			const invalid = (message: string): ExplorerToolError => new ExplorerToolError({ kind: 'invalid', tool: 'setConnectionSafety', message });
			if (!isSafetyLevel(safety)) throw invalid("The safety level was not saved: it must be 'off', 'risky' or 'every'.");
			await listReady('setConnectionSafety');
			stillAllowed();
			const record = getSavedConnection(connId);
			if (!record) throw invalid(`There is no saved connection '${connId}'.`);
			if (record.safety === safety) return;
			upsertSavedConnection({ ...record, safety });
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
			const keys = await busRequest(cm, 'client.getEnvironmentKeys', {}, ENV_KEYS_TIMEOUT_MS);
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
			activation.dispose();
			identity.dispose();
			offRecovered();
			statusListeners.clear();
		},
		statusSource,
		subscribeStatus(cb) {
			const notify = (): void => cb(statusSource());
			notify();
			const offStore = endpoints.subscribe(notify);
			statusListeners.add(notify);
			return () => {
				offStore();
				statusListeners.delete(notify);
			};
		},
	};
}
