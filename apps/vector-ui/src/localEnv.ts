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
// VECTOR ENV - LOCAL (over a realm's own endpoint store and client; pure)
// =============================================================================
//
// The env of a realm that owns an endpoint store: the full app (the app's
// store singleton, its SDK client, the app's connection registry) and the
// dev-tool CONTROLLER (its own store over the bus-backed client). The client
// is null while the realm is not connected: nothing is sent then, and a call
// a view makes anyway fails with a sentence (adapters/connections.ts).
// =============================================================================

import type { IEndpointStore, IExplorerClient, IExplorerEndpoint } from 'shared/explorer';
import { probeAware, probeAwareChannel, vectorChannels } from './adapters/actions';
import type { IConnectionLink, IConnectionRegistry } from './adapters/connections';
import { NO_CHANNELS } from './env';
import type { IQueryHistorySource, IReadable, IVectorEndpointsState, IVectorEnv } from './env';

/** What {@link createLocalVectorEnv} needs. */
export interface ILocalVectorEnvOptions {
	/** Whether the realm is connected. */
	ready: boolean;
	/** The realm's client (the full app's SDK client, the controller's bus client), or null while not connected. */
	client: IExplorerClient | null;
	/** The realm's endpoint store. */
	store: IEndpointStore;
	/** The mount's connection registry. */
	registry: IConnectionRegistry;
	/** The Query tab's history (the full app's persisted one; the controller's in memory). */
	queryHistory: IQueryHistorySource;
	/** The connection the fronted document belongs to. */
	activeConnection: IReadable<string | null>;
	/** Open (or focus) a connection's console. */
	openConsole(endpoint: IExplorerEndpoint): void;
	/** Open (or focus) one stored document. */
	openDocument(endpoint: IExplorerEndpoint, objectId: string, path: string | null, chunkId?: number): void;
	/** Override discovery (the controller gates it on identity and activation). */
	refresh?: IVectorEnv['refresh'];
}

/** Endpoint snapshots with `omitted: 0`, per store snapshot (stable between changes). */
const snapshots = new WeakMap<object, IVectorEndpointsState>();

/**
 * Create a LOCAL env.
 *
 * @param opts - See {@link ILocalVectorEnvOptions}.
 * @returns The env.
 */
export function createLocalVectorEnv(opts: ILocalVectorEnvOptions): IVectorEnv {
	const { store, registry } = opts;
	const client = opts.ready ? opts.client : null;
	const link = client === null ? null : linkOver(store, client);
	const endpoints: IReadable<IVectorEndpointsState> = {
		get: () => {
			const state = store.getState();
			let snapshot = snapshots.get(state);
			if (!snapshot) {
				snapshot = { ...state, omitted: 0 };
				snapshots.set(state, snapshot);
			}
			return snapshot;
		},
		subscribe: store.subscribe,
	};
	return {
		kind: 'local',
		ready: opts.ready,
		endpoints,
		refresh: opts.refresh ?? ((o) => (client ? store.refresh(client, { reprobe: o?.reprobe === true }) : Promise.resolve())),
		probe: (key) => (client ? store.probe(client, key) : Promise.resolve(null)),
		// A call refused for want of a probe that answered says so (probeAware), never "update the node".
		session: (endpoint) => (client ? probeAware(store.session(client, endpoint), () => probedOn(store, endpoint.key)) : null),
		channels: (endpoint) => {
			if (!client) return NO_CHANNELS;
			const channels = vectorChannels(store, client, endpoint);
			return channels.tools === null ? channels : { ...channels, tools: probeAwareChannel(channels.tools, () => probedOn(store, endpoint.key)) };
		},
		connection: (endpoint, limits) => registry.entry(endpoint, link, limits),
		existingConnection: (key) => registry.existing(key),
		consoleModel: (model) => model,
		openConsole: opts.openConsole,
		openDocument: opts.openDocument,
		activeConnection: opts.activeConnection,
		degraded: null,
		queryHistory: opts.queryHistory,
	};
}

/**
 * How the realm's connection entries call the store: its sessions and probes, on this client.
 *
 * @param store - The realm's store.
 * @param client - The client.
 * @returns The link.
 */
export function linkOver(store: Pick<IEndpointStore, 'session' | 'probe' | 'getState'>, client: IExplorerClient): IConnectionLink {
	return {
		session: (endpoint) => store.session(client, endpoint),
		reprobe: (endpointKey) =>
			store.probe(client, endpointKey).then(
				() => undefined,
				() => undefined
			),
		probed: (endpointKey) => probedOn(store, endpointKey),
	};
}

/**
 * Whether the store answered its last probe of an endpoint.
 *
 * @param store - The realm's store.
 * @param endpointKey - The endpoint.
 * @returns False when the probe failed or none ran.
 */
function probedOn(store: Pick<IEndpointStore, 'getState'>, endpointKey: string): boolean {
	return store.getState().probes[endpointKey]?.ok === true;
}
