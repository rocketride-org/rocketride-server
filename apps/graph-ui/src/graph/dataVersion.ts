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
// GRAPH - DATA VERSIONS (has something that can change data run on this connection?)
// =============================================================================
//
// A counter per connection that goes up whenever `execute` may have changed data
// there, from ANY document of the app: the write console is one document and the
// workbench's graph another, and the graph must find out that what it drew may no
// longer exist. It holds numbers only.
//
// The count is taken where the write is SENT (countWrite), not when a document
// records the outcome: a write can land after its console was closed, and the shared
// runner records nothing for a closed document. And a write that FAILED is counted
// too, unless it was refused before anything was sent: the node can fail after the
// database ran the statement (see failures.ts, writeMayHaveApplied).
// =============================================================================

import { writeMayHaveApplied } from './failures';

/** The counters. */
export interface IDataVersions {
	/** The current version of a connection (0 until a write ran). */
	get(key: string): number;
	/** Record that something may have changed. */
	bump(key: string): void;
	/** Subscribe to any change. */
	subscribe(listener: () => void): () => void;
	/** Every connection's version, as a plain object ordered from the least to the most recently bumped. */
	snapshot(): Record<string, number>;
}

/**
 * Create the counters.
 *
 * @returns A store with every connection at version 0.
 */
export function createDataVersions(): IDataVersions {
	const versions = new Map<string, number>();
	const listeners = new Set<() => void>();
	return {
		get: (key) => versions.get(key) ?? 0,
		bump(key) {
			const next = (versions.get(key) ?? 0) + 1;
			// Re-inserted, so the map runs from the least to the most recently bumped (a capped summary keeps the newest).
			versions.delete(key);
			versions.set(key, next);
			listeners.forEach((l) => l());
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		snapshot: () => Object.fromEntries(versions),
	};
}

/**
 * Send a write and count it on the connection when it may have changed data: when it succeeds, and when it fails in a
 * way that can come after the database ran it. Counting here, in the call, does not depend on any document still
 * being open when the answer arrives.
 *
 * @param versions - The counters.
 * @param key - The connection's key.
 * @param send - Sends the statement through `execute`.
 * @returns What `send` resolved with; a failure is rethrown unchanged.
 */
export async function countWrite<T>(versions: IDataVersions, key: string, send: () => Promise<T>): Promise<T> {
	let result: T;
	try {
		result = await send();
	} catch (error) {
		if (writeMayHaveApplied(error)) versions.bump(key);
		throw error;
	}
	versions.bump(key);
	return result;
}

/**
 * Whether a recorded outcome counts on top of {@link countWrite}: a write the user stopped waiting for may still
 * complete on the database, so drawn graphs go out of date at once rather than when (if ever) its answer lands.
 *
 * @param mode - `read` for the workbench, `write` for the write console.
 * @param outcome - How the run ended.
 * @returns True for a write the app stopped waiting for.
 */
export function isAbandonedWrite(mode: 'read' | 'write', outcome: string): boolean {
	return mode === 'write' && outcome === 'abandoned';
}
