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
// SHELL CONNECTION TYPES — shared contract for shell-ui and VSCode hosts
// =============================================================================
//
// Both hosts implement IConnectionManager with their own internals:
//   - shell-ui:  module singleton with typed event bus
//   - VSCode:    class extending Node EventEmitter
//
// All shell events use the 'shell:*' prefix. The ShellConnectionEventMap
// defines canonical event names and payload types that both hosts agree on.
// =============================================================================

import type { ConnectResult, DAPMessage } from 'rocketride';
import type { ConnectionStatus } from './connection';
import type { CheckoutPlan } from '../modules/checkout/types';

// =============================================================================
// APP ENTRY — minimal shape for app catalog events
// =============================================================================

/**
 * Minimal app entry shape shared across hosts for event payloads.
 *
 * Both shell-ui and VSCode emit `shell:appsUpdated` and `shell:subscribe`
 * with app entries. This captures the common fields; hosts cast to their
 * concrete type (e.g. shell-ui's `AppManifestEntry`) for full access.
 */
export interface ShellAppEntry {
	/** Unique app identifier (e.g. 'rocketride.home'). */
	id: string;
	/** Display name. */
	name: string;
	/** Optional description. */
	description?: string;
	/** Additional properties vary by host. */
	[key: string]: unknown;
}

// =============================================================================
// EVENT MAP
// =============================================================================

/**
 * Canonical map of all shell event names to their payload shapes.
 *
 * Both shell-ui and VSCode emit and listen to events from this map.
 * Hosts may augment the map with host-specific events via declaration
 * merging, but the core events listed here must be consistent.
 *
 * Events are grouped by concern:
 * - **Connection lifecycle**: connect/disconnect/status
 * - **Server data**: push events, account updates, service catalog
 * - **Auth**: login/logout flows
 * - **UI coordination**: app switching, subscriptions, theme, sidebar
 */
export interface ShellConnectionEventMap {
	// ── Connection lifecycle ─────────────────────────────────────────────

	/** Fired when the WebSocket handshake completes and authentication succeeds. */
	'shell:connected': Record<string, never>;

	/** Fired when the WebSocket closes (cleanly or due to error). */
	'shell:disconnected': { reason: string; hasError: boolean };

	/**
	 * Transient status bar text shown during connection state transitions.
	 *
	 * Examples: `"Reconnecting..."`, `"Authenticating..."`.
	 * Pass `null` to clear the message.
	 */
	'shell:statusMessage': { message: string | null };

	/**
	 * Full connection state machine update.
	 *
	 * VSCode emits this with the complete `ConnectionStatus` object
	 * (state, connectionMode, hasCredentials, retryAttempt, progressMessage, etc.).
	 * Cloud-ui may emit a simpler version or omit it entirely.
	 *
	 * Both shell-ui and VSCode now share the ConnectionStatus type from
	 * shared-ui/types/connection.ts.
	 */
	'shell:statusChange': ConnectionStatus;

	/** Fired when a connection attempt or operation fails with an error. */
	'shell:error': { error: Error | unknown };

	// ── Server data ─────────────────────────────────────────────────────

	/**
	 * Every push event received from the RocketRide server over the WebSocket.
	 *
	 * Wraps the raw DAP event message so app plugins can subscribe to
	 * server-pushed data without needing direct client access.
	 */
	'shell:event': { event: DAPMessage };

	/**
	 * Server-pushed account update (e.g. subscription change, profile edit,
	 * environment variable change).
	 *
	 * Triggered by the `apaext_account` DAP event. The payload is the
	 * updated `ConnectResult` containing identity, organizations, teams,
	 * envKeys, and subscription status.
	 */
	'shell:accountUpdate': ConnectResult;

	/**
	 * Emitted when the service catalog is fetched or refreshed.
	 *
	 * Contains the full services map and an optional error string if
	 * the fetch failed.
	 */
	'shell:servicesUpdated': { services: Record<string, unknown>; servicesError?: string };

	/**
	 * The app catalog has changed — shell and app-store views should update.
	 *
	 * Emitted after authentication (ConnectResult includes entitled apps),
	 * or when the server pushes an app-publish notification. The `apps` array
	 * is the complete replacement set — consumers should discard their
	 * previous list entirely.
	 *
	 * The `apps` array contains server app entries. Typed as a minimal
	 * interface to avoid importing shell-ui's AppManifestEntry into shared-ui.
	 * Hosts cast to their concrete AppManifestEntry type.
	 */
	'shell:appsUpdated': { apps: ShellAppEntry[] };

	// ── Auth ─────────────────────────────────────────────────────────────

	/**
	 * Successful authentication — identity is now available.
	 *
	 * Emitted after `connect()` resolves with valid credentials.
	 * The `user` field contains the full `ConnectResult` with identity data.
	 */
	'shell:login': { user: ConnectResult };

	/** User signed out — identity cleared, client disconnected. */
	'shell:logout': Record<string, never>;

	/**
	 * Sign-in request initiated by the UI (e.g. "Get Started" button).
	 *
	 * Optional `appId` specifies which app to navigate to after auth completes.
	 * Optional `register` requests Zitadel's sign-up form instead of sign-in
	 * (used by "Get Started" CTAs vs. "Sign In" controls).
	 */
	'shell:loginRequest': { appId?: string; register?: boolean };

	/** Sign-out request initiated by the UI (e.g. "Sign Out" button). */
	'shell:logoutRequest': Record<string, never>;

	// ── UI coordination ──────────────────────────────────────────────────

	/** Switch the active app without going through the workspace dispatch. */
	'shell:switchApp': { appId: string };

	/**
	 * User clicked "Subscribe" on a paid app in the marketplace.
	 *
	 * Opens the CheckoutModal. The `app` field is the manifest entry. The
	 * optional `plan` preselects a tier and skips the picker — going straight
	 * to payment (used by the web pricing page); omit it to show the picker.
	 */
	'shell:subscribe': { app: ShellAppEntry; plan?: CheckoutPlan };

	/** Navigate back to the My Apps launcher screen. */
	'shell:myApps': Record<string, never>;

	/**
	 * Request the shell open a built-in overlay (e.g. from a guest app's
	 * profile/account menu, which can't render the shell's overlays directly).
	 * The `id` selects which overlay to show.
	 */
	'shell:openOverlay': { id: 'account' | 'settings' | 'environment' };

	/** Sidebar is starting to collapse — dependent UI can prepare. */
	'shell:sidebarCollapsing': Record<string, never>;

	/**
	 * Theme tokens changed.
	 *
	 * Contains the full set of CSS custom property key/value pairs
	 * for the new theme.
	 */
	'shell:themeChange': { tokens: Record<string, string> };

	// ── App-defined events ───────────────────────────────────────────────
	// Apps may emit their own events through the connection manager's event
	// bus (e.g. 'home:browsingChange'). The index signature allows any
	// string key so apps don't need to cast custom event names.
	[key: string]: unknown;
}

// =============================================================================
// CONNECTION MANAGER INTERFACE
// =============================================================================

/**
 * Minimal interface that both shell-ui and VSCode connection managers implement.
 *
 * Each host has its own concrete implementation with additional host-specific
 * methods, but consumers that need cross-host compatibility should program
 * against this interface.
 *
 * The `on()` method returns an unsubscribe function (matching the shell-ui
 * pattern), not the EventEmitter `this` reference. VSCode's implementation
 * wraps the Node EventEmitter to provide this API.
 */
export interface IConnectionManager {
	/**
	 * Returns the underlying RocketRideClient instance, or `null` if not
	 * yet initialized.
	 *
	 * Typed as `unknown` so the shared package does not depend on the
	 * concrete client type. Hosts should cast to `RocketRideClient` in
	 * their own code.
	 */
	getClient(): unknown | null;

	/** Returns `true` if the WebSocket is authenticated and connected. */
	isConnected(): boolean;

	/**
	 * Returns the cached `ConnectResult` from the most recent successful
	 * authentication, or `null` if never connected.
	 *
	 * Contains identity, organizations, teams, envKeys, subscription status.
	 */
	getAccountInfo(): unknown | null;

	/**
	 * Returns the cached service catalog.
	 *
	 * If the cache is empty and the client is connected, implementations
	 * should trigger a lazy background fetch and emit `shell:servicesUpdated`
	 * when the result arrives.
	 */
	getCachedServices(): { services: Record<string, unknown>; servicesError?: string };

	/**
	 * Fetches the service catalog from the server and updates the cache.
	 *
	 * Deduplicates concurrent calls.  Emits `shell:servicesUpdated` on
	 * completion (success or failure).
	 */
	refreshServices(): Promise<void>;

	/**
	 * Initiates a connection to the RocketRide server.
	 *
	 * @param credential - Optional authentication credential. Shape varies
	 *   by host (token string, PKCE exchange object, etc.).
	 */
	connect(credential?: unknown): Promise<unknown>;

	/**
	 * Gracefully disconnects from the RocketRide server.
	 *
	 * Safe to call when already disconnected.
	 */
	disconnect(): Promise<void>;

	/**
	 * Registers a handler for a typed shell event.
	 *
	 * @param event   - The event name from `ShellConnectionEventMap`.
	 * @param handler - Callback invoked when the event fires.
	 * @returns An unsubscribe function — call it to remove the handler.
	 */
	on<K extends keyof ShellConnectionEventMap>(
		event: K,
		handler: (payload: ShellConnectionEventMap[K]) => void,
	): () => void;

	/**
	 * Emits a typed shell event, dispatching to all registered handlers.
	 *
	 * Public so that any code (sidebar, home app, plugins) can fire UI
	 * coordination events through the connection manager.
	 *
	 * @param event   - The event name from `ShellConnectionEventMap`.
	 * @param payload - The payload matching the event's type.
	 */
	emit<K extends keyof ShellConnectionEventMap>(
		event: K,
		payload: ShellConnectionEventMap[K],
	): void;
}
