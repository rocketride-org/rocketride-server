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
// VECTOR-UI — UPLOAD NAME LOCKS
// =============================================================================
//
// Upload progress events reach every listener of the shell's client and are
// keyed by the file's base name only. Within one connection the queue sends
// shared base names one at a time (uploads.ts batchForSend); these locks
// extend the rule across connections open in the same app: a send waits
// until no other send of the app has a file of the same base name in flight.
// Sends with different names still run side by side.
// =============================================================================

/** A set of base names held by sends in flight. */
export interface NameLocks {
	/**
	 * Wait until none of `names` is held, then hold them.
	 *
	 * @param names - Base names of the files about to be sent.
	 * @returns A function that releases them (safe to call twice).
	 */
	acquire(names: readonly string[]): Promise<() => void>;
	/** Names held right now (diagnostics and tests). */
	held(): string[];
}

/**
 * Create a lock set.
 *
 * @returns The locks.
 */
export function createNameLocks(): NameLocks {
	const held = new Set<string>();
	const waiting: Array<{ names: string[]; grant: (release: () => void) => void }> = [];

	const isFree = (names: readonly string[]): boolean => names.every((name) => !held.has(name));

	/**
	 * Hold names and build their release.
	 *
	 * @param names - The names.
	 * @returns The release function.
	 */
	const take = (names: string[]): (() => void) => {
		for (const name of names) held.add(name);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			for (const name of names) held.delete(name);
			pump();
		};
	};

	/** Grant every waiter whose names are free, oldest first. */
	const pump = (): void => {
		for (let i = 0; i < waiting.length; ) {
			const waiter = waiting[i];
			if (isFree(waiter.names)) {
				waiting.splice(i, 1);
				waiter.grant(take(waiter.names));
			} else {
				i++;
			}
		}
	};

	return {
		acquire(names) {
			const unique = [...new Set(names)];
			// A name an earlier waiter is waiting for stays theirs first.
			const contested = waiting.some((waiter) => waiter.names.some((name) => unique.includes(name)));
			if (!contested && isFree(unique)) return Promise.resolve(take(unique));
			return new Promise((grant) => waiting.push({ names: unique, grant }));
		},
		held() {
			return [...held];
		},
	};
}

/** The locks every upload queue of the app shares. */
export const sharedUploadLocks: NameLocks = createNameLocks();
