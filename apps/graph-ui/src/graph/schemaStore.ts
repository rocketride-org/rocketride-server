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
// GRAPH - SCHEMA STORE (one snapshot per connection, with a last-good fallback)
// =============================================================================
//
// Holds the parsed schema of every connection the user has opened. It follows the
// rules the node's schema contract sets:
//
//   - A load that FAILS keeps the previous snapshot visible (with its age) and
//     records the failure; it never replaces a good schema with an empty one.
//   - A load that returns an old-format or failed schema is recorded as what it
//     proves: `unknown` evidence, never "an empty graph" (see schema.ts).
//   - Concurrent loads for one connection COALESCE: a second request while one is
//     running gets the same promise, so a double click does not send two
//     `refresh_schema` calls. The one exception is a REFRESH asked for while a
//     plain load runs: that load cannot answer it (it reads the snapshot taken at
//     pipeline start), so the refresh runs once, after it.
//   - `clear` (a connection closed, or the identity changed) drops the snapshot
//     and expires any load in flight, so a late answer cannot repopulate it.
//
// The store holds parsed schema and failure text only: no token, no client.
// =============================================================================

import { NO_SCHEMA, parseSchema } from './schema';
import type { ISchemaView } from './schema';
import type { IFailureNotice } from './failures';

/** One connection's schema state. */
export interface ISchemaEntry {
	status: 'idle' | 'loading' | 'ready' | 'error';
	/** The newest schema that was read (the last good one, when a later load failed). */
	view: ISchemaView;
	/** Why the latest load failed; null otherwise. */
	failure: IFailureNotice | null;
	/** Epoch ms of the latest completed load (successful or not); 0 = never. */
	loadedAt: number;
}

/** A schema store. */
export interface ISchemaStore {
	/** The entry for a connection (a shared idle entry for an unknown one, stable between changes). */
	get(key: string): ISchemaEntry;
	/** Subscribe to any change. */
	subscribe(listener: () => void): () => void;
	/**
	 * Load (or refresh) a connection's schema.
	 *
	 * @param key - The connection's key.
	 * @param fetch - Calls the node and resolves with the tool's value.
	 * @param describe - Turns a thrown error into a notice.
	 * @param options - `refresh`: the user asked to re-read the database (see the header).
	 * @returns A promise that settles when the load does; never rejects.
	 */
	load(key: string, fetch: () => Promise<unknown>, describe: (error: unknown) => IFailureNotice, options?: { refresh?: boolean }): Promise<void>;
	/** Forget one connection (or all). A load in flight for it is ignored when it lands. */
	clear(key?: string): void;
	/** The connections that have an entry (the dev-tool controller publishes a summary of each). */
	keys(): string[];
}

/** The entry of a connection nothing was loaded for. */
const IDLE: ISchemaEntry = { status: 'idle', view: NO_SCHEMA, failure: null, loadedAt: 0 };

/**
 * Create a schema store.
 *
 * @param now - The clock (default: Date.now).
 * @returns The store.
 */
export function createSchemaStore(now: () => number = () => Date.now()): ISchemaStore {
	const entries = new Map<string, ISchemaEntry>();
	const inFlight = new Map<string, { promise: Promise<void>; refresh: boolean }>();
	// A refresh waiting for a plain load to end, one per connection.
	const queued = new Map<string, Promise<void>>();
	const generations = new Map<string, number>();
	const listeners = new Set<() => void>();

	const notify = (): void => listeners.forEach((l) => l());
	const set = (key: string, entry: ISchemaEntry): void => {
		entries.set(key, entry);
		notify();
	};

	const store: ISchemaStore = {
		get: (key) => entries.get(key) ?? IDLE,

		keys: () => [...entries.keys()],

		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		load(key, fetch, describe, options = {}) {
			const refresh = options.refresh === true;
			const running = inFlight.get(key);
			if (running) {
				if (!refresh || running.refresh) return running.promise;
				const waiting = queued.get(key);
				if (waiting) return waiting;
				const startedFor = generations.get(key);
				const next = running.promise.then(() => {
					queued.delete(key);
					// Cleared meanwhile (identity change, connection closed): nothing to refresh any more.
					if (generations.get(key) !== startedFor) return undefined;
					return store.load(key, fetch, describe, { refresh: true });
				});
				queued.set(key, next);
				return next;
			}
			const generation = (generations.get(key) ?? 0) + 1;
			generations.set(key, generation);
			const previous = entries.get(key) ?? IDLE;
			set(key, { ...previous, status: 'loading', failure: null });
			const promise = (async () => {
				let next: ISchemaEntry;
				try {
					const view = parseSchema(await fetch());
					next = { status: 'ready', view, failure: null, loadedAt: now() };
				} catch (error) {
					// Keep what was last known: a failed refresh must not erase a good schema.
					next = { status: 'error', view: previous.view, failure: describe(error), loadedAt: now() };
				}
				if (generations.get(key) === generation) set(key, next);
			})().finally(() => {
				if (generations.get(key) === generation) inFlight.delete(key);
			});
			inFlight.set(key, { promise, refresh });
			return promise;
		},

		clear(key) {
			if (key === undefined) {
				for (const k of generations.keys()) generations.set(k, (generations.get(k) ?? 0) + 1);
				entries.clear();
				inFlight.clear();
				queued.clear();
			} else {
				generations.set(key, (generations.get(key) ?? 0) + 1);
				entries.delete(key);
				inFlight.delete(key);
				queued.delete(key);
			}
			notify();
		},
	};
	return store;
}
