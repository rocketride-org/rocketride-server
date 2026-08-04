// MIT License
//
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
// EXTERNAL STORE — Shared pub/sub plumbing for module-level stores
// =============================================================================
//
// The navigation, connections, and actions stores are plain module-level
// state exposed to React via useSyncExternalStore. This factory owns the
// listener Set / emit / subscribe boilerplate so each store file doesn't
// re-implement it. One store can back several derived hooks — each hook
// supplies its own snapshot getter to useValue().
// =============================================================================

import { useSyncExternalStore } from 'react';

/** Handle returned by createExternalStore(). */
export interface ExternalStore {
	/** Stable subscribe function for useSyncExternalStore. Returns unsubscribe. */
	subscribe: (cb: () => void) => () => void;
	/** Notify all subscribers of a change. */
	emit: () => void;
	/** React hook — read a reactive snapshot of this store. */
	useValue: <T>(get: () => T) => T;
	/** Drop all subscribers (store teardown). */
	clear: () => void;
}

/**
 * Create a minimal external store: a shared listener Set with emit(),
 * a stable subscribe(), and a useValue() hook helper bound to it.
 */
export function createExternalStore(): ExternalStore {
	// One listener Set shared by every hook derived from this store
	const listeners = new Set<() => void>();

	/** Stable subscribe closure required by useSyncExternalStore. */
	function subscribe(cb: () => void): () => void {
		listeners.add(cb);
		return () => {
			listeners.delete(cb);
		};
	}

	return {
		subscribe,
		emit: () => {
			for (const fn of listeners) fn();
		},
		useValue: <T>(get: () => T): T => useSyncExternalStore(subscribe, get),
		clear: () => {
			listeners.clear();
		},
	};
}
