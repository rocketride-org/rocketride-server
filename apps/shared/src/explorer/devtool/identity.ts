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
// EXPLORER DEV TOOL — IDENTITY TRACKER (who is signed in, failing closed, R9)
// =============================================================================
//
// The controller's endpoint store must never discover under an identity it
// cannot vouch for: a null identity makes discovery skip the
// other-organization filter (connect/identity.ts), and a stale one lists the
// previous session's runs. The tracker answers ONE question, "whose session
// is this, right now?", and answers "unknown" whenever it cannot be sure.
//
// WHERE THE ANSWER COMES FROM (verified in source, 2026-10-21):
//
//   A realm that OWNS the client (rocket-ui): the SDK client's own account,
//   `getClient().getAccountInfo()`. Every (re)connect handshake sets it, every
//   disconnect and logout clears it, an `apaext_account` push replaces it
//   (client-typescript client.ts: _connectResult), so the tracker reads it
//   directly rather than through the manager.
//
//   A SOCKETLESS realm (VS Code webview; `getClient()` is null): the root's
//   retained `shell:account` topic. The extension host republishes it on
//   every status change and account push, and publishes null when it loses
//   the account (apps/vscode busHost.ts startMirrors; the SDK clears its
//   account before announcing a disconnect). The realm's own manager IGNORES
//   that null (connection.ts installMirrorSubscriptions: `if (!snapshot)
//   return;`), so its `getAccountInfo()` can keep answering the previous
//   account after a sign-out. The tracker therefore subscribes to the topic
//   itself and reads it (`cm.read`) at mount and on every reconnect.
//
// RECONNECT RULE. What a socketless realm sees around a reconnect: the root
// publishes `shell:status` then `shell:account` on the same host event, so the
// realm emits `shell:connected` FIRST and `shell:accountUpdate` (the fresh
// account) AFTER it. So:
//
//   shell:disconnected            -> unknown; nothing held survives the drop
//   shell:connected               -> re-read the source (above); never re-use
//                                    a pre-drop account
//   shell:login / accountUpdate   -> that account (a falsy one: unknown)
//   shell:logout / orgChanged     -> unknown until a truthy account arrives
//                                    (a reconnect does not end the wait)
//   topic snapshot (socketless)   -> that account; null: unknown
//
// Account A -> disconnect -> reconnect -> account B therefore reads A, then
// unknown, then B: never "A again", never "A then nothing". If the root kept
// the same account through the drop it never republishes it, and the re-read
// on `shell:connected` finds it current.
//
// ORDER. A topic delivery is newer than any root read still in flight, so it
// invalidates that read: a late read can never override a newer push.
//
// ANONYMOUS SESSIONS (checked in source). An anonymous or public attach never
// yields an identity today: the SDK's `_attachAnonymous` sets no account
// (client.ts), the manager emits `shell:connected` only for an AUTHENTICATED
// client (connection.ts onConnected guard and `_connect`'s
// requireAuthenticatedResult, which demands a userId), and the root publishes
// a null account. The tracker still fails closed on it: in a client realm the
// identity is known only while the client reports `isAuthenticated()`.
//
// A bus without `read`/`subscribe` (a bare structural fake) degrades to the
// strict event rule: the mount-time `getAccountInfo()`, then only account
// events. Epochs are never compared (a remounted VS Code controller restarts
// them).
// =============================================================================

import type { ShellEventMap } from 'shell';
import { identityFingerprint, identityFromConnectResult } from '../connect/identity';
import type { IExplorerIdentity } from '../types';

/** The root's retained account topic (busRealm.ts / connection.ts installMirrorSubscriptions). */
export const ACCOUNT_MIRROR_TOPIC = 'shell:account';

/** The shell events the tracker follows. */
export type IdentityEvent = 'shell:login' | 'shell:logout' | 'shell:accountUpdate' | 'shell:orgChanged' | 'shell:connected' | 'shell:disconnected';

/** What the tracker needs from a realm's ConnectionManager (structural). */
export interface IIdentityBus {
	/** Follow a shell event; returns the unsubscribe function. */
	on<K extends IdentityEvent>(event: K, handler: (payload: ShellEventMap[K]) => void): () => void;
	/** The manager's account (only a fallback; see the header). */
	getAccountInfo(): unknown;
	/** Whether the realm is connected. */
	isConnected(): boolean;
	/** The realm's client (null in a socketless realm). */
	getClient?(): unknown;
	/** Follow a retained topic (the root's account topic). */
	subscribe?(topic: string, cb: (snapshot: unknown) => void): () => void;
	/** Read a retained topic at the root. */
	read?(topic: string): Promise<unknown>;
}

/** The tracker's answer. */
export interface IIdentitySnapshot {
	/** True only when an identity is known and the realm is connected. Discovery waits for it. */
	known: boolean;
	/** The identity, or null when unknown (signed out, disconnected, waiting for a fresh account). */
	identity: IExplorerIdentity | null;
	/** `identityFingerprint(identity)`; frames compare it (R9). */
	fingerprint: string | null;
}

/** The tracker. */
export interface IIdentityTracker {
	/** The current answer (a stable object until it changes; useSyncExternalStore-friendly). */
	get(): IIdentitySnapshot;
	/** `get().known`. */
	readonly known: boolean;
	/** `get().identity`. */
	readonly identity: IExplorerIdentity | null;
	/** `get().fingerprint`. */
	readonly fingerprint: string | null;
	/** Be told about every change (fingerprint or permission hints); returns unsubscribe. */
	subscribe(cb: (snapshot: IIdentitySnapshot) => void): () => void;
	/**
	 * Whether the tracker has given its FIRST real answer: at once in a client
	 * realm, once the root's account topic was read in a socketless one. Before
	 * that, `known: false` means "not read yet", not "signed out".
	 */
	settled(): boolean;
	/** Be told once, when the tracker settles (at once if it has); returns unsubscribe. */
	whenSettled(cb: () => void): () => void;
	/** Stop following the realm (idempotent). */
	dispose(): void;
}

const UNKNOWN: IIdentitySnapshot = Object.freeze({ known: false, identity: null, fingerprint: null }) as IIdentitySnapshot;

/**
 * Track the signed-in identity of a controller realm.
 *
 * @param opts - `cm`: the realm's ConnectionManager (structural).
 * @returns The tracker.
 */
export function createIdentityTracker(opts: { cm: IIdentityBus }): IIdentityTracker {
	const { cm } = opts;
	const listeners = new Set<(snapshot: IIdentitySnapshot) => void>();
	const offs: Array<() => void> = [];

	/** The account currently trusted, or null. */
	let account: unknown = null;
	/** After logout / orgChanged: nothing but a truthy account event ends the wait. */
	let awaiting = false;
	/** Bumped whenever an in-flight topic read must be ignored. */
	let readSeq = 0;
	let snapshot: IIdentitySnapshot = UNKNOWN;
	let signature = '';
	let disposed = false;
	let isSettled = false;
	const settleListeners = new Set<() => void>();
	/** The first real answer is in. */
	const markSettled = (): void => {
		if (isSettled) return;
		isSettled = true;
		for (const listener of [...settleListeners]) listener();
		settleListeners.clear();
	};

	const isConnected = (): boolean => {
		try {
			return cm.isConnected() === true;
		} catch {
			return false;
		}
	};
	const client = (): unknown => (typeof cm.getClient === 'function' ? cm.getClient() : undefined);
	const socketless = (): boolean => typeof cm.getClient === 'function' && (client() === null || client() === undefined);
	const canReadRoot = (): boolean => socketless() && typeof cm.read === 'function';
	/** In a client realm, whether the client says its session is authenticated (fails closed). */
	const authenticated = (): boolean => {
		if (socketless()) return true;
		const own = client() as { isAuthenticated?: () => unknown } | undefined;
		if (typeof own?.isAuthenticated !== 'function') return true;
		try {
			return own.isAuthenticated() === true;
		} catch {
			return false;
		}
	};

	/** Recompute the answer and tell subscribers when it changed. */
	const publish = (): void => {
		const identity = isConnected() && authenticated() && account ? identityFromConnectResult(account) : null;
		const next: IIdentitySnapshot = identity === null ? UNKNOWN : { known: true, identity, fingerprint: identityFingerprint(identity) };
		const nextSignature = identity === null ? '' : JSON.stringify(identity);
		if (nextSignature === signature) return;
		signature = nextSignature;
		snapshot = next;
		for (const listener of [...listeners]) listener(snapshot);
	};

	/**
	 * Trust an account (a falsy one means unknown).
	 *
	 * @param value - The account.
	 */
	const accept = (value: unknown): void => {
		account = value ? value : null;
		if (account !== null) awaiting = false;
		publish();
	};

	/**
	 * Forget the account.
	 *
	 * @param wait - Also wait for a truthy account event before trusting anything again.
	 */
	const forget = (wait: boolean): void => {
		readSeq += 1;
		account = null;
		if (wait) awaiting = true;
		publish();
	};

	/** Re-read the source of truth for this realm kind (mount and reconnect). */
	const reread = (): void => {
		if (disposed || awaiting) return publish();
		if (!isConnected()) return forget(false);
		if (canReadRoot()) {
			const seq = ++readSeq;
			(cm.read as (topic: string) => Promise<unknown>)(ACCOUNT_MIRROR_TOPIC).then(
				(value) => {
					if (!disposed && seq === readSeq && !awaiting) accept(value);
					markSettled();
				},
				() => {
					if (!disposed && seq === readSeq) forget(false);
					markSettled();
				},
			);
			return;
		}
		if (socketless()) return publish();
		const own = client() as { getAccountInfo?: () => unknown } | undefined;
		accept(typeof own?.getAccountInfo === 'function' ? own.getAccountInfo() : cm.getAccountInfo());
	};

	const on = (event: IdentityEvent, handler: (payload: unknown) => void): void => {
		offs.push(cm.on(event, handler));
	};
	on('shell:login', (payload) => accept(payload !== null && typeof payload === 'object' ? (payload as { user?: unknown }).user : null));
	on('shell:accountUpdate', (payload) => accept(payload));
	on('shell:logout', () => forget(true));
	on('shell:orgChanged', () => forget(true));
	on('shell:disconnected', () => forget(false));
	// The payload may be undefined in a mirrored realm: never read it.
	on('shell:connected', () => reread());

	if (typeof cm.subscribe === 'function') {
		offs.push(cm.subscribe(ACCOUNT_MIRROR_TOPIC, (value) => {
			if (disposed || !socketless()) return;
			// Newer than any read still in flight: that read must not land after it.
			readSeq += 1;
			if (value) accept(value);
			else forget(false);
			markSettled();
		}));
	}

	// Mount: a socketless realm with a root to read waits for it; a bare bus
	// takes the manager's snapshot (the only one it has); a client realm reads
	// its client.
	if (socketless() && !canReadRoot()) accept(isConnected() ? cm.getAccountInfo() : null);
	else reread();
	// Only a socketless realm's root read answers later; everything else answered now.
	if (!(socketless() && canReadRoot() && isConnected())) markSettled();

	return {
		get: () => snapshot,
		get known() { return snapshot.known; },
		get identity() { return snapshot.identity; },
		get fingerprint() { return snapshot.fingerprint; },
		subscribe(cb) {
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
		settled: () => isSettled,
		whenSettled(cb) {
			if (isSettled) {
				cb();
				return () => undefined;
			}
			settleListeners.add(cb);
			return () => { settleListeners.delete(cb); };
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			readSeq += 1;
			for (const off of offs.splice(0)) off();
			listeners.clear();
			settleListeners.clear();
		},
	};
}
