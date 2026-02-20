/**
 * MIT License
 * Copyright (c) 2026 RocketRide, Inc.
 * See LICENSE file for details.
 */

/**
 * RocketRide Client Singleton Module
 * 
 * Manages a single, shared WebSocket connection to RocketRideservices across
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
 * - Session-based authentication caching
 * 
 * Event Types:
 * - Connection events: broadcast when WebSocket connects
 * - Disconnection events: broadcast when WebSocket disconnects
 * - Message events: broadcast for all incoming RocketRidemessages
 * - Status events: broadcast for UI status updates
 * 
 * Authentication Flow:
 * 1. Check session storage for cached token
 * 2. In dev mode: use API key from config
 * 3. In production: check URL params or fetch from /api/auth
 * 4. Cache token in session storage for reuse
 * 
 * @module clientSingleton
 */

import { RocketRideClient, RocketRideClientConfig } from 'rocketride';
import { API_CONFIG } from '../config/apiConfig';

// ============================================================================
// SINGLETON STATE
// ============================================================================

/** The single shared RocketRideClient instance (null if not yet created) */
let clientInstance: RocketRideClient | null = null;

// ============================================================================
// SUBSCRIBER TYPES
// ============================================================================

/** Callback for RocketRidemessage events */
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

/** Set of functions subscribed to RocketRidemessage events */
const eventSubscribers = new Set<EventSubscriber>();

/** Set of functions subscribed to connection events */
const connectedSubscribers = new Set<ConnectionSubscriber>();

/** Set of functions subscribed to disconnection events */
const disconnectedSubscribers = new Set<DisconnectionSubscriber>();

/** Set of functions subscribed to status message updates */
const statusSubscribers = new Set<StatusSubscriber>();

/**
 * Last connection error (from connect failure or onDisconnected with hasError).
 * Stored so late subscribers can display it.
 */
let lastConnectionError: { reason: string; hasError: boolean } | null = null;

// ============================================================================
// AUTHENTICATION
// ============================================================================

/**
 * Retrieves authentication token from various sources
 * 
 * Token Priority:
 * 1. Session storage (cached from previous retrieval)
 * 2. Dev mode: API key from configuration
 * 3. Production: URL parameter or /api/auth endpoint
 * 
 * Caching:
 * - Tokens are cached in sessionStorage for reuse
 * - Reduces authentication requests
 * - Cleared on browser tab close
 * 
 * URL Cleanup:
 * - Removes token from URL bar after extraction (security)
 * - Uses history.replaceState to avoid adding to browser history
 * 
 * @returns Authentication token string or null if unavailable
 * 
 * @example
 * ```typescript
 * const token = await getAuthToken();
 * if (!token) {
 *   throw new Error('Authentication failed');
 * }
 * ```
 */
async function getAuthToken(): Promise<string | null> {
	// Check session storage first for cached token
	let auth = sessionStorage.getItem('auth');
	if (auth) return auth;

	if (API_CONFIG.devMode) {
		// Development mode: use API key from configuration
		auth = API_CONFIG.ROCKETRIDE_APIKEY || null;
	} else {
		// Production mode or vscode: check URL params or fetch from backend
		const urlParams = new URLSearchParams(window.location.search);
		auth = urlParams.get('token');

		if (!auth) {
			// No token in URL, fetch from backend authentication service
			try {
				const response = await fetch('/api/auth');
				if (!response.ok) return null;
				const result = await response.json();
				auth = result.auth;
			} catch {
				return null;
			}
		} else {
			// Token found in URL - clean up URL bar for security
			if (window.location.search.includes('token=')) {
				window.history.replaceState({}, "", window.location.pathname);
			}
		}
	}

	// Cache token in session storage for subsequent requests
	if (auth) sessionStorage.setItem('auth', auth);
	return auth;
}

// ============================================================================
// EVENT BROADCASTING
// ============================================================================

/**
 * Broadcasts incoming RocketRideevents to all subscribed listeners
 * 
 * Error Handling:
 * - Individual subscriber errors are caught and logged
 * - One failing subscriber doesn't affect others
 * - Ensures all subscribers receive the event
 * 
 * @param message - Event message from RocketRideclient
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
 * CONNECTION FLOW (persist mode): With persist, connect() resolves after first attempt
 * (success or scheduled retry). Client calls onConnectError on each failure and keeps
 * retrying. Subscribers get catch-up on subscribe if lastConnectionError is set.
 */

/**
 * Starts the RocketRideclient singleton with persistent connection
 * 
 * This function initializes the client once and enables automatic reconnection.
 * If the client is already started, this function does nothing (idempotent).
 * With persist, the client retries from initial failure and calls onConnectError.
 * 
 * @param authToken - Optional authentication token. If not provided, calls getAuthToken()
 * @throws Error if authentication token cannot be obtained
 * 
 * @example
 * ```typescript
 * // In App.tsx
 * await startClient(token);
 * ```
 */
export async function startClient(authToken?: string): Promise<void> {
	// Already started - do nothing (idempotent)
	if (clientInstance) {
		return;
	}

	// Get authentication token
	const token = authToken || await getAuthToken();
	
	if (!token) {
		throw new Error('Sorry, I couldn\'t get you authenticated. Please contact your system admin.');
	}

	// Create client first (before config) so we can reference it in callbacks
	let client: RocketRideClient;
	
	const config: RocketRideClientConfig = {
		auth: token,
		uri: API_CONFIG.ROCKETRIDE_URI || (typeof window !== 'undefined' ? window.location.origin : ''),
		persist: true,
		onEvent: handleEvent,
		onConnected: async (_info?: string) => {
			await handleConnected(client);
		},
		onDisconnected: async (reason?: string, hasError?: boolean) => {
			await handleDisconnected(reason || 'Connection lost', hasError || false);
		},
		onConnectError: (message: string) =>
			handleDisconnected(message, true).catch((e) => console.error('handleDisconnected:', e)),
		env: API_CONFIG
	};

	client = new RocketRideClient(config);
	await client.connect();
	clientInstance = client;
}

/**
 * Gets the current RocketRideclient instance
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
 * Stops the RocketRideclient and disables persistent connection
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
 * - onEvent: Called for each RocketRidemessage
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

	// Catch-up: if we have a stored connection error, notify this subscriber
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
