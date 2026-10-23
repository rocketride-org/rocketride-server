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
// EXPLORER DEV TOOL — DISCOVERY WATCH (when a controller's store may discover)
// =============================================================================
//
// The controller-side replacement for shellBinding.ts `createShellWatch`, built
// from the identity tracker and the activation gate instead of raw shell
// events. Discovery is ALLOWED only while both hold:
//
//   identity.known       the tracker vouches for the session (identity.ts)
//   activation.isOpen()  the tool was activated (activation.ts)
//
// What the watch does with that:
//
//   - forwards every identity change to the store (`onIdentity`); unknown
//     arrives as null, which resets everything the store holds;
//   - when discovery becomes allowed (first activation with a known identity,
//     or a known identity again after a drop) it asks for one refresh
//     (`onReconnect`: discover and re-probe), and again when the fingerprint
//     switches between two KNOWN identities while discovery stays allowed
//     (the store reset for the new identity and must not stay empty); a
//     change in permission hints alone (same fingerprint) asks for nothing;
//   - task events (`shell:event` apaevt_task) and window focus wake the store
//     ONLY while allowed;
//   - the task monitor is registered the first time discovery is allowed,
//     never at mount (quiet boot), and removed when the store detaches.
//
// Lanes attach with `store.attach(client, identity.get().identity,
// discovery.watch)` and check `discovery.allowed()` before an explicit
// refresh.
// =============================================================================

import type { ShellEventMap } from 'shell';
import { isPlainObject } from '../checks';
import type { EndpointWatch } from '../connect/store';
import type { IExplorerClient, IExplorerIdentity } from '../types';
import type { IActivationGate } from './activation';
import type { IIdentityTracker } from './identity';

/** The monitor key and type that deliver task lifecycle events (as shellBinding.ts). */
const TASK_MONITOR_KEY = { token: '*' };
const TASK_MONITOR_TYPES = ['task'];

/** What the watch needs from a realm's ConnectionManager (structural). */
export interface IDiscoveryBus {
	/** Follow the server event stream; returns the unsubscribe function. */
	on<K extends 'shell:event'>(event: K, handler: (payload: ShellEventMap[K]) => void): () => void;
}

/** Something that fires focus / visibilitychange (the window, or null in tests). */
export interface IFocusTarget {
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

/** What {@link createDevToolDiscovery} needs. */
export interface IDevToolDiscoveryOptions {
	/** The realm's ConnectionManager. */
	cm: IDiscoveryBus;
	/** The controller's bus client (registers the task monitor). */
	client: IExplorerClient;
	/** The identity tracker. */
	identity: IIdentityTracker;
	/** The activation gate. */
	activation: IActivationGate;
	/** Where focus comes from (default: the window, when there is one; null: none). */
	focusTarget?: IFocusTarget | null;
}

/** The composition. */
export interface IDevToolDiscovery {
	/** Pass to `store.attach(client, identity.get().identity, watch)`. */
	readonly watch: EndpointWatch;
	/** Whether the store may discover now (identity known AND activated). */
	allowed(): boolean;
	/** Be told when `allowed()` changes; returns unsubscribe. */
	subscribe(cb: (allowed: boolean) => void): () => void;
	/** Stop following identity and activation (idempotent). */
	dispose(): void;
}

/**
 * Compose the controller's discovery gate and its store watch.
 *
 * @param opts - See {@link IDevToolDiscoveryOptions}.
 * @returns The composition.
 */
export function createDevToolDiscovery(opts: IDevToolDiscoveryOptions): IDevToolDiscovery {
	const { cm, client, identity, activation } = opts;
	const focusTarget = opts.focusTarget !== undefined ? opts.focusTarget : (typeof window !== 'undefined' ? window : null);
	const listeners = new Set<(allowed: boolean) => void>();
	const compute = (): boolean => identity.get().known && activation.isOpen();
	let allowed = compute();
	let fingerprint = identity.get().fingerprint;
	let disposed = false;

	/** Fan-out targets inside the watch (one per attached store). */
	const wakers = new Set<{ onAllowed: () => void; onIdentity: (next: IExplorerIdentity | null) => void }>();

	const update = (): void => {
		const next = compute();
		if (next === allowed) return;
		allowed = next;
		for (const listener of [...listeners]) listener(allowed);
		if (allowed) for (const waker of [...wakers]) waker.onAllowed();
	};

	const offIdentity = identity.subscribe((snapshot) => {
		const wasAllowed = allowed;
		const previous = fingerprint;
		fingerprint = snapshot.fingerprint;
		for (const waker of [...wakers]) waker.onIdentity(snapshot.identity);
		update();
		const switched = previous !== null && fingerprint !== null && previous !== fingerprint;
		if (wasAllowed && allowed && switched) for (const waker of [...wakers]) waker.onAllowed();
	});
	const offActivation = activation.subscribe(() => update());

	const watch: EndpointWatch = (handlers) => {
		let monitored = false;
		const arm = (): void => {
			if (monitored) return;
			monitored = true;
			void client.addMonitor?.(TASK_MONITOR_KEY, TASK_MONITOR_TYPES)?.catch(() => undefined);
		};
		const waker = {
			onAllowed: () => {
				arm();
				handlers.onReconnect();
			},
			onIdentity: (next: IExplorerIdentity | null) => handlers.onIdentity(next),
		};
		wakers.add(waker);
		if (allowed) waker.onAllowed();

		const offTask = cm.on('shell:event', (payload: unknown) => {
			if (!allowed) return;
			const message = isPlainObject(payload) ? payload.event : undefined;
			if (!isPlainObject(message) || message.event !== 'apaevt_task') return;
			const body = isPlainObject(message.body) ? message.body : null;
			handlers.onTaskEvent({ reprobe: body?.action === 'restart' });
		});

		const onVisible = (): void => {
			if (!allowed) return;
			if (typeof document === 'undefined' || document.visibilityState === 'visible') handlers.onFocus();
		};
		focusTarget?.addEventListener('focus', onVisible);
		focusTarget?.addEventListener('visibilitychange', onVisible);

		return () => {
			wakers.delete(waker);
			offTask();
			focusTarget?.removeEventListener('focus', onVisible);
			focusTarget?.removeEventListener('visibilitychange', onVisible);
			if (monitored) void client.removeMonitor?.(TASK_MONITOR_KEY, TASK_MONITOR_TYPES)?.catch(() => undefined);
		};
	};

	return {
		watch,
		allowed: () => allowed,
		subscribe(cb) {
			listeners.add(cb);
			return () => { listeners.delete(cb); };
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			offIdentity();
			offActivation();
			listeners.clear();
		},
	};
}
