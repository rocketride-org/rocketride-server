/**
 * MIT License
 *
 * Copyright (c) 2026 Aparavi Software AG
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { RocketRideClient } from 'rocketride';
import { getClient, subscribeToClient } from './clientSingleton';

/**
 * useRocketRideClient - React hook for accessing shared RocketRide WebSocket client
 *
 * This hook provides a React-friendly interface to the RocketRide client singleton,
 * ensuring a single, persistent WebSocket connection across the entire application.
 *
 * Architecture Benefits:
 * - Singleton Pattern: Only one WebSocket connection for entire app
 * - React StrictMode Compatible: Immune to double-mount issues
 * - Persistent Connection: Survives component mount/unmount cycles
 * - Shared State: Multiple components can use same connection
 * - Automatic Reconnection: Built-in reconnection logic
 *
 * Connection Lifecycle:
 * 1. Hook mounts → subscribes to singleton events
 * 2. Singleton creates/returns client instance
 * 3. If already connected → fires onConnected immediately
 * 4. Component unmounts → unsubscribes but keeps connection alive
 * 5. Other components can reuse the same connection
 *
 * Usage Pattern:
 * ```tsx
 * const { isConnected, client } = useRocketRideClient(
 *   async (client) => {
 *     // Setup: Initialize pipelines when connected
 *     const result = await client.use({ pipeline: myPipeline });
 *   },
 *   (reason, hasError) => {
 *     // Cleanup: Handle disconnection
 *     console.log('Disconnected:', reason);
 *   },
 *   (status) => {
 *     // Status: Show connection messages to user
 *     setStatusMessage(status);
 *   }
 * );
 * ```
 *
 * Callback Stability:
 * - Callbacks are stored in refs to prevent unnecessary effect triggers
 * - Callback refs updated synchronously when props change
 * - Effect dependencies remain stable
 *
 * Memory Safety:
 * - isMountedRef prevents state updates after unmount
 * - Unsubscribes from singleton on unmount
 * - Connection persists for other components
 *
 * @param onConnected - Called when WebSocket connects (setup pipelines here)
 * @param onDisconnected - Called when WebSocket disconnects (cleanup here)
 * @param onStatusChange - Called for transient status updates
 *
 * @returns Object with connection state and client reference
 * @returns isConnected - Current WebSocket connection status
 * @returns client - Shared RocketRideClient instance derived from singleton (null if not started)
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { isConnected, client } = useRocketRideClient(
 *     async (client) => {
 *       console.log('Connected!');
 *       await setupPipelines(client);
 *     }
 *   );
 *
 *   if (!isConnected) return <div>Connecting...</div>;
 *
 *   return <div>Ready to process files</div>;
 * }
 * ```
 */
export const useRocketRideClient = (
	onConnected?: (client: RocketRideClient) => void | Promise<void>,
	onDisconnected?: (reason: string, hasError: boolean) => void | Promise<void>,
	onStatusChange?: (message: string | null) => void
) => {
	// ============= STATE =============

	/** Tracks whether the WebSocket client is currently connected */
	const [isConnected, setIsConnected] = useState(false);

	// ============= REFS =============

	/**
	 * Tracks if component is still mounted
	 * Prevents state updates after unmount (memory leak prevention)
	 */
	const isMountedRef = useRef(true);

	/**
	 * Stable references to callbacks
	 * Prevents unnecessary re-renders when callbacks change
	 * Updated synchronously when props change
	 */
	const onConnectedRef = useRef(onConnected);
	const onDisconnectedRef = useRef(onDisconnected);
	const onStatusChangeRef = useRef(onStatusChange);

	/**
	 * Keep callback refs up to date without triggering effect dependencies
	 * This allows callbacks to change without recreating subscriptions
	 */
	useEffect(() => {
		onConnectedRef.current = onConnected;
		onDisconnectedRef.current = onDisconnected;
		onStatusChangeRef.current = onStatusChange;
	}, [onConnected, onDisconnected, onStatusChange]);

	// ============= EVENT HANDLERS =============

	/**
	 * Handles successful WebSocket connection
	 *
	 * Flow:
	 * 1. Updates connection state
	 * 2. Delegates to consumer's onConnected callback
	 * 3. Catches and logs any errors in callback
	 *
	 * Safety:
	 * - Checks if component still mounted
	 * - Error handling prevents crashes
	 * - Only calls callback if provided
	 */
	const handleConnected = useCallback(async (connectedClient: RocketRideClient) => {
		if (!isMountedRef.current) return;

		setIsConnected(true);

		// Let the consumer handle what happens on connection (e.g., pipeline setup)
		if (onConnectedRef.current) {
			try {
				await onConnectedRef.current(connectedClient);
			} catch (error) {
				console.error('Error in onConnected callback:', error);
			}
		}
	}, []);

	/**
	 * Handles WebSocket disconnection
	 *
	 * Flow:
	 * 1. Updates connection state
	 * 2. Delegates to consumer's onDisconnected callback
	 * 3. Catches and logs any errors in callback
	 *
	 * Note: Client will automatically attempt reconnection
	 */
	const handleDisconnected = useCallback(async (reason: string, hasError: boolean) => {
		if (!isMountedRef.current) return;

		setIsConnected(false);

		// Let the consumer handle disconnection
		if (onDisconnectedRef.current) {
			try {
				await onDisconnectedRef.current(reason, hasError);
			} catch (error) {
				console.error('Error in onDisconnected callback:', error);
			}
		}
	}, []);

	/**
	 * Handles status change messages
	 * Used for displaying connection status to users
	 */
	const handleStatusChange = useCallback((message: string | null) => {
		if (!isMountedRef.current) return;

		if (onStatusChangeRef.current) {
			onStatusChangeRef.current(message);
		}
	}, []);

	/**
	 * Handles incoming events from the RocketRide client
	 *
	 * Note: Events are already logged in the singleton
	 * Additional per-component handling can be added here if needed
	 */
	const handleEvent = useCallback(async (_message: any) => {
		// Events are logged in the singleton
		// Additional handling can be added here if needed per-component
	}, []);

	// ============= LIFECYCLE =============

	/**
	 * Main effect: Get client and subscribe to events
	 *
	 * Flow:
	 * 1. Mark component as mounted
	 * 2. Get client instance (may be null if not started)
	 * 3. Subscribe to singleton events
	 * 4. If already connected, fire onConnected immediately
	 * 5. On unmount: unsubscribe and mark as unmounted
	 *
	 * Important: Does NOT start or disconnect client
	 * Client must be started by App.tsx using startClient()
	 */
	useEffect(() => {
		// Mark component as mounted
		isMountedRef.current = true;

		// Subscribe to client events from singleton
		const unsubscribe = subscribeToClient({
			onEvent: handleEvent,
			onConnected: handleConnected,
			onDisconnected: handleDisconnected,
			onStatusChange: handleStatusChange,
		});

		// Get the client from singleton (synchronous)
		const c = getClient();

		if (c) {
			const connected = c.isConnected();
			setIsConnected(connected);

			// If already connected, fire onConnected callback immediately
			// This handles the case where client was already connected
			// when this component mounted
			if (connected && onConnectedRef.current) {
				Promise.resolve(onConnectedRef.current(c)).catch((error: Error) => {
					console.error('Error in onConnected callback:', error);
				});
			}
		}

		// Cleanup on unmount
		return () => {
			isMountedRef.current = false;
			unsubscribe();
			// Note: We don't disconnect the client - it persists for other components
		};
	}, [handleEvent, handleConnected, handleDisconnected, handleStatusChange]);

	// ============= RETURN API =============

	return {
		/** Current connection status */
		isConnected,

		/** Shared client instance (derived from singleton) */
		client: getClient(),
	};
};
