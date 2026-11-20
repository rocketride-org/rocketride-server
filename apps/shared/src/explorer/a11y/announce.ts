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
// EXPLORER A11Y — ANNOUNCE (an app's polite live-region channel)
// =============================================================================
//
// The shell has no live-region utility: `useAnnouncements` fetches GitHub
// product announcements and is unrelated, and only `Banner` sets `aria-live`.
// So outcomes that are visible but not focused — a run finishing, an entry
// pinned, a join path found, a result count — would reach a screen-reader user
// only if they happened to be reading the right part of the page.
//
// An announcer is the write end of that channel: a text store any code may push
// to without holding a React reference. The read end is a single visually
// hidden live region mounted once by the app (see createLiveRegion).
//
// A factory, not a module: each app owns its own announcer, so one app's
// sentences are never spoken by another app's region.
// =============================================================================

/** One announcement: the text, plus a revision that changes on every call. */
export interface IAnnouncement {
	/** The sentence to speak. */
	text: string;
	/** Monotonic revision — repeating the SAME text still re-announces. */
	revision: number;
}

/** One app's announcement channel. */
export interface IAnnouncer {
	/**
	 * Announce one short outcome to assistive technology.
	 *
	 * Politely: the live region never interrupts. Errors are already announced
	 * assertively by `Banner`, so they do not belong here.
	 */
	announce(text: string): void;
	/**
	 * Subscribe to announcements.
	 *
	 * @returns The unsubscribe function.
	 */
	subscribe(callback: () => void): () => void;
	/**
	 * The current announcement. Safe as a `useSyncExternalStore` snapshot: the
	 * same object is returned until the next {@link IAnnouncer.announce}.
	 */
	get(): IAnnouncement;
}

/**
 * Create an announcer.
 *
 * @returns A channel with nothing announced yet.
 */
export function createAnnouncer(): IAnnouncer {
	/**
	 * The current announcement. Replaced (never mutated) on every call, so a
	 * `useSyncExternalStore` snapshot stays referentially stable between them.
	 */
	let snapshot: IAnnouncement = { text: '', revision: 0 };
	const listeners = new Set<() => void>();

	return {
		announce(text: string): void {
			snapshot = { text, revision: snapshot.revision + 1 };
			listeners.forEach((listener) => listener());
		},
		subscribe(callback: () => void): () => void {
			listeners.add(callback);
			return () => { listeners.delete(callback); };
		},
		get(): IAnnouncement {
			return snapshot;
		},
	};
}
