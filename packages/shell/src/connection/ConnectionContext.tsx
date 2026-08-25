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
// USE SHELL CONNECTION — thin React hook over ConnectionManager singleton
// =============================================================================
//
// Replaces the former ShellConnectionProvider context + useRocketRideClient hook.
// Components call useShellConnection() to get { client, isConnected, statusMessage }
// with automatic re-renders on connection state changes.
//
// No provider wrapper is needed — the hook reads directly from the module-level
// ConnectionManager singleton and subscribes to its events.
// =============================================================================

import { useState, useEffect, useRef } from 'react';
import type { RocketRideClient } from 'rocketride';
import { ConnectionManager } from './connection';

// =============================================================================
// HOOK RETURN TYPE
// =============================================================================

/**
 * Shape returned by `useShellConnection()`.
 *
 * Provides the RocketRide client instance, current connection status,
 * and any transient status message (e.g. "Reconnecting...").
 */
export interface ShellConnectionState {
	/** The shared RocketRideClient instance, or `null` if not yet initialised. */
	client: RocketRideClient | null;
	/** `true` when the WebSocket is authenticated and connected. */
	isConnected: boolean;
	/** Transient status bar text (e.g. `"Reconnecting\u2026"`), or `null` when clear. */
	statusMessage: string | null;
}

// =============================================================================
// HOOK
// =============================================================================

/**
 * React hook that provides connection state from the ConnectionManager singleton.
 *
 * Subscribes to `shell:connected`, `shell:disconnected`, and `shell:statusMessage`
 * events and returns React state that triggers re-renders on changes.
 *
 * No context provider is required — call this hook from any component.
 *
 * @returns The current connection state (`client`, `isConnected`, `statusMessage`).
 *
 * @example
 * ```tsx
 * const { client, isConnected } = useShellConnection();
 * if (!client || !isConnected) return <div>Connecting...</div>;
 * ```
 */
export function useShellConnection(): ShellConnectionState {
	// Initialise state from the singleton's current values so we don't
	// flash stale state on first render
	const [isConnected, setIsConnected] = useState<boolean>(
		() => ConnectionManager.getInstance().isConnected(),
	);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);

	// Track mount status to prevent setState on unmounted components
	const isMountedRef = useRef(true);

	useEffect(() => {
		isMountedRef.current = true;

		// Sync initial state in case the connection happened before this
		// component mounted
		const currentlyConnected = ConnectionManager.getInstance().isConnected();
		if (currentlyConnected !== isConnected) {
			setIsConnected(currentlyConnected);
		}

		// Subscribe to connection lifecycle events from the singleton
		const unsubConnected = ConnectionManager.getInstance().on('shell:connected', () => {
			if (isMountedRef.current) setIsConnected(true);
		});

		const unsubDisconnected = ConnectionManager.getInstance().on('shell:disconnected', () => {
			if (isMountedRef.current) setIsConnected(false);
		});

		const unsubStatus = ConnectionManager.getInstance().on('shell:statusMessage', ({ message }: { message: string | null }) => {
			if (isMountedRef.current) setStatusMessage(message);
		});

		// Clean up subscriptions on unmount
		return () => {
			isMountedRef.current = false;
			unsubConnected();
			unsubDisconnected();
			unsubStatus();
		};
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	return {
		client: ConnectionManager.getInstance().getClient(),
		isConnected,
		statusMessage,
	};
}
