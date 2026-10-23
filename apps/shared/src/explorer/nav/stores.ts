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
// EXPLORER NAV — ACTIVE-KEY STORE AND REQUEST CHANNEL (App <-> Sidebar state)
// =============================================================================
//
// The shell mounts an app's App and Sidebar components as SIBLINGS, so they
// cannot share React context; a small external store is the shared state both
// sides subscribe to (the admin-ui navigation pattern).
//
// Factories, not modules: each app creates its own stores, so Graph's active
// connection never leaks into SQL's sidebar.
// =============================================================================

import { useSyncExternalStore } from 'react';

// =============================================================================
// ACTIVE KEY
// =============================================================================

/** Which connection document currently has focus. */
export interface IActiveKeyStore {
	/**
	 * Record which connection is active (null = none). Called by the App
	 * whenever the active editor changes; read by the sidebar to decide whose
	 * schema tree to show.
	 */
	set(key: string | null): void;
	/** Subscribe to the active key (a React hook). */
	use(): string | null;
	/**
	 * The active key now, for code outside React (a dev-tool frame pushing its
	 * active key to the controller). Pairs with {@link IActiveKeyStore.subscribe}.
	 */
	get(): string | null;
	/**
	 * Subscribe to changes from code outside React. The callback is called on
	 * every change, not with the key; read it with {@link IActiveKeyStore.get}.
	 *
	 * @returns The unsubscribe function.
	 */
	subscribe(callback: () => void): () => void;
}

/**
 * Create an active-connection store.
 *
 * @returns A store with no active connection.
 */
export function createActiveKeyStore(): IActiveKeyStore {
	let activeKey: string | null = null;
	const listeners = new Set<() => void>();
	const subscribe = (callback: () => void): (() => void) => {
		listeners.add(callback);
		return () => { listeners.delete(callback); };
	};
	return {
		set(key: string | null): void {
			if (activeKey !== key) {
				activeKey = key;
				listeners.forEach((listener) => listener());
			}
		},
		use(): string | null {
			// The third argument is the server snapshot: unused in the browser, but it
			// lets the store render under react-dom/server (tests, static markup).
			const snapshot = (): string | null => activeKey;
			return useSyncExternalStore(subscribe, snapshot, snapshot);
		},
		get(): string | null {
			return activeKey;
		},
		subscribe,
	};
}

// =============================================================================
// REQUEST CHANNEL
// =============================================================================

/** A request as the consumer sees it: the payload plus a monotonic sequence. */
export type ChannelRequest<T extends object> = T & { seq: number };

/** A one-slot request channel from one surface (a sidebar click) to another (a drawer). */
export interface IRequestChannel<T extends object> {
	/** Post a request; every post re-fires, even with an identical payload. */
	request(payload: T): void;
	/** Subscribe to the latest request (a React hook); null until one is made. */
	use(): ChannelRequest<T> | null;
}

/**
 * Create a request channel.
 *
 * The `seq` makes a repeat request for the same target re-fire: a consumer
 * keys its effect on `seq`, so clicking the same item twice opens it twice.
 *
 * @returns A channel with no request yet.
 */
export function createRequestChannel<T extends object>(): IRequestChannel<T> {
	let latest: ChannelRequest<T> | null = null;
	let seq = 0;
	const listeners = new Set<() => void>();
	const subscribe = (callback: () => void): (() => void) => {
		listeners.add(callback);
		return () => { listeners.delete(callback); };
	};
	return {
		request(payload: T): void {
			seq += 1;
			latest = { ...payload, seq };
			listeners.forEach((listener) => listener());
		},
		use(): ChannelRequest<T> | null {
			const snapshot = (): ChannelRequest<T> | null => latest;
			return useSyncExternalStore(subscribe, snapshot, snapshot);
		},
	};
}
