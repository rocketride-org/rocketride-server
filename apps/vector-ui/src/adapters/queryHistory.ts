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
// ADAPTER - THE QUERY TAB'S HISTORY over the shared history store (pure)
// =============================================================================
//
// The Query tab records each finished run through `env.queryHistory`
// (env.ts IQueryHistorySource). Both mounts keep it in a shared history
// store (shared/explorer createHistoryStore: its bounds, pins and notes):
//
//   FULL APP   the app's `vectorHistory` (`vector.history`), which writes to
//              the workspace preferences while its bridge is mounted
//              (VectorApp) and belongs to the signed-in owner. A stored entry
//              keeps id, question, at, ms, outcome, kind, rows, limit, error,
//              pinned and note: the mode is `kind`, the top-k `limit` and the
//              result count `rows`. Nothing else of a run can be kept there.
//   DEV TOOL   a store of its own whose preferences read nothing and write
//              nowhere, so the history lives in memory only and goes with the
//              document (`forget` empties it on a change of identity).
//
// An entry this app did not write (another kind or outcome) is left stored
// and not shown. A Compare's question B (`compareWith`) is never handed to
// the shared store, whose saved entries would carry it to the workspace
// file: it is held beside it, in memory, for the page's life.
// =============================================================================

import { createHistoryStore } from 'shared/explorer';
import type { IHistoryEntry, IHistoryStore } from 'shared/explorer';
import type { IQueryHistoryEntry, IQueryHistorySource, IReadable, QueryHistoryKind } from '../env';

/** The kinds a Query tab run is recorded under. */
const KINDS: ReadonlySet<string> = new Set<QueryHistoryKind>(['semantic', 'keyword', 'hybrid', 'auto', 'ask', 'compare']);

/**
 * A stored entry as a Query history entry.
 *
 * @param entry - The shared store's entry.
 * @returns The entry, or null for one this app did not write.
 */
export function queryEntryOf(entry: IHistoryEntry<'question'>): IQueryHistoryEntry | null {
	if (!KINDS.has(entry.kind) || (entry.outcome !== 'rows' && entry.outcome !== 'error')) return null;
	return {
		id: entry.id,
		question: entry.question,
		kind: entry.kind as QueryHistoryKind,
		at: entry.at,
		ms: entry.ms,
		topK: entry.limit ?? null,
		results: entry.rows ?? null,
		outcome: entry.outcome,
		...(entry.error === undefined ? {} : { error: entry.error }),
		...(entry.pinned ? { pinned: true } : {}),
		...(entry.note === undefined ? {} : { note: entry.note }),
	};
}

/**
 * A Query run as the shared store keeps it.
 *
 * @param id - The new entry's id.
 * @param entry - The run.
 * @returns The stored entry.
 */
export function storedEntryOf(id: string, entry: Omit<IQueryHistoryEntry, 'id'>): IHistoryEntry<'question'> {
	return {
		id,
		question: entry.question,
		at: entry.at,
		ms: entry.ms,
		outcome: entry.outcome,
		kind: entry.kind,
		...(entry.results === null ? {} : { rows: entry.results }),
		...(entry.topK === null ? {} : { limit: entry.topK }),
		...(entry.error === undefined ? {} : { error: entry.error }),
		...(entry.pinned ? { pinned: true } : {}),
		...(entry.note === undefined ? {} : { note: entry.note }),
	};
}

/** Ids for new entries: unique within a page's life, and across reloads by their time. */
let sequence = 0;

/**
 * A new entry id.
 *
 * @param at - The run's start.
 * @returns The id.
 */
function newId(at: number): string {
	sequence += 1;
	return `q${at.toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Where a source reads its store: the store now, and its changes (a session store is replaced on a reset). */
interface IStoreHolder {
	current(): IHistoryStore<'question'>;
	subscribe(listener: () => void): () => void;
}

/**
 * A Query history over a shared history store.
 *
 * @param holder - The store and its changes.
 * @param info - Whether it is persisted, and the sentence that says where it is kept.
 * @returns The source.
 */
function sourceOver(holder: IStoreHolder, info: { persisted: boolean; note: string }): IQueryHistorySource & { forgetCompared(): void } {
	// Each stored list maps to one list of entries, so a snapshot stays the same object until its list changes.
	let mapped = new WeakMap<IHistoryEntry<'question'>[], readonly IQueryHistoryEntry[]>();
	// Compare's question B by entry id, in memory only.
	const compared = new Map<string, string>();
	const withCompared = (entry: IQueryHistoryEntry | null): IQueryHistoryEntry | null => {
		const b = entry === null ? undefined : compared.get(entry.id);
		return entry === null || b === undefined ? entry : { ...entry, compareWith: b };
	};
	const entryReadables = new Map<string, IReadable<readonly IQueryHistoryEntry[]>>();
	const recordingReadables = new Map<string, IReadable<boolean>>();
	return {
		persisted: info.persisted,
		note: info.note,
		entries(key) {
			let readable = entryReadables.get(key);
			if (!readable) {
				readable = {
					get: () => {
						const stored = holder.current().getHistory(key);
						let list = mapped.get(stored);
						if (!list) {
							list = stored.map((entry) => withCompared(queryEntryOf(entry))).filter((entry): entry is IQueryHistoryEntry => entry !== null);
							mapped.set(stored, list);
						}
						return list;
					},
					subscribe: holder.subscribe,
				};
				entryReadables.set(key, readable);
			}
			return readable;
		},
		record(key, entry) {
			const id = newId(entry.at);
			// Known before the store tells its listeners, so the first snapshot already carries it.
			if (entry.compareWith !== undefined) compared.set(id, entry.compareWith);
			holder.current().runs.emitRun(key, storedEntryOf(id, entry));
		},
		togglePin: (key, id) => holder.current().togglePin(key, id),
		setNote: (key, id, note) => holder.current().setNote(key, id, note),
		remove(key, id) {
			compared.delete(id);
			holder.current().removeEntry(key, id);
		},
		clear(key) {
			for (const entry of holder.current().getHistory(key)) compared.delete(entry.id);
			holder.current().clearForKey(key);
		},
		recording(key) {
			let readable = recordingReadables.get(key);
			if (!readable) {
				readable = { get: () => holder.current().getRecording(key), subscribe: holder.subscribe };
				recordingReadables.set(key, readable);
			}
			return readable;
		},
		setRecording: (key, on) => holder.current().setRecording(key, on),
		forgetCompared() {
			compared.clear();
			mapped = new WeakMap();
		},
	};
}

/**
 * The full app's Query history: the app's shared history store, kept in the workspace preferences.
 *
 * @param store - The app's store (`vectorHistory`).
 * @param note - The sentence that says what is kept.
 * @returns The source.
 */
export function persistedQueryHistory(store: IHistoryStore<'question'>, note: string): IQueryHistorySource {
	const { forgetCompared: _forgetCompared, ...source } = sourceOver({ current: () => store, subscribe: store.subscribe }, { persisted: true, note });
	return source;
}

/** A Query history kept in memory only, which a mount empties on a change of identity. */
export interface ISessionQueryHistory extends IQueryHistorySource {
	/** Forget every connection's entries and switches. */
	forget(): void;
}

/**
 * A history store whose preferences read nothing and write nowhere: it records at once (the shared store records
 * only once preferences are attached) and keeps everything in its own memory.
 *
 * @returns The store.
 */
function memoryStore(): IHistoryStore<'question'> {
	const store = createHistoryStore({ historyKey: 'vector.history', recordingKey: 'vector.historyRecording', textField: 'question' });
	store.attachPrefs({ getPref: () => undefined, setPref: () => undefined });
	return store;
}

/**
 * A dev-tool mount's Query history: memory only.
 *
 * @param note - The sentence that says where it is kept.
 * @returns The source.
 */
export function sessionQueryHistory(note: string): ISessionQueryHistory {
	let store = memoryStore();
	const listeners = new Set<() => void>();
	const notify = (): void => {
		for (const listener of [...listeners]) listener();
	};
	let unsubscribe = store.subscribe(notify);
	const holder: IStoreHolder = {
		current: () => store,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const { forgetCompared, ...source } = sourceOver(holder, { persisted: false, note });
	return {
		...source,
		forget() {
			unsubscribe();
			store = memoryStore();
			forgetCompared();
			unsubscribe = store.subscribe(notify);
			notify();
		},
	};
}
