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
// GRAPH ENV - LOCAL (over a realm's own stores and client)
// =============================================================================
//
// The env of a realm that owns the stores: the full app (its module-level
// stores, the workspace prefs) and the dev-tool CONTROLLER (its own stores, an
// fs-backed history, session-only drafts). The client is the realm's
// bus-backed IExplorerClient (null while the realm is not connected): in the
// shell, `cm.request('client.*')` runs in the same realm and keeps every
// error's code; in a VS Code webview the bus bridge carries messages only.
// =============================================================================

import { createMessageGridPersistence } from 'shell';
import type { IDataGridPersistence } from 'shell';
import type { IEndpointStore, IExplorerClient, IHistoryEntry, IHistoryStore, IPrefsAccessor } from 'shared/explorer';
import { createCopyingGridPersistence, createSessionGridPersistence } from 'shared/explorer/devtool/gridPersistence';
import { loadConnectionSchema } from './adapters/actions';
import { countWrite } from './graph/dataVersion';
import type { IDataVersions } from './graph/dataVersion';
import type { IPreviewStore } from './graph/previews';
import type { ISchemaEntry, ISchemaStore } from './graph/schemaStore';
import type { IGraphEndpointsState, IGraphHistoryView } from './devtool/protocol';
import type { DocTarget, GraphMount, IGraphEnv, IGraphHistory, IKeyed, IReadable } from './env';

/** The stores one LOCAL realm owns. */
export interface IGraphStores {
	endpoints: IEndpointStore;
	schemas: ISchemaStore;
	dataVersions: IDataVersions;
	history: IHistoryStore<'cypher'>;
	previews: IPreviewStore;
}

/** What {@link createLocalGraphEnv} needs. */
export interface ILocalGraphEnvOptions {
	mount: Exclude<GraphMount, 'frame'>;
	/** Whether the realm is connected. */
	ready: boolean;
	/** The realm's bus-backed client, or null while not connected. */
	client: IExplorerClient | null;
	stores: IGraphStores;
	activeConnection: IReadable<string | null>;
	openDocument(target: DocTarget): void;
	prefs: IPrefsAccessor;
	historyPrivacyNote: string;
	/** Override discovery (the controller gates it on identity and activation). */
	refresh?: IGraphEnv['refresh'];
}

/**
 * The full app's grid layouts: its own workspace prefs, through the shell's
 * grid config channel, but stored and handed out as plain-JSON copies, so
 * Tabulator never rewrites a stored layout in place
 * (shared/explorer/devtool/gridPersistence). The channel is made on first use.
 */
const APP_GRIDS: IDataGridPersistence = createCopyingGridPersistence(() => createMessageGridPersistence());

/** The controller's: a dev-tool mount never writes the host's prefs, so any layout stays in the session (it renders no grid today). */
const CONTROLLER_GRIDS: IDataGridPersistence = createSessionGridPersistence();

const NO_LABELS: readonly string[] = [];

/** Label names per schema view object, so a snapshot read twice is the same array. */
const labelCache = new WeakMap<object, readonly string[]>();

/**
 * A schema entry's label names (stable per view object).
 *
 * @param entry - The entry.
 * @returns The names.
 */
function labelsOf(entry: ISchemaEntry): readonly string[] {
	if (entry.view.labels.length === 0) return NO_LABELS;
	const cached = labelCache.get(entry.view);
	if (cached) return cached;
	const names = entry.view.labels.map((label) => label.name);
	labelCache.set(entry.view, names);
	return names;
}

/** Endpoint snapshots with `omitted: 0`, per store snapshot. */
const endpointCache = new WeakMap<object, IGraphEndpointsState>();

/**
 * History over a LOCAL history store.
 *
 * @param store - The store.
 * @returns The history API.
 */
export function localHistory(store: IHistoryStore<'cypher'>): IGraphHistory {
	const views = new Map<string, IReadable<IGraphHistoryView>>();
	return {
		view(key) {
			let readable = views.get(key);
			if (!readable) {
				let last: IGraphHistoryView | null = null;
				readable = {
					get: () => {
						const entries = store.getHistory(key);
						const recording = store.getRecording(key);
						if (last === null || last.entries !== entries || last.recording !== recording) last = { entries, recording };
						return last;
					},
					subscribe: store.subscribe,
				};
				views.set(key, readable);
			}
			return readable;
		},
		record: (key: string, entry: IHistoryEntry<'cypher'>) => store.runs.emitRun(key, entry),
		// Applied at once in this realm; a promise like the dev-tool frame's, so callers confirm the same way.
		removeEntry: async (key, id) => store.removeEntry(key, id),
		togglePin: async (key, id) => store.togglePin(key, id),
		setNote: async (key, id, note) => store.setNote(key, id, note),
		clearForKey: async (key) => store.clearForKey(key),
		setRecording: async (key, on) => store.setRecording(key, on),
	};
}

/**
 * Create a LOCAL env.
 *
 * @param opts - See {@link ILocalGraphEnvOptions}.
 * @returns The env.
 */
export function createLocalGraphEnv(opts: ILocalGraphEnvOptions): IGraphEnv {
	const { client, stores } = opts;
	const endpoints: IReadable<IGraphEndpointsState> = {
		get: () => {
			const state = stores.endpoints.getState();
			let snapshot = endpointCache.get(state);
			if (!snapshot) {
				snapshot = { ...state, omitted: 0 };
				endpointCache.set(state, snapshot);
			}
			return snapshot;
		},
		subscribe: stores.endpoints.subscribe,
	};
	const schemaLabels: IKeyed<readonly string[]> = { get: (key) => labelsOf(stores.schemas.get(key)), subscribe: stores.schemas.subscribe };
	const dataVersions: IKeyed<number> = { get: (key) => stores.dataVersions.get(key), subscribe: stores.dataVersions.subscribe };
	return {
		mount: opts.mount,
		ready: opts.ready,
		endpoints,
		refresh: opts.refresh ?? ((o) => (client ? stores.endpoints.refresh(client, { reprobe: o?.reprobe === true }) : Promise.resolve())),
		probe: (key) => (client ? stores.endpoints.probe(client, key) : Promise.resolve(null)),
		schemaLabels,
		schemas: stores.schemas,
		loadSchema: (key, o) => {
			const endpoint = stores.endpoints.getState().endpoints.find((e) => e.key === key);
			if (!client || !endpoint) return Promise.resolve();
			return loadConnectionSchema(client, endpoint, o ?? {}, { endpoints: stores.endpoints, schemas: stores.schemas });
		},
		session: (endpoint) => (client ? stores.endpoints.session(client, endpoint) : null),
		dataVersions,
		countWrite: (key, send) => countWrite(stores.dataVersions, key, send),
		markAbandonedWrite: (key) => stores.dataVersions.bump(key),
		history: localHistory(stores.history),
		previews: {
			pending: { get: stores.previews.get, subscribe: stores.previews.subscribe },
			request: (input) => {
				stores.previews.request(input);
			},
			consume: (nonce) => stores.previews.consume(nonce),
		},
		activeConnection: opts.activeConnection,
		gridPersistence: opts.mount === 'app' ? APP_GRIDS : CONTROLLER_GRIDS,
		openDocument: opts.openDocument,
		prefs: opts.prefs,
		historyPrivacyNote: opts.historyPrivacyNote,
	};
}
