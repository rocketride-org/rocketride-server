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
// EXPLORER DEV TOOL — FRAME IDENTITY GUARD (the frame half of R9)
// =============================================================================
//
// The controller vouches for the session (identity.ts) and publishes ONLY its
// fingerprint, as retained state on the `identity` topic:
//
//   controller   publishIdentityState(channel, tracker)   -> { fingerprint }
//   frame        createFrameIdentityGuard({ channel, docKey, documents, onReset })
//
// A frame remembers the FIRST fingerprint it sees (`first()`), and keeps
// following for as long as it is mounted:
//
//   a different fingerprint   another user, organization or development team:
//                             the frame resets its caches (`onReset('identity')`)
//                             and adopts the new fingerprint; a document frame
//                             also closes (`documents.close(docKey)`), AT MOST
//                             ONCE. A landing frame (docKey undefined or '')
//                             holds nothing connection-scoped and is never
//                             closed. `closed()` latches only on a close that
//                             returned: with no `documents`, or a close that
//                             threw, the next change tries again.
//   null                      the controller cannot vouch for anyone (signed
//                             out, disconnected): caches reset
//                             (`onReset('unknown')`), the document stays; the
//                             SAME fingerprint coming back changes nothing.
//   host:connection false     caches reset (`onReset('disconnected')`), once
//                             per drop.
//
// A remounted controller's tracker starts unknown until it reads the account
// again. `publishIdentityState` therefore publishes nothing until the tracker
// SETTLES (identity.ts `whenSettled`), or until it knows an identity, so live
// frames do not reset their caches for a remount that changed nothing. A
// tracker without `whenSettled` gets IDENTITY_SETTLE_GRACE_MS to know one.
//
// Fingerprints are compared, never epochs: a remounted VS Code controller
// restarts its own counters. Nothing here posts, so a frame may mount it at
// once; a permission-hint change keeps the fingerprint and publishes nothing.
// =============================================================================

import type { ToolChannel } from 'shell';
import { HOST_CONNECTION_TOPIC } from './frame';
import type { IIdentitySnapshot, IIdentityTracker } from './identity';

/** The retained state topic the controller publishes its identity on. */
export const IDENTITY_STATE_TOPIC = 'identity';

/** How long publishIdentityState waits for a tracker without `whenSettled` to know an identity before it publishes null. */
export const IDENTITY_SETTLE_GRACE_MS = 2_000;

/** What crosses: the fingerprint only (never the identity, never a token). */
export interface IIdentityState {
	/** `identityFingerprint(identity)`, or null when the controller cannot vouch for anyone. */
	fingerprint: string | null;
}

/**
 * The identity state for a tracker snapshot.
 *
 * @param snapshot - The tracker's answer.
 * @returns `{ fingerprint }`.
 */
export function identityState(snapshot: IIdentitySnapshot): IIdentityState {
	return { fingerprint: snapshot.known ? snapshot.fingerprint : null };
}

/**
 * CONTROLLER: publish the tracker's fingerprint now and whenever it changes
 * (a retained state publish, allowed at mount by R7).
 *
 * @param channel - The controller's channel.
 * @param tracker - The identity tracker.
 * @param topic - The state topic (default {@link IDENTITY_STATE_TOPIC}).
 * @returns Stop publishing.
 */
export function publishIdentityState(channel: ToolChannel, tracker: Pick<IIdentityTracker, 'get' | 'subscribe'> & Partial<Pick<IIdentityTracker, 'whenSettled'>>, topic: string = IDENTITY_STATE_TOPIC): () => void {
	/** The fingerprint last published; undefined before the first publish. */
	let last: string | null | undefined;
	let stopped = false;
	const publish = (): void => {
		if (stopped) return;
		const next = identityState(tracker.get()).fingerprint;
		if (next === last) return;
		last = next;
		channel.publishState(topic, { fingerprint: next } satisfies IIdentityState);
	};
	// Nothing before the first real answer, unless an identity is already known.
	let started = tracker.get().known;
	let grace: ReturnType<typeof setTimeout> | null = null;
	let offSettled: (() => void) | null = null;
	const start = (): void => {
		if (grace !== null) clearTimeout(grace);
		grace = null;
		started = true;
		publish();
	};
	if (started) publish();
	else if (typeof tracker.whenSettled === 'function') offSettled = tracker.whenSettled(start);
	else grace = setTimeout(start, IDENTITY_SETTLE_GRACE_MS);
	const offChanges = tracker.subscribe((snapshot) => {
		if (!started && !snapshot.known) return;
		if (!started) start();
		else publish();
	});
	return () => {
		stopped = true;
		if (grace !== null) clearTimeout(grace);
		offSettled?.();
		offChanges();
	};
}

/**
 * What a frame may say about the account, from the controller's `identity`
 * topic:
 *
 *   pending    nothing published yet (the controller publishes only once its
 *              tracker has a first answer): say nothing about the account;
 *   nobody     the controller vouches for no one (signed out, or the identity
 *              is not known): "waiting for sign-in", not "not connected";
 *   signed-in  a fingerprint.
 */
export type SignInState = 'pending' | 'nobody' | 'signed-in';

/**
 * FRAME: follow what the controller says about the account. Told at once
 * ('pending'), then on every change.
 *
 * @param channel - The frame's channel.
 * @param onChange - Told the state.
 * @param topic - The state topic (default {@link IDENTITY_STATE_TOPIC}).
 * @returns Stop following.
 */
export function followSignIn(channel: ToolChannel, onChange: (state: SignInState) => void, topic: string = IDENTITY_STATE_TOPIC): () => void {
	let last: SignInState = 'pending';
	let stopped = false;
	onChange(last);
	const off = channel.onState(topic, (snapshot: unknown) => {
		if (stopped) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { fingerprint?: unknown }).fingerprint : undefined;
		const next: SignInState = typeof value === 'string' && value !== '' ? 'signed-in' : 'nobody';
		if (next === last) return;
		last = next;
		onChange(next);
	});
	return () => {
		stopped = true;
		off();
	};
}

/** Why a frame reset its caches. */
export type FrameResetReason = 'identity' | 'unknown' | 'disconnected';

/** What {@link createFrameIdentityGuard} needs. */
export interface IFrameIdentityGuardOptions {
	/** The frame's channel (DevToolProps.channel, or the per-peer one). */
	channel: ToolChannel;
	/** The frame's docKey (undefined or '' for the landing / generic frame). */
	docKey?: string | null;
	/** The mount's documents (DevToolProps.documents). */
	documents?: { close(docKey: string): void };
	/** Clear every cache the frame holds (schemas, results, sessions in flight). */
	onReset: (reason: FrameResetReason) => void;
	/** The state topic (default {@link IDENTITY_STATE_TOPIC}). */
	topic?: string;
}

/** The guard. */
export interface IFrameIdentityGuard {
	/** The fingerprint the frame belongs to (the first it saw), or null before one arrived. */
	first(): string | null;
	/** Whether the guard closed the document. */
	closed(): boolean;
	/** Stop following the channel (idempotent). */
	dispose(): void;
}

/**
 * FRAME: close the document and clear caches when the controller's identity
 * changes, and clear caches when the host connection drops.
 *
 * @param opts - See {@link IFrameIdentityGuardOptions}.
 * @returns The guard; dispose it in the mount's cleanup.
 */
export function createFrameIdentityGuard(opts: IFrameIdentityGuardOptions): IFrameIdentityGuard {
	const { channel, documents, onReset } = opts;
	const docKey = typeof opts.docKey === 'string' && opts.docKey !== '' ? opts.docKey : null;
	let first: string | null = null;
	let current: string | null = null;
	let wasClosed = false;
	let connected: boolean | null = null;
	let disposed = false;

	/** Close the document, at most once; latch only on a close that returned. */
	const closeOnce = (): void => {
		if (wasClosed || docKey === null || documents === undefined) return;
		try {
			documents.close(docKey);
			wasClosed = true;
		} catch {
			// The host could not close it now; the next change tries again.
		}
	};

	const offIdentity = channel.onState(opts.topic ?? IDENTITY_STATE_TOPIC, (snapshot) => {
		if (disposed) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { fingerprint?: unknown }).fingerprint : undefined;
		const fingerprint = typeof value === 'string' && value !== '' ? value : null;
		if (fingerprint === null) {
			if (current !== null) onReset('unknown');
			current = null;
			return;
		}
		current = fingerprint;
		if (first === null) {
			first = fingerprint;
			return;
		}
		if (fingerprint === first) return;
		first = fingerprint;
		closeOnce();
		onReset('identity');
	});

	const offConnection = channel.onState(HOST_CONNECTION_TOPIC, (snapshot) => {
		if (disposed) return;
		const value = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { connected?: unknown }).connected : undefined;
		if (typeof value !== 'boolean') return;
		const was = connected;
		connected = value;
		if (!value && was !== false) onReset('disconnected');
	});

	return {
		first: () => first,
		closed: () => wasClosed,
		dispose() {
			if (disposed) return;
			disposed = true;
			offIdentity();
			offConnection();
		},
	};
}
