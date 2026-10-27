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
// GRAPH ENV - the one seam every view reaches the engine and the stores through
// =============================================================================
//
// Views never call useShellConnection, usePrefs or the adapter's singletons:
// they call useGraphEnv() (or the hooks below). Two implementations sit behind
// the one context:
//
//   LOCAL  (localEnv.ts)        over a realm's own stores and its bus-backed
//                               client: the full app (`app:`) and the dev-tool
//                               CONTROLLER (the sidebar mount).
//   REMOTE (devtool/frame.ts)   over controller ops and retained state: every
//                               dev-tool document FRAME, which holds no client.
//
// This module is types, the context and hooks only: nothing here owns a store,
// a client or a token, so a frame can import it.
// =============================================================================

import { createContext, useContext, useSyncExternalStore } from 'react';
import type { IDataGridPersistence } from 'shell';
import type { IExplorerEndpoint, IHistoryEntry, IPrefsAccessor, IProbeResult, IToolSession } from 'shared/explorer';
import type { IGraphEndpointsState, IGraphHistoryView } from './devtool/protocol';
import type { IGraphPreview, PreviewAction } from './graph/previews';
import type { ISchemaView } from './graph/schema';
import type { ISchemaStore } from './graph/schemaStore';
import type { IGraphUserData, ISavedQueriesView, IStyleView } from './graph/userData';

/** A value that changes, readable outside React (useSyncExternalStore-friendly: `get` is stable between changes). */
export interface IReadable<T> {
	get(): T;
	subscribe(listener: () => void): () => void;
}

/** A keyed value that changes (`get(key)` is stable between changes). */
export interface IKeyed<T> {
	get(key: string): T;
	subscribe(listener: () => void): () => void;
}

/**
 * History, as every mount offers it (the full app's prefs-backed store, or the controller's, over ops). A change
 * resolves once it is APPLIED (in a dev-tool frame: when the controller's Reply says so) and rejects with the reason
 * otherwise, so nothing is announced as done before it is.
 */
export interface IGraphHistory {
	/** One connection's entries and recording switch (one stable readable per key). */
	view(key: string): IReadable<IGraphHistoryView>;
	/** Record a finished run (dropped when recording is off for the connection); a failure is reported by the mount. */
	record(key: string, entry: IHistoryEntry<'cypher'>): void;
	removeEntry(key: string, id: string): Promise<void>;
	togglePin(key: string, id: string): Promise<void>;
	setNote(key: string, id: string, note: string): Promise<void>;
	clearForKey(key: string): Promise<void>;
	setRecording(key: string, on: boolean): Promise<void>;
}

/** A document a view asks to open. */
export type DocTarget = { kind: 'connections' } | { kind: 'workbench' | 'write'; endpoint: IExplorerEndpoint };

/** Which mount an env serves. */
export type GraphMount = 'app' | 'controller' | 'frame';

/** The engine surface and stores a Graph Explorer view may use. */
export interface IGraphEnv {
	/** Which mount this is. */
	mount: GraphMount;
	/** Whether the engine is reachable (frames: the host's `host:connection`). Drives run/apply enablement. */
	ready: boolean;
	/** Discovered connections and their probes. */
	endpoints: IReadable<IGraphEndpointsState>;
	/**
	 * Discover (and probe) now; failures show in `endpoints`. `quiet`: an automatic refresh (a mount) says nothing when
	 * it is refused (the state says what happened); one a person asked for says why.
	 */
	refresh(opts?: { reprobe?: boolean; quiet?: boolean }): Promise<void>;
	/** Test one connection again (null: nothing was tested). */
	probe(key: string): Promise<IProbeResult | null>;
	/** A connection's schema label names (graph colours). */
	schemaLabels: IKeyed<readonly string[]>;
	/** The full schema store: only where the schema tree is drawn (the full app and the controller), else null. */
	schemas: ISchemaStore | null;
	/**
	 * A connection's full schema view (labels and relationship types with their properties, endpoints and counts), or
	 * null until a load of it has completed. Every mount has it: a frame fetches it from the controller.
	 */
	schemaView: IKeyed<ISchemaView | null>;
	/** Load (or, with `fresh`, refresh) a connection's schema; never rejects. */
	loadSchema(key: string, opts?: { fresh?: boolean }): Promise<void>;
	/** A session on a connection (null while it cannot be called). */
	session(endpoint: IExplorerEndpoint): IToolSession | null;
	/** Per connection: has something that can change data run there? */
	dataVersions: IKeyed<number>;
	/** Send a write and count it where it may have changed data (the controller counts it itself). */
	countWrite<T>(key: string, send: () => Promise<T>): Promise<T>;
	/** A write the user stopped waiting for: drawn graphs go out of date now. */
	markAbandonedWrite(key: string): void;
	/** Statement history. */
	history: IGraphHistory;
	/** Sidebar preview requests (graph/previews.ts). */
	previews: {
		pending: IReadable<IGraphPreview | null>;
		request(input: { endpointKey: string; action: PreviewAction; name: string }): void;
		/** Take a request; false when it was already taken. */
		consume(nonce: string): boolean;
	};
	/** The connection the fronted document belongs to (the sidebar follows it). */
	activeConnection: IReadable<string | null>;
	/** Open (or focus) a document. Only ever on a user action. */
	openDocument(target: DocTarget): void;
	/** Drafts and captions: the workspace prefs in the full app, session-only memory in dev-tool mounts. */
	prefs: IPrefsAccessor;
	/** What the History panel says about where history is kept, true for this mount. */
	historyPrivacyNote: string;
	/** Label styles and saved queries, per connection (graph/userData.ts). */
	userData: IGraphUserData;
	/**
	 * Grid layouts (sort, columns, page), always as plain-JSON copies
	 * (shared/explorer/devtool/gridPersistence): never the shell's bare
	 * channel, which hands Tabulator the stored object to rewrite in place.
	 * The full app keeps them in its own workspace prefs. A dev-tool mount
	 * keeps them in memory, so its grids never write into the host's prefs:
	 * frames share one store per realm, and the controller (which renders no
	 * grid today) has its own.
	 */
	gridPersistence: IDataGridPersistence;
}

const GraphEnvContext = createContext<IGraphEnv | null>(null);

/** The provider every mount root wraps its subtree in (GraphApp, the dev-tool sidebar and frame). */
export const GraphEnvProvider = GraphEnvContext.Provider;

/**
 * The subtree's env.
 *
 * @returns The env.
 * @throws Error when no provider is mounted (every mount root installs one).
 */
export function useGraphEnv(): IGraphEnv {
	const env = useContext(GraphEnvContext);
	if (!env) throw new Error('useGraphEnv: no GraphEnvProvider above this component.');
	return env;
}

/**
 * Follow a readable.
 *
 * @param readable - The readable.
 * @returns Its value.
 */
export function useReadable<T>(readable: IReadable<T>): T {
	return useSyncExternalStore(readable.subscribe, readable.get, readable.get);
}

/**
 * Follow one key of a keyed value.
 *
 * @param keyed - The keyed value.
 * @param key - The key.
 * @returns Its value for the key.
 */
export function useKeyed<T>(keyed: IKeyed<T>, key: string): T {
	const get = (): T => keyed.get(key);
	return useSyncExternalStore(keyed.subscribe, get, get);
}

/** @returns Discovered connections and their probes. */
export function useGraphEndpoints(): IGraphEndpointsState {
	return useReadable(useGraphEnv().endpoints);
}

/**
 * @param key - The connection.
 * @returns Its schema label names.
 */
export function useSchemaLabels(key: string): readonly string[] {
	return useKeyed(useGraphEnv().schemaLabels, key);
}

/**
 * @param key - The connection.
 * @returns Its full schema view, or null until one was read.
 */
export function useSchemaView(key: string): ISchemaView | null {
	return useKeyed(useGraphEnv().schemaView, key);
}

/**
 * @param key - The connection.
 * @returns How its labels and relationship types are drawn, and whether that was read yet (`ready`: until then, draw
 * labels in a neutral colour rather than in colours that would change a moment later).
 */
export function useConnectionStyle(key: string): IStyleView {
	return useReadable(useGraphEnv().userData.style(key));
}

/**
 * @param key - The connection.
 * @returns Its saved queries.
 */
export function useSavedQueries(key: string): ISavedQueriesView {
	return useReadable(useGraphEnv().userData.saved(key));
}

/**
 * @param key - The connection.
 * @returns Its data version.
 */
export function useDataVersion(key: string): number {
	return useKeyed(useGraphEnv().dataVersions, key);
}

/** @returns The active connection's key. */
export function useActiveConnection(): string | null {
	return useReadable(useGraphEnv().activeConnection);
}

/** @returns The pending preview request. */
export function usePendingPreview(): IGraphPreview | null {
	return useReadable(useGraphEnv().previews.pending);
}

/**
 * @param key - The connection.
 * @returns Its history entries and recording switch.
 */
export function useHistoryView(key: string): IGraphHistoryView {
	const env = useGraphEnv();
	return useReadable(env.history.view(key));
}

/**
 * Session-only preferences (drafts, captions) for dev-tool mounts: neither host gives a store tool workspace
 * preferences, and the shell's own usePrefs would write into the HOST app's bag.
 *
 * @returns The accessor.
 */
export function memoryPrefs(): IPrefsAccessor {
	const values = new Map<string, unknown>();
	return {
		getPref: (key) => values.get(key),
		setPref: (key, value) => {
			values.set(key, value);
		},
	};
}

/** The full app's History note (its history is in the workspace prefs on the server). */
export const APP_HISTORY_PRIVACY_NOTE = 'Saved in your RocketRide workspace file on the server, not in this browser. Statements are stored as typed, including literal values.';

/** The dev-tool History note (its history is in a file in the user's folder on the server, written by the sidebar). */
export const DEVTOOL_HISTORY_PRIVACY_NOTE = 'Saved on the server in your user folder (rocketride.graph.history.json), not in this window. Statements are stored as typed, including literal values. If that file cannot be read, history is kept for this session only.';
