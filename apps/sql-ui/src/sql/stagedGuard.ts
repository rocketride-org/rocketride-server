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
// SQL — STAGED GUARD (ask before staged row edits are dropped)
// =============================================================================
//
// A new data seed remounts a connection's Data page, and its staged edits
// go with it. The page registers how many it holds, by endpoint key; the
// workbench asks before it replaces the page when there are any (review P4
// R2-M2). One page per connection document, so one count per key.
// =============================================================================

/** Each open Data page's staged-change count, by endpoint key. */
const readers = new Map<string, () => number>();

/**
 * Register a Data page's staged-change count.
 *
 * @param key - The connection's endpoint key.
 * @param read - Reads the count now.
 * @returns Unregisters it (only if it is still the registered one).
 */
export function registerStagedCount(key: string, read: () => number): () => void {
	readers.set(key, read);
	return () => {
		if (readers.get(key) === read) readers.delete(key);
	};
}

/**
 * How many changes the connection's Data page holds staged.
 *
 * @param key - The connection's endpoint key.
 * @returns The count (0 with no page open).
 */
export function stagedCount(key: string): number {
	return readers.get(key)?.() ?? 0;
}

/**
 * The question before another table's data replaces staged changes.
 *
 * @param count - How many are staged.
 * @param table - The table about to open.
 * @returns `You have 3 staged changes. Discard them and open customers?`
 */
export function leaveDataText(count: number, table: string): string {
	return count === 1
		? `You have 1 staged change. Discard it and open ${table}?`
		: `You have ${count} staged changes. Discard them and open ${table}?`;
}
