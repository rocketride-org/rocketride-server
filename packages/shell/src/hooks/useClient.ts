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
// USE CLIENT — null-safe RocketRideClient access
// =============================================================================

import type { RocketRideClient } from 'rocketride';
import { useShellConnection } from '../connection/ConnectionContext';

/**
 * Returns the RocketRideClient if connected, or null if not.
 *
 * Replaces the common defensive pattern:
 * ```ts
 * const client = getClient();
 * if (!client || !client.isConnected()) return;
 * ```
 *
 * The returned client is guaranteed to be connected when non-null.
 * Re-renders when connection state changes.
 *
 * @returns The connected RocketRideClient, or null.
 *
 * @example
 * ```tsx
 * const client = useClient();
 * if (!client) return <div>Not connected</div>;
 * const data = await client.getDashboard();
 * ```
 */
export function useClient(): RocketRideClient | null {
	const { client, isConnected } = useShellConnection();
	// Only return the client if actually connected
	if (!client || !isConnected) return null;
	return client;
}
