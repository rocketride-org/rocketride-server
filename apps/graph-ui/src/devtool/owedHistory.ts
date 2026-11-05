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
// GRAPH-UI - HISTORY OWED TO AN OWNER (the last batch across a disconnect, a sign-out, an unmount)
// =============================================================================
//
// The controller writes history through one fs accessor per identity
// (shared/explorer/devtool/prefs.ts). The base's accessor already knows who may
// receive a write: its `ownerNow` says the owner (write), nobody known (HOLD and
// retry later), or someone else (DROP: never into another account's file). What
// it cannot do is outlive the code that holds it. This module keeps an accessor
// that still owes its owner a change:
//
//   HELD    The identity went unknown (a disconnect or a sign-out reaches the
//           identity tracker before anything unmounts): the controller keeps
//           the accessor, with the store's last batch already handed to it, and
//           re-uses it when the same owner is back (its change then goes out),
//           or flushes it when another owner is known (the base drops it).
//   PARKED  The controller unmounted while the identity was unknown (VS Code
//           unmounts it on every disconnect): the accessor, and the identity
//           tracker its `ownerNow` reads, are parked for the realm. The next
//           controller in the realm ADOPTS it (one accessor, so no second
//           reader can load the file without the change); with no controller,
//           the parked accessor writes (same owner back) or drops (another
//           owner) by itself. It is released after PARKED_HISTORY_TTL_MS
//           whatever happened.
//
// `ownerNow` never vouches for an owner the tracker does not know: while the
// identity is unknown it answers null, so the base holds the write instead of
// sending it into whatever session the transport comes back with. An explicit
// flush when the owner is known again sends it at once (the base's own retries
// stop after a few minutes).
// =============================================================================

import type { IIdentityTracker } from 'shared/explorer/devtool/identity';
import type { IFsPrefs } from 'shared/explorer/devtool/prefs';

/** Where an accessor's `ownerNow` reads the identity from (swapped when a parked accessor is adopted). */
export interface IVouch {
	tracker: Pick<IIdentityTracker, 'get'>;
}

/** An fs accessor and the owner it writes for. */
export interface IOwedHistory {
	readonly owner: string;
	readonly prefs: IFsPrefs;
	readonly vouch: IVouch;
}

/** How long a parked accessor waits for its owner (or for another) before it is released, dropping its change. */
export const PARKED_HISTORY_TTL_MS = 10 * 60_000;

/**
 * The `ownerNow` of an accessor: the fingerprint the tracker knows, or null while it knows nobody.
 *
 * @param vouch - Where the identity is read.
 * @returns The function.
 */
export function ownerNowOf(vouch: IVouch): () => string | null {
	return () => {
		const snapshot = vouch.tracker.get();
		return snapshot.known ? snapshot.fingerprint : null;
	};
}

/**
 * Let an accessor settle its change under the identity its tracker knows now (written for its owner, dropped for
 * another), then dispose it.
 *
 * @param owed - The accessor.
 * @returns When it is done.
 */
export function settleOwed(owed: IOwedHistory): Promise<void> {
	const done = (): void => owed.prefs.dispose();
	return owed.prefs.flush().then(done, done);
}

/** One parked accessor. */
interface IParked {
	owed: IOwedHistory;
	tracker: IIdentityTracker;
	off: () => void;
	timer: unknown;
	clearTimer: (handle: unknown) => void;
	/** Adopted by a controller: it now owns the accessor (and disposed the parked tracker). */
	adopted: boolean;
	released: boolean;
}

/** Parked accessors, per history file (one realm, one file per tool). */
const PARKED = new Map<string, IParked>();

/**
 * Release a parked accessor: dispose it and the tracker it kept alive (unless a controller adopted it).
 *
 * @param path - Its file.
 * @param parked - The record.
 */
function release(path: string, parked: IParked): void {
	if (parked.released) return;
	parked.released = true;
	if (PARKED.get(path) === parked) PARKED.delete(path);
	parked.off();
	parked.clearTimer(parked.timer);
	if (parked.adopted) return;
	parked.owed.prefs.dispose();
	parked.tracker.dispose();
}

/**
 * Park an accessor that still owes its owner a change, with the identity tracker its `ownerNow` will read (this
 * realm's, kept alive). The next controller adopts it; without one, it writes when its owner is known again, drops
 * its change when another identity is known, and is released after the TTL.
 *
 * @param path - Its file.
 * @param owed - The accessor.
 * @param tracker - The realm's identity tracker (handed over: released with the accessor).
 * @param opts - The TTL and timers (tests).
 */
export function parkHistory(path: string, owed: IOwedHistory, tracker: IIdentityTracker, opts: { ttlMs?: number; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (handle: unknown) => void } = {}): void {
	const earlier = PARKED.get(path);
	if (earlier) {
		PARKED.delete(path);
		const done = (): void => release(path, earlier);
		void earlier.owed.prefs.flush().then(done, done);
	}
	// The time limit only frees memory: it must never keep a process alive (Node's `unref`; browsers return a number).
	const setTimer =
		opts.setTimer ??
		((fn: () => void, ms: number): unknown => {
			const handle = setTimeout(fn, ms) as unknown as { unref?: () => void };
			handle.unref?.();
			return handle;
		});
	const clearTimer = opts.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
	owed.vouch.tracker = tracker;
	const parked: IParked = { owed, tracker, off: () => undefined, timer: null, clearTimer, adopted: false, released: false };
	const settleIfKnown = (): void => {
		if (parked.released || parked.adopted || !tracker.get().known) return;
		// Known again: its owner (written) or another account (dropped by the base). Either way it is settled.
		const done = (): void => release(path, parked);
		void owed.prefs.flush().then(done, done);
	};
	parked.timer = setTimer(() => release(path, parked), opts.ttlMs ?? PARKED_HISTORY_TTL_MS);
	parked.off = tracker.subscribe(() => settleIfKnown());
	PARKED.set(path, parked);
	settleIfKnown();
}

/**
 * Adopt the accessor an unmounted controller parked for this file, when it is this owner's; another owner's is
 * settled (dropped, since the tracker now knows someone else) and released.
 *
 * @param path - The file.
 * @param owner - The adopting controller's identity fingerprint.
 * @param tracker - The adopting controller's identity tracker (the accessor reads it from now on).
 * @returns The accessor for this owner, or null.
 */
export function adoptParkedHistory(path: string, owner: string, tracker: Pick<IIdentityTracker, 'get'>): IOwedHistory | null {
	const parked = PARKED.get(path);
	if (!parked || parked.released) return null;
	PARKED.delete(path);
	parked.owed.vouch.tracker = tracker;
	if (parked.owed.owner !== owner) {
		// Flushed while this (other) identity is known: the base drops the change; then the accessor and tracker go.
		const done = (): void => release(path, parked);
		void parked.owed.prefs.flush().then(done, done);
		return null;
	}
	parked.adopted = true;
	release(path, parked);
	parked.tracker.dispose();
	return parked.owed;
}

/**
 * Whether an accessor is parked for a file (tests).
 *
 * @param path - The file.
 * @returns True while one is.
 */
export function hasParkedHistory(path: string): boolean {
	return PARKED.has(path);
}
