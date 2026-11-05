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
// VECTOR-UI — BRIDGE (the selection the console, document tabs and map share)
// =============================================================================
//
// One store per open connection. The console's directory, the document tab,
// the chat sources and the map all read and write it, so selecting a document
// in the console highlights its chunks on the map even while the map tab is
// hidden, and a click on the map lands back in the console. Search's Compare
// sets a second question (queryB) beside the first, for a second star.
//
// Plain external store: every change replaces the snapshot (never mutates it),
// so React reads it with useSyncExternalStore and tests read it directly. No
// imports from 'shell', no timers, no module-level state.
// =============================================================================

import type { IProjectItem, SelectionState, SelectionStore, VectorKey } from './types';

/**
 * The empty selection of a connection.
 *
 * @param connectionKey - The connection, or null.
 * @returns A fresh state.
 */
export function emptySelection(connectionKey: string | null): SelectionState {
	return { connectionKey, document: null, chunk: null, keys: [], highlight: null, query: null, queryB: null, sampleModel: null };
}

/**
 * Whether two keys name the same chunk.
 *
 * @param a - A key.
 * @param b - Another key.
 * @returns True when objectId and chunkId match.
 */
export function sameKey(a: VectorKey, b: VectorKey): boolean {
	return a[0] === b[0] && a[1] === b[1];
}

/**
 * Create the selection store of one connection.
 *
 * @param connectionKey - The connection the store starts bound to (null = none yet).
 * @returns The store.
 */
export function createSelectionStore(connectionKey: string | null = null): SelectionStore {
	let state: SelectionState = emptySelection(connectionKey);
	const listeners = new Set<() => void>();

	/**
	 * Replace the snapshot and notify, unless nothing changed.
	 *
	 * @param next - The next state.
	 */
	function set(next: SelectionState): void {
		if (next === state) return;
		state = next;
		for (const listener of [...listeners]) listener();
	}

	return {
		getState: () => state,
		subscribe(listener: () => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		reset(nextKey: string | null): void {
			set(emptySelection(nextKey));
		},
		selectDocument(document): void {
			set({ ...state, document: document === null ? null : { objectId: document.objectId, path: document.path } });
		},
		focusChunk(key): void {
			set({ ...state, chunk: key });
		},
		setKeys(keys): void {
			set({ ...state, keys: [...keys] });
		},
		setHighlight(highlight): void {
			set({ ...state, highlight: highlight === null ? null : { source: highlight.source, keys: [...highlight.keys] } });
		},
		setQuery(query): void {
			set({ ...state, query });
		},
		setQueryB(queryB): void {
			set({ ...state, queryB });
		},
		clearQueryB(): void {
			if (state.queryB !== null) set({ ...state, queryB: null });
		},
		setSampleModel(model): void {
			set({ ...state, sampleModel: model });
		},
		addPinned(items: readonly IProjectItem[]): void {
			const model = state.sampleModel;
			if (model === null || items.length === 0) return;
			set({ ...state, sampleModel: { ...model, pinned: [...model.pinned, ...items] } });
		},
		forgetDocument(objectId: string): void {
			const keep = (key: VectorKey): boolean => key[0] !== objectId;
			const model = state.sampleModel;
			set({
				...state,
				document: state.document?.objectId === objectId ? null : state.document,
				chunk: state.chunk !== null && !keep(state.chunk) ? null : state.chunk,
				keys: state.keys.filter(keep),
				highlight: state.highlight === null ? null : { ...state.highlight, keys: state.highlight.keys.filter(keep) },
				// Point indices are positional, so the document's points are marked removed (and
				// hidden by the map) rather than spliced out; its pinned extras go.
				sampleModel: model === null
					? null
					: {
						...model,
						pinned: model.pinned.filter((item) => item.key === null || keep(item.key)),
						removed: model.removed.includes(objectId) ? model.removed : [...model.removed, objectId],
					},
			});
		},
	};
}
