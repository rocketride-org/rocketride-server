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
// A11Y — ANNOUNCE (the app's polite live-region channel)
// =============================================================================
//
// The shell has no live-region utility: `useAnnouncements` fetches GitHub
// product announcements and is unrelated, and only `Banner` sets `aria-live`.
// So outcomes that are visible but not focused — a run finishing, an entry
// pinned, a join path found — would reach a screen-reader user only if they
// happened to be reading the right part of the page.
//
// This module is the write end of that channel: a text store any code may
// push to without holding a React reference. The read end is a single
// visually-hidden live region mounted once by the app shell.
// =============================================================================

/** One announcement: the text, plus a revision that changes on every call. */
export interface IAnnouncement {
	/** The sentence to speak. */
	text: string;
	/** Monotonic revision — repeating the SAME text still re-announces. */
	revision: number;
}

/**
 * The current announcement. Replaced (never mutated) on every call, so a
 * `useSyncExternalStore` snapshot stays referentially stable between them.
 */
let snapshot: IAnnouncement = { text: '', revision: 0 };

const listeners = new Set<() => void>();

/**
 * Announce one short outcome to assistive technology.
 *
 * Politely: the live region never interrupts. Errors are already announced
 * assertively by `Banner`, so they do not belong here.
 *
 * @param text - The sentence to announce.
 */
export function announce(text: string): void {
	snapshot = { text, revision: snapshot.revision + 1 };
	listeners.forEach((listener) => listener());
}

/**
 * Subscribe to announcements.
 *
 * @param callback - Called after every announcement.
 * @returns The unsubscribe function.
 */
export function subscribeAnnouncements(callback: () => void): () => void {
	listeners.add(callback);
	return () => { listeners.delete(callback); };
}

/**
 * The current announcement. Safe as a `useSyncExternalStore` snapshot: the
 * same object is returned until the next {@link announce}.
 *
 * @returns The latest announcement.
 */
export function getAnnouncement(): IAnnouncement {
	return snapshot;
}
