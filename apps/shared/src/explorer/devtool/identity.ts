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
// WHERE THE ANSWER COMES FROM. Every realm holds a real client (the root's, or
// a RocketRideClientProxy seeded from the root's mirror), so whether a realm
// owns a socket is NEVER inferred from having a client. Two sources exist, and
// the bus's own capabilities decide between them:
//
//   The root's retained `shell:account` topic, when the bus offers
//   `subscribe`/`read` AND the topic has ever delivered a value to this realm
//   (even null): the authority. The VS Code extension host republishes it on
//   every status change and account push, and publishes null when it loses the
//   account (apps/vscode busHost.ts startMirrors; the SDK clears its account
//   before announcing a disconnect). A mirrored realm's own manager IGNORES
//   that null (connection.ts installMirrorSubscriptions: `if (!snapshot)
//   return;`), so the realm client's `getAccountInfo()` keeps answering the
//   PREVIOUS account after a sign-out, and `shell:status` (connected) lands
//   before `shell:account` on the next sign-in: a client read at that moment
//   would show the old user for the new connection. So once the topic is known
//   the tracker reads and follows the topic, never the client's account.
//
//   The client's own account (`getAccountInfo()`), when the topic never
//   delivered (the cloud shell's root has no such publisher): every
//   (re)connect handshake sets it, every disconnect and logout clears it, an
//   `apaext_account` push replaces it (client-typescript client.ts:
//   _connectResult).
//
// RECONNECT RULE. What a mirrored realm sees around a reconnect: the root
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
//   topic snapshot                -> that account; null: unknown
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
// a null account. The tracker still fails closed on it: the identity is known
// only while the client (when there is one) reports `isAuthenticated()`.
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
	/** The realm's client (null until the realm can answer; never evidence of what the realm owns). */
	getClient?(): unknown;
	/** Follow a retained topic (the root's account topic): its presence is the capability. */
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
	 * Whether the tracker has given its FIRST real answer: at once, unless the
	 * root's account topic is being read (the bus offers `read`) and that read
	 * has not answered. Before
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
	/** Whether the root's account topic has ever delivered a value (even null) to this realm: then it is the authority. */
	let topicKnown = false;
	/** The client says its session is authenticated, or has no way to say (fails closed on a throw). */
	const authenticated = (): boolean => {
		const own = client() as { isAuthenticated?: () => unknown } | null | undefined;
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

	/** Trust the client's own account (the topic never delivered). */
	const acceptClient = (): void => {
		const own = client() as { getAccountInfo?: () => unknown } | null | undefined;
		accept(typeof own?.getAccountInfo === 'function' ? own.getAccountInfo() : cm.getAccountInfo());
	};

	/** Whether a read of the root topic is pending at mount (the first answer is not in yet). */
	let readPending = false;

	/** Re-read the source of truth (mount and reconnect). */
	const reread = (): void => {
		if (disposed || awaiting) return publish();
		if (!isConnected()) return forget(false);
		if (typeof cm.read === 'function') {
			const seq = ++readSeq;
			cm.read(ACCOUNT_MIRROR_TOPIC).then(
				(value) => {
					if (!disposed && seq === readSeq && !awaiting) {
						if (value !== undefined) {
							topicKnown = true;
							accept(value);
						} else if (topicKnown) {
							// The topic spoke before and now says nothing: nobody is vouched for.
							forget(false);
						} else {
							// The root has no account topic (the cloud shell's root): the client's own account answers.
							acceptClient();
						}
					}
					readPending = false;
					markSettled();
				},
				() => {
					if (!disposed && seq === readSeq) forget(false);
					readPending = false;
					markSettled();
				},
			);
			readPending = true;
			// Nothing is trusted until the read answers: a mirrored realm's client may still hold the PREVIOUS account.
			return;
		}
		acceptClient();
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
			if (disposed || value === undefined) return;
			topicKnown = true;
			// Newer than any read still in flight: that read must not land after it.
			readSeq += 1;
			if (value) accept(value);
			else forget(false);
			readPending = false;
			markSettled();
		}));
	}

	// Mount: read the source of truth. Only a pending read of the root answers later.
	reread();
	if (!readPending) markSettled();

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
