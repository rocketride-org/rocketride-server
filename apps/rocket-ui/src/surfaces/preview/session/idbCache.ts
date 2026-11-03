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
// IDB CACHE — the App Builder's derived-data cache (never user truth)
// =============================================================================

/**
 * One tiny IndexedDB wrapper for the App Builder's DERIVED caches: unpacked
 * platform types, fetched dependency modules and their type downloads,
 * probe verdicts. Everything here is reconstructible — reads and writes are
 * best-effort and failures degrade to a refetch, never to an error.
 */

/** Cache database name. */
const DB_NAME = 'rr-appdev';

/** The object stores (declared up front — IDB upgrades are versioned). */
const STORES = ['types', 'deps', 'dts', 'probe'] as const;

/** A cache store name. */
export type CacheStore = (typeof STORES)[number];

/** The opened database (memoized). */
let dbPromise: Promise<IDBDatabase> | null = null;

/** Opens (creating on first use) the appdev cache database. */
function openDb(): Promise<IDBDatabase> {
	if (!dbPromise) {
		dbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 2);
			req.onupgradeneeded = () => {
				for (const store of STORES) {
					if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store);
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}
	return dbPromise;
}

/**
 * Reads one cache row.
 *
 * @param store - The store name.
 * @param key - The row key.
 * @returns The value, or undefined on miss or ANY IDB failure.
 */
export async function cacheGet<T>(store: CacheStore, key: string): Promise<T | undefined> {
	try {
		const db = await openDb();
		return await new Promise<T | undefined>((resolve) => {
			const req = db.transaction(store, 'readonly').objectStore(store).get(key);
			req.onsuccess = () => resolve(req.result as T | undefined);
			req.onerror = () => resolve(undefined);
		});
	} catch {
		return undefined;
	}
}

/**
 * Writes one cache row (best-effort — failures are silent).
 *
 * @param store - The store name.
 * @param key - The row key.
 * @param value - The value to store (structured-clonable).
 */
export async function cachePut(store: CacheStore, key: string, value: unknown): Promise<void> {
	try {
		const db = await openDb();
		await new Promise<void>((resolve) => {
			const tx = db.transaction(store, 'readwrite');
			tx.objectStore(store).put(value, key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => resolve();
		});
	} catch { /* cache is an optimization, never a dependency */ }
}
