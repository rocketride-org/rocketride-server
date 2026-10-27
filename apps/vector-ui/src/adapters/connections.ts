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
// ADAPTER - PER-CONNECTION OBJECTS (pure: no React, no shell values)
// =============================================================================
//
// What one open connection keeps while its console and document tabs come
// and go: the console controller (stats, directory, trash, chunks, writes),
// the shared selection (vector/bridge), the console's inner tab
// (vector/workbench.ts) with the Query tab's mode and handed-in question and
// the document asked of the Documents tab, the chat's scope ("Ask about these
// only"), the directory's scope (conditions shared with the map, search and
// chat), the documents staged for the trash (vector/staged.ts), the metadata
// fields read so far (vector/fields.ts), and the loaded rows as a source for
// the map. Every one is built from the endpoint KEY plus refs: the controller
// reads the client and the live endpoint from `ctx` at call time, so a
// restarted pipeline (same key, new token) is called correctly without
// rebuilding anything.
//
// Beside them, four in-memory caches keyed by the endpoint key: saved
// filters, saved views, reviewed documents and recommend examples. Nothing
// here is kept in browser storage.
//
// A change of identity clears them all (the app's cache registry): every
// controller is disposed (its late answers are dropped), every selection is
// reset and every cache is emptied, so nothing of the previous identity's
// connections remains.
//
// THE REGISTRIES. Each mount keeps its own (createConnectionRegistry): the
// full app's is the module-level one below (`connectionEntry`, bound to the
// app's endpoint store and client), and every dev-tool frame makes one of
// its own, so two frames in one realm never share a controller (or the
// confirmation it holds). How an entry calls its store is its `link`, read at
// call time: the full app's store session, or a frame's controller ops.
// =============================================================================

import { ExplorerToolError } from 'shared/explorer';
import type { IExplorerClient, IExplorerEndpoint } from 'shared/explorer';
import { createSelectionStore } from '../contract/bridge';
import type { IDocumentRowsSource, IRecommendExamples, IScopeState, ISavedFilter, ISavedView, IVectorLimits, SelectionStore } from '../contract/types';
import { CHUNKS_PAGE } from '../vector/budgets';
import { createConsoleStore } from '../vector/consoleStore';
import type { IConsoleClock, IConsoleStore } from '../vector/consoleStore';
import type { IFieldsEstimate } from '../vector/fields';
import { DEFAULT_LIMITS } from '../vector/results';
import { NO_STAGED, unstage } from '../vector/staged';
import type { IStagedSet } from '../vector/staged';
import { DEFAULT_TAB } from '../vector/workbench';
import type { IOpenDocumentRequest, IQueryPrefill, QueryMode, WorkbenchTab } from '../vector/workbench';
import { deleteBatch, fetchChunks, fetchDocumentsPage, fetchStats, restoreBatch, trashBatch } from './actions';
import type { IVectorCaller } from './actions';
import { announcer, connectionCaches, vectorEndpoints } from './explorer';

/** A tiny external store of one value (useSyncExternalStore-compatible). */
export interface IValueStore<T> {
	get(): T;
	set(value: T): void;
	subscribe(listener: () => void): () => void;
}

/**
 * Create a value store.
 *
 * @param initial - The first value.
 * @returns The store.
 */
export function createValueStore<T>(initial: T): IValueStore<T> {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		set(next: T): void {
			if (Object.is(next, value)) return;
			value = next;
			for (const listener of [...listeners]) listener();
		},
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** The tabs of a console (its workbench). */
export type ConsoleTab = WorkbenchTab;

/** How one mount calls a connection's store (read by the console controller at call time). */
export interface IConnectionLink {
	/** The connection's anchor session, or what stands in for it in a dev-tool frame. */
	session(endpoint: IExplorerEndpoint): IVectorCaller;
	/** Probe the store again (its `dialect`), fire and forget. */
	reprobe(endpointKey: string): void;
}

/** What the controller reads at call time. */
export interface IConnectionContext {
	/** How to call the store, or null while this mount cannot (not connected). */
	link: IConnectionLink | null;
	endpoint: IExplorerEndpoint;
	limits: IVectorLimits;
}

/** One open connection's objects. */
export interface IConnectionEntry {
	key: string;
	ctx: IConnectionContext;
	controller: IConsoleStore;
	selection: SelectionStore;
	tab: IValueStore<ConsoleTab>;
	/** The Query tab's mode. */
	queryMode: IValueStore<QueryMode>;
	/** A question handed to the Query tab (Ask about these, Use as query, a history entry), or null. */
	queryPrefill: IValueStore<IQueryPrefill | null>;
	/** A document another tab asks the Documents tab to show in its drawer (read once, then set back to null). */
	openDocument: IValueStore<IOpenDocumentRequest | null>;
	chatScope: IValueStore<readonly string[] | null>;
	/** The directory's scope (ConsoleModel.scope), or null with no condition. */
	scope: IValueStore<IScopeState | null>;
	/** The directory's loaded rows, for the map (MapViewProps.documents). */
	documents: IDocumentRowsSource;
	/** How many writes the console ran on this store; a change asks the map to draw its sample again (MapViewProps.writes). */
	writes: IValueStore<number>;
	/** Documents staged to move to the trash (applied through the controller's confirmation). */
	staged: IValueStore<IStagedSet>;
	/** The metadata fields read so far, or null before any were read. */
	fields: IValueStore<IFieldsEstimate | null>;
	/** True once the console asked for its first stats and page. */
	opened: boolean;
}

/** The real clock. */
const REAL_CLOCK: IConsoleClock = {
	now: () => Date.now(),
	setTimer: (fn, ms) => setTimeout(fn, ms),
	clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Build the controller of one connection, calling through the entry's link at call time.
 *
 * @param entry - The entry (its ctx and selection).
 * @param clock - The clock (tests pass a manual one).
 * @returns The controller.
 */
function makeController(entry: Pick<IConnectionEntry, 'ctx' | 'selection' | 'writes' | 'staged'>, clock: IConsoleClock): IConsoleStore {
	const { ctx } = entry;
	const session = (tool: string): IVectorCaller => {
		if (ctx.link === null) throw new ExplorerToolError({ kind: 'unavailable', tool, message: 'Not connected to the server. Reconnect, then refresh.' });
		return ctx.link.session(ctx.endpoint);
	};
	return createConsoleStore(
		{
			stats: (mode) => fetchStats(session('stats'), ctx.endpoint.nodeId, mode),
			documents: (cursor, limit, filter, deleted) => fetchDocumentsPage(session('list_documents'), ctx.endpoint.nodeId, { cursor, limit }, {}, filter, deleted),
			chunks: (objectId, afterChunk, limit) => fetchChunks(session('chunks'), ctx.endpoint.nodeId, { objectId, afterChunk, limit }),
			trash: (ids) => trashBatch(session('soft_delete'), ctx.endpoint.nodeId, ids),
			restore: (ids) => restoreBatch(session('restore'), ctx.endpoint.nodeId, ids),
			remove: (ids, opts) => deleteBatch(session('delete'), ctx.endpoint.nodeId, ids, opts),
			announce: (text) => announcer.announce(text),
			onRemoved: (ids) => {
				for (const id of ids) entry.selection.forgetDocument(id);
				entry.staged.set(unstage(entry.staged.get(), ids));
			},
			reprobe: () => ctx.link?.reprobe(ctx.endpoint.key),
			onWritten: () => entry.writes.set(entry.writes.get() + 1),
			clock,
		},
		{
			get pageSize() {
				return ctx.limits.documents_page;
			},
			get chunkPage() {
				return Math.min(CHUNKS_PAGE, ctx.limits.chunks_page);
			},
			get writeBatch() {
				return ctx.limits.write_ids_max;
			},
		}
	);
}

/** One mount's per-connection objects. */
export interface IConnectionRegistry {
	/**
	 * The objects of one connection, made on first use and kept until the registry is cleared; refreshed in place.
	 *
	 * @param endpoint - The live endpoint (its key names the entry; the rest refreshes ctx).
	 * @param link - How this mount calls the store now, or null while it cannot.
	 * @param limits - The node's limits (the dialect's, else the documented ones).
	 * @param clock - The clock of a new entry (tests pass a manual one).
	 */
	entry(endpoint: IExplorerEndpoint, link: IConnectionLink | null, limits?: IVectorLimits, clock?: IConsoleClock): IConnectionEntry;
	/** The entry of a connection, if one was made. */
	existing(key: string): IConnectionEntry | undefined;
	/** How many connections have objects. */
	count(): number;
	/** Every entry. */
	entries(): IConnectionEntry[];
	/** Forget every entry, as it is (the full app's cache registry disposes and resets them first, each by name). */
	forget(): void;
	/** Dispose every controller (late answers are dropped), reset every selection, forget every entry. */
	clear(): void;
}

/**
 * Create a mount's registry of per-connection objects.
 *
 * @returns An empty registry.
 */
export function createConnectionRegistry(): IConnectionRegistry {
	const entries = new Map<string, IConnectionEntry>();
	return {
		entry(endpoint, link, limits = DEFAULT_LIMITS, clock = REAL_CLOCK) {
			let entry = entries.get(endpoint.key);
			if (!entry) {
				const ctx: IConnectionContext = { link, endpoint, limits };
				const selection = createSelectionStore(endpoint.key);
				const made: IConnectionEntry = {
					key: endpoint.key,
					ctx,
					selection,
					controller: undefined as unknown as IConsoleStore,
					tab: createValueStore<ConsoleTab>(DEFAULT_TAB),
					queryMode: createValueStore<QueryMode>('search'),
					queryPrefill: createValueStore<IQueryPrefill | null>(null),
					openDocument: createValueStore<IOpenDocumentRequest | null>(null),
					chatScope: createValueStore<readonly string[] | null>(null),
					scope: createValueStore<IScopeState | null>(null),
					documents: undefined as unknown as IDocumentRowsSource,
					writes: createValueStore(0),
					staged: createValueStore<IStagedSet>(NO_STAGED),
					fields: createValueStore<IFieldsEstimate | null>(null),
					opened: false,
				};
				made.controller = makeController(made, clock);
				made.documents = directoryRows(made.controller);
				entries.set(endpoint.key, made);
				entry = made;
			}
			entry.ctx.link = link;
			entry.ctx.endpoint = endpoint;
			entry.ctx.limits = limits;
			return entry;
		},
		existing: (key) => entries.get(key),
		count: () => entries.size,
		entries: () => [...entries.values()],
		forget: () => entries.clear(),
		clear() {
			for (const entry of entries.values()) entry.controller.dispose();
			for (const entry of entries.values()) entry.selection.reset(null);
			entries.clear();
		},
	};
}

/** The full app's registry (its console tabs and document tabs share one entry per connection). */
export const appConnections: IConnectionRegistry = createConnectionRegistry();

/**
 * How the full app calls a connection: through the app's endpoint store, on its client.
 *
 * @param client - The client.
 * @returns The link.
 */
export function appLink(client: IExplorerClient): IConnectionLink {
	return {
		session: (endpoint) => vectorEndpoints.session(client, endpoint),
		reprobe: (endpointKey) => {
			void vectorEndpoints.probe(client, endpointKey);
		},
	};
}

/**
 * The full app's objects of one connection, made on first use and kept until a change of identity.
 *
 * @param endpoint - The live endpoint (its key names the entry; the rest refreshes ctx).
 * @param client - The client, or null while disconnected.
 * @param limits - The node's limits (the dialect's, else the documented ones).
 * @param clock - The clock (tests pass a manual one).
 * @returns The entry.
 */
export function connectionEntry(endpoint: IExplorerEndpoint, client: IExplorerClient | null, limits: IVectorLimits = DEFAULT_LIMITS, clock: IConsoleClock = REAL_CLOCK): IConnectionEntry {
	return appConnections.entry(endpoint, client === null ? null : appLink(client), limits, clock);
}

/**
 * The directory's loaded rows of a controller, as a source the map can subscribe to.
 *
 * @param controller - The console controller.
 * @returns The source (the rows array is replaced, never mutated, when they change).
 */
function directoryRows(controller: IConsoleStore): IDocumentRowsSource {
	return { getRows: () => controller.getState().directory.rows, subscribe: (listener) => controller.subscribe(listener) };
}

/**
 * The full app's entry of a connection, if one was made.
 *
 * @param key - The endpoint key.
 * @returns The entry or undefined.
 */
export function existingEntry(key: string): IConnectionEntry | undefined {
	return appConnections.existing(key);
}

/** How many connections have objects in the full app (tests). */
export function entryCount(): number {
	return appConnections.count();
}

connectionCaches.register('documents, auto-pager, chunks and removals', () => {
	for (const entry of appConnections.entries()) entry.controller.dispose();
});
connectionCaches.register('selection and sample models', () => {
	for (const entry of appConnections.entries()) entry.selection.reset(null);
});
connectionCaches.register('console tabs and chat scope', () => {
	appConnections.forget();
});

// =============================================================================
// IN-MEMORY CACHES PER CONNECTION (keyed by endpoint key; never browser storage)
// =============================================================================

/** Saved condition sets (vector/savedFilters.ts reads and writes them). */
export const savedFilters = new Map<string, readonly ISavedFilter[]>();

/** Saved map views, at most 20 per connection (vector/savedViews.ts). */
export const savedViews = new Map<string, readonly ISavedView[]>();

/** objectIds marked reviewed in the duplicates and outliers queues. */
export const reviewedDocuments = new Map<string, ReadonlySet<string>>();

/** The examples of the map's Recommend tab. */
export const recommendExamples = new Map<string, IRecommendExamples>();

connectionCaches.register('saved filters', () => savedFilters.clear(), (key) => savedFilters.delete(key));
connectionCaches.register('saved views', () => savedViews.clear(), (key) => savedViews.delete(key));
connectionCaches.register('reviewed documents', () => reviewedDocuments.clear(), (key) => reviewedDocuments.delete(key));
connectionCaches.register('recommend examples', () => recommendExamples.clear(), (key) => recommendExamples.delete(key));
