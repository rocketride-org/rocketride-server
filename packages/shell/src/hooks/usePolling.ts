// MIT License
//
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
// USE POLLING — connection-aware interval polling with automatic cleanup
// =============================================================================

import { useEffect, useRef } from 'react';
import { useShellConnection } from '../connection/ConnectionContext';

/**
 * Poll a fetcher function at a fixed interval, only while connected.
 *
 * Replaces the duplicated polling pattern found in monitor apps:
 * ```ts
 * useEffect(() => {
 *     if (!isConnected) return;
 *     fetchDashboard();
 *     const id = setInterval(fetchDashboard, 3000);
 *     return () => clearInterval(id);
 * }, [isConnected, fetchDashboard]);
 * ```
 *
 * @param fetcher  - Async function to call on each interval tick.
 * @param interval - Polling interval in milliseconds.
 *
 * @example
 * ```tsx
 * const fetchDashboard = useCallback(async () => {
 *     const client = ConnectionManager.getInstance().getClient();
 *     if (!client) return;
 *     const data = await client.getDashboard();
 *     setDashboard(data);
 * }, []);
 *
 * usePolling(fetchDashboard, 3000);
 * ```
 */
/** Options for {@link usePolling}. */
export interface IUsePollingOptions {
	/**
	 * Connection gate for the interval.
	 * - 'shell' (default): poll only while the shell's global connection is up —
	 *   right for anything fetched through the shell's RocketRide client.
	 * - 'none': poll unconditionally — for apps that talk to their own sockets
	 *   (e.g. models-ui's model-server telemetry, which runs unauthenticated
	 *   and must keep ticking while the shell is disconnected).
	 */
	gate?: 'shell' | 'none';
}

export function usePolling(fetcher: () => void | Promise<void>, interval: number, options?: IUsePollingOptions): void {
	const { isConnected } = useShellConnection();
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;

	// Resolve the gate: ungated pollers tick regardless of the shell connection.
	const gated = (options?.gate ?? 'shell') === 'shell';

	useEffect(() => {
		// Only poll while connected, unless the caller opted out of the gate.
		if (gated && !isConnected) return;

		// Fetch immediately on (re)start
		fetcherRef.current();

		// Set up the interval
		const id = setInterval(() => {
			fetcherRef.current();
		}, interval);

		return () => clearInterval(id);
	}, [isConnected, interval, gated]);
}
