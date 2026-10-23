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
// GRAPH-UI - DEV-TOOL CONTROLLER (the sidebar mount: the tool's one engine connection)
// =============================================================================
//
// A plain function over injected parts (the realm's ConnectionManager as a
// structural type, the peer, the host's channel and the shell's protocol
// factories), so it runs under node:test against the real shell modules. The
// React mount (GraphDevToolSidebar.tsx) calls it in an effect and disposes it
// in the cleanup (R6).
//
// What it owns (R1): its OWN endpoint store, schema store, data versions,
// history and preview request; the bus-backed client; the identity tracker,
// the activation gate and the discovery watch; and every op handler.
//
//   QUIET (R7)  At mount it publishes retained state only: no event, no call,
//               no document, no engine request. Discovery waits for identity
//               AND activation (devtool/watch.ts); history is read only once
//               the tool is activated and an identity is known.
//   GATES (T10) graph.execute re-checks the write gate (canWrite on the
//               node's own dialect answer, and a ready endpoint) HERE, whatever
//               the frame believed, and counts the write (countWrite) here too,
//               so `dataVersions` moves for every frame of the connection.
//   IDENTITY    A different identity (or none) resets the endpoint store (the
//               watch), and here clears the schema snapshots and the pending
//               preview and re-binds history to the new owner's bag; frames
//               close themselves on the published fingerprint (R9).
//   SIZES (T11) Rows and history lists are op results. Retained snapshots are
//               cut by the protocol (protocol.ts) and kept by the base guard
//               under 64 KiB each and 128 KiB together, degraded through the
//               same cuts; a result over maxResultBytes is refused, not sent.
// =============================================================================

import type { DevToolProps, IToolOpServer, ToolChannel } from 'shell';
import { ExplorerToolError, createActiveKeyStore } from 'shared/explorer';
import type { IExplorerClient, IExplorerEndpoint, IHistoryEntry } from 'shared/explorer';
import { createActivationGate } from 'shared/explorer/devtool/activation';
import type { IActivationBus, IActivationGate } from 'shared/explorer/devtool/activation';
import { getBusExplorerClient } from 'shared/explorer/devtool/busClient';
import type { IExplorerBus } from 'shared/explorer/devtool/busClient';
import { attachController } from 'shared/explorer/devtool/controller';
import type { RequiredControllerHandlers } from 'shared/explorer/devtool/controller';
import { publishIdentityState } from 'shared/explorer/devtool/frameIdentity';
import { createIdentityTracker } from 'shared/explorer/devtool/identity';
import type { IIdentityBus, IIdentityTracker } from 'shared/explorer/devtool/identity';
import { attachWhenLoaded, createFsPrefs, historyPrefsPath } from 'shared/explorer/devtool/prefs';
import type { DevToolPeer } from 'shared/explorer/devtool/realm';
import { replyOk } from 'shared/explorer/devtool/reply';
import { guardRetainedState, jsonByteLength } from 'shared/explorer/devtool/state';
import type { IOversizeInfo } from 'shared/explorer/devtool/state';
import { createDevToolDiscovery } from 'shared/explorer/devtool/watch';
import type { IDevToolDiscovery, IDiscoveryBus, IFocusTarget } from 'shared/explorer/devtool/watch';
import { loadConnectionSchema } from '../adapters/actions';
import { TOOL, makeGraphEndpointStore, makeGraphHistory } from '../adapters/explorer';
import { DEVTOOL_HISTORY_PRIVACY_NOTE, memoryPrefs } from '../env';
import type { DocTarget, IGraphEnv, IReadable } from '../env';
import { endpointKeyFromUri } from '../graph/addresses';
import { countWrite, createDataVersions } from '../graph/dataVersion';
import { canWrite, parseDialect } from '../graph/dialect';
import { createPreviewStore } from '../graph/previews';
import { createSchemaStore } from '../graph/schemaStore';
import type { ReadQueryResult } from '../graph/types';
import { createLocalGraphEnv } from '../localEnv';
import type { IGraphStores } from '../localEnv';
import { adoptParkedHistory, ownerNowOf, parkHistory, settleOwed } from './owedHistory';
import type { IOwedHistory, IVouch } from './owedHistory';
import { EVENT, GRAPH_APP_ID, OP, STATE, docKeyFor, endpointsSnapshot, field, schemasSnapshot, toWire, versionsSnapshot } from './protocol';
import type { GraphOps, HistoryEdit, IGraphHistoryView } from './protocol';

/** What the controller needs from its realm's ConnectionManager (structural; tests pass the base's fake realms). */
export type IGraphRealm = IIdentityBus & IActivationBus & IDiscoveryBus & IExplorerBus;

/** The largest result the controller sends to a frame (well above the node's own bounds; see T11). */
export const MAX_GRAPH_RESULT_BYTES = 32 * 1024 * 1024;

/** Said when a frame asks for a write the connection does not allow (nothing was sent). */
export const WRITE_REFUSED_TEXT = 'This connection does not allow writes: its node has direct execution off, does not support the graph result shape, or has not answered its check. Nothing was sent.';

/** What {@link createGraphController} needs. */
export interface IGraphControllerOptions {
	/** The realm's ConnectionManager. */
	cm: IGraphRealm;
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
	createToolOpServer: (peer: DevToolPeer) => IToolOpServer<GraphOps>;
	/** The tool's app id (default rocketride.graph). */
	appId?: string;
	/** The clock (deadlines, previews). */
	now?: () => number;
	/** Where focus comes from (null in tests). */
	focusTarget?: IFocusTarget | null;
	/** The largest result sent to a frame (default MAX_GRAPH_RESULT_BYTES). */
	maxResultBytes?: number;
	/** Replace a store (tests). */
	stores?: Partial<IGraphStores>;
	/** Told about refused calls, oversize state and history file failures. */
	onError?: (error: unknown, where: string) => void;
}

/** A mounted controller. */
export interface IGraphController {
	readonly channel: ToolChannel;
	readonly stores: IGraphStores;
	readonly client: IExplorerClient;
	readonly identity: IIdentityTracker;
	readonly activation: IActivationGate;
	readonly discovery: IDevToolDiscovery;
	/** The connection the fronted document belongs to. */
	readonly activeConnection: IReadable<string | null>;
	/** Feed every new activeDocKey prop value. */
	noteActiveDocKey(key: string | null | undefined): void;
	/** The LOCAL env the sidebar's views use (rebuild it when the realm's connection flag changes). */
	env(ready: boolean): IGraphEnv;
	/** Dispose everything (idempotent). History still pending is written first. */
	dispose(): void;
}

/**
 * Mount the Graph Explorer controller.
 *
 * @param opts - See {@link IGraphControllerOptions}.
 * @returns The controller; dispose it in the mount's cleanup.
 */
export function createGraphController(opts: IGraphControllerOptions): IGraphController {
	const { cm, peer } = opts;
	const appId = opts.appId ?? GRAPH_APP_ID;
	const now = opts.now ?? Date.now;
	const maxResultBytes = opts.maxResultBytes ?? MAX_GRAPH_RESULT_BYTES;
	const report = (error: unknown, where: string): void => opts.onError?.(error, where);
	const client = getBusExplorerClient(cm);
	const stores: IGraphStores = {
		endpoints: opts.stores?.endpoints ?? makeGraphEndpointStore(),
		schemas: opts.stores?.schemas ?? createSchemaStore(),
		dataVersions: opts.stores?.dataVersions ?? createDataVersions(),
		history: opts.stores?.history ?? makeGraphHistory(),
		previews: opts.stores?.previews ?? createPreviewStore({ now }),
	};
	const identity = createIdentityTracker({ cm });
	const activation = createActivationGate({ appId, cm, ...(opts.activeDocKey !== undefined ? { activeDocKey: opts.activeDocKey } : {}) });
	const discovery = createDevToolDiscovery({ cm, client, identity, activation, ...(opts.focusTarget !== undefined ? { focusTarget: opts.focusTarget } : {}) });
	const offs: Array<() => void> = [];
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

	// ── Op handlers: each answers a Reply (attachController wraps escaping failures) ────────────
	const keyOf = (params: unknown, op: string): string => {
		const key = field(params, 'key');
		if (typeof key !== 'string' || key === '') throw new ExplorerToolError({ kind: 'invalid', tool: op, message: `${op} needs a connection key.` });
		return key;
	};
	const textOf = (params: unknown, name: string, op: string): string => {
		const value = field(params, name);
		if (typeof value !== 'string') throw new ExplorerToolError({ kind: 'invalid', tool: op, message: `${op} needs ${name} as text.` });
		return value;
	};
	const endpointOf = (key: string, tool: string): IExplorerEndpoint => {
		const endpoint = stores.endpoints.getState().endpoints.find((candidate) => candidate.key === key);
		if (!endpoint) throw new ExplorerToolError({ kind: 'unavailable', tool, message: 'This connection is not listed any more. Refresh the connections.' });
		return endpoint;
	};
	const sized = <T>(result: T, tool: string): T => {
		const bytes = jsonByteLength(result);
		if (bytes > maxResultBytes) {
			const mb = (n: number): string => (n / (1024 * 1024)).toFixed(1);
			throw new ExplorerToolError({ kind: 'malformed', tool, message: `The result is ${mb(bytes)} MB, too large to send to this window (the limit is ${mb(maxResultBytes)} MB). Lower the row limit, or return fewer or smaller properties.` });
		}
		return result;
	};
	const applyEdit = (key: string, edit: HistoryEdit): void => {
		const history = stores.history;
		switch (edit.action) {
			case 'record': {
				const entry = edit.entry as unknown;
				if (typeof field(entry, 'id') !== 'string' || typeof field(entry, 'cypher') !== 'string' || typeof field(entry, 'at') !== 'number') {
					throw new ExplorerToolError({ kind: 'invalid', tool: OP.historyEdit, message: 'A history entry needs an id, a statement and a time.' });
				}
				history.runs.emitRun(key, entry as IHistoryEntry<'cypher'>);
				return;
			}
			case 'remove':
				history.removeEntry(key, edit.id);
				return;
			case 'pin':
				history.togglePin(key, edit.id);
				return;
			case 'note':
				history.setNote(key, edit.id, edit.note);
				return;
			case 'clear':
				history.clearForKey(key);
				return;
			case 'recording':
				history.setRecording(key, edit.on === true);
				return;
			default:
				throw new ExplorerToolError({ kind: 'invalid', tool: OP.historyEdit, message: 'Unknown history change.' });
		}
	};
	const editOf = (params: unknown): HistoryEdit => {
		const edit = field(params, 'edit');
		const action = field(edit, 'action');
		const id = field(edit, 'id');
		const needsId = action === 'remove' || action === 'pin' || action === 'note';
		if (typeof action !== 'string' || (needsId && typeof id !== 'string') || (action === 'note' && typeof field(edit, 'note') !== 'string')) {
			throw new ExplorerToolError({ kind: 'invalid', tool: OP.historyEdit, message: 'Unknown history change.' });
		}
		return edit as HistoryEdit;
	};

	// Every op has a handler (RequiredControllerHandlers): a frame never meets "No handler serves".
	const handlers: RequiredControllerHandlers<GraphOps> = {
		[OP.refreshEndpoints]: (params) => {
			if (!discovery.allowed()) throw new ExplorerToolError({ kind: 'unavailable', tool: OP.refreshEndpoints, message: 'Not signed in to a server yet, so nothing was discovered.' });
			void stores.endpoints.refresh(client, { reprobe: field(params, 'reprobe') === true });
			return replyOk(null);
		},
		[OP.probe]: async (params) => replyOk(await stores.endpoints.probe(client, keyOf(params, OP.probe))),
		[OP.loadSchema]: (params) => {
			const endpoint = endpointOf(keyOf(params, OP.loadSchema), TOOL.getSchema);
			void loadConnectionSchema(client, endpoint, { fresh: field(params, 'fresh') === true }, { endpoints: stores.endpoints, schemas: stores.schemas });
			return replyOk(null);
		},
		[OP.readQuery]: async (params) => {
			const endpoint = endpointOf(keyOf(params, OP.readQuery), TOOL.readQuery);
			const cypher = textOf(params, 'cypher', OP.readQuery);
			const input = field(params, 'params');
			const limit = field(params, 'limit');
			if (typeof limit !== 'number' || !(input !== null && typeof input === 'object' && !Array.isArray(input))) {
				throw new ExplorerToolError({ kind: 'invalid', tool: TOOL.readQuery, message: 'read_query needs its params and a row limit.' });
			}
			const result = await stores.endpoints.session(client, endpoint).invoke<ReadQueryResult>(TOOL.readQuery, { cypher, params: input as Record<string, unknown>, limit });
			return replyOk(sized(result, TOOL.readQuery));
		},
		[OP.execute]: async (params) => {
			const key = keyOf(params, OP.execute);
			const endpoint = endpointOf(key, TOOL.execute);
			const query = textOf(params, 'query', OP.execute);
			// T10: the gate is the CONTROLLER's, whatever the frame believed.
			const probe = stores.endpoints.getState().probes[key];
			const dialect = probe?.ok ? parseDialect(probe.info) : null;
			if (endpoint.state !== 'ready' || !canWrite(dialect)) throw new ExplorerToolError({ kind: 'unavailable', tool: TOOL.execute, message: WRITE_REFUSED_TEXT });
			const session = stores.endpoints.session(client, endpoint);
			const result = await countWrite(stores.dataVersions, key, () => session.invoke<ReadQueryResult>(TOOL.execute, { query, shape: 'graph' }));
			return replyOk(sized(result, TOOL.execute));
		},
		[OP.ask]: async (params) => {
			const endpoint = endpointOf(keyOf(params, OP.ask), TOOL.getQuery);
			const question = textOf(params, 'question', OP.ask);
			return replyOk(await stores.endpoints.session(client, endpoint).invoke<unknown>(TOOL.getQuery, { question }));
		},
		[OP.historyList]: (params) => {
			const key = keyOf(params, OP.historyList);
			const view: IGraphHistoryView = { entries: stores.history.getHistory(key), recording: stores.history.getRecording(key) };
			return replyOk(toWire(view));
		},
		[OP.historyEdit]: (params) => {
			applyEdit(keyOf(params, OP.historyEdit), editOf(params));
			return replyOk(null);
		},
		[OP.writeAbandoned]: (params) => {
			stores.dataVersions.bump(keyOf(params, OP.writeAbandoned));
			return replyOk(null);
		},
	};

	// ── The channel first, then the ONE op server (attachController, R6) ────────────────────────
	const attached = attachController<GraphOps>({
		peer,
		...(opts.channel ? { channel: opts.channel } : {}),
		createToolChannel: opts.createToolChannel,
		createToolOpServer: opts.createToolOpServer,
		handlers,
		now,
		onFirstOp: () => activation.open('op'),
		onRefused: (error) => report(error, 'refused'),
	});
	// The guard DEGRADES an oversize snapshot through `shrink` (here: the protocol's own cuts at the budget the guard
	// leaves, so `omitted` and the newest-first schema order stay true; never the generic `truncated` marker), and
	// keeps the whole map under its total budget. Only a WITHHELD snapshot was not published.
	const entriesOf = () => stores.schemas.keys().map((key) => [key, stores.schemas.get(key)] as const);
	const shrink = (topic: string, snapshot: unknown, info: IOversizeInfo): unknown => {
		if (topic === STATE.endpoints) return endpointsSnapshot(stores.endpoints.getState(), info.budgetBytes);
		if (topic === STATE.schemas) return schemasSnapshot(entriesOf(), info.budgetBytes);
		if (topic === STATE.dataVersions) return versionsSnapshot(stores.dataVersions.snapshot(), shownKeys, info.budgetBytes);
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
	// The connections the frames can show: the data versions keep theirs first.
	let shownKeys: ReadonlySet<string> = new Set();
	const publishEndpoints = (): void => {
		const snapshot = endpointsSnapshot(stores.endpoints.getState());
		shownKeys = new Set(snapshot.endpoints.map((endpoint) => endpoint.key));
		publish(STATE.endpoints, snapshot);
		publishVersions();
	};
	const publishSchemas = (): void => publish(STATE.schemas, schemasSnapshot(entriesOf()));
	function publishVersions(): void {
		publish(STATE.dataVersions, versionsSnapshot(stores.dataVersions.snapshot(), shownKeys));
	}
	let historyRev = 0;
	const publishHistory = (): void => publish(STATE.history, { rev: historyRev });
	const publishPreviews = (): void => publish(STATE.previews, { pending: stores.previews.get() });
	offs.push(stores.endpoints.subscribe(publishEndpoints));
	offs.push(stores.schemas.subscribe(publishSchemas));
	offs.push(stores.dataVersions.subscribe(publishVersions));
	offs.push(stores.history.subscribe(() => {
		historyRev += 1;
		publishHistory();
	}));
	offs.push(stores.previews.subscribe(publishPreviews));
	publishEndpoints();
	publishSchemas();
	publishVersions();
	publishHistory();
	publishPreviews();
	offs.push(publishIdentityState(channel, identity));

	// ── Frame events: `active` (the fallback for the fronted document, and a taken preview) ─────
	offs.push(attached.channel.onEvent(EVENT.active, (payload) => {
		const docKey = field(payload, 'docKey');
		const consumed = field(payload, 'consumed');
		if (typeof consumed === 'string') stores.previews.consume(consumed);
		if (typeof docKey === 'string') {
			eventActive = docKey;
			syncActive();
		}
	}));

	// ── Discovery: the store follows identity, activation, task events and focus ────────────────
	offs.push(stores.endpoints.attach(client, identity.get().identity, discovery.watch));

	// ── Identity: what belonged to the previous one goes ────────────────────────────────────────
	let fingerprint = identity.get().known ? identity.get().fingerprint : null;
	offs.push(identity.subscribe((snapshot) => {
		const next = snapshot.known ? snapshot.fingerprint : null;
		if (next === fingerprint) return;
		fingerprint = next;
		stores.schemas.clear();
		stores.previews.clear();
		syncHistory();
	}));

	// ── History: an fs-backed bag per identity, loaded before it is attached (§3.5) ─────────────
	// One accessor per identity. Its `ownerNow` reads this controller's identity tracker: the owner known (write), nobody
	// known (the base HOLDS the write), someone else (the base DROPS it). See owedHistory.ts for HELD and PARKED.
	const historyPath = historyPrefsPath('graph');
	let current: IOwedHistory | null = null;
	let held: IOwedHistory | null = null;
	let detachHistory: (() => void) | null = null;
	let historyOwner: string | null = null;
	const newAccessor = (owner: string): IOwedHistory => {
		const vouch: IVouch = { tracker: identity };
		const prefs = createFsPrefs({ cm, path: historyPath, owner, ownerNow: ownerNowOf(vouch), onError: (error, phase) => report(error, `history ${phase}`) });
		return { owner, prefs, vouch };
	};
	function syncHistory(): void {
		const owner = activation.isOpen() && identity.get().known ? identity.get().fingerprint : null;
		if (owner === historyOwner) return;
		// 1. The batch still in the store's debounce is the PREVIOUS owner's: hand it to that owner's accessor before the
		//    detach drops it. A disconnect, a sign-out or an account switch reaches the identity tracker before anything
		//    unmounts, so this is where the last batch is saved (dispose() comes too late for it).
		stores.history.flush();
		detachHistory?.();
		detachHistory = null;
		// 2. Forget the previous owner's history in memory NOW: an attach under the new owner (or under none) makes the
		//    store drop what it held for anyone else, and the immediate detach leaves nothing attached. Nothing of A is
		//    served to B while B's file loads; the file-backed attach below hydrates the new owner's bag.
		stores.history.attachPrefs(memoryPrefs(), owner)();
		const previous = current;
		current = null;
		historyOwner = owner;
		if (previous) {
			if (owner === null) {
				// Nobody known (a disconnect, a sign-out): HOLD the accessor. The base holds its write until the tracker
				// knows who is back; it is re-used for the same owner and settled (dropped) for another.
				if (held) void settleOwed(held);
				held = previous;
			} else {
				// Another identity is known: the base drops the previous owner's change ('other'), never into B's file.
				void settleOwed(previous);
			}
		}
		if (owner === null || disposed) return;
		// 3. What is owed to this owner: the accessor this controller held, or one an unmounted controller parked in
		//    this realm. Re-using it (not a fresh read of the file) keeps the change; its write goes out now.
		let owed: IOwedHistory | null = null;
		if (held) {
			if (held.owner === owner) owed = held;
			else void settleOwed(held);
			held = null;
		}
		const parked = adoptParkedHistory(historyPath, owner, identity);
		if (parked && owed) void settleOwed(parked);
		else if (parked) owed = parked;
		current = owed ?? newAccessor(owner);
		detachHistory = attachWhenLoaded(current.prefs, (api, who) => stores.history.attachPrefs(api, who));
		if (owed) void owed.prefs.flush();
	}
	offs.push(activation.subscribe(() => syncHistory()));

	// ── The sidebar's own env (LOCAL, over these stores) ─────────────────────────────────────────
	const openDocument = (target: DocTarget): void => {
		activation.open('user');
		const documents = opts.documents;
		if (!documents) return;
		if (target.kind === 'connections') documents.open('', 'Graph Explorer');
		else documents.open(docKeyFor(target.kind, target.endpoint.key), target.kind === 'write' ? `${target.endpoint.nodeName || 'Graph'} (write)` : target.endpoint.nodeName || 'Graph');
	};
	const sidebarPrefs = memoryPrefs();
	const activeConnection: IReadable<string | null> = { get: active.get, subscribe: active.subscribe };
	let lastEnv: { ready: boolean; env: IGraphEnv } | null = null;

	return {
		channel: attached.channel,
		stores,
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
			const local = createLocalGraphEnv({
				mount: 'controller',
				ready,
				client: ready ? client : null,
				stores,
				activeConnection,
				openDocument,
				prefs: sidebarPrefs,
				historyPrivacyNote: DEVTOOL_HISTORY_PRIVACY_NOTE,
				refresh: (o) => {
					// A refresh asked for in the sidebar; an automatic one (quiet) is not the user activating the tool.
					if (!o?.quiet) activation.open('user');
					return discovery.allowed() ? stores.endpoints.refresh(client, { reprobe: o?.reprobe === true }) : Promise.resolve();
				},
			});
			// The sidebar loads the active connection's schema by itself (an effect): that is not a user action, and a
			// connection can only be active once the tool is, so loadSchema opens nothing.
			const env: IGraphEnv = {
				...local,
				previews: {
					...local.previews,
					request: (input) => {
						activation.open('user');
						local.previews.request(input);
					},
				},
			};
			lastEnv = { ready, env };
			return env;
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const off of offs.splice(0)) off();
			// The last batch still in the history store's debounce goes to the current accessor before the detach drops
			// it. (A disconnect or a sign-out reached the identity first: syncHistory already handed it to the HELD one.)
			stores.history.flush();
			detachHistory?.();
			detachHistory = null;
			const owed = current ?? held;
			current = null;
			held = null;
			discovery.dispose();
			activation.dispose();
			attached.dispose();
			const snapshot = identity.get();
			if (owed && !(snapshot.known && snapshot.fingerprint === owed.owner)) {
				// Unmounted while nobody (or someone else) is known, as VS Code does on a disconnect: PARK the accessor with
				// this realm's tracker. The next controller adopts it; otherwise it writes when its owner is back, drops its
				// change for another account, and is released after PARKED_HISTORY_TTL_MS.
				parkHistory(historyPath, owed, identity);
				return;
			}
			// Unmounted under its own owner (still connected): write now, then stop. The tracker goes once that is done.
			if (owed) void owed.prefs.close().then(() => identity.dispose(), () => identity.dispose());
			else identity.dispose();
		},
	};
}
