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

/**
 * RocketRide Client Singleton Module
 *
 * Manages a single, shared WebSocket connection to RocketRide services across
 * the entire application. This singleton pattern ensures:
 * 
 * Benefits:
 * - Only one WebSocket connection exists (no duplicate connections)
 * - Connection persists across component mount/unmount cycles
 * - Immune to React StrictMode double-mounting
 * - Multiple components can share the same connection
 * - Automatic reconnection handling
 * - Centralized event broadcasting
 * 
 * Architecture:
 * - Singleton instance stored outside React lifecycle
 * - Pub/sub pattern for event distribution
 * - Promise-based connection management
 * 
 * Event Types:
 * - Connection events: broadcast when WebSocket connects
 * - Disconnection events: broadcast when WebSocket disconnects
 * - Message events: broadcast for all incoming RocketRide messages
 * - Status events: broadcast for UI status updates
 * 
 * Authentication: Token is obtained by App and passed to startClient().
 * 
 * @module clientSingleton
 */

import { RocketRideClient, RocketRideClientConfig, ConnectionException } from 'rocketride';
import { API_CONFIG } from '../config/apiConfig';

// ============================================================================
// SINGLETON STATE
// ============================================================================

/** The single shared RocketRideClient instance (null if not yet created) */
let clientInstance: RocketRideClient | null = null;

// ============================================================================
// SUBSCRIBER TYPES
// ============================================================================

/** Callback for RocketRide message events */
type EventSubscriber = (message: any) => void | Promise<void>;

/** Callback for successful connection events */
type ConnectionSubscriber = (client: RocketRideClient) => void | Promise<void>;

/** Callback for disconnection events */
type DisconnectionSubscriber = (reason: string, hasError: boolean) => void | Promise<void>;

/** Callback for UI status message updates */
type StatusSubscriber = (message: string | null) => void;

// ============================================================================
// SUBSCRIBER COLLECTIONS
// ============================================================================

/** Set of functions subscribed to RocketRide message events */
const eventSubscribers = new Set<EventSubscriber>();

/** Set of functions subscribed to connection events */
const connectedSubscribers = new Set<ConnectionSubscriber>();

/** Set of functions subscribed to disconnection events */
const disconnectedSubscribers = new Set<DisconnectionSubscriber>();

/** Set of functions subscribed to status message updates */
const statusSubscribers = new Set<StatusSubscriber>();

/**
 * Last connection error (from connect failure or onDisconnected with hasError).
 * Stored so late subscribers (e.g. ChatContainer after App's startClient) can display it.
 */
let lastConnectionError: { reason: string; hasError: boolean } | null = null;

// ============================================================================
// EVENT BROADCASTING
// ============================================================================

/**
 * Broadcasts incoming RocketRide events to all subscribed listeners
 * 
 * Error Handling:
 * - Individual subscriber errors are caught and logged
 * - One failing subscriber doesn't affect others
 * - Ensures all subscribers receive the event
 * 
 * @param message - Event message from RocketRide client
 */
async function handleEvent(message: any): Promise<void> {
	for (const subscriber of eventSubscribers) {
		try {
			await subscriber(message);
		} catch (error) {
			console.error('Error in event subscriber:', error);
		}
	}
}

/**
 * Broadcasts connection event to all subscribed listeners
 * 
 * Flow:
 * 1. Clears any status messages (connection successful)
 * 2. Notifies all connection subscribers
 * 3. Allows subscribers to perform setup (e.g., initialize pipelines)
 * 
 * @param client - The connected RocketRideClient instance
 */
async function handleConnected(client: RocketRideClient): Promise<void> {
	lastConnectionError = null;

	// Clear any status messages (e.g., "Connecting...")
	for (const subscriber of statusSubscribers) {
		try {
			subscriber(null);
		} catch (error) {
			console.error('Error in status subscriber:', error);
		}
	}

	// Notify connection subscribers
	for (const subscriber of connectedSubscribers) {
		try {
			await subscriber(client);
		} catch (error) {
			console.error('Error in connected subscriber:', error);
		}
	}
}

/**
 * Broadcasts disconnection event to all subscribed listeners
 * 
 * Flow:
 * 1. Shows descriptive error message from server
 * 2. Notifies all disconnection subscribers
 * 3. SDK will automatically attempt reconnection
 * 
 * Server Error Messages:
 * - HTTP 400: Pipeline not running
 * - HTTP 401: Authentication error
 * - Other: Connection lost or network errors
 * 
 * @param reason - Reason for disconnection (from server or network)
 * @param hasError - Whether disconnection was due to an error
 */
async function handleDisconnected(reason: string, hasError: boolean): Promise<void> {
	if (hasError) {
		lastConnectionError = { reason, hasError: true };
	}

	// Notify disconnection subscribers - they handle their own status display logic
	for (const subscriber of disconnectedSubscribers) {
		try {
			await subscriber(reason, hasError);
		} catch (error) {
			console.error('Error in disconnected subscriber:', error);
		}
	}
}

// ============================================================================
// CLIENT MANAGEMENT
// ============================================================================

/**
 * CONNECTION FLOW (connect / disconnect with persistent connections)
 *
 * 1) connect() [RocketRideClient]
 *    - Sets _manualDisconnect = false (allow reconnect on drop).
 *    - Calls super.connect() (DAPClient):
 *      a) transport.connect() → WebSocket open (no auth on wire).
 *      b) Sends DAP auth request; on failure: transport.disconnect(message, true), then throws.
 *      c) On success: onConnected(connectionInfo) → user's onConnected (we never got here if (b) failed).
 *    - If super.connect() throws:
 *      - persist false: rethrow (caller handles).
 *      - persist true: call onConnectError(message), _scheduleReconnect(), resolve (do not throw).
 *    - SDK does NOT call onDisconnected when connect fails (only when onConnected had been called).
 *
 * 2) disconnect() [RocketRideClient]
 *    - Sets _manualDisconnect = true and clears reconnect timeout.
 *    - transport.disconnect() → transport calls bound onDisconnected(reason, hasError).
 *    - Client's onDisconnected: only invokes user's onDisconnected if _didNotifyConnected (we had
 *      called onConnected); then schedules reconnect only when persist && !_manualDisconnect.
 *
 * 3) Persistent connection — handled by the client (RocketRideClient), not the app.
 *    - When created with persist: true, the client owns reconnection. After a successful
 *      connection, if the link drops, transport calls onDisconnected; the client invokes the
 *      user's onDisconnected and _scheduleReconnect(). After reconnectDelay it calls connect()
 *      again; success → onConnected again. The app does not run a reconnect loop.
 *
 *    How persist affects connect/disconnect:
 *    - connect(): The app typically calls it once to start. With persist, the client may also
 *      call connect() internally on each reconnect attempt. So connect() means "establish or
 *      re-establish the connection."
 *    - disconnect(): Only the app calls this. It sets _manualDisconnect = true and closes the
 *      transport, so the client will not schedule any further reconnects. So disconnect() means
 *      "I'm done; close the connection and do not reconnect." Without a call to disconnect(),
 *      the client keeps reconnecting whenever the link drops.
 *
 * 4) Chat UI (startClient)
 *    - Creates RocketRideClient with persist: true and callbacks; calls client.connect() once.
 *    - On throw: handleDisconnected(message, true) and lastConnectionError for late subscribers.
 *    - The client itself handles reconnection on subsequent drops; subscribers get catch-up on
 *      subscribe if lastConnectionError is set.
 */

/**
 * Starts the RocketRide client singleton with persistent connection
 * 
 * This function initializes the client once and enables automatic reconnection.
 * If the client is already started, this function does nothing (idempotent).
 * 
 * Connection Flow:
 * - Creates RocketRideClient with persist: true
 * - Attempts initial connection (may fail if pipeline not running)
 * - SDK automatically retries connection every 1 second
 * - onConnected/onDisconnected callbacks notify subscribers
 * 
 * @param authToken - Authentication token (obtained by App from URL, session storage, or config)
 * @throws Error if authentication token is missing
 * 
 * @example
 * ```typescript
 * // In App.tsx
 * await startClient(token);
 * ```
 */
export async function startClient(authToken: string): Promise<void> {
	// Already started - do nothing (idempotent)
	if (clientInstance) {
		return;
	}

	if (!authToken) {
		throw new Error("Sorry, I couldn't get you authenticated. Please contact your system admin.");
	}

	const config: RocketRideClientConfig = {
		auth: authToken,
		uri: API_CONFIG.ROCKETRIDE_URI || window.location.origin,
		persist: true, // Client retries from initial failure and on drop
		onEvent: handleEvent,
		onConnected: async (_info?: string) => {
			await handleConnected(client);
		},
		onDisconnected: async (reason?: string, hasError?: boolean) => {
			await handleDisconnected(reason || 'Connection lost', hasError || false);
		},
		onConnectError: (error: ConnectionException) =>
			handleDisconnected(error.message, true).catch((e) => console.error('handleDisconnected:', e)),
		env: API_CONFIG,
	};

	const client = new RocketRideClient(config);
	// With persist, connect() resolves once the first attempt completes (success or scheduled retry)
	await client.connect();
	clientInstance = client;
}

/**
 * Gets the current RocketRide client instance
 *
 * Returns the singleton client instance if started, null otherwise.
 * Does not create or start the client - use startClient() first.
 *
 * @returns The RocketRideClient instance or null if not started
 *
 * @example
 * ```typescript
 * const client = getClient();
 * if (!client) {
 *   // Client not started yet
 * }
 * ```
 */
export function getClient(): RocketRideClient | null {
	return clientInstance;
}

/**
 * Stops the RocketRide client and disables persistent connection
 * 
 * Disconnects from the server and clears the singleton instance.
 * After calling this, you must call startClient() again to reconnect.
 * 
 * @example
 * ```typescript
 * await stopClient();
 * ```
 */
export async function stopClient(): Promise<void> {
	if (clientInstance) {
		await clientInstance.disconnect();
		clientInstance = null;
	}
}

// ============================================================================
// SUBSCRIPTION MANAGEMENT
// ============================================================================

/**
 * Subscribes to client events with automatic cleanup
 * 
 * Subscription Pattern:
 * - Register callbacks for events, connection, disconnection, status
 * - Returns unsubscribe function for cleanup
 * - Safe to call during component unmount
 * 
 * Callback Types:
 * - onEvent: Called for each RocketRide message
 * - onConnected: Called once when connection established
 * - onDisconnected: Called when connection lost
 * - onStatusChange: Called for UI status updates
 * 
 * Usage Pattern:
 * ```typescript
 * useEffect(() => {
 *   const unsubscribe = subscribeToClient({
 *     onEvent: (msg) => console.log('Event:', msg),
 *     onConnected: (client) => console.log('Connected'),
 *     onDisconnected: (reason) => console.log('Disconnected:', reason)
 *   });
 *   
 *   return () => unsubscribe(); // Cleanup on unmount
 * }, []);
 * ```
 * 
 * @param callbacks - Object containing optional callback functions
 * @returns Unsubscribe function to remove all callbacks
 */
export function subscribeToClient(callbacks: {
	onEvent?: EventSubscriber;
	onConnected?: ConnectionSubscriber;
	onDisconnected?: DisconnectionSubscriber;
	onStatusChange?: StatusSubscriber;
}): () => void {
	const { onEvent, onConnected, onDisconnected, onStatusChange } = callbacks;

	// Add callbacks to subscriber sets
	if (onEvent) eventSubscribers.add(onEvent);
	if (onConnected) connectedSubscribers.add(onConnected);
	if (onDisconnected) disconnectedSubscribers.add(onDisconnected);
	if (onStatusChange) statusSubscribers.add(onStatusChange);

	// If we have a stored connection error, notify this subscriber so it can display it
	// (handles the case where connect failed before this component subscribed)
	if (onDisconnected && lastConnectionError?.hasError) {
		Promise.resolve(onDisconnected(lastConnectionError.reason, true)).catch((err) => {
			console.error('Error in onDisconnected (catch-up):', err);
		});
	}

	// Return unsubscribe function that removes all callbacks
	return () => {
		if (onEvent) eventSubscribers.delete(onEvent);
		if (onConnected) connectedSubscribers.delete(onConnected);
		if (onDisconnected) disconnectedSubscribers.delete(onDisconnected);
		if (onStatusChange) statusSubscribers.delete(onStatusChange);
	};
}
