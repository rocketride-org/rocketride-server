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
// CONNECT — ENDPOINT STORE (shared discovery state for App + Sidebar)
// =============================================================================
//
// The shell mounts the App and Sidebar components as SIBLINGS, so they cannot
// share React context; this module-level store (the admin-ui navigation
// pattern) is the shared state both sides subscribe to.
// =============================================================================

import { useSyncExternalStore } from 'react';
import type { RocketRideClient } from 'shell';
import { discoverSqlEndpoints } from './discovery';
import type { ISqlEndpoint } from './types';

// =============================================================================
// STATE
// =============================================================================

/** Discovery lifecycle of the endpoint list. */
export type EndpointStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The store's snapshot shape consumed by React. */
export interface IEndpointState {
	/** Discovery lifecycle state. */
	status: EndpointStatus;
	/** The discovered endpoints (empty until the first refresh completes). */
	endpoints: ISqlEndpoint[];
	/** Failure detail when status is 'error'. */
	error: string | null;
}

// ── Module-level state ───────────────────────────────────────────────────────

let state: IEndpointState = { status: 'idle', endpoints: [], error: null };
const listeners = new Set<() => void>();

// Monotonic refresh counter so an outdated in-flight discovery never
// overwrites the result of a newer one.
let refreshSeq = 0;

/**
 * Replace the snapshot and notify all subscribed React components.
 *
 * @param next - The new snapshot.
 */
function setState(next: IEndpointState): void {
	state = next;
	listeners.forEach((fn) => fn());
}

// =============================================================================
// ACTIONS
// =============================================================================

/**
 * Run (or re-run) endpoint discovery. Concurrent calls are safe: only the
 * most recent call's result is applied.
 *
 * @param client - The shell's RocketRide client.
 */
export async function refreshEndpoints(client: RocketRideClient): Promise<void> {
	const seq = ++refreshSeq;
	setState({ ...state, status: 'loading', error: null });
	try {
		const endpoints = await discoverSqlEndpoints(client);
		if (seq !== refreshSeq) return;
		setState({ status: 'ready', endpoints, error: null });
	} catch (err) {
		if (seq !== refreshSeq) return;
		setState({ status: 'error', endpoints: state.endpoints, error: err instanceof Error ? err.message : String(err) });
	}
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * Subscribe to the endpoint discovery state.
 *
 * Uses `useSyncExternalStore` for tear-free reads in concurrent mode.
 *
 * @returns The current endpoint state snapshot.
 */
export function useSqlEndpoints(): IEndpointState {
	return useSyncExternalStore(
		(cb) => { listeners.add(cb); return () => listeners.delete(cb); },
		() => state,
	);
}
